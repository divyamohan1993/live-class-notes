/**
 * Document exporters — turn the finalized session into shareable artifacts.
 *
 * Every exporter reads the DATA MODEL straight from `useSession.getState()` (never the
 * virtualized DOM, which only holds on-screen rows) and builds the full document from the
 * same `buildTimeline` reading order the screen uses. Nothing here touches the network:
 * math is rendered locally with KaTeX, images are already inlined as data URLs.
 *
 * Four targets:
 *   - PDF  → the browser's own print-to-PDF, via a full static render NotesView mounts on
 *            request (see `useNotesUi.printRequested`); this module only orchestrates it.
 *   - HTML → a single self-contained .html file; math is native MathML (no CSS/fonts).
 *   - MD   → Markdown that preserves `$...$` math source so it round-trips into other tools.
 *   - DOCX → a real Word document (math kept as readable `$...$` LaTeX source, images
 *            embedded) built with the `docx` package.
 */
import katex from 'katex'
import { mathify } from '../../lib/mathify.ts'
// `docx` is heavy and only `exportDocx` needs it, so the runtime values are pulled in via
// a dynamic import() inside that function (keeping it out of the initial bundle). We import
// only the Paragraph TYPE here for annotations — `import type` emits no runtime dependency.
import type { Paragraph as DocxParagraph } from 'docx'
import { useSession } from '../../store.ts'
import type { NoteImage, SessionMeta } from '../../types.ts'
import { buildTimeline } from '../../lib/alignment.ts'
import type { TimelineEntry } from '../../lib/alignment.ts'
import { formatClock } from '../../lib/time.ts'
import { useNotesUi } from './search-store.ts'

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Largest image width (px) we lay out at, so a full-res photo never overflows the page. */
const MAX_IMAGE_WIDTH = 680

/** A piece of segment text split into prose and math runs (math delimiters preserved). */
type MathPiece =
  | { kind: 'text'; value: string }
  | { kind: 'inline'; value: string }
  | { kind: 'block'; value: string }

/**
 * Split text on `$$...$$` (block) and `$...$` (inline) math, mirroring MathText's
 * delimiters. Deliberately minimal and self-contained (not coupled to `mathify`): it only
 * needs to separate math source from prose for the HTML renderer. Unterminated delimiters
 * are treated as literal text so a stray `$` never eats the rest of the document.
 */
function splitMath(text: string): MathPiece[] {
  const pieces: MathPiece[] = []
  let i = 0
  let prose = ''
  const flushProse = (): void => {
    if (prose) {
      pieces.push({ kind: 'text', value: prose })
      prose = ''
    }
  }

  while (i < text.length) {
    if (text[i] === '$') {
      const isBlock = text[i + 1] === '$'
      const open = isBlock ? '$$' : '$'
      const start = i + open.length
      const close = text.indexOf(open, start)
      if (close !== -1 && close > start) {
        flushProse()
        pieces.push({
          kind: isBlock ? 'block' : 'inline',
          value: text.slice(start, close),
        })
        i = close + open.length
        continue
      }
    }
    prose += text[i]
    i += 1
  }
  flushProse()
  return pieces
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render one segment's text to an HTML fragment. Math is emitted as native MathML
 * (`output: 'mathml'`), which every modern browser renders with its own math fonts — so
 * the exported file needs no KaTeX CSS or bundled web fonts and is truly self-contained
 * and offline-perfect. A malformed expression falls back to its literal `$...$` source.
 */
function segmentHtml(text: string): string {
  return splitMath(text)
    .map((piece) => {
      if (piece.kind === 'text') return escapeHtml(piece.value)
      try {
        return katex.renderToString(piece.value, {
          throwOnError: false,
          displayMode: piece.kind === 'block',
          output: 'mathml',
        })
      } catch {
        // A malformed expression should never abort the whole export.
        return escapeHtml(piece.kind === 'block' ? `$$${piece.value}$$` : `$${piece.value}$`)
      }
    })
    .join('')
}

/** MIME type encoded in a data: URL, lowercased, e.g. "image/png" → "png". */
function dataUrlImageType(dataUrl: string): string {
  const match = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)
  return match ? match[1].toLowerCase() : 'png'
}

/** Display dimensions for an image, scaled to fit MAX_IMAGE_WIDTH, preserving aspect. */
function scaledSize(image: NoteImage): { width: number; height: number } {
  const w = image.width ?? MAX_IMAGE_WIDTH
  const h = image.height ?? Math.round(MAX_IMAGE_WIDTH * 0.66)
  if (w <= MAX_IMAGE_WIDTH) return { width: w, height: h }
  const ratio = MAX_IMAGE_WIDTH / w
  return { width: MAX_IMAGE_WIDTH, height: Math.max(1, Math.round(h * ratio)) }
}

/** Decode a base64 data: URL to bytes for embedding (e.g. Word's ImageRun). */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const base64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** A caption to show under an image: human caption if set, else the original file name. */
function imageCaption(image: NoteImage): string {
  return image.caption.trim() || image.name
}

/** "Captured HH:MM:SS" line for an image, or empty when it had no capture time. */
function capturedLabel(image: NoteImage): string {
  return image.capturedAtEpoch != null
    ? `Captured ${formatClock(image.capturedAtEpoch)}`
    : ''
}

/** A filesystem-friendly base name derived from the session title. */
function exportFileBase(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'NoteWeave Notes'
}

/** Trigger a browser download of a Blob, cleaning up the object URL afterwards. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Revoke on the next tick so the navigation/download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** The session's timeline plus its meta, read fresh from the store. */
function readDocument(): { meta: SessionMeta; entries: TimelineEntry[]; hasContent: boolean } {
  const { meta, segments, images, clockOffsetMs } = useSession.getState()
  const entries = buildTimeline(segments, images, clockOffsetMs)
  return { meta, entries, hasContent: entries.length > 0 }
}

/** Subtitle line assembled from course · instructor · date (omitting blanks). */
function metaSubtitle(meta: SessionMeta): string {
  return [meta.course, meta.instructor, meta.dateLabel].map((s) => s.trim()).filter(Boolean).join('  ·  ')
}

/* ------------------------------------------------------------------ *
 * PDF — orchestrate the browser print of NotesView's static copy
 * ------------------------------------------------------------------ */

/**
 * Print to PDF. A virtualized list only has its visible rows in the DOM, so we first ask
 * NotesView to mount a full, static, print-only copy of the document (`printRequested`),
 * wait two animation frames for it to render (and for KaTeX to lay out), then open the
 * print dialog. The flag is lowered on `afterprint` (or a timeout fallback for browsers
 * that never fire it), restoring the live virtualized view.
 */
export function exportPrint(): void {
  const ui = useNotesUi.getState()
  ui.setPrintRequested(true)

  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    window.removeEventListener('afterprint', finish)
    useNotesUi.getState().setPrintRequested(false)
  }
  window.addEventListener('afterprint', finish)

  // Two frames: one to commit the printRequested state, one for the static copy to paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print()
      // Fallback: some browsers don't reliably emit `afterprint`.
      setTimeout(finish, 1500)
    })
  })
}

/* ------------------------------------------------------------------ *
 * HTML — self-contained, math pre-rendered, images inlined
 * ------------------------------------------------------------------ */

/** Build a single self-contained HTML document and download it as a .html file. */
export function exportHtml(): void {
  const { meta, entries } = readDocument()
  const title = meta.title.trim() || 'Untitled Class Notes'

  const body = entries
    .map((entry) => {
      if (entry.kind === 'segment') {
        return (
          `<p class="seg">` +
          `<span class="ts">${escapeHtml(formatClock(entry.segment.startedAtEpoch))}</span>` +
          `<span class="txt">${segmentHtml(mathify(entry.segment.text))}</span>` +
          `</p>`
        )
      }
      const img = entry.image
      const { width } = scaledSize(img)
      const captured = capturedLabel(img)
      return (
        `<figure>` +
        `<img src="${escapeHtml(img.dataUrl)}" alt="${escapeHtml(imageCaption(img))}" ` +
        `style="max-width:${width}px;width:100%" />` +
        `<figcaption>${escapeHtml(imageCaption(img))}` +
        (captured ? `<span class="cap-time">${escapeHtml(captured)}</span>` : '') +
        `</figcaption>` +
        `</figure>`
      )
    })
    .join('\n')

  const summary = meta.summary.trim()
  const summaryBlock = summary
    ? `<section class="summary"><h2>Summary</h2><p>${escapeHtml(summary)}</p></section>`
    : ''

  const html =
    `<!doctype html>\n<html lang="${escapeHtml(meta.lang || 'en')}">\n<head>\n` +
    `<meta charset="utf-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    // Math is native MathML — no KaTeX CSS needed; only the document's own light styles.
    `<style>${HTML_DOC_CSS}</style>\n` +
    `</head>\n<body>\n` +
    `<article class="page">\n` +
    `<header class="masthead">\n` +
    `<h1>${escapeHtml(title)}</h1>\n` +
    (metaSubtitle(meta) ? `<p class="sub">${escapeHtml(metaSubtitle(meta))}</p>\n` : '') +
    `</header>\n` +
    summaryBlock +
    `<section class="notes">\n${body || '<p class="empty">No notes captured.</p>'}\n</section>\n` +
    `</article>\n</body>\n</html>\n`

  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${exportFileBase(title)}.html`)
}

/** Minimal embedded stylesheet for the exported HTML — a clean, printable document read. */
const HTML_DOC_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f3f1ec;color:#1f2328;
  font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  line-height:1.62;-webkit-font-smoothing:antialiased}
.page{max-width:760px;margin:32px auto;padding:48px 56px;background:#fff;
  box-shadow:0 8px 28px rgba(31,35,40,.10);border-radius:6px}
.masthead{border-bottom:1px solid #e6e2da;padding-bottom:18px;margin-bottom:24px}
.masthead h1{font-size:30px;line-height:1.15;margin:0;letter-spacing:-.01em}
.masthead .sub{margin:8px 0 0;font-family:"Segoe UI",system-ui,sans-serif;
  font-size:13px;color:#6b7280;letter-spacing:.02em}
.summary{background:#f7f5f0;border:1px solid #e6e2da;border-radius:8px;
  padding:16px 20px;margin:0 0 28px}
.summary h2{font-family:"Segoe UI",system-ui,sans-serif;font-size:12px;
  text-transform:uppercase;letter-spacing:.09em;color:#314c8c;margin:0 0 6px}
.summary p{margin:0;font-size:15.5px}
.notes .seg{display:flex;gap:16px;margin:0 0 14px;align-items:baseline}
.notes .ts{flex:0 0 auto;font-family:"Cascadia Code",Consolas,monospace;
  font-size:11px;color:#9aa0a8;padding-top:3px;font-variant-numeric:tabular-nums}
.notes .txt{flex:1 1 auto;font-size:17px}
figure{margin:22px 0;padding:0}
figure img{display:block;border:1px solid #e6e2da;border-radius:8px}
figcaption{margin-top:8px;font-family:"Segoe UI",system-ui,sans-serif;
  font-size:13px;color:#3b424b}
figcaption .cap-time{display:block;font-size:11px;color:#9aa0a8;margin-top:2px;
  font-family:"Cascadia Code",Consolas,monospace}
.empty{color:#9aa0a8;font-style:italic}
math{font-size:1.05em}
math[display="block"]{display:block;margin:.6em 0;text-align:center}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;
  border-radius:0;padding:0}math[display="block"],figure{break-inside:avoid}}
`

/* ------------------------------------------------------------------ *
 * Markdown — math source preserved
 * ------------------------------------------------------------------ */

/** Build a Markdown document (math kept as `$...$` source) and download it as .md. */
export function exportMarkdown(): void {
  const { meta, entries } = readDocument()
  const title = meta.title.trim() || 'Untitled Class Notes'
  const lines: string[] = []

  lines.push(`# ${title}`)
  const sub = metaSubtitle(meta)
  if (sub) lines.push('', `*${sub}*`)
  if (meta.summary.trim()) {
    lines.push('', '## Summary', '', meta.summary.trim())
  }
  lines.push('', '## Notes', '')

  for (const entry of entries) {
    if (entry.kind === 'segment') {
      // Timestamp as a small italic lead-in; math source ($...$) is kept verbatim.
      lines.push(`*${formatClock(entry.segment.startedAtEpoch)}* — ${mathify(entry.segment.text)}`, '')
    } else {
      const img = entry.image
      const alt = imageCaption(img).replace(/[[\]]/g, '')
      lines.push(`![${alt}](${img.dataUrl})`, '')
      const captured = capturedLabel(img)
      const caption = [imageCaption(img), captured].filter(Boolean).join(' · ')
      if (caption) lines.push(`*${caption}*`, '')
    }
  }

  const md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${exportFileBase(title)}.md`)
}

/* ------------------------------------------------------------------ *
 * DOCX — a real Word document
 * ------------------------------------------------------------------ */

/** Map a data: URL MIME to a docx-supported image kind; unknown kinds coerce to png. */
function docxImageType(dataUrl: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  const t = dataUrlImageType(dataUrl)
  if (t === 'jpeg' || t === 'jpg') return 'jpg'
  if (t === 'gif') return 'gif'
  if (t === 'bmp') return 'bmp'
  return 'png'
}

/** The runtime shape of the dynamically-imported `docx` module. */
type DocxModule = typeof import('docx')

/** Build the paragraph list for a single image: the picture plus its caption lines. */
function imageParagraphs(docx: DocxModule, image: NoteImage): DocxParagraph[] {
  const { Paragraph, TextRun, ImageRun, AlignmentType } = docx
  const { width, height } = scaledSize(image)
  const captured = capturedLabel(image)
  const paras: DocxParagraph[] = []

  // Embed the picture; if its data can't be decoded, fall back to a text placeholder so a
  // single broken image never aborts the whole document.
  try {
    paras.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 60 },
        children: [
          new ImageRun({
            type: docxImageType(image.dataUrl),
            data: dataUrlToBytes(image.dataUrl),
            transformation: { width, height },
          }),
        ],
      }),
    )
  } catch {
    paras.push(
      new Paragraph({
        spacing: { before: 200, after: 60 },
        children: [new TextRun({ text: `[image: ${imageCaption(image)}]`, italics: true })],
      }),
    )
  }

  paras.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: captured ? 20 : 160 },
      children: [new TextRun({ text: imageCaption(image), italics: true, size: 20, color: '3B424B' })],
    }),
  )
  if (captured) {
    paras.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new TextRun({ text: captured, size: 18, color: '9AA0A8' })],
      }),
    )
  }
  return paras
}

/** Build a Word .docx from the session and download it. Math is kept as `$...$` source. */
export async function exportDocx(): Promise<void> {
  // Pull the heavy `docx` library in only when the user actually exports to Word.
  const docx = await import('docx')
  const { Document, Paragraph, TextRun, HeadingLevel, Packer } = docx

  const { meta, entries } = readDocument()
  const title = meta.title.trim() || 'Untitled Class Notes'

  const children: DocxParagraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
  ]

  const sub = metaSubtitle(meta)
  if (sub) {
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({ text: sub, color: '6B7280', size: 22 })],
      }),
    )
  }

  if (meta.summary.trim()) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Summary')] }),
      new Paragraph({ spacing: { after: 200 }, children: [new TextRun(meta.summary.trim())] }),
    )
  }

  children.push(
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Notes')] }),
  )

  for (const entry of entries) {
    if (entry.kind === 'segment') {
      children.push(
        new Paragraph({
          spacing: { after: 140 },
          children: [
            new TextRun({
              text: `${formatClock(entry.segment.startedAtEpoch)}  `,
              color: '9AA0A8',
              size: 16,
            }),
            // Math stays as readable LaTeX source ($...$) since Word can't render KaTeX.
            new TextRun({ text: mathify(entry.segment.text), size: 24 }),
          ],
        }),
      )
    } else {
      for (const para of imageParagraphs(docx, entry.image)) children.push(para)
    }
  }

  if (entries.length === 0) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: 'No notes captured.', italics: true })] }),
    )
  }

  const doc = new Document({
    creator: 'NoteWeave',
    title,
    description: meta.summary.trim() || undefined,
    sections: [{ children }],
  })

  const blob = await Packer.toBlob(doc)
  downloadBlob(blob, `${exportFileBase(title)}.docx`)
}
