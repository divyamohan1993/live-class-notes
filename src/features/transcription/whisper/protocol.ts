/**
 * Message protocol between WhisperEngine (main thread) and the inference Web Worker.
 *
 * The worker owns the heavy, blocking work (loading the ONNX Whisper model and running
 * transcription) so it never janks the UI during a multi-hour session. The engine owns
 * audio capture, chunking, and turning raw worker results into the TranscriptionEngine
 * callbacks the rest of the app already understands.
 *
 * This file is the FROZEN contract: the worker and the engine are built against it
 * independently. Keep both sides in sync only through these types.
 */

/** Default model: multilingual Whisper-base in ONNX form, WebGPU-capable, ~150MB on first load.
 *  Multilingual (not base.en) so Hindi / Hinglish and other Indian-language sessions work; the
 *  active language is passed per-transcribe from the existing language selector. */
export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-base'

/**
 * A domain-vocabulary prompt fed to Whisper's decoder to bias recognition toward technical
 * terms it would otherwise mishear (the whole reason we moved off browser STT). Whisper uses
 * the *preceding* text as context, so a sentence seeded with the right jargon nudges spelling.
 * Kept broad-academic with an optimization lean; the engine may append a per-session hint.
 */
export const DEFAULT_DOMAIN_PROMPT =
  'Lecture on mathematics and optimization. Terms: theorem, lemma, polytope, polyhedron, ' +
  'convex, facet, vertex, hyperplane, valid inequality, integer programming, linear program, ' +
  'LP relaxation, duality, polar duality, extreme point, gradient, Lagrangian, constraint, ' +
  'objective, feasible, simplex, branch and bound, eigenvalue, matrix, subgradient.'

/** main -> worker: load (and warm up) the model. */
export interface WhisperLoadRequest {
  type: 'load'
  model: string
}

/** main -> worker: transcribe one window of 16 kHz mono PCM. */
export interface WhisperTranscribeRequest {
  type: 'transcribe'
  /** 16 kHz, mono, float32 PCM in [-1, 1] for the window to transcribe. */
  audio: Float32Array
  /** Whisper language code (e.g. 'en', 'hi') or 'auto' for detection. */
  language: string
  /** Decoder prompt to bias domain vocabulary; '' for none. */
  prompt: string
  /** Monotonic id echoed back on the result so the engine can correlate windows. */
  requestId: number
}

export type WhisperRequest = WhisperLoadRequest | WhisperTranscribeRequest

/** worker -> main: model download / warm-up progress (0..1). */
export interface WhisperProgressMsg {
  type: 'progress'
  progress: number
  status: string
}

/** worker -> main: model is loaded and the first inference is ready to run. */
export interface WhisperReadyMsg {
  type: 'ready'
  backend: 'webgpu' | 'wasm'
}

/** worker -> main: a finished transcription for the window with `requestId`. */
export interface WhisperResultMsg {
  type: 'result'
  requestId: number
  text: string
}

/** worker -> main: an error. `fatal` true means the engine should stop and surface it. */
export interface WhisperErrorMsg {
  type: 'error'
  message: string
  fatal: boolean
}

export type WhisperResponse =
  | WhisperProgressMsg
  | WhisperReadyMsg
  | WhisperResultMsg
  | WhisperErrorMsg
