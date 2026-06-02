/**
 * useSpeechRecognition — the React adapter that turns a {@link TranscriptionEngine} into a
 * rock-solid, multi-hour live transcription source for the session store.
 *
 * Design (see engine.ts for the mechanism/policy split):
 *   - The engine emits raw events; THIS hook owns all policy and is the single writer of
 *     `connection` state. Restart, backoff, watchdog, and online/offline handling live here.
 *   - One guarded `ensureRunning()` funnel starts the engine; a `running` ref (set by the
 *     engine's onStart / cleared by onEnd) stops the watchdog, the auto-restart, and the
 *     online handler from triple-starting. Every engine call is wrapped so the app never
 *     throws uncaught.
 *   - Restart policy reads `store.status`, which we always update BEFORE tearing the engine
 *     down. So onEnd's rule is simply: status==='recording' → restart, else stay down. A
 *     deliberate stop sets a `stopping` flag so onEnd doesn't auto-restart.
 *   - We SUBSCRIBE to store.status to drive start/stop, but the microphone only ever opens
 *     after an explicit user gesture in the current page load (tracked by gestureStartedRef).
 *     A session restored from IndexedDB as status==='recording' is applied by hydrate() as a
 *     state change AFTER this hook subscribes, so without that latch the subscription would
 *     auto-start the mic on reload. Instead we leave it down and wait for the Resume prompt's
 *     click (which also satisfies the browser's user-gesture requirement). A separate lang
 *     subscription bounces the engine to apply a new language while recording. Once a session
 *     IS live (the gesture already happened), every reconnection path — scheduleRestart,
 *     ensureRunning, the watchdog's self-heal — runs WITHOUT a further gesture, so a mid-lecture
 *     drop reconnects fully automatically. The gesture latch gates only the very first start and
 *     the online handler, never reconnection.
 *   - Universal self-heal: the watchdog is not just a silence detector — while status is
 *     'recording' it recovers EVERY failure mode. A wedged start (Chromium fires neither
 *     onstart nor onend — the classic "stuck reconnecting") is timed out, hard-reset, and
 *     retried; a session that ended without a restart scheduled (e.g. abort() returned but no
 *     onEnd came) is kicked back up. There is no recording state that stays dead.
 *   - Never lose words: the latest interim is held verbatim and FLUSHED to a committed segment
 *     at the single onEnd chokepoint whenever recording continues (a drop, a stall, or a
 *     proactive cycle mid-utterance). Web Speech discards in-flight interim on end/abort, so this
 *     is the only way the last spoken words survive a disconnect. The seam dedup absorbs an exact
 *     reconnect re-emit; a refined/extended re-emit may leave a partial dup (we prefer duplication
 *     over loss). A deliberate Stop discards the partial — it is an explicit end.
 *
 * Chronological invariant: image placement depends on segment start times being
 * monotonically non-decreasing. Every commit clamps `startedAtEpoch` up to the last
 * committed start, and `endedAtEpoch` up to that start, so order is preserved even across
 * restart seams and clock skew. Exact-duplicate finals at a restart seam are dropped and do
 * NOT advance the clamp baseline.
 */
import { useEffect, useRef, useState } from 'react'
import { useSession } from '../../store.ts'
import { WebSpeechEngine } from './engine.ts'
import type { TranscriptionEngine, WebSpeechEngineOptions } from './engine.ts'
import { WhisperEngine } from './whisper/whisperEngine.ts'
import { useEnginePref } from './enginePref.ts'

/**
 * PROACTIVE CYCLING — the anti-hang core for multi-hour use.
 *
 * Chromium's continuous SpeechRecognition silently stops emitting results after roughly
 * 50-60s of a single session: no error, no `end`, the recognizer just goes deaf. If we wait
 * for that to surface we lose seconds (the watchdog's silence window) every minute and, worse,
 * a long monologue past the cliff drops a massive chunk. So we PRE-EMPT it: while running, we
 * proactively recycle the recognizer well before the cliff, turning an unpredictable
 * multi-second silent death into a predictable, near-instant (~sub-300ms) seam that the seam
 * de-dup stitches across.
 *
 * To avoid clipping a word mid-utterance, we prefer to cycle during a brief lull (>1s since the
 * last interim) once past the soft target, but we FORCE the cycle at the hard cap regardless —
 * fast continuous speech (no Indian-accented lecturer pauses) never yields a lull, and missing
 * the cliff is worse than clipping one word that the next session immediately re-captures.
 *
 * These are checked on the existing watchdog tick (no extra timer to leak); 2.5s granularity
 * means the hard cap actually fires at ~55-57.5s, still safely under Chrome's ~60s death.
 */
const CYCLE_SOFT_MS = 45_000
const CYCLE_HARD_MS = 55_000
/** A gap this long since the last interim counts as a lull safe to cycle in past the soft target. */
const CYCLE_LULL_MS = 1_000

/**
 * Watchdog cadence and silence threshold — now a pure BACKSTOP behind proactive cycling. It
 * only fires if a session goes deaf BEFORE its proactive cycle (e.g. an early stall) or a cycle
 * restart fails to produce results. The silence window is wider than a normal speaking pause
 * (board work, thinking) so ordinary gaps in a lecture don't trigger needless restarts; proactive
 * cycling, not the watchdog, is what keeps us ahead of Chrome's silent-death cliff.
 */
const WATCHDOG_INTERVAL_MS = 2_500
const SILENCE_LIMIT_MS = 9_000
/**
 * Per-start timer thresholds — the fix for the "stuck reconnecting, never recovers" trap.
 *
 * After a network blip or a rapid cycle, Chromium can wedge a freshly-started recognizer so it
 * fires NEITHER onstart NOR onend. Without a timeout the `starting` flag would latch forever:
 * every scheduled restart no-ops (the funnel bails while starting). So each engine.start() arms
 * two dedicated timers (in ensureRunning), cleared the instant onStart or onEnd fires:
 *   - at STALL_GRACE_MS, if onStart still hasn't fired, we surface 'reconnecting' (the ONLY place
 *     a routine restart escalates to a visible status — a healthy reopen clears this well first,
 *     so the ~45s proactive cycle never flickers the pill);
 *   - at START_TIMEOUT_MS, if onStart still hasn't fired, the open is declared wedged: we salvage
 *     pending text, hard-reset the engine (so the abandoned instance can never emit a late
 *     event), clear `starting`, and retry through the funnel.
 * Dedicated timers (not the watchdog tick) give true ~1.5s / ~3s timing. Combined with the
 * watchdog's down-engine self-heal, there is no state from which an active recording cannot
 * recover within a couple of seconds.
 */
const STALL_GRACE_MS = 1_500
const START_TIMEOUT_MS = 3_000
/**
 * Auto-restart backoff bounds. The normal case (a clean end / proactive cycle mid-talk) restarts
 * almost immediately to minimize the seam gap; backoff only grows when restarts keep failing
 * (service genuinely unreachable) and is capped low so we never sit idle long enough to lose much.
 * It self-resets to MIN in onStart, so every healthy cycle reopens at the fast path; the
 * escalation is purely a safety valve against a tight retry loop when the service is down.
 */
const BACKOFF_MIN_MS = 200
const BACKOFF_MAX_MS = 1_500
/**
 * Idle auto-complete. If genuinely NO speech is heard (no final AND no interim) for this long
 * while recording, we auto-finalize the session (store.stopRecording → persist/archive-ready).
 * This is the graceful end for a class that quietly wrapped up, a forgotten-open tab, or a mic
 * that was unplugged and never returned. Reset ONLY by real interim/final results — never by
 * restart churn (a proactive cycle / reconnect produces an onStart but no speech, and must NOT
 * count as activity), so a silent-but-"running" recognizer still completes on schedule.
 *
 * Tradeoff worth knowing: this deliberately overrides the recovery loops past the 5-minute mark.
 * A mic locked/in-use, network down, or tab backgrounded for >5 min produces no results, so the
 * session auto-completes rather than retrying forever. That is the intended "no speech = done"
 * semantics; recovery is unbounded only within the idle window. (A permission denial is the one
 * case that ends immediately rather than via idle — it is a hard stop; see onError.)
 */
const IDLE_COMPLETE_MS = 5 * 60 * 1_000

/**
 * One-time model load/download progress for the on-device engine. `null` whenever nothing is
 * loading (Web Speech, or Whisper after the model is cached + ready). The Whisper engine emits
 * this via onProgress while fetching the ~150MB model on first use; the UI shows a small inline
 * indicator from it.
 */
export interface ModelStatus {
  /** Load progress in [0, 1]. */
  progress: number
  /** Human-readable status label, e.g. "Downloading model". */
  status: string
}

export interface UseSpeechRecognition {
  supported: boolean
  listening: boolean
  error: string | null
  /** Model download/warm-up progress for the on-device engine; null when not loading. */
  modelStatus: ModelStatus | null
  start: () => void
  stop: () => void
}

export function useSpeechRecognition(): UseSpeechRecognition {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState(false)
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null)

  // Which engine the user has chosen. The whole engine-construction effect depends on this, so
  // switching tears the old engine down and builds the selected one. Default 'web-speech'.
  const enginePref = useEnginePref((s) => s.engine)

  // All mutable control state lives in refs so the engine's long-lived callbacks (bound once)
  // always read the latest values without stale closures and without re-creating the engine.
  const engineRef = useRef<TranscriptionEngine | null>(null)
  /** True between the engine's onStart and onEnd — the authoritative "is it live" flag. */
  const runningRef = useRef(false)
  /** Guards the async gap between requesting a start and onStart firing. */
  const startingRef = useRef(false)
  /** Set while a deliberate stop is in flight so onEnd doesn't auto-restart. */
  const stoppingRef = useRef(false)
  /** Last finalized text, the baseline for seam dedup. Updated on every commit. */
  const lastFinalRef = useRef('')
  /**
   * True only for the FIRST final after an auto-restart. Web Speech can re-emit the tail of
   * the previous session's last utterance when it reconnects; we dedup just that one boundary
   * final. We must NOT dedup globally, or a lecturer legitimately repeating a phrase ("Okay.")
   * later in the talk would be silently dropped.
   */
  const seamPendingRef = useRef(false)
  /** Monotonic baseline for the chronological clamp on segment start times. */
  const lastCommittedStartRef = useRef(0)
  /** Wall-clock of the last engine activity (start / interim / final), for the watchdog. */
  const lastActivityRef = useRef(0)
  /**
   * Wall-clock the CURRENT recognizer session actually opened (stamped in onStart, not at the
   * start request — the request→onStart gap varies). Drives the proactive-cycle age check.
   */
  const sessionStartRef = useRef(0)
  /**
   * Wall-clock of the last INTERIM result only. Tracked separately from lastActivityRef (which
   * finals/status also bump) so the proactive-cycle "lull" check reflects a genuine speech gap.
   */
  const lastInterimRef = useRef(0)
  /**
   * The latest interim (not-yet-finalized) text, kept verbatim so we can SALVAGE it on a drop.
   * Web Speech discards in-flight interim when a session ends/aborts, so without this the last
   * spoken words before a disconnect (or a proactive cycle mid-utterance) are lost. Flushed to a
   * committed segment at the onEnd chokepoint; the seam dedup absorbs any matching reconnect tail.
   */
  const interimTextRef = useRef('')
  /** Current restart backoff; reset to MIN whenever results flow. */
  const backoffRef = useRef(BACKOFF_MIN_MS)
  /** Pending restart timer + watchdog interval, cancelled on stop / unmount. */
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /**
   * Per-start timers, armed when engine.start() is issued and cleared the instant onStart or
   * onEnd fires (or on stop/unmount). startTimeoutRef un-wedges a recognizer that fired NEITHER
   * onstart nor onend (the "stuck reconnecting" trap); graceTimerRef is the ONLY thing that flips
   * the visible status to 'reconnecting', and only if the open is genuinely slow — so a healthy
   * sub-second reopen on the ~45s proactive cycle never flickers the pill.
   */
  const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Idle auto-complete timer. Armed when the user starts/resumes recording and reset on EVERY
   * real interim/final result; if it ever fires, the session has been silent for IDLE_COMPLETE_MS
   * and we auto-finalize it. Deliberately NOT reset by onStart/restarts (see IDLE_COMPLETE_MS).
   */
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Bridges the effect-scoped `ensureRunning` out to `start()`. Needed for the reload-resume
   * path: a session persisted as 'recording' has no state change for the status subscription
   * to react to, so the Resume click must bring the engine up directly within the gesture.
   */
  const ensureRunningRef = useRef<() => void>(() => {})
  /**
   * Bridges the effect-scoped idle-timer arm/reset/clear helpers out to `start()` (which lives
   * outside the effect). Assigned once the effect runs; the no-op default covers the first render.
   */
  const armIdleTimerRef = useRef<() => void>(() => {})
  /**
   * Latches true once the user explicitly starts/resumes recording in THIS page load. Gates
   * every auto-start path so a session restored from IndexedDB as status==='recording' never
   * opens the microphone without a gesture; it waits for the Resume prompt instead.
   */
  const gestureStartedRef = useRef(false)

  useEffect(() => {
    const markActivity = (): void => {
      lastActivityRef.current = Date.now()
    }

    const clearRestartTimer = (): void => {
      if (restartTimerRef.current != null) {
        clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
    }

    /**
     * Clear the per-start timeout + grace timers. Called the instant a start resolves either way
     * (onStart success / onEnd failure) and on every teardown, so neither can stale-fire against
     * a session that has already moved on. Safe to call when nothing is armed.
     */
    const clearStartTimers = (): void => {
      if (startTimeoutRef.current != null) {
        clearTimeout(startTimeoutRef.current)
        startTimeoutRef.current = null
      }
      if (graceTimerRef.current != null) {
        clearTimeout(graceTimerRef.current)
        graceTimerRef.current = null
      }
    }

    const clearIdleTimer = (): void => {
      if (idleTimerRef.current != null) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }

    /**
     * (Re)arm the idle auto-complete timer. Called once when recording starts and again on every
     * real interim/final result, so the 5-minute clock only elapses during genuine silence. On
     * fire, if we are still recording, finalize the session — the store persists/archives it and
     * the status change tears the engine down through the normal non-recording path.
     */
    const armIdleTimer = (): void => {
      clearIdleTimer()
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null
        if (useSession.getState().status === 'recording') {
          useSession.getState().stopRecording()
        }
      }, IDLE_COMPLETE_MS)
    }
    // Expose arming to start() (outside the effect) for fresh start / resume / reload-resume.
    armIdleTimerRef.current = armIdleTimer

    /**
     * The single funnel that brings the engine up. Idempotent: a no-op when already running
     * or when a start is pending. Everything that wants the engine running calls this.
     */
    const ensureRunning = (): void => {
      const engine = engineRef.current
      if (!engine || !engine.supported) return
      if (runningRef.current || startingRef.current) return
      clearRestartTimer()
      clearStartTimers()
      startingRef.current = true
      stoppingRef.current = false
      markActivity()
      try {
        engine.start()
      } catch {
        startingRef.current = false
        scheduleRestart()
        return
      }
      // The wedge-timeout + grace timers below are a Web-Speech-specific failure mode (Chromium
      // wedging a freshly-started recognizer so it fires neither onstart nor onend). Whisper has no
      // such mode AND its onStart only fires after a multi-minute model download on first use, so a
      // 3s wedge-timeout would reset() the worker mid-download (terminating it) and loop forever. So
      // we arm these timers ONLY for Web Speech; for Whisper a slow start is normal and the worker's
      // own getUserMedia / worker-error paths surface failures via onError + onEnd.
      if (enginePref !== 'web-speech') return
      // (1) START-TIMEOUT — un-wedge. If onStart never fires, the recognizer is wedged (Chromium
      // fired neither onstart nor onend; the classic "shows reconnecting, never reconnects"). On
      // fire: salvage any pending text, force a HARD engine teardown so the abandoned instance can
      // never deliver a late event, drop the starting flag, and restart through the funnel.
      startTimeoutRef.current = setTimeout(() => {
        startTimeoutRef.current = null
        if (!startingRef.current || runningRef.current) return
        // Cancel the grace timer too (defensive: independent of the two thresholds' ordering).
        clearStartTimers()
        startingRef.current = false
        if (useSession.getState().status === 'recording' && !stoppingRef.current) {
          flushPendingInterim()
        }
        try {
          engineRef.current?.reset()
        } catch {
          // ignore — reset is best-effort; the next start() also tears down defensively.
        }
        scheduleRestart()
      }, START_TIMEOUT_MS)
      // (4) GRACE — the ONLY path that shows 'reconnecting'. A healthy reopen fires onStart (which
      // clears this) in well under the grace, so the proactive ~45s cycle stays 'live' with no
      // flicker. Only a genuinely slow open trips it. Never stomp a real 'offline'/'error'.
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null
        if (!startingRef.current || runningRef.current) return
        const conn = useSession.getState().connection
        if (
          useSession.getState().status === 'recording' &&
          conn !== 'offline' &&
          conn !== 'error'
        ) {
          useSession.getState().setConnection('reconnecting')
        }
      }, STALL_GRACE_MS)
    }

    /**
     * Schedule an auto-restart with capped backoff, only while the session wants recording.
     *
     * Deliberately does NOT touch `connection`. Almost every restart here is routine — a
     * proactive cycle, a transient 'aborted'/'no-speech' end, or a watchdog stall trip — and
     * flapping the status to 'reconnecting' on each (every ~45s) would be alarming noise.
     * Connection state is driven only by genuine signals: 'offline' from a real `network` error
     * / the browser offline event, and 'reconnecting' from the online handler while reopening.
     * A successful reopen re-asserts 'live' in onStart.
     */
    const scheduleRestart = (): void => {
      if (useSession.getState().status !== 'recording') return
      clearRestartTimer()
      // The next session's first final may be a duplicated boundary tail — arm seam dedup.
      seamPendingRef.current = true
      const delay = backoffRef.current
      // Escalate backoff for the NEXT attempt; reset happens when results actually flow.
      backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS)
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null
        if (useSession.getState().status === 'recording') ensureRunning()
      }, delay)
    }

    /**
     * Commit one segment under the chronological clamp and advance the dedup/clamp baselines.
     * The single writer of committed segments, shared by onFinal and the drop-flush so both move
     * the same baselines and neither can emit an out-of-order segment. Seam-dedup is the CALLER's
     * decision (only onFinal can receive a duplicated boundary tail); this just commits.
     */
    const commitWithClamp = (text: string, startedAtEpoch: number, endedAtEpoch: number): void => {
      // Chronological clamp: start never goes backwards; end never precedes start.
      const start = Math.max(startedAtEpoch, lastCommittedStartRef.current)
      const end = Math.max(endedAtEpoch, start)
      lastCommittedStartRef.current = start
      lastFinalRef.current = text
      useSession.getState().commitSegment(text, start, end)
    }

    /**
     * Salvage the last interim text on a drop so the user never loses their final spoken words.
     * Web Speech throws away in-flight interim when a session ends/aborts (a network drop, a
     * proactive cycle mid-utterance, a stall recovery). We commit it as a real segment, then ARM
     * the seam so that if the NEXT session re-emits the same tail as a final, the dedup drops the
     * repeat. A refined/extended re-emit may still slip through as a near-duplicate the user can
     * edit — losing words outright is far worse, so we err toward keeping the text.
     *
     * The flush itself is never seam-deduped: it is current speech and must always be kept. We
     * arm the seam AFTER committing (and overwrite lastFinalRef via commitWithClamp first) so the
     * dedup compares the next final against exactly this flushed tail.
     */
    const flushPendingInterim = (): void => {
      const text = interimTextRef.current.trim()
      interimTextRef.current = ''
      if (text === '') return
      const now = Date.now()
      commitWithClamp(text, now, now)
      // Now lastFinalRef === this tail; arm the seam so a matching reconnect final is dropped.
      seamPendingRef.current = true
    }

    /**
     * Force the current session to recycle NOW: stop() the engine, which fires onEnd and (status
     * still 'recording') funnels into scheduleRestart for a near-instant reopen. Used by BOTH the
     * proactive cycle and the silence backstop. We pre-mark activity and clear runningRef so a
     * later watchdog tick can't double-fire before onEnd lands; if abort() throws (so onEnd may
     * never come) we recover directly. Connection is left untouched — this is a routine seam.
     */
    const cycleNow = (): void => {
      markActivity()
      runningRef.current = false
      try {
        engineRef.current?.stop()
      } catch {
        // abort() threw → onEnd may not fire. Drive the restart ourselves.
        scheduleRestart()
      }
    }

    // Expose the funnel to start() for the reload-resume path (see ensureRunningRef).
    ensureRunningRef.current = ensureRunning

    // Typed as WebSpeechEngineOptions (callbacks + lang); this shape also satisfies
    // WhisperEngineOptions (which only adds optional model/prompt), so the one literal builds
    // either engine. The annotation gives the callback params their contextual types back.
    const engineCallbacks: WebSpeechEngineOptions = {
      lang: useSession.getState().meta.lang,
      onStart: () => {
        runningRef.current = true
        startingRef.current = false
        // Loaded and live: any model-download indicator is done (covers Web Speech, which never
        // shows one, and Whisper once the worker reports ready).
        setModelStatus(null)
        // The start resolved successfully: cancel the wedge-timeout and the grace timer so the
        // grace can never fire a stray 'reconnecting' AFTER we are already live (item 4).
        clearStartTimers()
        backoffRef.current = BACKOFF_MIN_MS
        // Begin this session's proactive-cycle clock from the moment it actually opened.
        sessionStartRef.current = Date.now()
        markActivity()
        setListening(true)
        // A successful open clears any prior transient/error connection state.
        setError(null)
        const conn = useSession.getState().connection
        if (conn !== 'live') useSession.getState().setConnection('live')
      },
      onInterim: (text) => {
        markActivity()
        // Real speech heard → push back the idle auto-complete clock (item: 5-min idle).
        armIdleTimer()
        // Separate interim stamp feeds the proactive-cycle lull check (see the watchdog tick).
        lastInterimRef.current = Date.now()
        // Keep the latest interim verbatim so a drop can salvage it (see flushPendingInterim).
        interimTextRef.current = text
        useSession.getState().setInterim(text)
      },
      onFinal: (text, startedAtEpoch, endedAtEpoch) => {
        markActivity()
        // Real speech heard (even a deduped boundary repeat) → push back the idle clock.
        armIdleTimer()
        backoffRef.current = BACKOFF_MIN_MS
        // This utterance finalized cleanly — there is nothing left to salvage on a later drop.
        interimTextRef.current = ''
        // Seam dedup: only the FIRST final after a restart/flush can be a duplicated boundary
        // tail. Outside a seam, identical text is a genuine repeat ("Okay." again) and is kept.
        const atSeam = seamPendingRef.current
        seamPendingRef.current = false
        if (atSeam && text === lastFinalRef.current) {
          // Dropped boundary duplicate: do not advance the clamp or commit.
          useSession.getState().setInterim('')
          return
        }
        commitWithClamp(text, startedAtEpoch, endedAtEpoch)
      },
      onStatus: (status) => {
        if (status === 'live') {
          markActivity()
          // Never override a user-facing terminal 'error' (cleared on the next onStart).
          if (useSession.getState().connection !== 'error') {
            useSession.getState().setConnection('live')
          }
        } else {
          useSession.getState().setConnection(status)
        }
      },
      onError: (code) => {
        markActivity()
        // Every error code EXCEPT a permission denial is recoverable while recording: onError is
        // always followed by onEnd, which runs the actual restart via the funnel, so here we only
        // set the visible connection status per code. Permission is the one hard stop — auto-retry
        // there can't help (the browser requires a fresh user gesture to grant mic access), so it
        // would just loop; we end the session and ask the user to allow + Record again.
        const recording = useSession.getState().status === 'recording'
        switch (code) {
          case 'not-allowed':
          case 'service-not-allowed': {
            // Microphone permission denied/blocked. HARD STOP: a granted permission needs a user
            // gesture, so re-probing would loop forever and fail. Show the actionable message,
            // surface 'error', stop the restart machinery, and end the session cleanly (the store
            // persists it). stoppingRef makes the forced engine.stop()'s onEnd stay down. The user
            // re-grants permission in the browser, then clicks Record to start a fresh session.
            setError(
              'Microphone access is blocked. Allow microphone permission in your browser, then start recording again.',
            )
            stoppingRef.current = true
            clearRestartTimer()
            clearStartTimers()
            clearIdleTimer()
            useSession.getState().setConnection('error')
            if (recording) useSession.getState().stopRecording()
            try {
              engineRef.current?.stop()
            } catch {
              // ignore — onEnd will still fire and find stoppingRef set
            }
            return
          }
          case 'audio-capture': {
            // Mic missing / unplugged / locked or in use by another app or tab. Fully recoverable:
            // we keep retrying on backoff and resume automatically the moment the device frees (a
            // successful start → onStart → 'live'). Surface 'reconnecting' (the recoverable status
            // in our 5-value enum) so the user sees we are working on it, not a dead session.
            setError(null)
            if (recording) useSession.getState().setConnection('reconnecting')
            break
          }
          case 'network': {
            // Real connectivity loss → 'offline'. onOnline + the restart loop bring it back.
            if (recording) useSession.getState().setConnection('offline')
            break
          }
          case 'no-speech': {
            // Common with unclear/accented audio and during pauses. Treat as an INSTANT restart:
            // reset backoff so the reopen is immediate (never give up). Chrome's no-speech latency
            // is multi-second so this is not a tight loop; the 5-minute idle is the real backstop
            // for prolonged silence. Leave connection 'live' — this is not a fault the user needs.
            backoffRef.current = BACKOFF_MIN_MS
            break
          }
          default:
            // 'aborted' (our own proactive cycle / watchdog stop surfaces here) and any unknown
            // code → quiet, recoverable. Leave connection untouched (stay 'live') so routine
            // cycling never flaps the pill; onEnd runs the restart.
            break
        }
      },
      onEnd: () => {
        runningRef.current = false
        startingRef.current = false
        // The session ended: any per-start timeout/grace for it is now moot.
        clearStartTimers()
        setListening(false)
        // Any end clears the model-download indicator: a successful load surfaces via onStart, so a
        // non-null modelStatus reaching here means the load attempt ended without becoming live
        // (stop mid-download, fatal worker error). Cleared up front so the early-return stop path
        // below cannot strand a stale progress bar.
        setModelStatus(null)
        // onEnd is the single chokepoint for EVERY session ending — clean stop, network drop,
        // proactive cycle, stall, error (Web Speech fires onError THEN onEnd, so handling the
        // flush here also covers the error case without risking a double-commit). Salvage the
        // last interim before anything else so a drop never loses the user's final words.
        if (useSession.getState().status === 'recording' && !stoppingRef.current) {
          flushPendingInterim()
        } else {
          // Not continuing: discard any partial; a deliberate stop shouldn't strand a fragment.
          interimTextRef.current = ''
        }
        if (stoppingRef.current) {
          stoppingRef.current = false
          return
        }
        // Auto-restart only if the session still wants to record (the 10h endurance core). This
        // path has NO gesture gate — once a session is live, reconnection is fully automatic.
        if (useSession.getState().status === 'recording') {
          scheduleRestart()
        } else {
          useSession.getState().setConnection('idle')
        }
      },
      // Only the on-device engine emits this (first-use model download); Web Speech never calls it.
      // Hold it as hook state so the UI can show "Loading model N%"; onStart/onEnd clear it.
      onProgress: (progress: number, status: string) => {
        setModelStatus({ progress, status })
        // Push back the 5-min idle auto-complete while the model is genuinely downloading. The idle
        // clock is armed on the Record click and otherwise reset only by interim/final speech, but a
        // slow first-use download (~150MB) can exceed 5 minutes with no speech yet — without this it
        // would auto-stop an empty session mid-download. Progress ticks frequently, so this keeps the
        // clock fresh until onStart; normal silence semantics resume once recognition is live.
        armIdleTimer()
      },
    }

    // Construct the SELECTED engine. The effect re-runs (and fully tears down below) whenever the
    // engine pref changes, so exactly one engine is ever live. Whisper needs the same user gesture
    // (getUserMedia) as Web Speech; the gesture latch above gates both equally.
    const engine: TranscriptionEngine =
      enginePref === 'whisper'
        ? new WhisperEngine(engineCallbacks)
        : new WebSpeechEngine(engineCallbacks)

    engineRef.current = engine
    setSupported(engine.supported)

    // --- Watchdog tick: the universal self-heal. While recording there is NO state it cannot
    // recover from. Three jobs, in priority order; each returns after acting so only one fires:
    //   A. (item 2) DOWN ENGINE — recording but not running, not mid-start, with no restart and
    //      no start-timeout pending: the engine is simply dead (a dropped restart, an abort() that
    //      never delivered onEnd, any unforeseen gap). Bring it straight back up. A WEDGED start is
    //      NOT handled here — its dedicated startTimeout/grace timers own that (see ensureRunning).
    //   B. PROACTIVE CYCLE (running): pre-empt Chrome's ~50-60s silent-death cliff — cycle at a
    //      >1s lull past the soft target, force at the hard cap (fast speech yields no lull).
    //   C. SILENCE BACKSTOP (running): catch a session gone deaf before its proactive cycle.
    watchdogRef.current = setInterval(() => {
      if (useSession.getState().status !== 'recording') return
      const now = Date.now()

      // --- A. Down engine → self-heal (item 2). ---
      if (!runningRef.current) {
        // Only act when the engine is genuinely idle: not opening (startingRef / startTimeoutRef)
        // and not already scheduled to restart (restartTimerRef). The gesture gate keeps a
        // hydrated 'recording' reload from auto-opening the mic without a Resume click — note it
        // is a no-op MID-SESSION (gestureStartedRef is already true once a session has started),
        // so it never blocks reconnection; it only guards the pre-gesture reload case.
        const idle =
          !startingRef.current &&
          restartTimerRef.current == null &&
          startTimeoutRef.current == null
        if (gestureStartedRef.current && idle) ensureRunning()
        return
      }

      // Jobs B and C below are Web-Speech-only. They exist to pre-empt / recover Chromium's
      // ~50-60s silent-death cliff. Whisper has no silent-death: it captures continuously and
      // emits a final only every ~WINDOW_SECONDS, going legitimately quiet during board work, so
      // cycling it would needlessly reload the model and the 9s silence backstop would tear the
      // mic down mid-lecture. Whisper relies on job A (warm restart) + the 5-min idle complete.
      if (enginePref !== 'web-speech') return

      // --- B. Proactive cycle while running. ---
      const sessionAge = now - sessionStartRef.current
      const interimLull = now - lastInterimRef.current
      if (sessionAge >= CYCLE_HARD_MS || (sessionAge >= CYCLE_SOFT_MS && interimLull >= CYCLE_LULL_MS)) {
        cycleNow()
        return
      }
      // --- C. Silent-stall backstop while running: alive flag set but no activity for too long.
      if (now - lastActivityRef.current > SILENCE_LIMIT_MS) {
        cycleNow()
      }
    }, WATCHDOG_INTERVAL_MS)

    // --- React to lifecycle changes from anywhere (LiveTranscriber, other tabs of logic).
    // Zustand subscribe does NOT fire for the initial value, so a hydrated 'recording'
    // status never auto-starts the mic; only an in-session transition does.
    const unsubStatus = useSession.subscribe((state, prev) => {
      if (state.status === prev.status) return
      if (state.status === 'recording') {
        // Only a real user gesture may open the mic. A session restored from disk as
        // 'recording' (hydrate applies it as a change after we subscribed) must wait for the
        // Resume prompt rather than auto-starting here.
        if (gestureStartedRef.current) ensureRunning()
      } else {
        // paused / stopped / idle → take the engine down. onEnd sees the non-recording
        // status (set before this) and stays down.
        stoppingRef.current = true
        clearRestartTimer()
        clearStartTimers()
        clearIdleTimer()
        try {
          engineRef.current?.stop()
        } catch {
          // ignore
        }
      }
    })

    // Restart on language change while recording so the new lang takes effect immediately.
    const unsubLang = useSession.subscribe((state, prev) => {
      if (state.meta.lang === prev.meta.lang) return
      if (
        engineRef.current instanceof WebSpeechEngine ||
        engineRef.current instanceof WhisperEngine
      ) {
        engineRef.current.setLang(state.meta.lang)
      }
      if (useSession.getState().status === 'recording' && runningRef.current) {
        stoppingRef.current = false
        clearRestartTimer()
        try {
          // abort() → onEnd → (status still 'recording') → scheduleRestart with new lang.
          engineRef.current?.stop()
        } catch {
          // ignore
        }
      }
    })

    // --- Network transitions. Resume on reconnect, surface offline immediately.
    const onOnline = (): void => {
      if (useSession.getState().status !== 'recording') return
      // Never resurrect a session the user has not actively started in this page load.
      if (!gestureStartedRef.current) return
      useSession.getState().setConnection('reconnecting')
      backoffRef.current = BACKOFF_MIN_MS
      if (!runningRef.current && !startingRef.current) ensureRunning()
    }
    const onOffline = (): void => {
      if (useSession.getState().status === 'recording') {
        useSession.getState().setConnection('offline')
      }
    }
    // --- Tab visibility. Browsers throttle (and can fully suspend) background tabs, which pauses
    // Web Speech and often ends the session silently. When the tab returns to the foreground,
    // re-acquire the recognizer if a started recording is not currently live. Gesture-gated like
    // onOnline so a hydrated reload still waits for Resume; the funnel's guard makes it a no-op
    // when already running/starting.
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      if (useSession.getState().status !== 'recording') return
      if (!gestureStartedRef.current) return
      if (!runningRef.current && !startingRef.current) ensureRunning()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      // Full teardown on unmount: stop the engine and clear EVERY timer/subscription/listener.
      stoppingRef.current = true
      clearRestartTimer()
      clearStartTimers()
      clearIdleTimer()
      if (watchdogRef.current != null) {
        clearInterval(watchdogRef.current)
        watchdogRef.current = null
      }
      unsubStatus()
      unsubLang()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
      try {
        // On an engine SWITCH, stop() the Web Speech engine but hard-reset() Whisper so its worker
        // is terminated (stop() leaves the warm worker alive for a later start, which we don't want
        // when abandoning the engine entirely). reset() makes no onEnd promise and frees the model.
        if (engineRef.current instanceof WhisperEngine) engineRef.current.reset()
        else engineRef.current?.stop()
      } catch {
        // ignore
      }
      engineRef.current = null
      // Clear any in-flight model-download indicator so a switch never leaves a stale progress bar.
      setModelStatus(null)
    }
  }, [enginePref])

  // start()/stop() are thin drivers: they move the STORE lifecycle, and the status
  // subscription above brings the engine up/down. This keeps the user gesture (the click)
  // on the same synchronous path as engine.start(), which browsers require for mic access.
  const start = (): void => {
    const state = useSession.getState()
    setError(null)
    // The user has now explicitly asked to record/resume; unlock the auto-keep-alive machinery.
    gestureStartedRef.current = true
    // Arm the idle auto-complete clock for this active session. Done here (not in onStart) so a
    // proactive cycle / reconnect — which produces an onStart but no speech — never resets it;
    // only real interim/final results push it back. Covers fresh start, resume, and reload-resume.
    armIdleTimerRef.current()
    if (state.status === 'recording') {
      // Reload-resume: status was persisted as 'recording' but the engine isn't running and
      // the status subscription won't fire (no state change). Bring it up directly, inside
      // this click's synchronous call stack so the browser grants microphone access. The
      // funnel's running/starting guard makes this a no-op if it is somehow already live.
      ensureRunningRef.current()
    } else if (state.status === 'paused') {
      state.resumeRecording()
    } else {
      // idle or stopped → begin a fresh recording session.
      state.startRecording()
    }
  }

  const stop = (): void => {
    const state = useSession.getState()
    if (state.status === 'idle' || state.status === 'stopped') return
    state.stopRecording()
  }

  return { supported, listening, error, modelStatus, start, stop }
}
