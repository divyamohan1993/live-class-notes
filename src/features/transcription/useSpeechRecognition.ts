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
 *     subscription bounces the engine to apply a new language while recording.
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
import type { TranscriptionEngine } from './engine.ts'

/**
 * Watchdog cadence and silence threshold for forcing a restart. Kept aggressive on purpose:
 * over a multi-hour lecture, restarting during a genuine pause costs nothing (no speech is lost
 * during silence), while a fast watchdog recovers a silently-stalled recognizer before it drops
 * large chunks. So we check often and forgive only a short stall.
 */
const WATCHDOG_INTERVAL_MS = 2_500
const SILENCE_LIMIT_MS = 5_000
/**
 * Auto-restart backoff bounds. The normal case (a clean end mid-talk) restarts almost
 * immediately to minimize the seam gap; backoff only grows when restarts keep failing (service
 * genuinely unreachable) and is capped low so we never sit idle long enough to lose much.
 */
const BACKOFF_MIN_MS = 200
const BACKOFF_MAX_MS = 1_500

export interface UseSpeechRecognition {
  supported: boolean
  listening: boolean
  error: string | null
  start: () => void
  stop: () => void
}

export function useSpeechRecognition(): UseSpeechRecognition {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState(false)

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
  /** Current restart backoff; reset to MIN whenever results flow. */
  const backoffRef = useRef(BACKOFF_MIN_MS)
  /** Pending restart timer + watchdog interval, cancelled on stop / unmount. */
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /**
   * Bridges the effect-scoped `ensureRunning` out to `start()`. Needed for the reload-resume
   * path: a session persisted as 'recording' has no state change for the status subscription
   * to react to, so the Resume click must bring the engine up directly within the gesture.
   */
  const ensureRunningRef = useRef<() => void>(() => {})
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
     * The single funnel that brings the engine up. Idempotent: a no-op when already running
     * or when a start is pending. Everything that wants the engine running calls this.
     */
    const ensureRunning = (): void => {
      const engine = engineRef.current
      if (!engine || !engine.supported) return
      if (runningRef.current || startingRef.current) return
      clearRestartTimer()
      startingRef.current = true
      stoppingRef.current = false
      markActivity()
      try {
        engine.start()
      } catch {
        startingRef.current = false
        scheduleRestart()
      }
    }

    /** Schedule an auto-restart with capped backoff, only while the session wants recording. */
    const scheduleRestart = (): void => {
      if (useSession.getState().status !== 'recording') return
      clearRestartTimer()
      // The next session's first final may be a duplicated boundary tail — arm seam dedup.
      seamPendingRef.current = true
      const conn = useSession.getState().connection
      // Don't stomp a user-facing 'error'/'offline'; otherwise show we're reconnecting.
      if (conn !== 'error' && conn !== 'offline') {
        useSession.getState().setConnection('reconnecting')
      }
      const delay = backoffRef.current
      // Escalate backoff for the NEXT attempt; reset happens when results actually flow.
      backoffRef.current = Math.min(backoffRef.current * 2, BACKOFF_MAX_MS)
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null
        if (useSession.getState().status === 'recording') ensureRunning()
      }, delay)
    }

    // Expose the funnel to start() for the reload-resume path (see ensureRunningRef).
    ensureRunningRef.current = ensureRunning

    const engine = new WebSpeechEngine({
      lang: useSession.getState().meta.lang,
      onStart: () => {
        runningRef.current = true
        startingRef.current = false
        backoffRef.current = BACKOFF_MIN_MS
        markActivity()
        setListening(true)
        // A successful open clears any prior transient/error connection state.
        setError(null)
        const conn = useSession.getState().connection
        if (conn !== 'live') useSession.getState().setConnection('live')
      },
      onInterim: (text) => {
        markActivity()
        useSession.getState().setInterim(text)
      },
      onFinal: (text, startedAtEpoch, endedAtEpoch) => {
        markActivity()
        backoffRef.current = BACKOFF_MIN_MS
        // Seam dedup: only the first final after a restart can be a duplicated boundary
        // tail. Outside a seam, identical text is a genuine repeat and must be kept.
        const atSeam = seamPendingRef.current
        seamPendingRef.current = false
        if (atSeam && text === lastFinalRef.current) {
          // Dropped boundary duplicate: do not advance the clamp or commit.
          useSession.getState().setInterim('')
          return
        }
        // Chronological clamp: start never goes backwards; end never precedes start.
        const start = Math.max(startedAtEpoch, lastCommittedStartRef.current)
        const end = Math.max(endedAtEpoch, start)
        lastCommittedStartRef.current = start
        lastFinalRef.current = text
        useSession.getState().commitSegment(text, start, end)
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
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          // Hard stop: microphone permission denied/blocked. Tell the user, stop the loop.
          setError(
            'Microphone access is blocked. Allow microphone permission in your browser, then start recording again.',
          )
          stoppingRef.current = true
          clearRestartTimer()
          useSession.getState().setConnection('error')
          if (useSession.getState().status === 'recording') {
            useSession.getState().stopRecording()
          }
          try {
            engineRef.current?.stop()
          } catch {
            // ignore — onEnd will still fire and find stoppingRef set
          }
          return
        }
        // 'no-speech' | 'aborted' | 'audio-capture' | 'network' | others → recoverable.
        // A network error means connectivity trouble; otherwise we're just reconnecting.
        // onEnd follows the error and runs the actual restart via the funnel.
        if (useSession.getState().status === 'recording') {
          useSession
            .getState()
            .setConnection(code === 'network' ? 'offline' : 'reconnecting')
        }
      },
      onEnd: () => {
        runningRef.current = false
        startingRef.current = false
        setListening(false)
        if (stoppingRef.current) {
          stoppingRef.current = false
          return
        }
        // Auto-restart only if the session still wants to record (the 10h endurance core).
        if (useSession.getState().status === 'recording') {
          scheduleRestart()
        } else {
          useSession.getState().setConnection('idle')
        }
      },
    })

    engineRef.current = engine
    setSupported(engine.supported)

    // --- Watchdog: clear silent Chromium stalls where the recognizer is "running" but dead.
    watchdogRef.current = setInterval(() => {
      if (useSession.getState().status !== 'recording') return
      if (!runningRef.current) return
      if (Date.now() - lastActivityRef.current <= SILENCE_LIMIT_MS) return
      // Force a clean restart: abort() → engine onEnd → scheduleRestart() via the funnel.
      // Pre-mark activity so we don't fire again before onEnd lands.
      markActivity()
      try {
        engineRef.current?.stop()
      } catch {
        // ignore — if abort throws, onEnd may not fire; recover directly.
        runningRef.current = false
        scheduleRestart()
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
      if (engineRef.current instanceof WebSpeechEngine) {
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
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      // Full teardown on unmount: stop the engine and clear every timer/subscription.
      stoppingRef.current = true
      clearRestartTimer()
      if (watchdogRef.current != null) {
        clearInterval(watchdogRef.current)
        watchdogRef.current = null
      }
      unsubStatus()
      unsubLang()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      try {
        engineRef.current?.stop()
      } catch {
        // ignore
      }
      engineRef.current = null
    }
  }, [])

  // start()/stop() are thin drivers: they move the STORE lifecycle, and the status
  // subscription above brings the engine up/down. This keeps the user gesture (the click)
  // on the same synchronous path as engine.start(), which browsers require for mic access.
  const start = (): void => {
    const state = useSession.getState()
    setError(null)
    // The user has now explicitly asked to record/resume; unlock the auto-keep-alive machinery.
    gestureStartedRef.current = true
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

  return { supported, listening, error, start, stop }
}
