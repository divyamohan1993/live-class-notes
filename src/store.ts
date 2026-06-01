/**
 * NoteWeave session store (Zustand).
 *
 * This is the single source of truth the whole app reads and mutates. It owns the
 * persistence policy that makes a 10-hour class survivable:
 *
 *   - Finalizing / editing / deleting a segment writes ONLY that one segment record
 *     immediately (db.putSegment / db.deleteSegment). We never re-serialize the whole
 *     transcript on every word.
 *   - Metadata, images, the clock offset, and lifecycle timestamps are bundled into one
 *     MetaRecord and written via a DEBOUNCED full meta write (~800ms) so rapid edits
 *     coalesce into a single IndexedDB write.
 *   - Recording start/stop flush meta immediately (lifecycle transitions are worth a
 *     synchronous-ish persist for crash recovery).
 *
 * Crash recovery: hydrate() restores everything from IndexedDB, including the persisted
 * `status`. A session that was 'recording' at crash time returns as 'recording' with
 * `connection` left at its fresh 'idle' default (the engine is not actually running) —
 * the transcription layer owns any "resume recording?" decision off that combination.
 */
import { create } from 'zustand'
import type {
  ConnectionStatus,
  NoteImage,
  SessionMeta,
  SessionState,
  TranscriptSegment,
} from './types.ts'
import * as db from './lib/db.ts'
import type { MetaRecord } from './lib/db.ts'
import { newId } from './lib/id.ts'
import { formatDateLabel } from './lib/time.ts'

/** Imperative actions exposed on the store. Feature agents depend on these signatures. */
export interface SessionActions {
  startRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => void
  setConnection: (c: ConnectionStatus) => void
  setInterim: (text: string) => void
  commitSegment: (text: string, startedAtEpoch: number, endedAtEpoch: number) => void
  editSegment: (id: string, text: string) => void
  deleteSegment: (id: string) => void
  addImage: (img: NoteImage) => void
  updateImage: (id: string, patch: Partial<NoteImage>) => void
  removeImage: (id: string) => void
  setMeta: (patch: Partial<SessionMeta>) => void
  setClockOffsetMs: (ms: number) => void
  hydrate: () => Promise<void>
  resetSession: () => Promise<void>
  /**
   * Flush any pending debounced meta write to IndexedDB right now. Wire this to
   * `pagehide` / `visibilitychange` so the last sub-second of title/image/offset edits
   * survive a hard close. Safe to call anytime; a no-op when nothing is pending.
   */
  flushMeta: () => Promise<void>
}

export type SessionStore = SessionState & SessionActions

function defaultMeta(): SessionMeta {
  return {
    title: 'Untitled Class Notes',
    course: '',
    instructor: '',
    dateLabel: formatDateLabel(Date.now()),
    summary: '',
    lang: 'en-US',
  }
}

function freshState(): SessionState {
  return {
    meta: defaultMeta(),
    status: 'idle',
    connection: 'idle',
    startedAtEpoch: null,
    endedAtEpoch: null,
    segments: [],
    interimText: '',
    images: [],
    clockOffsetMs: 0,
  }
}

const PERSIST_DEBOUNCE_MS = 800

/**
 * Module-scoped debounce for the bundled meta write. There is exactly one store, so a
 * single timer is sufficient. At flush time we read the freshest state from the store,
 * so coalesced edits always persist the latest snapshot.
 */
let metaTimer: ReturnType<typeof setTimeout> | null = null
let getStoreState: (() => SessionState) | null = null

function snapshotMeta(state: SessionState): MetaRecord {
  return {
    meta: state.meta,
    images: state.images,
    clockOffsetMs: state.clockOffsetMs,
    startedAtEpoch: state.startedAtEpoch,
    endedAtEpoch: state.endedAtEpoch,
    status: state.status,
  }
}

function cancelPendingMeta(): void {
  if (metaTimer != null) {
    clearTimeout(metaTimer)
    metaTimer = null
  }
}

/** Persist the current meta snapshot immediately (used by lifecycle + explicit flush). */
async function persistMetaNow(): Promise<void> {
  cancelPendingMeta()
  if (!getStoreState) return
  await db.putMeta(snapshotMeta(getStoreState()))
}

/** Queue a debounced meta write; rapid edits coalesce into one persist. */
function persistMetaDebounced(): void {
  cancelPendingMeta()
  metaTimer = setTimeout(() => {
    metaTimer = null
    if (!getStoreState) return
    void db.putMeta(snapshotMeta(getStoreState()))
  }, PERSIST_DEBOUNCE_MS)
}

export const useSession = create<SessionStore>()((set, get) => {
  // Allow the persistence helpers to read the latest state without capturing a stale ref.
  getStoreState = get

  return {
    ...freshState(),

    startRecording: () => {
      set((s) => ({
        startedAtEpoch: s.startedAtEpoch ?? Date.now(),
        status: 'recording',
        connection: 'live',
      }))
      void persistMetaNow()
    },

    pauseRecording: () => set({ status: 'paused' }),

    resumeRecording: () => set({ status: 'recording' }),

    stopRecording: () => {
      set({ status: 'stopped', endedAtEpoch: Date.now(), connection: 'idle' })
      void persistMetaNow()
    },

    setConnection: (c) => set({ connection: c }),

    setInterim: (text) => set({ interimText: text }),

    commitSegment: (text, startedAtEpoch, endedAtEpoch) => {
      const seg: TranscriptSegment = {
        id: newId(),
        text,
        startedAtEpoch,
        endedAtEpoch,
        isFinal: true,
        edited: false,
      }
      set((s) => ({ segments: [...s.segments, seg], interimText: '' }))
      void db.putSegment(seg)
    },

    editSegment: (id, text) => {
      let updated: TranscriptSegment | null = null
      set((s) => ({
        segments: s.segments.map((seg) => {
          if (seg.id !== id) return seg
          updated = { ...seg, text, edited: true }
          return updated
        }),
      }))
      if (updated) void db.putSegment(updated)
    },

    deleteSegment: (id) => {
      set((s) => ({ segments: s.segments.filter((seg) => seg.id !== id) }))
      void db.deleteSegment(id)
    },

    addImage: (img) => {
      set((s) => ({ images: [...s.images, img] }))
      persistMetaDebounced()
    },

    updateImage: (id, patch) => {
      set((s) => ({
        images: s.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
      }))
      persistMetaDebounced()
    },

    removeImage: (id) => {
      set((s) => ({ images: s.images.filter((img) => img.id !== id) }))
      persistMetaDebounced()
    },

    setMeta: (patch) => {
      set((s) => ({ meta: { ...s.meta, ...patch } }))
      persistMetaDebounced()
    },

    setClockOffsetMs: (ms) => {
      set({ clockOffsetMs: ms })
      persistMetaDebounced()
    },

    hydrate: async () => {
      const { segments, meta } = await db.loadAll()
      // Do NOT schedule a debounced write here; hydration must not dirty the DB.
      set(() => {
        const base = freshState()
        const next: SessionState = {
          ...base,
          // Segments arrive sorted by startedAtEpoch from the byTime index; keep order.
          segments,
        }
        if (meta) {
          next.meta = meta.meta
          next.images = meta.images
          next.clockOffsetMs = meta.clockOffsetMs
          next.startedAtEpoch = meta.startedAtEpoch
          next.endedAtEpoch = meta.endedAtEpoch
          next.status = meta.status
          // `connection` intentionally stays at its fresh 'idle' default: on reload the
          // transcription engine is not running, whatever the session was doing.
        }
        return next
      })
    },

    resetSession: async () => {
      // Cancel any queued meta write so it can't resurrect data into the cleared store.
      cancelPendingMeta()
      await db.clearAll()
      set(() => freshState())
    },

    flushMeta: async () => {
      await persistMetaNow()
    },
  }
})
