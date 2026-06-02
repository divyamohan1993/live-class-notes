/**
 * enginePref — a tiny persisted store for which speech-to-text engine the user has chosen.
 *
 * Two engines exist (see engine.ts and whisper/whisperEngine.ts): the browser's Web Speech API
 * (fast, needs internet, Chromium-only, audio leaves the machine) and the on-device Whisper
 * engine (private, accurate, downloads a ~150MB model once). The choice is a UI preference, not
 * session data, so it lives here rather than in the durable useSession store, and it persists in
 * localStorage so it survives reloads.
 *
 * Default is 'web-speech' so existing users see no behavior change. useSpeechRecognition reads
 * this and rebuilds the engine when it changes; LiveTranscriber owns the picker that writes it.
 */
import { create } from 'zustand'

/** The two transcription engines a user can pick between. */
export type EngineKind = 'web-speech' | 'whisper'

/** localStorage key for the persisted engine choice. */
const STORAGE_KEY = 'noteweave.engine'

interface EnginePrefState {
  /** The currently selected engine. */
  engine: EngineKind
  /** Switch engines and persist the choice. */
  setEngine: (engine: EngineKind) => void
}

/**
 * Read the persisted choice, guarded for SSR and private-mode (where localStorage access can
 * throw). Anything but a known value falls back to the safe default.
 */
function readStoredEngine(): EngineKind {
  try {
    if (typeof localStorage === 'undefined') return 'web-speech'
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'whisper' ? 'whisper' : 'web-speech'
  } catch {
    return 'web-speech'
  }
}

/** Persist the choice, swallowing failures (private mode / disabled storage). */
function writeStoredEngine(engine: EngineKind): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, engine)
  } catch {
    // Ignore: a failed persist still leaves the in-memory choice correct for this session.
  }
}

export const useEnginePref = create<EnginePrefState>()((set) => ({
  engine: readStoredEngine(),
  setEngine: (engine) => {
    writeStoredEngine(engine)
    set({ engine })
  },
}))
