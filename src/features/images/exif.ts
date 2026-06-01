/**
 * Read a photo's TRUE capture time from its EXIF metadata.
 *
 * A student snaps boards/slides during class and imports the photos afterwards; the only
 * reliable clue to *when* each photo belongs in the transcript is the camera's own capture
 * timestamp, not the file's `lastModified` (which changes on copy/download/airdrop and would
 * place every photo at import time). We therefore read EXIF only, and return null when no
 * camera timestamp exists — the dock then asks the student to pin those by hand.
 *
 * Tag preference mirrors what cameras actually write:
 *   1. DateTimeOriginal — the instant the shutter fired (the truth we want).
 *   2. CreateDate       — when the file was created (usually identical on a camera).
 *   3. ModifyDate       — last resort; still EXIF, still the device clock.
 *
 * exifr (with its default `reviveValues: true`) revives these tags into `Date` instances
 * built from the photo's *local* clock components — which lines up exactly with
 * `formatClock`, that reads local wall-clock from an epoch. We still defend against the raw
 * EXIF string shape ("YYYY:MM:DD HH:MM:SS") in case reviving is ever disabled or a value
 * arrives malformed: a bare `new Date("2018:07:25 …")` yields Invalid Date → NaN, which we
 * must convert to null rather than silently corrupt placement.
 *
 * Any camera-clock drift (a few seconds/minutes off real time) is corrected downstream by
 * the session calibration offset, not here. This function's single job is the device's own
 * recorded instant, as faithfully as possible.
 */
import exifr from 'exifr'

/** EXIF date tags we trust, in descending order of fidelity to the shutter moment. */
const DATE_TAGS = ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] as const

/** Matches the canonical EXIF datetime string, e.g. "2018:07:25 16:34:23". */
const EXIF_DATETIME = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/

/**
 * Coerce a single revived EXIF date value into epoch milliseconds, or null when it carries
 * no usable instant. Accepts a `Date` (exifr's default) or the raw EXIF string.
 */
function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'string') {
    const m = EXIF_DATETIME.exec(value.trim())
    if (!m) return null
    // Interpret the EXIF components as LOCAL time (cameras record local wall-clock), so the
    // resulting epoch formats back to the same HH:MM:SS the camera showed.
    const [, y, mo, d, h, mi, s] = m
    const epoch = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ).getTime()
    return Number.isFinite(epoch) ? epoch : null
  }
  return null
}

/**
 * Read the photo's capture time as epoch milliseconds, or null when EXIF carries none.
 *
 * Never throws: unreadable bytes, unsupported containers, stripped metadata, and screenshots
 * (which legitimately have no capture time) all resolve to null so the caller can keep
 * importing the rest of a large batch and offer manual placement for the stragglers.
 *
 * Handles JPEG/TIFF/HEIC (full EXIF) and degrades gracefully on PNG/WebP/screenshots, which
 * typically expose no DateTimeOriginal — there is simply nothing to return, not an error.
 */
export async function readCaptureTime(file: File): Promise<number | null> {
  try {
    // Restrict parsing to the EXIF/IFD0 date tags: faster, smaller, and avoids dragging in
    // GPS/XMP/thumbnail work we don't need for a 10-hour batch of photos.
    const parsed = (await exifr.parse(file, DATE_TAGS as unknown as string[])) as
      | Record<string, unknown>
      | undefined
    if (!parsed) return null
    for (const tag of DATE_TAGS) {
      const ms = toEpochMs(parsed[tag])
      if (ms != null) return ms
    }
    return null
  } catch {
    // EXIF is best-effort. A bad file must never break the import flow.
    return null
  }
}
