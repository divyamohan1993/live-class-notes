/**
 * NoteWeave persistence layer (IndexedDB via `idb`).
 *
 * Endurance is the whole point: a class can run 10+ hours and nothing the student hears
 * may ever be lost. Persistence is therefore INCREMENTAL — finalizing, editing, or
 * deleting a single segment writes only that one record (`putSegment` / `deleteSegment`).
 * Session metadata, imported images, and the clock offset are bundled into a single
 * `MetaRecord` written via a debounced full meta write (`putMeta`) so we never
 * re-serialize the entire transcript per word.
 *
 * Durability guarantees this module provides:
 *   - All writes are SERIALIZED through one internal promise chain, so concurrent
 *     putSegment / putMeta / archive calls can never race, interleave, or drop a record.
 *   - Each write is retried a couple of times with short backoff on transient failure.
 *   - QuotaExceededError is handled gracefully: we do NOT retry (free space will not
 *     appear by waiting) and the write functions swallow it so an awaited flush on
 *     pagehide can never crash. The line is still safe in the in-memory store; only the
 *     on-disk copy is missing. There is no SessionState flag to surface this (the state
 *     shape is frozen), so this comment is the only signal — an accepted MVP tradeoff.
 *   - Reads tolerate an empty/fresh/corrupt database and never throw; a corrupt meta
 *     record degrades to "no meta" while segments still load.
 *
 * Schema (database "noteweave", version 2):
 *   - object store "segments", keyPath "id", index "byTime" on "startedAtEpoch"
 *   - object store "meta", single record under the fixed key "current"
 *   - object store "archive", keyPath "id", index "byCreated" on "createdAtEpoch"
 *     (added in v2; the v1→v2 upgrade is purely additive and preserves all prior data)
 *
 * No audio is ever stored.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  NoteImage,
  RecordingStatus,
  SessionMeta,
  TranscriptSegment,
} from '../types.ts'

/** The bundled, debounce-persisted session record (everything except segments). */
export interface MetaRecord {
  meta: SessionMeta
  images: NoteImage[]
  clockOffsetMs: number
  startedAtEpoch: number | null
  endedAtEpoch: number | null
  status: RecordingStatus
}

/**
 * A complete, permanent snapshot of one finished (or set-aside) session, stored in the
 * `archive` store. Self-contained: it carries its own segments and meta so it can be
 * restored later with zero dependence on whatever the "current" record then holds.
 * `status` round-trips so a restored session resumes in the exact lifecycle state it
 * was archived in.
 */
export interface ArchivedSession {
  id: string
  meta: SessionMeta
  segments: TranscriptSegment[]
  images: NoteImage[]
  clockOffsetMs: number
  startedAtEpoch: number | null
  endedAtEpoch: number | null
  status: RecordingStatus
  /** When this snapshot was archived (epoch ms). Stable sort key, newest first. */
  createdAtEpoch: number
}

const DB_NAME = 'noteweave'
const DB_VERSION = 2
const SEGMENTS_STORE = 'segments'
const META_STORE = 'meta'
const ARCHIVE_STORE = 'archive'
const META_KEY = 'current' as const

const WRITE_RETRIES = 2
const RETRY_BASE_DELAY_MS = 60

interface NoteWeaveDB extends DBSchema {
  segments: {
    key: string
    value: TranscriptSegment
    indexes: { byTime: number }
  }
  meta: {
    key: string
    value: MetaRecord
  }
  archive: {
    key: string
    value: ArchivedSession
    indexes: { byCreated: number }
  }
}

let dbPromise: Promise<IDBPDatabase<NoteWeaveDB>> | null = null

function getDB(): Promise<IDBPDatabase<NoteWeaveDB>> {
  if (!dbPromise) {
    const opening = openDB<NoteWeaveDB>(DB_NAME, DB_VERSION, {
      // Additive, idempotent upgrade. Each store is created only if absent, so a fresh
      // install (no prior version) and a v1→v2 upgrade follow the same safe path and the
      // existing "segments"/"meta" stores and their data are never touched.
      upgrade(database) {
        if (!database.objectStoreNames.contains(SEGMENTS_STORE)) {
          const segments = database.createObjectStore(SEGMENTS_STORE, {
            keyPath: 'id',
          })
          segments.createIndex('byTime', 'startedAtEpoch')
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE)
        }
        if (!database.objectStoreNames.contains(ARCHIVE_STORE)) {
          const archive = database.createObjectStore(ARCHIVE_STORE, {
            keyPath: 'id',
          })
          archive.createIndex('byCreated', 'createdAtEpoch')
        }
      },
    })
    // Never cache a rejected open: a one-off open failure must not permanently poison
    // every read/write. On failure, drop the memo so the next call (including a retry)
    // re-attempts opening the database.
    opening.catch(() => {
      dbPromise = null
    })
    dbPromise = opening
  }
  return dbPromise
}

/** True for a DOMException signalling the storage quota is exhausted. */
function isQuotaExceeded(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' ||
      // Firefox legacy alias.
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Serialized write chain. There is exactly one database, so a single chain is enough to
 * guarantee writes commit in submission order and never overlap. The chain is kept from
 * ever staying rejected (each link recovers in both `.then` branches) so one failed write
 * cannot poison every subsequent write.
 */
let writeChain: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  // Run `op` after the previous link settles, regardless of whether it resolved/rejected.
  const result = writeChain.then(op, op)
  // Advance the chain with a link that can never be rejected.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Run a write with bounded retries and short backoff for transient IndexedDB failures
 * (e.g. a momentarily aborted transaction). QuotaExceeded is rethrown immediately —
 * waiting will not free space — and is the caller's job to swallow.
 */
async function withRetry<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (isQuotaExceeded(err)) throw err
      lastErr = err
      if (attempt < WRITE_RETRIES) {
        await delay(RETRY_BASE_DELAY_MS * (attempt + 1))
      }
    }
  }
  throw lastErr
}

/**
 * Enqueue a durable write: serialized, retried on transient errors, and quota-safe.
 * QuotaExceeded resolves to `void` (degrade, never crash an awaited flush); any other
 * exhausted-retry error also resolves to `void` so the public write API never rejects and
 * a `void`-fired call can't raise an unhandled rejection. The in-memory store remains the
 * source of truth when a disk write is dropped this way.
 */
function durableWrite(op: () => Promise<void>): Promise<void> {
  return enqueueWrite(() => withRetry(op)).then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Load the full persisted "current" session: all segments (sorted ascending by
 * startedAtEpoch) and the meta record. Each part is read in its own try/catch so a
 * corrupt or unreadable meta record degrades to `null` while segments still load — and
 * vice versa. Never throws.
 */
export async function loadAll(): Promise<{
  segments: TranscriptSegment[]
  meta: MetaRecord | null
}> {
  let database: IDBPDatabase<NoteWeaveDB>
  try {
    database = await getDB()
  } catch {
    // The database itself could not be opened: nothing is recoverable this load.
    return { segments: [], meta: null }
  }

  let segments: TranscriptSegment[] = []
  try {
    // Reading via the byTime index returns segments already ordered by startedAtEpoch.
    segments = await database.getAllFromIndex(SEGMENTS_STORE, 'byTime')
  } catch {
    segments = []
  }

  let meta: MetaRecord | null = null
  try {
    const raw = (await database.get(META_STORE, META_KEY)) ?? null
    meta = isValidMeta(raw) ? raw : null
  } catch {
    meta = null
  }

  return { segments, meta }
}

/** Structural guard: a truthy-but-malformed meta record must degrade to defaults, not poison state. */
function isValidMeta(value: unknown): value is MetaRecord {
  if (typeof value !== 'object' || value === null) return false
  const rec = value as Partial<MetaRecord>
  return (
    typeof rec.meta === 'object' &&
    rec.meta !== null &&
    typeof (rec.meta as SessionMeta).title === 'string' &&
    Array.isArray(rec.images)
  )
}

/** Persist (insert or replace) a single finalized segment. Serialized, retried, quota-safe. */
export function putSegment(seg: TranscriptSegment): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    await db.put(SEGMENTS_STORE, seg)
  })
}

/** Delete a single segment by id. Serialized, retried, quota-safe. */
export function deleteSegment(id: string): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    await db.delete(SEGMENTS_STORE, id)
  })
}

/** Persist the bundled meta record (session meta, images, offset, timestamps, status). */
export function putMeta(rec: MetaRecord): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    await db.put(META_STORE, rec, META_KEY)
  })
}

/**
 * Atomically replace the entire "current" session in a single readwrite transaction:
 * clear `segments` + `meta`, then write the supplied segments and meta. Used when
 * restoring an archived session so the restored transcript can never interleave with the
 * outgoing session's leftover segment records. Serialized and retried like every write.
 */
export function replaceCurrent(
  segments: TranscriptSegment[],
  meta: MetaRecord,
): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    const tx = db.transaction([SEGMENTS_STORE, META_STORE], 'readwrite')
    const segStore = tx.objectStore(SEGMENTS_STORE)
    const metaStore = tx.objectStore(META_STORE)
    await segStore.clear()
    await metaStore.clear()
    for (const seg of segments) {
      await segStore.put(seg)
    }
    await metaStore.put(meta, META_KEY)
    await tx.done
  })
}

/**
 * Wipe the "current" session (segments + meta) for a fresh start. The permanent `archive`
 * store is intentionally NOT cleared here: resetSession() relies on that so starting a new
 * note never destroys an archived one.
 */
export function clearAll(): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    const tx = db.transaction([SEGMENTS_STORE, META_STORE], 'readwrite')
    await Promise.all([
      tx.objectStore(SEGMENTS_STORE).clear(),
      tx.objectStore(META_STORE).clear(),
      tx.done,
    ])
  })
}

/** Persist a full session snapshot into the permanent archive. Serialized, retried, quota-safe. */
export function putArchivedSession(snapshot: ArchivedSession): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    await db.put(ARCHIVE_STORE, snapshot)
  })
}

/**
 * All archived snapshots, newest first (createdAtEpoch descending). Reads via the
 * `byCreated` index, then reverses, so ordering is index-driven rather than a manual sort.
 * Returns [] if the archive is empty or unreadable; never throws.
 *
 * Note: this deserializes every snapshot, including image data, even though callers
 * typically only need summaries. Acceptable for the MVP's session counts; if very many
 * long sessions are expected a denormalized summary store would be the proper fix.
 */
export async function getAllArchivedSessions(): Promise<ArchivedSession[]> {
  try {
    const db = await getDB()
    const all = await db.getAllFromIndex(ARCHIVE_STORE, 'byCreated')
    return all.reverse()
  } catch {
    return []
  }
}

/** A single archived snapshot by id, or null if absent/unreadable. Never throws. */
export async function getArchivedSession(
  id: string,
): Promise<ArchivedSession | null> {
  try {
    const db = await getDB()
    return (await db.get(ARCHIVE_STORE, id)) ?? null
  } catch {
    return null
  }
}

/** Remove one snapshot from the permanent archive. Serialized, retried, quota-safe. */
export function deleteArchivedSession(id: string): Promise<void> {
  return durableWrite(async () => {
    const db = await getDB()
    await db.delete(ARCHIVE_STORE, id)
  })
}
