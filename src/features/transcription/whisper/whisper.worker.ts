/**
 * Whisper inference Web Worker.
 *
 * Runs on-device speech-to-text via transformers.js so technical-lecture jargon is
 * transcribed accurately (the browser Web Speech API mishears it badly). All heavy work
 * lives here off the main thread: it owns the singleton ASR pipeline, model download, and
 * sequential per-window inference. It speaks only the frozen protocol in `./protocol.ts`.
 *
 * Engine pattern follows the official Hugging Face "realtime-whisper-webgpu" example:
 * a lazily-created `automatic-speech-recognition` pipeline on `onnx-community/whisper-base`
 * with an fp32 encoder + q4 decoder on WebGPU, falling back to WASM if WebGPU construction
 * fails. transformers.js v4.2.0 API.
 */

import { env, pipeline } from '@huggingface/transformers'
import type {
  AutomaticSpeechRecognitionOutput,
  AutomaticSpeechRecognitionPipeline,
} from '@huggingface/transformers'
import type {
  WhisperErrorMsg,
  WhisperProgressMsg,
  WhisperReadyMsg,
  WhisperRequest,
  WhisperResponse,
  WhisperResultMsg,
  WhisperTranscribeRequest,
} from './protocol.ts'

// Models are fetched from the HF hub and cached by the browser (Cache API), never from
// a same-origin /models/ path. This mirrors the official web examples.
env.allowLocalModels = false

/** The dedicated worker global. Typed minimally so we don't pull in the full DOM `Window`. */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WhisperRequest>) => void) | null
  postMessage: (message: WhisperResponse) => void
}

function post(message: WhisperResponse): void {
  ctx.postMessage(message)
}

/** Singleton pipeline, created lazily on the first 'load' message and reused thereafter. */
let pipe: AutomaticSpeechRecognitionPipeline | null = null
let backend: 'webgpu' | 'wasm' | null = null

/**
 * In-flight load promise. Guards against a second 'load' (or a 'transcribe' that races the
 * load) kicking off a duplicate download / pipeline construction.
 */
let loadPromise: Promise<void> | null = null

/**
 * Serializes transcription. Every transcribe request chains onto this tail so we never run
 * two inferences concurrently (ONNX sessions are single-threaded per pipeline and concurrent
 * calls would corrupt state / spike memory mid-session).
 */
let transcribeChain: Promise<void> = Promise.resolve()

/**
 * Maps a transformers.js file-download progress event to an overall 0..1 fraction.
 *
 * The library reports per-file byte progress; whisper-base ships several ONNX shards plus
 * tokenizer/config files. We track each file's loaded/total and emit the aggregate so the UI
 * shows a single monotonic-ish bar instead of jumping per file.
 */
const fileProgress = new Map<string, { loaded: number; total: number }>()

function reportProgress(status: string): void {
  let loaded = 0
  let total = 0
  for (const f of fileProgress.values()) {
    loaded += f.loaded
    total += f.total
  }
  const progress = total > 0 ? Math.min(loaded / total, 1) : 0
  const msg: WhisperProgressMsg = { type: 'progress', progress, status }
  post(msg)
}

/**
 * Builds the ASR pipeline on a specific device. Kept separate so the WebGPU and WASM paths
 * each construct from scratch with device-appropriate dtypes (we never reuse the fp32-encoder
 * map on WASM, where the q8 default is far smaller and faster).
 */
async function buildPipeline(
  model: string,
  device: 'webgpu' | 'wasm',
): Promise<AutomaticSpeechRecognitionPipeline> {
  // fp32 encoder + q4 decoder is the documented shape for whisper-base on WebGPU; the keys
  // (`encoder_model`, `decoder_model_merged`) must match the model's ONNX filenames or the
  // dtype is silently ignored. On WASM, omit the map and let the q8 default apply.
  const dtype =
    device === 'webgpu'
      ? ({ encoder_model: 'fp32', decoder_model_merged: 'q4' } as const)
      : undefined

  return pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (info) => {
      // Only the 'progress' status carries loaded/total byte counts. 'initiate' / 'download'
      // register the file; 'done' / 'ready' need no per-byte handling here.
      if (info.status === 'initiate' || info.status === 'download') {
        if (!fileProgress.has(info.file)) {
          fileProgress.set(info.file, { loaded: 0, total: 0 })
        }
      } else if (info.status === 'progress') {
        fileProgress.set(info.file, { loaded: info.loaded, total: info.total })
        reportProgress('downloading model')
      } else if (info.status === 'done') {
        const f = fileProgress.get(info.file)
        if (f && f.total > 0) {
          f.loaded = f.total
        }
        reportProgress('downloading model')
      }
    },
  })
}

/**
 * Loads (and warms up) the model exactly once. Tries WebGPU first, falls back to WASM if
 * WebGPU construction throws. Resolves when `pipe` and `backend` are set; throws only if both
 * devices fail (a fatal condition for the engine).
 */
async function load(model: string): Promise<void> {
  if (pipe) return
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      pipe = await buildPipeline(model, 'webgpu')
      backend = 'webgpu'
    } catch {
      // WebGPU unavailable or construction failed: rebuild from scratch on WASM.
      fileProgress.clear()
      reportProgress('falling back to wasm')
      pipe = await buildPipeline(model, 'wasm')
      backend = 'wasm'
    }

    // Tiny warm-up on a short silent buffer so the first real window isn't penalized by JIT /
    // graph compilation. 0.5 s of 16 kHz silence is cheap and never produces useful text.
    try {
      await pipe(new Float32Array(8000), {
        task: 'transcribe',
        return_timestamps: false,
      })
    } catch {
      // A warm-up failure is non-fatal: the model is loaded and real windows can still run.
    }

    const ready: WhisperReadyMsg = {
      type: 'ready',
      backend: backend ?? 'wasm',
    }
    post(ready)
  })()

  try {
    await loadPromise
  } catch (err) {
    // Reset so a future 'load' can retry from a clean slate.
    loadPromise = null
    pipe = null
    backend = null
    throw err
  }
}

/**
 * Runs one window through the pipeline. `prompt` is accepted by the protocol for decoder
 * vocabulary biasing, but transformers.js v4.2.0 exposes no text-prompt option on the ASR
 * pipeline (its `prompt` param is an encoder input Tensor, not biasing text), so we ignore it
 * here rather than pass a no-op key that would fake the feature. Surfaced to the engine owner.
 */
async function transcribe(req: WhisperTranscribeRequest): Promise<void> {
  if (!pipe) {
    const errMsg: WhisperErrorMsg = {
      type: 'error',
      message: 'transcribe received before model was loaded',
      fatal: false,
    }
    post(errMsg)
    return
  }

  try {
    const output = (await pipe(req.audio, {
      // Omit `language` for auto-detection; otherwise pass the Whisper code through.
      language: req.language === 'auto' ? undefined : req.language,
      task: 'transcribe',
      return_timestamps: false,
    })) as AutomaticSpeechRecognitionOutput

    const result: WhisperResultMsg = {
      type: 'result',
      requestId: req.requestId,
      text: output.text.trim(),
    }
    post(result)
  } catch (err) {
    // A single window failing must not stop the session; the engine keeps feeding windows.
    const errMsg: WhisperErrorMsg = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      fatal: false,
    }
    post(errMsg)
  }
}

ctx.onmessage = (event: MessageEvent<WhisperRequest>): void => {
  const data = event.data
  if (data.type === 'load') {
    void load(data.model).catch((err) => {
      // Both WebGPU and WASM construction failed: nothing more this worker can do.
      const errMsg: WhisperErrorMsg = {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      }
      post(errMsg)
    })
  } else {
    // Chain onto the tail so transcriptions run strictly one at a time, in arrival order.
    transcribeChain = transcribeChain.then(() => transcribe(data))
  }
}
