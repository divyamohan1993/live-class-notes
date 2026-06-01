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
  ArchivedSessionSummary,
  ConnectionStatus,
  NoteImage,
  SessionMeta,
  SessionState,
  TranscriptSegment,
} from './types.ts'
import * as db from './lib/db.ts'
import type { ArchivedSession, MetaRecord } from './lib/db.ts'
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
  /**
   * Snapshot the current session into the permanent archive and return its archive id.
   * Returns null when there is nothing worth keeping (no segments and no images). Flushes
   * any pending meta first so the snapshot is current. Calling it twice on an unchanged
   * session does not create a duplicate — the existing archive id is returned instead.
   */
  archiveCurrentSession: () => Promise<string | null>
  /** All archived sessions as lightweight summaries, newest first. */
  listArchivedSessions: () => Promise<ArchivedSessionSummary[]>
  /**
   * Restore an archived session into the current workspace. The outgoing current session
   * is archived first (so it is never lost), then the chosen snapshot becomes the live
   * session and is persisted as the 'current' record, atomically replacing it. A no-op if
   * the id is unknown.
   */
  loadArchivedSession: (id: string) => Promise<void>
  /** Permanently remove one archived session. */
  deleteArchivedSession: (id: string) => Promise<void>
}

export type SessionStore = SessionState & SessionActions

function defaultMeta(): SessionMeta {
  return {
    title: 'Untitled Class Notes',
    course: '',
    instructor: '',
    dateLabel: formatDateLabel(Date.now()),
    summary: '',
    lang: 'en-IN',
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

/**
 * Monotonic mutation counter + the (counter, id) of the session most recently archived,
 * used to suppress duplicate archives WITHOUT ever skipping a real change.
 *
 * `mutationSeq` is bumped by every mutator that changes persisted content (segments,
 * images, meta, clock offset). `archiveCurrent` skips writing only when `mutationSeq`
 * still equals `lastArchivedSeq` — i.e. nothing changed since the last archive. This is
 * O(1) and cannot have false negatives: a content signature based on counts/title would
 * miss an in-place segment edit (same length, same ids, same title) and then a following
 * resetSession/replaceCurrent would destroy that edit. The counter closes that hole.
 *
 * `lastArchivedSeq`/`lastArchivedId` are set after a successful archive AND after
 * restoring a snapshot (a freshly loaded session already exists in the archive, so an
 * immediate New session must reuse `lastArchivedId` rather than duplicate it).
 */
let mutationSeq = 0
let lastArchivedSeq = -1
let lastArchivedId: string | null = null

/** Record that persisted content changed, so the next archive is not deduped away. */
function markDirty(): void {
  mutationSeq++
}

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

/** Build a complete, self-contained archive snapshot from the current state. */
function snapshotSession(state: SessionState, id: string): ArchivedSession {
  return {
    id,
    meta: state.meta,
    segments: state.segments,
    images: state.images,
    clockOffsetMs: state.clockOffsetMs,
    startedAtEpoch: state.startedAtEpoch,
    endedAtEpoch: state.endedAtEpoch,
    status: state.status,
    createdAtEpoch: Date.now(),
  }
}

/** Project a stored snapshot down to the list-ready summary the session picker consumes. */
function toSummary(snap: ArchivedSession): ArchivedSessionSummary {
  return {
    id: snap.id,
    title: snap.meta.title,
    dateLabel: snap.meta.dateLabel,
    segmentCount: snap.segments.length,
    imageCount: snap.images.length,
    createdAtEpoch: snap.createdAtEpoch,
    endedAtEpoch: snap.endedAtEpoch,
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

  /**
   * Snapshot the current session into the archive unless it is empty or unchanged since
   * the last archive. Shared by archiveCurrentSession (public), resetSession, and
   * loadArchivedSession so all three apply identical "never lose, never duplicate" rules.
   * Returns the archive id used, or null when nothing was kept.
   */
  const archiveCurrent = async (): Promise<string | null> => {
    // Capture the latest edits first so the snapshot is faithful.
    await persistMetaNow()
    const state = get()
    if (state.segments.length === 0 && state.images.length === 0) return null

    // Nothing changed since the last archive (e.g. New session immediately after a load,
    // or two archive calls in a row): the session is already preserved, so reuse its id
    // rather than writing a duplicate. Any real mutation has bumped mutationSeq past
    // lastArchivedSeq, so an edit can never be deduped away.
    if (mutationSeq === lastArchivedSeq && lastArchivedId != null) return lastArchivedId

    // Pin the sequence we are about to persist BEFORE awaiting, so a concurrent mutation
    // during the write bumps mutationSeq beyond it and is not lost to a later dedup.
    const seqAtSnapshot = mutationSeq
    const id = newId()
    await db.putArchivedSession(snapshotSession(state, id))
    lastArchivedSeq = seqAtSnapshot
    lastArchivedId = id
    return id
  }

  return {
    ...freshState(),

    startRecording: () => {
      set((s) => ({
        startedAtEpoch: s.startedAtEpoch ?? Date.now(),
        status: 'recording',
        connection: 'live',
      }))
      markDirty()
      void persistMetaNow()
    },

    pauseRecording: () => set({ status: 'paused' }),

    resumeRecording: () => set({ status: 'recording' }),

    stopRecording: () => {
      set({ status: 'stopped', endedAtEpoch: Date.now(), connection: 'idle' })
      markDirty()
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
      markDirty()
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
      if (updated) {
        markDirty()
        void db.putSegment(updated)
      }
    },

    deleteSegment: (id) => {
      set((s) => ({ segments: s.segments.filter((seg) => seg.id !== id) }))
      markDirty()
      void db.deleteSegment(id)
    },

    addImage: (img) => {
      set((s) => ({ images: [...s.images, img] }))
      markDirty()
      persistMetaDebounced()
    },

    updateImage: (id, patch) => {
      set((s) => ({
        images: s.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
      }))
      markDirty()
      persistMetaDebounced()
    },

    removeImage: (id) => {
      set((s) => ({ images: s.images.filter((img) => img.id !== id) }))
      markDirty()
      persistMetaDebounced()
    },

    setMeta: (patch) => {
      set((s) => ({ meta: { ...s.meta, ...patch } }))
      markDirty()
      persistMetaDebounced()
    },

    setClockOffsetMs: (ms) => {
      set({ clockOffsetMs: ms })
      markDirty()
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
      // Preserve the outgoing session permanently BEFORE clearing, so "New session" can
      // never destroy prior work. archiveCurrent() flushes pending meta itself.
      await archiveCurrent()
      // Cancel any queued meta write so it can't resurrect data into the cleared store.
      cancelPendingMeta()
      await db.clearAll()
      // The new blank session has not been archived; reset the dedup guard so its first
      // real content can be archived later.
      lastArchivedSeq = -1
      lastArchivedId = null
      set(() => freshState())
    },

    flushMeta: async () => {
      await persistMetaNow()
    },

    archiveCurrentSession: async () => {
      return archiveCurrent()
    },

    listArchivedSessions: async () => {
      const all = await db.getAllArchivedSessions()
      return all.map(toSummary)
    },

    loadArchivedSession: async (id) => {
      // Never lose the session currently open: archive it first.
      await archiveCurrent()
      const snap = await db.getArchivedSession(id)
      if (!snap) return

      // Cancel any debounced meta write queued against the outgoing session so it can't
      // land on top of the restored one.
      cancelPendingMeta()

      const meta: MetaRecord = {
        meta: snap.meta,
        images: snap.images,
        clockOffsetMs: snap.clockOffsetMs,
        startedAtEpoch: snap.startedAtEpoch,
        endedAtEpoch: snap.endedAtEpoch,
        status: snap.status,
      }
      // Atomically swap the persisted 'current' record to the restored snapshot so the
      // outgoing session's segments can never interleave with the restored ones.
      await db.replaceCurrent(snap.segments, meta)

      set(() => {
        const base = freshState()
        const next: SessionState = {
          ...base,
          meta: snap.meta,
          // Snapshots are stored already ordered by startedAtEpoch.
          segments: snap.segments,
          images: snap.images,
          clockOffsetMs: snap.clockOffsetMs,
          startedAtEpoch: snap.startedAtEpoch,
          endedAtEpoch: snap.endedAtEpoch,
          status: snap.status,
          // `connection` stays at its fresh 'idle' default: restoring a session does not
          // start the transcription engine.
        }
        return next
      })

      // The freshly loaded session already exists in the archive under `id`; mark it as
      // archived at the current mutationSeq so an immediate New session does not write a
      // duplicate, while any subsequent edit (which bumps mutationSeq) still re-archives.
      lastArchivedSeq = mutationSeq
      lastArchivedId = id
    },

    deleteArchivedSession: async (id) => {
      await db.deleteArchivedSession(id)
      // If we just deleted the snapshot the dedup guard points at, drop the guard so a
      // later New session re-archives the (now un-backed) current session.
      if (lastArchivedId === id) {
        lastArchivedSeq = -1
        lastArchivedId = null
      }
    },
  }
})
