/**
 * Time alignment between the transcript and imported photos.
 *
 * A student snaps photos during class and imports them later. Each photo carries an EXIF
 * capture time; we add a per-session calibration offset (to correct camera-clock drift)
 * to get its "effective" wall-clock time, then slot it into the transcript right after
 * the segment that was being spoken at that moment. A manual anchor overrides all of this.
 */
import type { NoteImage, TranscriptSegment } from '../types.ts'

/** An ordered timeline of transcript segments interleaved with their anchored images. */
export type TimelineEntry =
  | { kind: 'segment'; at: number; segment: TranscriptSegment }
  | { kind: 'image'; at: number; image: NoteImage }

/** Grace window (ms): a photo taken up to this long before the first segment still
 *  anchors to that first segment; earlier than this and it is treated as unplaced. */
const PRE_FIRST_GRACE_MS = 120_000

/** The effective capture time of an image after applying the clock offset, or null. */
function effectiveCaptureTime(
  image: NoteImage,
  clockOffsetMs: number,
): number | null {
  if (image.capturedAtEpoch == null) return null
  return image.capturedAtEpoch + clockOffsetMs
}

/**
 * Resolve which segment an image belongs after, or null if it cannot be placed.
 *
 * - Manual anchor wins when its target segment still exists.
 * - No capture time and no (valid) manual anchor → unplaced (null).
 * - Otherwise pick the latest segment that started at or before the effective time.
 *   A photo after the last segment anchors to the last segment. A photo before the
 *   first segment anchors to the first segment, unless it precedes it by more than the
 *   grace window, in which case it is unplaced.
 *
 * Segments are assumed ordered ascending by startedAtEpoch (the store keeps them so).
 */
export function resolveImageAnchor(
  image: NoteImage,
  segments: TranscriptSegment[],
  clockOffsetMs: number,
): string | null {
  if (image.manualAnchorSegmentId != null) {
    const exists = segments.some((s) => s.id === image.manualAnchorSegmentId)
    if (exists) return image.manualAnchorSegmentId
    // A stale manual anchor (segment was deleted) falls through to time-based logic.
  }

  const effective = effectiveCaptureTime(image, clockOffsetMs)
  if (effective == null) return null
  if (segments.length === 0) return null

  // Latest segment with startedAtEpoch <= effective.
  let anchor: TranscriptSegment | null = null
  for (const seg of segments) {
    if (seg.startedAtEpoch <= effective) {
      anchor = seg
    } else {
      // Segments are sorted ascending; nothing later can qualify.
      break
    }
  }

  if (anchor) return anchor.id

  // Effective time is before every segment.
  const first = segments[0]
  if (effective < first.startedAtEpoch - PRE_FIRST_GRACE_MS) return null
  return first.id
}

/** Sort key for images sharing an anchor: effective capture time, then import time, then id. */
function imageOrderKey(image: NoteImage, clockOffsetMs: number): [number, string] {
  const effective = effectiveCaptureTime(image, clockOffsetMs)
  return [effective ?? image.importedAtEpoch, image.id]
}

function compareImages(
  a: NoteImage,
  b: NoteImage,
  clockOffsetMs: number,
): number {
  const [at, aid] = imageOrderKey(a, clockOffsetMs)
  const [bt, bid] = imageOrderKey(b, clockOffsetMs)
  if (at !== bt) return at - bt
  return aid < bid ? -1 : aid > bid ? 1 : 0
}

/**
 * Build the interleaved reading order: every segment in startedAtEpoch order, with each
 * image placed immediately after the segment it anchors to. Images sharing an anchor are
 * ordered by effective capture time then id. Unplaced images are omitted (see
 * `unplacedImages`). The returned `at` is the segment's startedAtEpoch (images inherit
 * their anchor segment's time) for convenient downstream display/sorting.
 */
export function buildTimeline(
  segments: TranscriptSegment[],
  images: NoteImage[],
  clockOffsetMs: number,
): TimelineEntry[] {
  // Bucket images by the segment id they anchor to.
  const byAnchor = new Map<string, NoteImage[]>()
  for (const image of images) {
    const anchorId = resolveImageAnchor(image, segments, clockOffsetMs)
    if (anchorId == null) continue
    const bucket = byAnchor.get(anchorId)
    if (bucket) {
      bucket.push(image)
    } else {
      byAnchor.set(anchorId, [image])
    }
  }

  const entries: TimelineEntry[] = []
  for (const segment of segments) {
    entries.push({ kind: 'segment', at: segment.startedAtEpoch, segment })
    const bucket = byAnchor.get(segment.id)
    if (bucket) {
      bucket.sort((a, b) => compareImages(a, b, clockOffsetMs))
      for (const image of bucket) {
        entries.push({ kind: 'image', at: segment.startedAtEpoch, image })
      }
    }
  }
  return entries
}

/**
 * Images that cannot be anchored to any segment (no capture time and no valid manual
 * anchor, or taken well before the transcript began). These are surfaced separately so
 * the student can place them by hand.
 */
export function unplacedImages(
  segments: TranscriptSegment[],
  images: NoteImage[],
  clockOffsetMs: number,
): NoteImage[] {
  return images.filter(
    (image) => resolveImageAnchor(image, segments, clockOffsetMs) == null,
  )
}
