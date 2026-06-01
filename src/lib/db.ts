/**
 * NoteWeave persistence layer (IndexedDB via `idb`).
 *
 * Endurance is the whole point: a class can run 10+ hours. Persistence is therefore
 * INCREMENTAL — finalizing, editing, or deleting a single segment writes only that one
 * record (`putSegment` / `deleteSegment`). Session metadata, imported images, and the
 * clock offset are bundled into a single `MetaRecord` written via a debounced full meta
 * write (`putMeta`) so we never re-serialize the entire transcript per word.
 *
 * Schema (database "noteweave", version 1):
 *   - object store "segments", keyPath "id", index "byTime" on "startedAtEpoch"
 *   - object store "meta", single record under the fixed key "current"
 *
 * No audio is ever stored. Reads tolerate an empty/fresh database and never throw.
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

const DB_NAME = 'noteweave'
const DB_VERSION = 1
const SEGMENTS_STORE = 'segments'
const META_STORE = 'meta'
const META_KEY = 'current' as const

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
}

let dbPromise: Promise<IDBPDatabase<NoteWeaveDB>> | null = null

function getDB(): Promise<IDBPDatabase<NoteWeaveDB>> {
  if (!dbPromise) {
    dbPromise = openDB<NoteWeaveDB>(DB_NAME, DB_VERSION, {
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
      },
    })
  }
  return dbPromise
}

/**
 * Load the full persisted session: all segments (sorted ascending by startedAtEpoch)
 * and the meta record (null when none has been written yet). Returns empty results
 * rather than throwing if the database is fresh or unreadable.
 */
export async function loadAll(): Promise<{
  segments: TranscriptSegment[]
  meta: MetaRecord | null
}> {
  try {
    const db = await getDB()
    // Reading via the byTime index returns segments already ordered by startedAtEpoch.
    const segments = await db.getAllFromIndex(SEGMENTS_STORE, 'byTime')
    const meta = (await db.get(META_STORE, META_KEY)) ?? null
    return { segments, meta }
  } catch {
    return { segments: [], meta: null }
  }
}

/** Persist (insert or replace) a single finalized segment. */
export async function putSegment(seg: TranscriptSegment): Promise<void> {
  const db = await getDB()
  await db.put(SEGMENTS_STORE, seg)
}

/** Delete a single segment by id. */
export async function deleteSegment(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(SEGMENTS_STORE, id)
}

/** Persist the bundled meta record (session meta, images, offset, timestamps, status). */
export async function putMeta(rec: MetaRecord): Promise<void> {
  const db = await getDB()
  await db.put(META_STORE, rec, META_KEY)
}

/** Wipe all persisted data for a fresh session (factory reset / new note). */
export async function clearAll(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([SEGMENTS_STORE, META_STORE], 'readwrite')
  await Promise.all([
    tx.objectStore(SEGMENTS_STORE).clear(),
    tx.objectStore(META_STORE).clear(),
    tx.done,
  ])
}
