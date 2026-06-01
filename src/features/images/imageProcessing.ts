/**
 * Turn a picked `File` into a persistable `NoteImage`.
 *
 * Two pressures shape this:
 *   1. A 10-hour class can yield dozens of multi-megapixel photos, all inlined as data URLs
 *      into IndexedDB (we never keep audio, but every photo lives forever in the session).
 *      So we downscale + re-encode to keep memory and storage sane.
 *   2. The whole point of a photo is *when* it was taken. EXIF capture time must be read
 *      from the ORIGINAL bytes BEFORE any canvas re-encode, because re-encoding strips EXIF.
 *
 * Ordering is therefore load-bearing:
 *   (a) read capture time from the original file,
 *   (b) decode with orientation baked in (phone photos carry an EXIF orientation tag; a
 *       naive draw renders a board/equation sideways), then
 *   (c) downscale → JPEG data URL, measuring dimensions from the *oriented* bitmap.
 */
import type { NoteImage } from '../../types.ts'
import { newId } from '../../lib/id.ts'
import { readCaptureTime } from './exif.ts'

/** Longest-edge cap (px). Comfortably sharp for a board photo, far smaller than a 12MP shot. */
const MAX_EDGE = 1920
/** JPEG quality for the re-encode — visually clean, roughly a quarter the bytes of full res. */
const JPEG_QUALITY = 0.85

/** Read the whole file as a data URL (fallback path when canvas decode/encode is unavailable). */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

/** A decoded, EXIF-orientation-corrected bitmap plus its true display dimensions. */
interface Decoded {
  bitmap: ImageBitmap
  width: number
  height: number
}

/**
 * Decode the file with orientation applied. Returns null when the platform can't decode it
 * here (e.g. HEIC on a browser without native support), so the caller can fall back to
 * storing the original bytes rather than dropping the photo.
 */
async function decodeOriented(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    // `imageOrientation: 'from-image'` bakes the EXIF rotation into the pixels, so width/height
    // and the later canvas draw are already upright.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    return null
  }
}

/** Re-encode a decoded bitmap to a downscaled JPEG data URL, or null if canvas is unavailable. */
function encodeDownscaled(decoded: Decoded): string | null {
  const { bitmap, width, height } = decoded
  const longest = Math.max(width, height)
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1
  // Guard against a zero-area decode producing a 0x0 canvas (toDataURL would be useless).
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

export async function fileToImage(file: File): Promise<NoteImage> {
  // (a) Capture time FIRST — from the original bytes, before any re-encode strips EXIF.
  const capturedAtEpoch = await readCaptureTime(file)

  let dataUrl: string
  let width: number | null = null
  let height: number | null = null

  // (b) Decode with orientation baked in; (c) downscale + re-encode only when oversized.
  const decoded = await decodeOriented(file)
  if (decoded) {
    width = decoded.width
    height = decoded.height
    const oversized = Math.max(decoded.width, decoded.height) > MAX_EDGE
    if (oversized) {
      const encoded = encodeDownscaled(decoded)
      dataUrl = encoded ?? (await readAsDataUrl(file))
    } else {
      // Already small: keep the ORIGINAL bytes verbatim. Re-encoding here would only hurt —
      // JPEG has no alpha (transparent PNGs would composite over black) and lossy compression
      // adds ringing to the line art and text we most care about (board equations, diagrams).
      dataUrl = await readAsDataUrl(file)
    }
    // Free the decoded bitmap promptly — across a big batch this keeps peak memory bounded.
    decoded.bitmap.close()
  } else {
    // Couldn't decode here (e.g. HEIC without native support): store original bytes so the
    // photo still appears, persists, and can be placed by capture time or by hand.
    dataUrl = await readAsDataUrl(file)
  }

  return {
    id: newId(),
    name: file.name,
    dataUrl,
    capturedAtEpoch,
    importedAtEpoch: Date.now(),
    caption: '',
    manualAnchorSegmentId: null,
    width,
    height,
  }
}
