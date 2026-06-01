/**
 * Top application chrome.
 *
 * Layout (per the shell's slot model — this is the toolbar slot only):
 *   left   — the NoteWeave wordmark
 *   center — the live recording control surface (<LiveTranscriber/>)
 *   right  — full-text search that drives the transcript view (via useNotesUi)
 *
 * The session masthead, notes body, image dock, and export bar all live in their own
 * Layout slots, so they are intentionally absent here.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { IconButton } from '../../components/ui.tsx'
import { LiveTranscriber } from '../transcription/LiveTranscriber.tsx'
import { useNotesUi } from './search-store.ts'

/** Woven-thread mark — three interlaced strokes echoing the "NoteWeave" idea. */
function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-9 w-9 place-items-center rounded-[var(--radius-nw)] bg-accent shadow-[var(--nw-shadow-sm)]"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M3 6.5c3.5 0 3.5 7 7 7s3.5-7 7-7M3 13.5c3.5 0 3.5-7 7-7s3.5 7 7 7"
            stroke="var(--nw-accent-contrast)"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.95"
          />
        </svg>
      </span>
      <span className="flex flex-col leading-none">
        <span className="font-serif text-[17px] font-semibold tracking-tight text-ink">
          NoteWeave
        </span>
        <span className="mt-0.5 hidden text-[10px] font-medium uppercase tracking-[0.16em] text-muted sm:block">
          Live Class Notes
        </span>
      </span>
    </div>
  )
}

function SearchBox() {
  const query = useNotesUi((s) => s.query)
  const matchCount = useNotesUi((s) => s.matchCount)
  const activeMatch = useNotesUi((s) => s.activeMatch)
  const setQuery = useNotesUi((s) => s.setQuery)
  const nextMatch = useNotesUi((s) => s.nextMatch)
  const prevMatch = useNotesUi((s) => s.prevMatch)
  const inputRef = useRef<HTMLInputElement>(null)

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    [setQuery],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) prevMatch()
        else nextMatch()
      } else if (e.key === 'Escape' && query !== '') {
        e.preventDefault()
        setQuery('')
      }
    },
    [nextMatch, prevMatch, query, setQuery],
  )

  // Ctrl/Cmd-F focuses our in-document search instead of the browser's.
  useEffect(() => {
    const onShortcut = (e: globalThis.KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  const hasQuery = query.trim() !== ''
  const counter = hasQuery ? (matchCount > 0 ? `${activeMatch + 1}/${matchCount}` : '0/0') : ''

  return (
    <div
      role="search"
      className="flex h-9 items-center gap-1.5 rounded-[var(--radius-nw)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] pl-2.5 pr-1 shadow-[var(--nw-shadow-sm)] transition-colors focus-within:border-[color:var(--nw-accent)] focus-within:ring-2 focus-within:ring-[color:var(--nw-accent-soft)]"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className="shrink-0 text-muted"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Search transcript"
        aria-label="Search transcript"
        className="w-32 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none sm:w-44 lg:w-56 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {counter && (
        <span
          className="select-none whitespace-nowrap font-mono text-[11px] tabular-nums text-muted"
          aria-live="polite"
          aria-atomic="true"
        >
          {counter}
        </span>
      )}
      <div className="flex items-center">
        <IconButton
          label="Previous match"
          size="sm"
          onClick={prevMatch}
          disabled={matchCount === 0}
          className="h-7 w-7 text-[13px]"
        >
          ↑
        </IconButton>
        <IconButton
          label="Next match"
          size="sm"
          onClick={nextMatch}
          disabled={matchCount === 0}
          className="h-7 w-7 text-[13px]"
        >
          ↓
        </IconButton>
      </div>
    </div>
  )
}

export function Toolbar() {
  return (
    <div className="mx-auto flex w-full max-w-[1320px] items-center justify-between gap-3 px-4 py-2.5 lg:gap-6 lg:px-6">
      <Wordmark />
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <LiveTranscriber />
      </div>
      <SearchBox />
    </div>
  )
}
