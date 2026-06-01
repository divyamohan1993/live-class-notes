/**
 * The image dock — import class photos and weave them into the transcript by capture time.
 *
 * The hard problem this panel solves: a phone's clock is rarely in perfect sync with the
 * wall clock the transcript runs on, so a photo's EXIF time can land it next to the wrong
 * sentence. The fix is CALIBRATION — a single signed offset (`clockOffsetMs`) the student
 * nudges until a photo lines up with what was being said. Because every placement in the app
 * derives from that offset (NotesView reads it; this dock recomputes each photo's "Placed
 * after HH:MM:SS" from it too), dragging the slider visibly slides photos through the
 * timeline in real time. That live cause-and-effect is the centerpiece of this component.
 *
 * Responsibilities:
 *   - Import: drag-&-drop + a keyboard-reachable file picker, tolerant of weird/failed files.
 *   - Per-photo: thumbnail, editable caption, capture time, live placement, pin/auto, remove.
 *   - Calibration: slider + mm:ss field + quick nudges + reset, all bound to one signed ms.
 *   - An unplaced tray for photos with no resolvable time, prompting a manual pin.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Button, IconButton, Panel, Pill } from '../../components/ui.tsx'
import { useSession } from '../../store.ts'
import { resolveImageAnchor } from '../../lib/alignment.ts'
import { formatClock } from '../../lib/time.ts'
import type { NoteImage, TranscriptSegment } from '../../types.ts'
import { fileToImage } from './imageProcessing.ts'

/** Calibration slider bounds: ±2 hours covers a badly-set phone clock; 5s steps for nudging. */
const OFFSET_LIMIT_MS = 2 * 60 * 60 * 1000
const OFFSET_STEP_MS = 5_000
/** Quick-nudge increments (ms): a fine 5-second tap and a coarse 1-minute tap, each way. */
const NUDGE_FINE_MS = 5_000
const NUDGE_COARSE_MS = 60_000

/** Tracks the outcome of a batch import so we can reassure the student about skipped files. */
interface ImportState {
  busy: boolean
  /** Files successfully turned into notes in the most recent batch. */
  added: number
  /** Files skipped in the most recent batch (unreadable / unsupported). */
  skipped: number
  /** Total files in the in-flight batch (for the progress readout); 0 when idle. */
  total: number
  /** How many of `total` have been processed so far. */
  done: number
}

const IDLE_IMPORT: ImportState = { busy: false, added: 0, skipped: 0, total: 0, done: 0 }

/** Image file extensions, for files whose MIME type the OS leaves blank (common for HEIC). */
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i

/** Accept a dropped/picked file as a photo by MIME OR extension (HEIC often has empty type). */
function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name)
}

function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, ms))
}

/** Signed ms → "±MM:SS" for the editable field (e.g. -90000 → "-01:30"). */
function offsetToMmss(ms: number): string {
  const sign = ms < 0 ? '-' : '+'
  const abs = Math.abs(Math.round(ms / 1000))
  const mm = Math.floor(abs / 60)
  const ss = abs % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${sign}${pad(mm)}:${pad(ss)}`
}

/**
 * Parse a "±MM:SS" (or "±M", or plain seconds-less) field back to signed ms. Returns null on
 * gibberish so the caller can keep the last good value rather than snapping to zero mid-edit.
 */
function mmssToOffset(text: string): number | null {
  const trimmed = text.trim()
  const m = /^([+-]?)(\d{1,3})(?::([0-5]?\d))?$/.exec(trimmed)
  if (!m) return null
  const [, sign, mm, ss] = m
  const total = Number(mm) * 60 + (ss ? Number(ss) : 0)
  const ms = total * 1000 * (sign === '-' ? -1 : 1)
  return clampOffset(ms)
}

/**
 * A photo thumbnail that degrades gracefully when the browser can't decode the format for
 * display (notably HEIC on Chrome/Firefox): on an image error we show a labelled placeholder
 * instead of a broken-image icon. Placement is unaffected — the photo's EXIF time, not its
 * preview, drives where it lands in the transcript.
 */
function Thumb({ image, size }: { image: NoteImage; size: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div
        className={`flex ${size} shrink-0 items-center justify-center rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface-muted)] text-muted`}
        role="img"
        aria-label={`${image.name} (preview unavailable)`}
        title="Preview not supported in this browser; the photo is still placed by its capture time."
      >
        <span aria-hidden="true" className="text-base">
          🖼
        </span>
      </div>
    )
  }
  return (
    <img
      src={image.dataUrl}
      alt={image.caption || image.name}
      onError={() => setFailed(true)}
      className={`${size} shrink-0 rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)] object-cover`}
    />
  )
}

/** Human summary of a photo's placement, derived from the shared anchor resolution. */
function placementLabel(
  image: NoteImage,
  anchorId: string | null,
  segmentsById: Map<string, TranscriptSegment>,
): { placed: boolean; text: string } {
  if (anchorId == null) return { placed: false, text: 'Unplaced' }
  const seg = segmentsById.get(anchorId)
  if (!seg) return { placed: false, text: 'Unplaced' }
  const pinned = image.manualAnchorSegmentId === anchorId
  return {
    placed: true,
    text: `${pinned ? 'Pinned' : 'Placed'} after ${formatClock(seg.startedAtEpoch)}`,
  }
}

export function ImageDock() {
  // Select RAW slices only; derive everything in useMemo so selectors never return fresh refs.
  const images = useSession((s) => s.images)
  const segments = useSession((s) => s.segments)
  const clockOffsetMs = useSession((s) => s.clockOffsetMs)
  const addImage = useSession((s) => s.addImage)
  const updateImage = useSession((s) => s.updateImage)
  const removeImage = useSession((s) => s.removeImage)
  const setClockOffsetMs = useSession((s) => s.setClockOffsetMs)

  const [imp, setImp] = useState<ImportState>(IDLE_IMPORT)
  const [dragging, setDragging] = useState(false)
  // Local text buffer for the offset field so partial edits ("-1", "-01:") don't fight the store.
  const [offsetText, setOffsetText] = useState<string | null>(null)
  // Re-entrancy guard for imports: a ref (not state) so the stable importFiles callback can
  // read it without dep churn, and dropping a second batch mid-import is ignored rather than
  // clobbering the progress readout.
  const importingRef = useRef(false)

  // One pass over images → anchor per image, placement labels, and counts. Recomputes whenever
  // segments, images, or the calibration offset change — so a slider drag visibly re-places.
  const { placements, placedCount, unplacedCount } = useMemo(() => {
    const segmentsById = new Map(segments.map((s) => [s.id, s]))
    let placed = 0
    let unplaced = 0
    const map = new Map<string, { placed: boolean; text: string }>()
    for (const image of images) {
      const anchorId = resolveImageAnchor(image, segments, clockOffsetMs)
      const label = placementLabel(image, anchorId, segmentsById)
      map.set(image.id, label)
      if (label.placed) placed += 1
      else unplaced += 1
    }
    return { placements: map, placedCount: placed, unplacedCount: unplaced }
  }, [images, segments, clockOffsetMs])

  const latestSegmentId = segments.length > 0 ? segments[segments.length - 1].id : null

  const importFiles = useCallback(
    async (files: File[]) => {
      if (importingRef.current) return // A batch is already running; don't clobber its progress.
      const pics = files.filter(looksLikeImage)
      if (pics.length === 0) return
      importingRef.current = true
      setImp({ busy: true, added: 0, skipped: 0, total: pics.length, done: 0 })
      let added = 0
      let skipped = 0
      // Sequential on purpose: decoding many multi-megapixel photos at once spikes memory on a
      // long class. One at a time keeps peak usage flat and lets the progress count tick up.
      try {
        for (const file of pics) {
          try {
            const note = await fileToImage(file)
            addImage(note)
            added += 1
          } catch {
            skipped += 1 // Tolerate a single bad file; keep importing the rest of the batch.
          }
          setImp((prev) => ({ ...prev, added, skipped, done: added + skipped }))
        }
      } finally {
        importingRef.current = false
        setImp({ busy: false, added, skipped, total: 0, done: 0 })
      }
    },
    [addImage],
  )

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files
      if (list && list.length > 0) void importFiles(Array.from(list))
      // Reset so picking the same file twice still fires change.
      e.target.value = ''
    },
    [importFiles],
  )

  const onDrop = useCallback(
    (e: DragEvent<HTMLLabelElement>) => {
      e.preventDefault()
      setDragging(false)
      const list = e.dataTransfer?.files
      if (list && list.length > 0) void importFiles(Array.from(list))
    },
    [importFiles],
  )

  const onDragOver = useCallback((e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const onDragLeave = useCallback((e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setDragging(false)
  }, [])

  // ---- Calibration handlers (all funnel through one clamped signed-ms setter) ----
  const commitOffset = useCallback((ms: number) => setClockOffsetMs(clampOffset(ms)), [setClockOffsetMs])
  const nudge = useCallback((delta: number) => commitOffset(clockOffsetMs + delta), [clockOffsetMs, commitOffset])

  const onSliderChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setOffsetText(null)
      commitOffset(Number(e.target.value))
    },
    [commitOffset],
  )

  const onOffsetFieldChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setOffsetText(e.target.value)
  }, [])

  const commitOffsetField = useCallback(() => {
    if (offsetText == null) return
    const parsed = mmssToOffset(offsetText)
    if (parsed != null) commitOffset(parsed)
    setOffsetText(null) // Snap the field back to the canonical formatting.
  }, [offsetText, commitOffset])

  const offsetFieldValue = offsetText ?? offsetToMmss(clockOffsetMs)

  const unplaced = useMemo(
    () => images.filter((img) => placements.get(img.id)?.placed === false),
    [images, placements],
  )

  return (
    <div className="flex flex-col gap-4">
      {/* ── Import ─────────────────────────────────────────────────────────── */}
      <Panel as="section" aria-label="Import photos">
        <div className="flex items-baseline justify-between">
          <h2 className="font-sans text-sm font-semibold text-ink">Photos</h2>
          <span className="text-xs text-muted" aria-live="polite">
            Placed {placedCount} · Unplaced {unplacedCount}
          </span>
        </div>

        <label
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          className={[
            'mt-3 flex cursor-pointer flex-col items-center justify-center rounded-[var(--nw-radius)]',
            'border-2 border-dashed px-4 py-6 text-center transition-colors',
            dragging
              ? 'border-[color:var(--nw-accent)] bg-[color:var(--nw-accent-soft)]'
              : 'border-[color:var(--color-hairline-strong)] hover:bg-[color:var(--nw-surface-muted)]',
          ].join(' ')}
        >
          <input
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            className="sr-only"
            onChange={onInputChange}
          />
          <span aria-hidden="true" className="text-2xl text-muted">
            ⤓
          </span>
          <span className="mt-1 text-sm font-medium text-ink">Drop photos here</span>
          <span className="mt-0.5 text-xs text-muted">or click to choose · JPEG, PNG, HEIC</span>
        </label>

        {imp.busy && (
          <p className="mt-3 text-xs text-ink-soft" role="status" aria-live="polite">
            Importing {imp.done} of {imp.total}…
          </p>
        )}
        {!imp.busy && (imp.added > 0 || imp.skipped > 0) && (
          <p className="mt-3 text-xs text-ink-soft" role="status">
            Imported {imp.added} photo{imp.added === 1 ? '' : 's'}
            {imp.skipped > 0 && (
              <span className="text-[color:var(--nw-warning)]">
                {' '}
                · {imp.skipped} skipped (unreadable)
              </span>
            )}
            .
          </p>
        )}
      </Panel>

      {/* ── Calibration (centerpiece) ──────────────────────────────────────── */}
      <Panel as="section" aria-label="Camera clock calibration">
        <h2 className="font-sans text-sm font-semibold text-ink">Camera clock offset</h2>
        <p className="mt-1 text-xs text-muted">
          {clockOffsetMs === 0
            ? 'Photos sit at their EXIF capture time. Drag if a photo lands by the wrong sentence.'
            : `Photos shift by ${offsetToMmss(clockOffsetMs)} (mm:ss) — drag until a photo lines up with what was being said.`}
        </p>

        <div className="mt-3">
          <label htmlFor="nw-clock-offset" className="sr-only">
            Camera clock offset in minutes
          </label>
          <input
            id="nw-clock-offset"
            type="range"
            min={-OFFSET_LIMIT_MS}
            max={OFFSET_LIMIT_MS}
            step={OFFSET_STEP_MS}
            value={clockOffsetMs}
            onChange={onSliderChange}
            aria-valuetext={`${offsetToMmss(clockOffsetMs)} (minutes:seconds)`}
            className="w-full accent-[color:var(--nw-accent)]"
          />
          <div className="mt-1 flex justify-between text-[11px] text-muted" aria-hidden="true">
            <span>−2h</span>
            <span>0</span>
            <span>+2h</span>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Nudge offset earlier">
            <Button size="sm" variant="ghost" onClick={() => nudge(-NUDGE_COARSE_MS)} aria-label="Minus one minute">
              −1m
            </Button>
            <Button size="sm" variant="ghost" onClick={() => nudge(-NUDGE_FINE_MS)} aria-label="Minus five seconds">
              −5s
            </Button>
          </div>

          <label htmlFor="nw-offset-field" className="sr-only">
            Offset as minutes and seconds
          </label>
          <input
            id="nw-offset-field"
            type="text"
            inputMode="text"
            value={offsetFieldValue}
            onChange={onOffsetFieldChange}
            onBlur={commitOffsetField}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitOffsetField()
            }}
            className={[
              'w-[5.5rem] rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)]',
              'bg-[color:var(--nw-surface)] px-2 py-1 text-center font-mono text-sm text-ink',
              'focus:border-[color:var(--nw-accent)] focus:outline-none',
            ].join(' ')}
            aria-describedby="nw-offset-hint"
          />

          <div className="flex items-center gap-1" role="group" aria-label="Nudge offset later">
            <Button size="sm" variant="ghost" onClick={() => nudge(NUDGE_FINE_MS)} aria-label="Plus five seconds">
              +5s
            </Button>
            <Button size="sm" variant="ghost" onClick={() => nudge(NUDGE_COARSE_MS)} aria-label="Plus one minute">
              +1m
            </Button>
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOffsetText(null)
              commitOffset(0)
            }}
            disabled={clockOffsetMs === 0}
          >
            Reset
          </Button>
        </div>
        <p id="nw-offset-hint" className="mt-1.5 text-[11px] text-muted">
          Positive = camera clock is slow. As you adjust, photos re-place live below and in your notes.
        </p>
      </Panel>

      {/* ── Unplaced tray ──────────────────────────────────────────────────── */}
      {unplaced.length > 0 && (
        <Panel as="section" aria-label="Unplaced photos" className="border-[color:var(--nw-warning)]/40">
          <div className="flex items-center gap-2">
            <Pill tone="warning">{unplaced.length} unplaced</Pill>
            <span className="text-xs text-muted">No timestamp — pin each to the live moment.</span>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {unplaced.map((img) => (
              <li key={img.id} className="flex items-center gap-2">
                <Thumb image={img} size="h-10 w-10" />
                <span className="min-w-0 flex-1 truncate text-xs text-ink-soft" title={img.name}>
                  {img.name}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={latestSegmentId == null}
                  onClick={() => latestSegmentId && updateImage(img.id, { manualAnchorSegmentId: latestSegmentId })}
                  title={
                    latestSegmentId == null
                      ? 'Start recording to create a moment to pin to'
                      : 'Pin this photo to the latest spoken moment'
                  }
                >
                  Pin here
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ── Imported list ──────────────────────────────────────────────────── */}
      {images.length > 0 && (
        <Panel as="section" padding="none" aria-label="Imported photos">
          <ul className="divide-y divide-[color:var(--color-hairline)]">
            {images.map((img) => {
              const placement = placements.get(img.id) ?? { placed: false, text: 'Unplaced' }
              const pinned = img.manualAnchorSegmentId != null
              return (
                <li key={img.id} className="flex gap-3 p-3">
                  <Thumb image={img} size="h-16 w-16" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-xs font-medium text-ink-soft" title={img.name}>
                        {img.name}
                      </p>
                      <IconButton
                        size="sm"
                        variant="danger"
                        label={`Remove ${img.name}`}
                        onClick={() => removeImage(img.id)}
                      >
                        ✕
                      </IconButton>
                    </div>

                    <label className="sr-only" htmlFor={`cap-${img.id}`}>
                      Caption for {img.name}
                    </label>
                    <input
                      id={`cap-${img.id}`}
                      type="text"
                      value={img.caption}
                      placeholder="Add a caption…"
                      onChange={(e) => updateImage(img.id, { caption: e.target.value })}
                      className={[
                        'w-full rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)]',
                        'bg-[color:var(--nw-surface)] px-2 py-1 text-xs text-ink',
                        'placeholder:text-muted focus:border-[color:var(--nw-accent)] focus:outline-none',
                      ].join(' ')}
                    />

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[11px] text-muted">
                        {img.capturedAtEpoch != null ? formatClock(img.capturedAtEpoch) : 'no timestamp'}
                      </span>
                      <Pill tone={placement.placed ? (pinned ? 'accent' : 'success') : 'warning'}>
                        {placement.text}
                      </Pill>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {pinned ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => updateImage(img.id, { manualAnchorSegmentId: null })}
                        >
                          Clear pin · Auto
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={latestSegmentId == null}
                          onClick={() =>
                            latestSegmentId && updateImage(img.id, { manualAnchorSegmentId: latestSegmentId })
                          }
                          title={
                            latestSegmentId == null
                              ? 'Start recording to create a moment to pin to'
                              : 'Drop this photo at the current live moment'
                          }
                        >
                          Pin here
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
    </div>
  )
}
