/**
 * The document masthead — the printed page's title block.
 *
 * Everything here is inline-editable and writes straight to session meta:
 *   - Title: a large serif heading the user types into directly; an "Auto-title" action
 *     derives one from the transcript (generateTitle) when they'd rather not.
 *   - Byline: course · instructor · date, each a quiet inline field.
 *   - Summary: an extractive summary (summarize) shown in an editable textarea, generated
 *     on demand and freely hand-editable afterwards.
 *
 * Controls are styled to read as document text, not form chrome, but remain real inputs
 * (labelled, keyboard-navigable). The whole block prints at the top of exported notes.
 */
import { useCallback } from 'react'
import type { ChangeEvent } from 'react'
import { useSession } from '../../store.ts'
import { generateTitle } from '../../lib/autotitle.ts'
import { summarize } from '../../lib/summarize.ts'
import { useAutosize } from './use-autosize.ts'

/** A quiet inline meta field (course / instructor / date) shown in the byline. */
function MetaField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <label className="group inline-flex items-center">
      <span className="sr-only">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        size={Math.max(placeholder.length, value.length || 1)}
        className="min-w-0 rounded-[var(--nw-radius-sm)] bg-transparent px-1 py-0.5 text-sm text-ink-soft placeholder:text-muted/70 hover:bg-[color:var(--nw-surface-muted)] focus:bg-[color:var(--nw-surface-muted)] focus:outline-none"
      />
    </label>
  )
}

export function SessionHeader() {
  const meta = useSession((s) => s.meta)
  const segments = useSession((s) => s.segments)
  const setMeta = useSession((s) => s.setMeta)

  const titleRef = useAutosize<HTMLTextAreaElement>(meta.title)
  const summaryRef = useAutosize<HTMLTextAreaElement>(meta.summary)

  const onTitleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      // Keep the title single-line; Enter shouldn't inject a newline into a heading.
      setMeta({ title: e.target.value.replace(/\n/g, ' ') })
    },
    [setMeta],
  )

  const onAutoTitle = useCallback(() => {
    setMeta({ title: generateTitle(segments, meta) })
  }, [segments, meta, setMeta])

  const onSummarize = useCallback(() => {
    const text = summarize(segments)
    // summarize() is local + extractive; if it yields nothing (too little text), guide.
    setMeta({
      summary:
        text.trim() ||
        'Not enough transcript yet to summarize. Record a little more, then try again.',
    })
  }, [segments, setMeta])

  const hasSegments = segments.length > 0

  return (
    <header className="border-b border-[color:var(--color-hairline)] px-6 pb-6 pt-8 sm:px-10">
      {/* Eyebrow + auto-title action */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
          Class Notes
        </span>
        <button
          type="button"
          onClick={onAutoTitle}
          disabled={!hasSegments}
          className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-hairline)] px-2.5 py-1 text-[11px] font-medium text-ink-soft transition-colors hover:border-[color:var(--nw-accent)] hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          title={hasSegments ? 'Suggest a title from the transcript' : 'Record some notes first'}
        >
          <span aria-hidden="true">✦</span> Auto-title
        </button>
      </div>

      {/* Title — large serif heading, edited in place */}
      <textarea
        ref={titleRef}
        value={meta.title}
        onChange={onTitleChange}
        rows={1}
        spellCheck={false}
        placeholder="Untitled Class Notes"
        aria-label="Session title"
        className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-serif text-[28px] font-semibold leading-tight tracking-tight text-ink placeholder:text-muted/60 focus:outline-none focus-visible:outline-none"
      />

      {/* Byline — course · instructor · date */}
      <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 font-sans text-sm text-muted">
        <MetaField
          label="Course"
          value={meta.course}
          placeholder="Course"
          onChange={(course) => setMeta({ course })}
        />
        <span aria-hidden="true" className="text-[color:var(--nw-border-strong)]">·</span>
        <MetaField
          label="Instructor"
          value={meta.instructor}
          placeholder="Instructor"
          onChange={(instructor) => setMeta({ instructor })}
        />
        <span aria-hidden="true" className="text-[color:var(--nw-border-strong)]">·</span>
        <MetaField
          label="Date"
          value={meta.dateLabel}
          placeholder="Date"
          onChange={(dateLabel) => setMeta({ dateLabel })}
        />
      </div>

      {/* Summary */}
      <section className="mt-5 rounded-[var(--nw-radius-lg)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface-muted)]/60 p-4">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
            Summary
          </h2>
          <button
            type="button"
            onClick={onSummarize}
            disabled={!hasSegments}
            className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] px-2.5 py-1 text-[11px] font-medium text-ink-soft transition-colors hover:border-[color:var(--nw-accent)] hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            title={hasSegments ? 'Generate a summary from the transcript' : 'Record some notes first'}
          >
            <span aria-hidden="true">❖</span> Summarize
          </button>
        </div>
        <textarea
          ref={summaryRef}
          value={meta.summary}
          onChange={(e) => setMeta({ summary: e.target.value })}
          rows={2}
          placeholder="A short summary of the session will appear here. Click Summarize, or write your own."
          aria-label="Session summary"
          className="block w-full resize-none overflow-hidden rounded-[var(--nw-radius-sm)] border-0 bg-transparent p-0 font-sans text-sm leading-relaxed text-ink-soft placeholder:text-muted/70 focus:outline-none"
        />
      </section>
    </header>
  )
}
