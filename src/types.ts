/**
 * NoteWeave shared domain types — the authoritative contract.
 *
 * Every module and feature imports these; nothing redefines them. If a shape needs
 * to change, change it here so the whole app moves together.
 */

/**
 * A unit of transcribed speech. Interim (live, not yet final) text is held separately
 * on the session as `interimText`; only finalized segments are persisted and formatted.
 */
export interface TranscriptSegment {
  id: string
  /** Finalized transcript text for this segment. */
  text: string
  /** Wall-clock epoch (ms) when speech for this segment began. Used for image alignment. */
  startedAtEpoch: number
  /** Wall-clock epoch (ms) when this segment was finalized. */
  endedAtEpoch: number
  /** Always true for stored segments; interim text never becomes a segment until final. */
  isFinal: boolean
  /** True once a human has manually edited the text. */
  edited: boolean
}

/**
 * A photo a student captured during class and imported afterwards. Audio is never
 * stored; images carry their own capture time so they can be slotted back into the
 * transcript at the moment they were taken.
 */
export interface NoteImage {
  id: string
  /** Original file name, for display and export. */
  name: string
  /** Inlined image data (data: URL) — fully local, survives reload, embeds in exports. */
  dataUrl: string
  /** EXIF capture time (epoch ms) if known; null when the photo has no timestamp. */
  capturedAtEpoch: number | null
  /** Epoch (ms) when the file was imported into NoteWeave. */
  importedAtEpoch: number
  /** Optional human caption shown beneath the image. */
  caption: string
  /** If set, pins the image to a specific segment, overriding time-based alignment. */
  manualAnchorSegmentId: string | null
  /** Natural pixel dimensions, when measurable. */
  width: number | null
  height: number | null
}

/** Lifecycle of the live transcription session. */
export type RecordingStatus = 'idle' | 'recording' | 'paused' | 'stopped'

/** Health of the underlying transcription engine connection. */
export type ConnectionStatus = 'idle' | 'live' | 'reconnecting' | 'offline' | 'error'

/** Editable, human-facing metadata about the class session. */
export interface SessionMeta {
  title: string
  course: string
  instructor: string
  /** Display date label (e.g. "1 June 2026"), not a timestamp. */
  dateLabel: string
  /** Generated or hand-written summary of the session. */
  summary: string
  /** BCP-47 language tag for transcription (e.g. "en-US"). */
  lang: string
}

/** The complete in-memory state of one NoteWeave session. */
export interface SessionState {
  meta: SessionMeta
  status: RecordingStatus
  connection: ConnectionStatus
  /** Epoch (ms) when recording first started this session; null until then. */
  startedAtEpoch: number | null
  /** Epoch (ms) when recording was stopped; null while open. */
  endedAtEpoch: number | null
  /** Finalized segments, kept ordered by startedAtEpoch. */
  segments: TranscriptSegment[]
  /** Live, not-yet-final transcript text (ghost line); never persisted as a segment. */
  interimText: string
  /** Imported photos for this session. */
  images: NoteImage[]
  /**
   * Calibration offset (ms) added to a photo's EXIF capture time to correct camera-clock
   * drift before aligning it to the transcript wall-clock. Positive = camera clock is slow.
   */
  clockOffsetMs: number
}
