/**
 * WhisperEngine — an on-device {@link TranscriptionEngine} backed by an ONNX Whisper model
 * running inside a Web Worker (WebGPU with a wasm fallback, decided in the worker).
 *
 * Unlike WebSpeechEngine, this engine never sends audio off the machine: the microphone PCM
 * is captured here, resampled to 16 kHz mono, and posted to the worker for inference. The
 * engine owns only the audio side — capture, the rolling window, overlap/dedup, and turning
 * worker `result` messages into the TranscriptionEngine callbacks. The worker owns the heavy,
 * UI-blocking work (model load + inference). The wire between them is the frozen protocol in
 * `./protocol.ts`.
 *
 * Why no internal restart/cycling logic (unlike the Web Speech path): Whisper has no
 * vendor-side silent-death. It captures continuously until stop(), so the host never needs to
 * proactively cycle it. The engine just provides clean start/stop/reset and accurate
 * streaming; all reconnection policy still lives in the host hook.
 *
 * Streaming model: raw PCM accumulates in a rolling buffer at the AudioContext's native rate.
 * Roughly every WINDOW_SECONDS of NEW audio we cut a window (the new audio plus ~OVERLAP_SECONDS
 * of the previous window), resample that window once to 16 kHz, and post a single transcribe
 * request. At most ONE transcribe is in flight at a time; audio keeps buffering while we wait,
 * so nothing is lost. On each result we strip the leading words that repeat the tail of the
 * last emitted final (the overlap) and emit the remainder via onFinal.
 */
import type { TranscriptionEngine, TranscriptionEngineCallbacks } from '../engine.ts'
import type { WhisperRequest, WhisperResponse } from './protocol.ts'
import { DEFAULT_DOMAIN_PROMPT, DEFAULT_WHISPER_MODEL } from './protocol.ts'

/**
 * `webkitAudioContext` (Safari/older Chromium) and the AudioWorklet/ScriptProcessor pieces we
 * touch are not all present in lib.dom in a strict-typed way; declare just the missing global
 * constructor so we can resolve it without reaching for `any`.
 */
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

/** Target sample rate Whisper expects: 16 kHz mono. */
const TARGET_SAMPLE_RATE = 16000
/** Seconds of NEW audio to accumulate before cutting and sending a window. */
const WINDOW_SECONDS = 4
/** Seconds of the previous window prepended to each new window so word boundaries survive. */
const OVERLAP_SECONDS = 1.25
/** ScriptProcessor block size (power of two). 4096 frames ≈ 85 ms at 48 kHz — low CPU, low jank. */
const PROCESSOR_BUFFER_SIZE = 4096

/** Construction options for {@link WhisperEngine}. */
export interface WhisperEngineOptions extends TranscriptionEngineCallbacks {
  /** BCP-47 language tag, e.g. "en-IN" / "hi-IN" / "auto". Mapped to a Whisper code per request. */
  lang: string
  /** ONNX model id for the worker to load. Defaults to {@link DEFAULT_WHISPER_MODEL}. */
  model?: string
  /** Decoder prompt biasing domain vocabulary. Defaults to {@link DEFAULT_DOMAIN_PROMPT}. */
  prompt?: string
}

/**
 * Map a BCP-47 language tag to a Whisper language code. Whisper takes the bare language
 * subtag (e.g. 'en', 'hi', 'bn'); we strip any region. 'auto' passes through for detection.
 */
function toWhisperLanguage(lang: string): string {
  if (lang === 'auto' || lang === '') return 'auto'
  const base = lang.split('-')[0]
  return base ? base.toLowerCase() : 'auto'
}

/** Resolve the AudioContext constructor (standard or webkit-prefixed), if this browser has one. */
function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return window.AudioContext ?? window.webkitAudioContext ?? null
}

/**
 * Linear-resample mono Float32 PCM from `inputRate` to {@link TARGET_SAMPLE_RATE}. Run once per
 * window (on the assembled buffer, never per chunk) so there are no boundary clicks or drift.
 * Returns the input unchanged (a copy) when it is already at the target rate.
 */
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input.slice()
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const outLength = Math.max(0, Math.floor(input.length / ratio))
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    output[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return output
}

/**
 * Strip the leading run of `incoming` words that repeats the trailing run of `previous` words,
 * then return the remaining text. This dedupes the ~OVERLAP_SECONDS that each window shares
 * with the last emitted final. Word-level (not byte-level) because Whisper re-decodes the
 * overlap and rarely returns byte-identical text; the match is best-effort, deliberately cheap.
 */
function dedupeOverlap(previous: string, incoming: string): string {
  const incomingWords = incoming.trim().split(/\s+/).filter(Boolean)
  if (incomingWords.length === 0) return ''
  const prevWords = previous.trim().split(/\s+/).filter(Boolean)
  if (prevWords.length === 0) return incomingWords.join(' ')

  const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  // Largest overlap we'll consider, bounded by both strings so we never over-trim.
  const maxOverlap = Math.min(prevWords.length, incomingWords.length)
  for (let k = maxOverlap; k > 0; k -= 1) {
    let matches = true
    for (let j = 0; j < k; j += 1) {
      if (norm(prevWords[prevWords.length - k + j]) !== norm(incomingWords[j])) {
        matches = false
        break
      }
    }
    if (matches) return incomingWords.slice(k).join(' ')
  }
  return incomingWords.join(' ')
}

/**
 * On-device Whisper implementation of {@link TranscriptionEngine}.
 *
 * The worker is kept ALIVE across stop()/start() so the ~150MB model is loaded once; reset()
 * is the only path that terminates it. Because the worker's `ready` message fires only on the
 * first load, a second start() re-signals `onStart`/`onStatus('live')` itself (gated on
 * `modelReady`) rather than waiting for a `ready` that will never come again.
 */
export class WhisperEngine implements TranscriptionEngine {
  readonly supported: boolean

  private readonly opts: WhisperEngineOptions
  private readonly audioCtxCtor: typeof AudioContext | null
  private readonly model: string
  private readonly prompt: string
  private lang: string

  private worker: Worker | null = null
  private modelReady = false
  /** True between a successful start() and stop()/reset(); gates audio + result handling. */
  private running = false

  private mediaStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processorNode: ScriptProcessorNode | null = null

  /** Rolling raw PCM at the AudioContext's native rate, accumulated across onaudioprocess calls. */
  private buffer: Float32Array[] = []
  private bufferedFrames = 0
  /** New (un-sent) frames accumulated since the last window was cut. */
  private newFrames = 0
  /** Native sample rate of the live AudioContext (read back, not assumed). */
  private nativeRate = TARGET_SAMPLE_RATE

  /** Whether a transcribe request is awaiting its result (keeps at most one in flight). */
  private inFlight = false
  private nextRequestId = 1
  /** Text of the most recently emitted final, used to dedupe the next window's overlap. */
  private lastFinalText = ''

  constructor(opts: WhisperEngineOptions) {
    this.opts = opts
    this.lang = opts.lang
    this.model = opts.model ?? DEFAULT_WHISPER_MODEL
    this.prompt = opts.prompt ?? DEFAULT_DOMAIN_PROMPT
    this.audioCtxCtor = resolveAudioContextCtor()
    const hasMedia =
      typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
    const hasWorker = typeof Worker !== 'undefined'
    this.supported = hasMedia && hasWorker && this.audioCtxCtor !== null
  }

  /** Update the language for subsequent transcribe requests (host restarts to apply cleanly). */
  setLang(lang: string): void {
    this.lang = lang
  }

  start(): void {
    if (!this.supported || this.running) return
    this.running = true
    this.resetStreamState()

    // Reuse a warm worker across stop()/start(); only create one if we don't have it yet.
    if (!this.worker) {
      this.modelReady = false
      try {
        this.worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), {
          type: 'module',
        })
      } catch {
        this.running = false
        this.opts.onError('worker-failed')
        this.opts.onEnd()
        return
      }
      this.worker.onmessage = (event: MessageEvent<WhisperResponse>) => {
        this.handleWorkerMessage(event.data)
      }
      this.worker.onerror = () => {
        // A worker-level error (load/parse) is fatal: tear down and report.
        this.opts.onError('worker-error')
        this.teardownAudio()
        this.terminateWorker()
        this.running = false
        this.opts.onEnd()
      }
      this.postToWorker({ type: 'load', model: this.model })
    }

    void this.beginCapture()
  }

  /** Acquire the mic and wire up the audio graph. Errors here surface as onError + onEnd. */
  private async beginCapture(): Promise<void> {
    if (!this.audioCtxCtor) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      // A stop()/reset() may have raced ahead while the permission prompt was open.
      const code = err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'not-allowed'
        : 'audio-capture'
      if (this.running) {
        this.running = false
        this.opts.onError(code)
        this.opts.onEnd()
      }
      return
    }

    // If we were torn down while awaiting permission, release immediately and bail.
    if (!this.running) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    this.mediaStream = stream
    // Ask for 16 kHz directly (Chromium honors it, skipping resample); read back the real rate
    // and resample anyway if it didn't take.
    const audioContext = new this.audioCtxCtor({ sampleRate: TARGET_SAMPLE_RATE })
    this.audioContext = audioContext
    this.nativeRate = audioContext.sampleRate

    const source = audioContext.createMediaStreamSource(stream)
    this.sourceNode = source
    const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 0)
    this.processorNode = processor
    processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!this.running) return
      const channel = ev.inputBuffer.getChannelData(0)
      // Copy: the event buffer is reused by the platform after this callback returns.
      this.buffer.push(channel.slice())
      this.bufferedFrames += channel.length
      this.newFrames += channel.length
      this.maybeSendWindow()
    }
    // Route source -> processor. We requested 0 output channels (createScriptProcessor(..,1,0))
    // so nothing is fed to the speakers (no feedback), but the node must still be connected to
    // the graph to be pulled, so connect it to the destination.
    source.connect(processor)
    processor.connect(audioContext.destination)

    // Retained-worker restart: `ready` already fired on first load and won't fire again, so
    // signal live ourselves once the mic is up and the model is known ready.
    if (this.modelReady) {
      this.opts.onStart()
      this.opts.onStatus('live')
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.teardownAudio()
    // Flush a final pending window only if it is cheap and safe: nothing in flight, and there
    // is buffered audio. If a request is in flight we drop the tail rather than risk an onFinal
    // racing past onEnd (the host has asked us to stop deterministically).
    if (!this.inFlight && this.bufferedFrames > 0) {
      this.sendWindow(true)
    }
    this.resetStreamState()
    this.opts.onEnd()
  }

  /**
   * Hard reset: terminate the worker, stop audio, and drop every reference so a later start()
   * rebuilds everything fresh (model reloads). Unlike stop(), this makes no onEnd promise.
   */
  reset(): void {
    this.running = false
    this.teardownAudio()
    this.terminateWorker()
    this.resetStreamState()
  }

  // ── Worker messages ──────────────────────────────────────────────────────

  private handleWorkerMessage(msg: WhisperResponse): void {
    switch (msg.type) {
      case 'progress':
        this.opts.onProgress?.(msg.progress, msg.status)
        break
      case 'ready':
        this.modelReady = true
        // First load completed. If capture is already live, announce running now.
        if (this.running) {
          this.opts.onStart()
          this.opts.onStatus('live')
        }
        break
      case 'result':
        this.inFlight = false
        // Ignore late results after teardown so we never emit past onEnd.
        if (this.running) this.emitResult(msg.text)
        // A window may have filled while this one was in flight; keep the pipeline moving.
        if (this.running) this.maybeSendWindow()
        break
      case 'error':
        this.opts.onError(msg.message)
        if (msg.fatal) {
          this.teardownAudio()
          this.terminateWorker()
          this.running = false
          this.opts.onEnd()
        }
        break
      default:
        break
    }
  }

  /** Dedupe the overlap against the last final and emit the remainder. */
  private emitResult(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    const deduped = dedupeOverlap(this.lastFinalText, trimmed).trim()
    if (deduped === '') return
    const endedAt = Date.now()
    // Best-estimate start: the window covers ~WINDOW_SECONDS + OVERLAP_SECONDS of audio ending
    // about now. Stamp the start at the window's leading edge so notes anchor sensibly in time.
    const startedAt = endedAt - Math.round((WINDOW_SECONDS + OVERLAP_SECONDS) * 1000)
    this.lastFinalText = trimmed
    this.opts.onStatus('live')
    this.opts.onFinal(deduped, startedAt, Math.max(endedAt, startedAt))
  }

  // ── Windowing ────────────────────────────────────────────────────────────

  /** Send a window once enough NEW audio has accumulated and no request is in flight. */
  private maybeSendWindow(): void {
    if (this.inFlight || !this.running) return
    if (this.newFrames < WINDOW_SECONDS * this.nativeRate) return
    this.sendWindow(false)
  }

  /**
   * Cut a window (overlap + new audio), resample it once to 16 kHz, and post it. When `final`
   * is true (stop-flush) we send whatever is buffered regardless of size and clear the buffer;
   * otherwise we retain ~OVERLAP_SECONDS of tail so the next window has context.
   */
  private sendWindow(final: boolean): void {
    if (!this.worker) return
    const flat = this.flattenBuffer()
    if (flat.length === 0) return

    const overlapFrames = Math.round(OVERLAP_SECONDS * this.nativeRate)
    const resampled = resampleTo16k(flat, this.nativeRate)

    this.inFlight = true
    this.postToWorker(
      {
        type: 'transcribe',
        audio: resampled,
        language: toWhisperLanguage(this.lang),
        prompt: this.prompt,
        requestId: this.nextRequestId++,
      },
      [resampled.buffer],
    )

    if (final) {
      this.buffer = []
      this.bufferedFrames = 0
      this.newFrames = 0
      return
    }
    // Keep only the trailing OVERLAP_SECONDS so the next window starts with shared context.
    if (flat.length > overlapFrames) {
      const tail = flat.subarray(flat.length - overlapFrames)
      this.buffer = [tail.slice()]
      this.bufferedFrames = tail.length
    } else {
      this.buffer = [flat]
      this.bufferedFrames = flat.length
    }
    this.newFrames = 0
  }

  /** Concatenate the rolling buffer chunks into one contiguous Float32Array at the native rate. */
  private flattenBuffer(): Float32Array {
    if (this.buffer.length === 1) return this.buffer[0]
    const out = new Float32Array(this.bufferedFrames)
    let offset = 0
    for (const chunk of this.buffer) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  // ── Teardown helpers ───────────────────────────────────────────────────────

  /** Post a message to the worker, optionally transferring buffers. No-op if no worker. */
  private postToWorker(msg: WhisperRequest, transfer?: Transferable[]): void {
    if (!this.worker) return
    if (transfer) this.worker.postMessage(msg, transfer)
    else this.worker.postMessage(msg)
  }

  /** Stop the mic and tear down the audio graph; leaves the worker untouched. */
  private teardownAudio(): void {
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null
      try {
        this.processorNode.disconnect()
      } catch {
        // Ignore: already disconnected.
      }
      this.processorNode = null
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {
        // Ignore: already disconnected.
      }
      this.sourceNode = null
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop())
      this.mediaStream = null
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {
        // Ignore: closing an already-closed context throws; harmless.
      })
      this.audioContext = null
    }
  }

  /** Detach handlers and terminate the worker so no late message can fire. */
  private terminateWorker(): void {
    if (!this.worker) return
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
    this.worker = null
    this.modelReady = false
  }

  /** Reset the per-session streaming state (buffers, in-flight, dedup) without touching audio. */
  private resetStreamState(): void {
    this.buffer = []
    this.bufferedFrames = 0
    this.newFrames = 0
    this.inFlight = false
    this.lastFinalText = ''
  }
}
