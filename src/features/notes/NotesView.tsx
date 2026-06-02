/**
 * NotesView — the transcript document and the heart of NoteWeave.
 *
 * Reading order comes from `buildTimeline`: finalized segments flow as serif paragraphs
 * with a quiet timestamp in the gutter, and imported photos slot in as framed figures at
 * the moment they were taken. The list is window-virtualized so a ten-hour lecture (tens
 * of thousands of rows) stays smooth.
 *
 * Live, transient affordances sit OUTSIDE the virtualized document, fixed to the viewport
 * and marked as chrome so they never print or export:
 *   - the interim (not-yet-final) line while recording,
 *   - a "Jump to live" button when the reader has scrolled away from the tail.
 *
 * Editing is inline (click a paragraph → textarea → blur saves). Per paragraph, the reader
 * can opt in to math formatting (mathify, never automatic) or delete it. Full-text search
 * (driven from the Toolbar via useNotesUi) highlights matches and scrolls between them.
 *
 * Printing can't use the virtualized DOM (off-screen rows aren't mounted), so when a print
 * is requested we render a full, static copy of the whole document (math included) that is
 * visible only on print; the live view is hidden on print.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { useSession } from '../../store.ts'
import type { NoteImage, TranscriptSegment } from '../../types.ts'
import { buildTimeline } from '../../lib/alignment.ts'
import type { TimelineEntry } from '../../lib/alignment.ts'
import { formatClock } from '../../lib/time.ts'
import { MathText } from '../../components/MathText.tsx'
import { mathify, maybeMath } from '../../lib/mathify.ts'
import { highlightRanges } from '../../lib/search.ts'
import { IconButton } from '../../components/ui.tsx'
import { useNotesUi } from './search-store.ts'
import { useAutosize } from './use-autosize.ts'

/** Distance (px) from the bottom within which we consider the reader "at the live tail". */
const LIVE_TAIL_THRESHOLD = 120

/* ------------------------------------------------------------------ *
 * Search highlighting
 * ------------------------------------------------------------------ */

/**
 * Render text with `<mark>`ed query matches. Used only for segments that match the active
 * query, so math rendering (which would be broken by slicing `$...$`) is skipped for those
 * rows; non-matching rows render through <MathText/> as normal.
 */
function Highlighted({ text, query, active }: { text: string; query: string; active: boolean }) {
  const ranges = useMemo(() => highlightRanges(text, query), [text, query])
  if (ranges.length === 0) return <>{text}</>

  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach(([start, end], idx) => {
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <mark
        key={idx}
        className={
          active
            ? 'rounded-[3px] bg-[color:var(--nw-warning)]/35 px-0.5 text-ink ring-1 ring-[color:var(--nw-warning)]/60'
            : 'rounded-[3px] bg-[color:var(--nw-accent-soft)] px-0.5 text-ink'
        }
      >
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

/* ------------------------------------------------------------------ *
 * Segment row
 * ------------------------------------------------------------------ */

// Memoized: while recording, every interim chunk re-renders NotesView. Stable props
// (segment refs are stable because `timeline` is memoized; q/isMatch/isActiveMatch change
// only on search) mean a memoized row re-renders — and re-runs KaTeX — only when its own
// text or match state changes, never on interim updates.
const SegmentRow = memo(function SegmentRow({
  segment,
  query,
  isMatch,
  isActiveMatch,
}: {
  segment: TranscriptSegment
  query: string
  isMatch: boolean
  isActiveMatch: boolean
}) {
  const editSegment = useSession((s) => s.editSegment)
  const deleteSegment = useSession((s) => s.deleteSegment)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(segment.text)
  const [mathPreview, setMathPreview] = useState<string | null>(null)
  const editRef = useAutosize<HTMLTextAreaElement>(draft)

  const beginEdit = useCallback(() => {
    setDraft(segment.text)
    setEditing(true)
  }, [segment.text])

  const commit = useCallback(() => {
    setEditing(false)
    const next = draft.trim()
    if (next !== segment.text && next !== '') editSegment(segment.id, next)
    else setDraft(segment.text)
  }, [draft, editSegment, segment.id, segment.text])

  const cancel = useCallback(() => {
    setDraft(segment.text)
    setEditing(false)
  }, [segment.text])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        commit()
      }
    },
    [cancel, commit],
  )

  // Offer math formatting only when the text looks mathematical and isn't already formatted.
  const canFormatMath = useMemo(
    () => !editing && maybeMath(segment.text) && !segment.text.includes('$'),
    [editing, segment.text],
  )

  // Auto-depict math: clean spoken equations (and any typed $...$) render as real math
  // automatically. mathify is gated, so ordinary prose is returned unchanged; the stored
  // segment text stays raw, so this is purely a non-destructive display transform.
  const display = useMemo(() => mathify(segment.text), [segment.text])

  const requestMath = useCallback(() => {
    setMathPreview(mathify(segment.text))
  }, [segment.text])

  const confirmMath = useCallback(() => {
    if (mathPreview != null) editSegment(segment.id, mathPreview)
    setMathPreview(null)
  }, [editSegment, mathPreview, segment.id])

  return (
    <div
      className={
        'group relative -mx-3 rounded-[var(--nw-radius-sm)] px-3 py-1.5 transition-colors ' +
        (isActiveMatch ? 'bg-[color:var(--nw-warning)]/8 ' : 'hover:bg-[color:var(--nw-surface-muted)]/50')
      }
    >
      <div className="flex gap-3 sm:gap-4">
        <button
          type="button"
          onClick={beginEdit}
          tabIndex={-1}
          aria-hidden="true"
          className="mt-[5px] shrink-0 select-none font-mono text-[11px] tabular-nums text-muted/80 hover:text-accent"
        >
          {formatClock(segment.startedAtEpoch)}
        </button>

        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea
              ref={editRef}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              rows={1}
              aria-label="Edit transcript text"
              className="block w-full resize-none overflow-hidden rounded-[var(--nw-radius-sm)] border border-[color:var(--nw-accent)] bg-[color:var(--nw-surface)] px-2 py-1 font-serif text-[1.0625rem] leading-relaxed text-ink shadow-[var(--nw-shadow-sm)] focus:outline-none"
            />
          ) : (
            <p
              onClick={beginEdit}
              className="cursor-text whitespace-pre-wrap font-serif text-[1.0625rem] leading-relaxed text-ink"
            >
              {isMatch ? (
                <Highlighted text={segment.text} query={query} active={isActiveMatch} />
              ) : (
                <MathText text={display} />
              )}
              {segment.edited && (
                <span
                  className="ml-1.5 align-middle text-[10px] font-medium uppercase tracking-wide text-muted/60"
                  title="Edited"
                >
                  ·edited
                </span>
              )}
            </p>
          )}

          {mathPreview != null && (
            <div className="mt-2 rounded-[var(--nw-radius-sm)] border border-[color:var(--nw-accent)] bg-[color:var(--nw-accent-soft)]/50 p-2.5">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-accent">
                Format math — preview
              </p>
              <p className="mb-2 font-serif text-[1.0625rem] leading-relaxed text-ink">
                <MathText text={mathPreview} />
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirmMath}
                  className="rounded-[var(--nw-radius-sm)] bg-accent px-2.5 py-1 text-xs font-medium text-[color:var(--nw-accent-contrast)] hover:bg-[color:var(--nw-accent-strong)]"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => setMathPreview(null)}
                  className="rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)] px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-[color:var(--nw-surface-muted)]"
                >
                  Keep original
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Row actions — appear on hover/focus, hidden on print */}
        {!editing && mathPreview == null && (
          <div
            data-chrome="true"
            className="absolute right-1.5 top-1 flex items-center gap-0.5 rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)]/95 opacity-0 shadow-[var(--nw-shadow-sm)] backdrop-blur transition-opacity focus-within:opacity-100 group-hover:opacity-100"
          >
            {canFormatMath && (
              <IconButton label="Format math in this line" size="sm" onClick={requestMath} className="h-7 w-7 text-[13px]">
                <span className="font-serif">∑</span>
              </IconButton>
            )}
            <IconButton label="Edit this line" size="sm" onClick={beginEdit} className="h-7 w-7 text-[12px]">
              ✎
            </IconButton>
            <IconButton
              label="Delete this line"
              size="sm"
              variant="danger"
              onClick={() => deleteSegment(segment.id)}
              className="h-7 w-7 border-0 text-[12px]"
            >
              ✕
            </IconButton>
          </div>
        )}
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------ *
 * Image row
 * ------------------------------------------------------------------ */

const ImageRow = memo(function ImageRow({ image }: { image: NoteImage }) {
  const updateImage = useSession((s) => s.updateImage)
  const [caption, setCaption] = useState(image.caption)
  const captionRef = useAutosize<HTMLTextAreaElement>(caption)

  // Reflect external caption changes (e.g. edited from the dock).
  useEffect(() => setCaption(image.caption), [image.caption])

  const commitCaption = useCallback(() => {
    if (caption !== image.caption) updateImage(image.id, { caption })
  }, [caption, image.caption, image.id, updateImage])

  return (
    <figure className="my-3 overflow-hidden rounded-[var(--nw-radius-lg)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] shadow-[var(--nw-shadow-sm)]">
      <img
        src={image.dataUrl}
        alt={image.caption.trim() || image.name}
        loading="lazy"
        className="block max-h-[60vh] w-full bg-[color:var(--nw-surface-muted)] object-contain"
      />
      <figcaption className="border-t border-[color:var(--color-hairline)] px-3.5 py-2.5">
        <textarea
          ref={captionRef}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={commitCaption}
          rows={1}
          placeholder="Add a caption…"
          aria-label={`Caption for ${image.name}`}
          className="block w-full resize-none overflow-hidden border-0 bg-transparent p-0 font-sans text-sm text-ink-soft placeholder:text-muted/70 focus:outline-none"
        />
        {image.capturedAtEpoch != null && (
          <p className="mt-1 font-mono text-[11px] tabular-nums text-muted">
            Captured {formatClock(image.capturedAtEpoch)}
          </p>
        )}
      </figcaption>
    </figure>
  )
})

/* ------------------------------------------------------------------ *
 * Static print copy (full, non-virtualized)
 * ------------------------------------------------------------------ */

function PrintDocument({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div className="hidden font-serif text-[1.0625rem] leading-relaxed text-ink print:block">
      {entries.map((entry) =>
        entry.kind === 'segment' ? (
          <p key={entry.segment.id} className="mb-3 flex gap-4">
            <span className="mt-[5px] shrink-0 select-none font-mono text-[11px] tabular-nums text-muted">
              {formatClock(entry.segment.startedAtEpoch)}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap">
              <MathText text={mathify(entry.segment.text)} />
            </span>
          </p>
        ) : (
          <figure key={entry.image.id} className="my-3">
            <img
              src={entry.image.dataUrl}
              alt={entry.image.caption.trim() || entry.image.name}
              className="block w-full rounded-[var(--nw-radius-sm)] border border-[color:var(--color-hairline)]"
            />
            <figcaption className="mt-1.5 font-sans text-sm text-ink-soft">
              {entry.image.caption.trim() || entry.image.name}
              {entry.image.capturedAtEpoch != null && (
                <span className="ml-2 font-mono text-[11px] text-muted">
                  Captured {formatClock(entry.image.capturedAtEpoch)}
                </span>
              )}
            </figcaption>
          </figure>
        ),
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Connection recovery status
 * ------------------------------------------------------------------ */

/** How long the brief, reassuring confirmations (reconnected / session complete) linger. */
const CONFIRMATION_VISIBLE_MS = 4000

/**
 * Reassures the reader, inside the document, that their notes are safe while the
 * transcription connection is recovering, and confirms briefly when it comes back or when
 * the session finishes.
 *
 * Deliberately a separate component (not part of NotesView's body) so subscribing to
 * `connection` / `status` never re-renders the virtualized timeline; this is purely
 * viewport chrome, stacked just above the live interim line. It stays out of the way and
 * never blocks the notes (pointer-events-none), and is marked chrome + print:hidden so it
 * never exports.
 *
 * What it shows:
 *   - a calm amber "Microphone is blocked" line whenever `connection` is `error` (a
 *     permission block the user must resolve; shown regardless of status, never auto-hidden);
 *   - while recording: a calm amber banner for `reconnecting` (covers both a service
 *     reconnect and a busy/locked microphone that auto-recovers) and `offline`;
 *   - a short green "Reconnected" confirmation once the connection returns to `live` after
 *     having been away;
 *   - a short green "Session complete. Saved." confirmation when the session enters
 *     `stopped` (manual Stop or the idle auto-complete, which can fire from paused too).
 * Nothing shows for a normal `live` connection, while idle, or while paused.
 */
function RecoveryStatus() {
  const connection = useSession((s) => s.connection)
  const status = useSession((s) => s.status)

  // Previous connection / status values, so we can detect transitions without store fields.
  // Both are seeded with the current value so the first render (incl. a hydrated 'stopped'
  // session) never flashes a confirmation that didn't just happen.
  const prevConnection = useRef(connection)
  const prevStatus = useRef(status)
  const [showReconnected, setShowReconnected] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  // Separate timers: a reconnect and a session-complete confirmation must not cancel
  // each other (they can never co-display, but each owns its own auto-hide lifecycle).
  const reconnectedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Detect connection coming back to `live` after a reconnecting/offline spell.
  useEffect(() => {
    const wasRecovering =
      prevConnection.current === 'reconnecting' || prevConnection.current === 'offline'
    // Always keep the ref current (ungated), so the transition check never goes stale.
    prevConnection.current = connection

    if (connection === 'live' && wasRecovering) {
      setShowReconnected(true)
      if (reconnectedTimer.current != null) clearTimeout(reconnectedTimer.current)
      reconnectedTimer.current = setTimeout(() => {
        reconnectedTimer.current = null
        setShowReconnected(false)
      }, CONFIRMATION_VISIBLE_MS)
    } else if (connection !== 'live') {
      // Connection left "live" again (e.g. a flap): drop any pending confirmation at once.
      if (reconnectedTimer.current != null) {
        clearTimeout(reconnectedTimer.current)
        reconnectedTimer.current = null
      }
      setShowReconnected(false)
    }
  }, [connection])

  // Detect the session finishing: entry into `stopped` from any other state. We watch for
  // entry (not strictly recording -> stopped) because the idle auto-complete can stop a
  // paused session too, and that finish deserves the same confirmation.
  useEffect(() => {
    const justStopped = prevStatus.current !== 'stopped' && status === 'stopped'
    prevStatus.current = status

    if (justStopped) {
      setShowComplete(true)
      if (completeTimer.current != null) clearTimeout(completeTimer.current)
      completeTimer.current = setTimeout(() => {
        completeTimer.current = null
        setShowComplete(false)
      }, CONFIRMATION_VISIBLE_MS)
    } else if (status !== 'stopped') {
      // Recording again (a new session): clear any lingering completion confirmation.
      if (completeTimer.current != null) {
        clearTimeout(completeTimer.current)
        completeTimer.current = null
      }
      setShowComplete(false)
    }
  }, [status])

  // Clear both timers if we unmount mid-confirmation (e.g. the document empties).
  useEffect(
    () => () => {
      if (reconnectedTimer.current != null) clearTimeout(reconnectedTimer.current)
      if (completeTimer.current != null) clearTimeout(completeTimer.current)
    },
    [],
  )

  const isRecording = status === 'recording'
  // A blocked microphone is a terminal condition the user must resolve, so it is shown
  // regardless of status (it is not auto-retried, unlike reconnecting/offline) and takes
  // priority over every other state.
  const showError = connection === 'error'
  const showReconnecting = isRecording && connection === 'reconnecting'
  const showOffline = isRecording && connection === 'offline'

  // The confirmations can outlast recording (you may stop right as the connection returns,
  // and "complete" is itself a stopped-state message), so they aren't gated on recording;
  // the live recovering banners are. Session-complete takes precedence over the recovering
  // banners: once stopped, the connection no longer matters.
  if (!showError && !showReconnecting && !showOffline && !showReconnected && !showComplete) {
    return null
  }

  // Two visual registers: a calm amber "attention" tone for anything still in flight or
  // needing the reader (error / reconnecting / offline), and a green "all good" tone for
  // the brief confirmations. Within attention, only the auto-retrying states pulse; the
  // blocked-mic error is static because it waits on the user, not on the network.
  const attention = showError || showReconnecting || showOffline
  const message = showError
    ? 'Microphone is blocked. Allow microphone access in your browser, then press Record again.'
    : showComplete
      ? 'Session complete. Saved.'
      : showOffline
        ? 'You appear to be offline. Recording will resume automatically when you are back online. Your notes are saved.'
        : showReconnecting
          ? 'Reconnecting. Your notes so far are saved.'
          : 'Reconnected. Recording continues.'

  return (
    <div
      data-chrome="true"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-4 print:hidden"
    >
      <div
        className={
          'flex w-full max-w-[820px] items-center gap-2.5 rounded-[var(--nw-radius-lg)] border px-4 py-2.5 text-sm font-medium shadow-[var(--nw-shadow-md)] backdrop-blur ' +
          (attention
            ? 'border-[color:var(--nw-warning)]/30 bg-[color:#fbf0e3]/95 text-[color:var(--nw-warning)]'
            : 'border-[color:var(--nw-success)]/30 bg-[color:#e6f4ec]/95 text-[color:var(--nw-success)]')
        }
      >
        {showError ? (
          <span aria-hidden="true" className="shrink-0 text-base leading-none">
            ⚠
          </span>
        ) : attention ? (
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-current"
          />
        ) : (
          <span aria-hidden="true" className="shrink-0 text-base leading-none">
            ✓
          </span>
        )}
        <span className="min-w-0 flex-1">{message}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * NotesView
 * ------------------------------------------------------------------ */

export function NotesView() {
  const segments = useSession((s) => s.segments)
  const images = useSession((s) => s.images)
  const clockOffsetMs = useSession((s) => s.clockOffsetMs)
  const interimText = useSession((s) => s.interimText)
  const status = useSession((s) => s.status)

  const query = useNotesUi((s) => s.query)
  const activeMatch = useNotesUi((s) => s.activeMatch)
  const scrollNonce = useNotesUi((s) => s.scrollNonce)
  const printRequested = useNotesUi((s) => s.printRequested)
  const setMatchCount = useNotesUi((s) => s.setMatchCount)

  const parentRef = useRef<HTMLDivElement>(null)
  // True while WE are scrolling programmatically, so the scroll handler doesn't mistake it
  // for the reader scrolling away from the live tail.
  const programmaticScroll = useRef(false)
  const [atTail, setAtTail] = useState(true)
  // The list's distance from the top of the document. The window virtualizer needs this as
  // its scrollMargin, or every row is offset by the masthead's height. The ref is null on
  // the first render, so we measure in a layout effect (and on resize) and re-render with
  // the real value before the browser paints.
  const [listOffsetTop, setListOffsetTop] = useState(0)

  // The interleaved reading order. Memoized so interim updates never rebuild it.
  const timeline = useMemo(
    () => buildTimeline(segments, images, clockOffsetMs),
    [segments, images, clockOffsetMs],
  )

  // The trimmed query is the single source of truth: match detection AND highlight
  // rendering must use the exact same string, or a trailing space (a common mid-type
  // state) counts a row as a match while highlightRanges finds nothing to <mark>.
  const q = query.trim()

  // Indices (into `timeline`) of segments that match the active query.
  const matchIndices = useMemo(() => {
    if (q === '') return [] as number[]
    const out: number[] = []
    timeline.forEach((entry, i) => {
      if (entry.kind === 'segment' && highlightRanges(entry.segment.text, q).length > 0) {
        out.push(i)
      }
    })
    return out
  }, [timeline, q])

  // Publish the match total so the Toolbar counter and nav stay in sync.
  useEffect(() => {
    setMatchCount(matchIndices.length)
  }, [matchIndices.length, setMatchCount])

  const activeMatchTimelineIndex =
    activeMatch >= 0 && activeMatch < matchIndices.length ? matchIndices[activeMatch] : -1
  const matchIndexSet = useMemo(() => new Set(matchIndices), [matchIndices])

  const virtualizer = useWindowVirtualizer({
    count: timeline.length,
    estimateSize: () => 84,
    overscan: 8,
    // The list does not start at the top of the page (the masthead is above it); feed the
    // virtualizer that offset or every row is mispositioned by the masthead's height.
    scrollMargin: listOffsetTop,
    getItemKey: (index) => {
      const entry = timeline[index]
      return entry.kind === 'segment' ? `s:${entry.segment.id}` : `i:${entry.image.id}`
    },
  })

  // Measure the list's offset from the document top (its scrollMargin) before paint, and
  // keep it current as the masthead reflows on resize. timeline.length is a dependency so
  // the measurement re-runs when the list first mounts out of the empty state.
  useLayoutEffect(() => {
    const measure = (): void => {
      const top = parentRef.current?.offsetTop ?? 0
      setListOffsetTop((prev) => (prev === top ? prev : top))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [timeline.length])

  // --- Auto-scroll to the newest content while recording (unless the reader scrolled up).
  const scrollToTail = useCallback(() => {
    if (timeline.length === 0) return
    programmaticScroll.current = true
    virtualizer.scrollToIndex(timeline.length - 1, { align: 'end' })
    // Also pin the window to the very bottom so the fixed interim line stays in view.
    window.scrollTo({ top: document.documentElement.scrollHeight })
    requestAnimationFrame(() => {
      programmaticScroll.current = false
    })
  }, [timeline.length, virtualizer])

  useEffect(() => {
    if (status === 'recording' && atTail) scrollToTail()
    // Re-run when new content arrives (timeline length or interim text changes).
  }, [status, atTail, timeline.length, interimText, scrollToTail])

  // Track whether the reader is near the bottom; ignore our own programmatic scrolls.
  useEffect(() => {
    const onScroll = (): void => {
      if (programmaticScroll.current) return
      const remaining =
        document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)
      setAtTail(remaining <= LIVE_TAIL_THRESHOLD)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // --- Scroll to the active search match when navigation requests it.
  useLayoutEffect(() => {
    if (activeMatchTimelineIndex < 0) return
    programmaticScroll.current = true
    virtualizer.scrollToIndex(activeMatchTimelineIndex, { align: 'center' })
    // Variable-size rows may settle after first measure; re-issue once on the next frame.
    const raf = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(activeMatchTimelineIndex, { align: 'center' })
      programmaticScroll.current = false
    })
    return () => cancelAnimationFrame(raf)
    // scrollNonce drives re-scroll even when the index is unchanged (e.g. single match).
  }, [scrollNonce, activeMatchTimelineIndex, virtualizer])

  const isRecording = status === 'recording'
  const showInterim = isRecording && interimText.trim() !== ''
  const isEmpty = timeline.length === 0 && !showInterim
  const items = virtualizer.getVirtualItems()

  return (
    <div className="relative">
      {/* Empty state */}
      {isEmpty && !printRequested && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <div
            aria-hidden="true"
            className="grid h-14 w-14 place-items-center rounded-full bg-[color:var(--nw-accent-soft)] text-2xl text-accent"
          >
            ❝
          </div>
          <h2 className="font-serif text-xl font-semibold text-ink">Your notes will appear here</h2>
          <p className="max-w-sm font-sans text-sm leading-relaxed text-muted">
            Press <span className="font-medium text-ink-soft">Record</span> to begin. Import photos
            anytime, they slot in by capture time. Spoken words are transcribed live and saved as
            you go.
          </p>
        </div>
      )}

      {/* Live virtualized document (hidden on print — see PrintDocument for the full copy) */}
      {!isEmpty && (
        <div ref={parentRef} className="print:hidden">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {items.map((item) => {
              const entry = timeline[item.index]
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  {entry.kind === 'segment' ? (
                    <SegmentRow
                      segment={entry.segment}
                      query={q}
                      isMatch={matchIndexSet.has(item.index)}
                      isActiveMatch={item.index === activeMatchTimelineIndex}
                    />
                  ) : (
                    <ImageRow image={entry.image} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Full static document for printing (mounted only when a print was requested). */}
      {printRequested && <PrintDocument entries={timeline} />}

      {/* Live interim line — fixed viewport chrome, never persisted or printed. */}
      {showInterim && (
        <div
          data-chrome="true"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4"
        >
          <div className="flex w-full max-w-[820px] items-baseline gap-3 rounded-[var(--nw-radius-lg)] border border-[color:var(--nw-accent)]/30 bg-[color:var(--nw-surface)]/95 px-4 py-2.5 shadow-[var(--nw-shadow-lg)] backdrop-blur sm:gap-4">
            <span
              aria-hidden="true"
              className="mt-1 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-[color:var(--nw-danger)]"
            />
            <span className="min-w-0 flex-1 whitespace-pre-wrap font-serif text-[1.0625rem] italic leading-relaxed text-ink-soft">
              {interimText}
            </span>
          </div>
        </div>
      )}

      {/* In-document recovery reassurance: separate chrome, stacks above the interim line. */}
      <RecoveryStatus />

      {/* Jump to live — fixed chrome, shown only when the reader scrolled away mid-record. */}
      {isRecording && !atTail && (
        <button
          type="button"
          data-chrome="true"
          onClick={() => {
            setAtTail(true)
            scrollToTail()
          }}
          className="fixed bottom-20 left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-[color:var(--nw-accent-contrast)] shadow-[var(--nw-shadow-lg)] transition-transform hover:bg-[color:var(--nw-accent-strong)] active:translate-y-px"
        >
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          Jump to live
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  )
}
