/**
 * Transcription engine — the swappable speech-to-text mechanism behind live notes.
 *
 * IMPORTANT: WebSpeechEngine uses the browser's Web Speech API, which streams microphone
 * audio to the BROWSER VENDOR'S SERVERS for recognition (Google for Chrome, Microsoft for
 * Edge). It is NOT on-device, it requires an internet connection, and it is only available
 * in Chromium browsers (Chrome / Edge). We never store the audio ourselves, but it does
 * leave the machine in transit. This `TranscriptionEngine` interface exists precisely so a
 * future on-device engine (e.g. a WhisperEngine running whisper.cpp via WASM) can drop in
 * with zero changes to the React hook or UI: same callbacks, same start/stop contract.
 *
 * Division of labour: the engine owns the recognition mechanism ONLY. It emits raw events
 * through callbacks and never decides reconnection policy, never touches the store, and
 * never imports React. All "should we reconnect / what is the connection status" policy
 * lives in useSpeechRecognition, which is the single writer of connection state.
 */
import type { ConnectionStatus } from '../../types.ts'

/**
 * The Web Speech controller types are only partially shipped in TypeScript's DOM lib: the
 * event/result types (`SpeechRecognitionEvent`, `SpeechRecognitionErrorEvent`, …) exist,
 * but the `SpeechRecognition` controller interface and its global constructors do not. We
 * declare just those missing pieces here, reusing the lib's existing event types so our
 * handler signatures match the platform exactly.
 */
interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onstart: ((ev: Event) => void) | null
  onend: ((ev: Event) => void) | null
  onresult: ((ev: SpeechRecognitionEvent) => void) | null
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}

/** Callbacks the host (the React hook) wires up to receive engine events. */
export interface TranscriptionEngineCallbacks {
  /**
   * The recognition session actually opened (vendor fired `start`). The host uses this as
   * the authoritative "engine is now running" signal — distinct from the host's own intent.
   */
  onStart: () => void
  /** Live, not-yet-final text for the current utterance. May fire many times per utterance. */
  onInterim: (text: string) => void
  /**
   * A finalized utterance. `startedAtEpoch` is the engine's best estimate of when this
   * utterance began (the first interim's wall-clock); `endedAtEpoch` is finalize time.
   * The host is responsible for enforcing chronological ordering on top of these.
   */
  onFinal: (text: string, startedAtEpoch: number, endedAtEpoch: number) => void
  /** Engine-originated connection signals: 'live' once audio/results flow. */
  onStatus: (status: ConnectionStatus) => void
  /** A recognition error code (Web Speech `SpeechRecognitionErrorCode`, or a generic string). */
  onError: (code: string) => void
  /**
   * The recognition session ended (vendor closed the stream, stop()/abort() completed, or a
   * silence timeout fired). The host decides whether to restart — the engine just reports it.
   */
  onEnd: () => void
  /**
   * Optional one-time model load/download progress (0..1) with a human label. Only an
   * on-device engine that must fetch a model (the Whisper engine) emits this; engines with
   * nothing to download (Web Speech) never call it, so it is optional.
   */
  onProgress?: (progress: number, status: string) => void
}

/**
 * A swappable speech-to-text engine. The locked contract is `start` / `stop` / `reset` /
 * `supported`; events are delivered through the callbacks supplied at construction.
 */
export interface TranscriptionEngine {
  /** Begin recognition. Safe to call only when not already running (host guards this). */
  start(): void
  /** Stop recognition. Fires `onEnd` asynchronously once the vendor closes the stream. */
  stop(): void
  /**
   * Hard reset: synchronously abandon the current session so it can NEVER emit another event
   * (no late onStart/onEnd). Unlike stop(), this does NOT promise an onEnd — the host has
   * already given up on the session. Used to recover a wedged start. A no-op when idle.
   */
  reset(): void
  /** True when this engine can run in the current browser. */
  readonly supported: boolean
}

/** Construction options for {@link WebSpeechEngine}. */
export interface WebSpeechEngineOptions extends TranscriptionEngineCallbacks {
  /** BCP-47 language tag, e.g. "en-US". Applied to the recognizer on each start. */
  lang: string
}

/** Resolve the vendor-prefixed or standard constructor, if this browser has one. */
function resolveCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

/**
 * Web Speech API implementation of {@link TranscriptionEngine}.
 *
 * Configured for continuous dictation (continuous + interimResults). We request up to 3
 * alternatives (`maxAlternatives = 3`) but always commit the recognizer's top-ranked guess
 * (`result[0]`): asking for alternatives nudges Chromium to still RETURN its best hypothesis
 * for unclear / accented / slurred audio instead of withholding a final, and we deliberately
 * never filter by confidence — every non-empty final is committed so the notes keep up with
 * everything heard. Each `start()` builds a fresh recognizer instance: Chromium's recognizer
 * is single-use in practice and reusing one across stop/start cycles is a known source of
 * silent stalls, so we create-and-discard per session. The engine stamps an utterance's
 * start time when its first interim arrives and clears it on finalize.
 */
export class WebSpeechEngine implements TranscriptionEngine {
  readonly supported: boolean

  private readonly opts: WebSpeechEngineOptions
  private readonly ctor: SpeechRecognitionCtor | null
  private recognition: SpeechRecognitionLike | null = null
  /** Wall-clock (ms) of the current utterance's first interim; null between utterances. */
  private utteranceStart: number | null = null

  constructor(opts: WebSpeechEngineOptions) {
    this.opts = opts
    this.ctor = resolveCtor()
    this.supported = this.ctor !== null
  }

  /** Update the recognition language for subsequent sessions (host restarts to apply live). */
  setLang(lang: string): void {
    this.opts.lang = lang
    if (this.recognition) this.recognition.lang = lang
  }

  start(): void {
    if (!this.ctor) return
    // Tear down any previous instance defensively; the host guards against double-start,
    // but we must never leak a live recognizer.
    this.teardown()

    const recognition = new this.ctor()
    recognition.lang = this.opts.lang
    recognition.continuous = true
    recognition.interimResults = true
    // Request 3 alternatives but commit only the top-ranked guess (result[0]) below; this coaxes
    // Chromium into returning its best hypothesis for unclear/accented/slurred audio rather than
    // withholding a final. We never score or filter by confidence.
    recognition.maxAlternatives = 3

    recognition.onstart = () => {
      // Audio is being captured and streamed: signal the session opened and is live.
      this.opts.onStart()
      this.opts.onStatus('live')
    }

    recognition.onresult = (event) => {
      let interim = ''
      // Walk only the results that changed in this event (resultIndex onward). Final results
      // are committed individually; interim text is accumulated and emitted once.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const alternative = result[0]
        const transcript = alternative ? alternative.transcript : ''
        if (result.isFinal) {
          const text = transcript.trim()
          // A final may arrive without our ever having seen an interim for it (Chromium can
          // deliver finals directly, or several at once). Fall back to "now" for the start.
          const startedAt = this.utteranceStart ?? Date.now()
          const endedAt = Date.now()
          this.utteranceStart = null
          if (text !== '') {
            this.opts.onStatus('live')
            this.opts.onFinal(text, startedAt, Math.max(endedAt, startedAt))
          }
        } else {
          interim += transcript
          // Stamp the utterance's start at the first interim we see for it.
          if (this.utteranceStart === null) this.utteranceStart = Date.now()
        }
      }
      const interimText = interim.trim()
      if (interimText !== '') {
        this.opts.onStatus('live')
        this.opts.onInterim(interimText)
      }
    }

    recognition.onerror = (event) => {
      this.opts.onError(event.error)
    }

    recognition.onend = () => {
      this.utteranceStart = null
      this.opts.onEnd()
    }

    this.recognition = recognition
    try {
      recognition.start()
    } catch {
      // start() throws InvalidStateError if a session is somehow already active. Surface it
      // as an end so the host's restart funnel can recover on its own schedule.
      this.opts.onEnd()
    }
  }

  stop(): void {
    if (!this.recognition) return
    try {
      // abort() stops immediately and discards pending results; stop() can hang waiting for a
      // final in some builds. For a clean teardown we want the fast path.
      this.recognition.abort()
    } catch {
      // Ignore: the session may already be closing; onend will still fire.
    }
  }

  /**
   * Hard reset: detach handlers, abort, and DROP the recognizer instance immediately. Unlike
   * stop() (which abort()s but leaves the instance and its handlers wired so onEnd can still
   * fire), reset() guarantees the current instance can never emit another event. The host uses
   * this to recover a WEDGED start — a recognizer that fired neither onstart nor onend (a real
   * Chromium failure mode after network blips / rapid cycles). After reset() the host owns the
   * "is it running" truth outright and can safely start a fresh session with no risk of a late,
   * stale onstart/onend from the abandoned instance corrupting its state.
   */
  reset(): void {
    this.teardown()
  }

  /** Detach handlers and drop the recognizer reference so a stale instance can't emit. */
  private teardown(): void {
    const recognition = this.recognition
    if (!recognition) return
    recognition.onstart = null
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
    this.recognition = null
    this.utteranceStart = null
    try {
      recognition.abort()
    } catch {
      // Ignore: already stopped.
    }
  }
}
