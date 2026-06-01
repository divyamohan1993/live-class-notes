/**
 * Export controls — the foot of the notes page.
 *
 * One labelled "Export" menu offers the four targets implemented in `exporters.ts`
 * (PDF via print, Word, HTML, Markdown). The whole control is disabled until there is
 * something worth exporting. The menu is keyboard-accessible (Arrow keys, Enter, Escape)
 * and closes on outside click or blur; it's chrome, so it never prints.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '../../components/ui.tsx'
import { useSession } from '../../store.ts'
import { exportDocx, exportHtml, exportMarkdown, exportPrint } from './exporters.ts'

interface ExportOption {
  key: string
  label: string
  hint: string
  glyph: string
  run: () => void | Promise<void>
}

const OPTIONS: ExportOption[] = [
  { key: 'pdf', label: 'PDF', hint: 'Print-ready document', glyph: '⎙', run: exportPrint },
  { key: 'docx', label: 'Word', hint: '.docx for editing', glyph: 'W', run: exportDocx },
  { key: 'html', label: 'HTML', hint: 'Self-contained web page', glyph: '◇', run: exportHtml },
  { key: 'md', label: 'Markdown', hint: '.md plain text', glyph: '↓', run: exportMarkdown },
]

export function ExportBar() {
  const segmentCount = useSession((s) => s.segments.length)
  const imageCount = useSession((s) => s.images.length)
  const hasContent = segmentCount > 0 || imageCount > 0

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()

  const close = useCallback(() => setOpen(false), [])

  // Close and return focus to the trigger — for keyboard-driven dismissals (Escape) and
  // after picking an item, matching native menu behavior. The Button atom isn't a
  // forwardRef, so we reach the trigger through the container rather than a ref.
  const closeAndRestore = useCallback(() => {
    setOpen(false)
    rootRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus()
  }, [])

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') closeAndRestore()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close, closeAndRestore])

  // Move focus onto the active item as the user arrows through the menu.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  const runOption = useCallback(async (option: ExportOption) => {
    closeAndRestore()
    setBusy(true)
    try {
      await option.run()
    } finally {
      setBusy(false)
    }
  }, [closeAndRestore])

  const onTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setActiveIndex(0)
        setOpen(true)
      }
    },
    [],
  )

  const onMenuKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % OPTIONS.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length)
      } else if (e.key === 'Home') {
        e.preventDefault()
        setActiveIndex(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setActiveIndex(OPTIONS.length - 1)
      }
    },
    [],
  )

  return (
    <div className="flex items-center justify-between gap-3" data-chrome="true">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-sans font-medium uppercase tracking-[0.12em]">Export</span>
        <span aria-hidden="true" className="text-[color:var(--nw-border-strong)]">·</span>
        <span>{hasContent ? 'PDF · Word · HTML · Markdown' : 'Nothing to export yet'}</span>
      </div>

      <div ref={rootRef} className="relative">
        <Button
          variant="primary"
          size="sm"
          disabled={!hasContent || busy}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            setActiveIndex(0)
            setOpen((o) => !o)
          }}
          onKeyDown={onTriggerKeyDown}
          leading={<span aria-hidden="true">⤓</span>}
        >
          {busy ? 'Preparing…' : 'Export'}
          <span aria-hidden="true" className="ml-0.5 text-[10px] opacity-80">▾</span>
        </Button>

        {open && (
          <div
            id={menuId}
            role="menu"
            aria-label="Export format"
            onKeyDown={onMenuKeyDown}
            className="absolute bottom-full right-0 z-40 mb-2 w-60 overflow-hidden rounded-[var(--nw-radius-lg)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] p-1.5 shadow-[var(--nw-shadow-lg)]"
          >
            {OPTIONS.map((option, i) => (
              <button
                key={option.key}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={i === activeIndex ? 0 : -1}
                onClick={() => void runOption(option)}
                onMouseEnter={() => setActiveIndex(i)}
                className="flex w-full items-center gap-3 rounded-[var(--nw-radius-sm)] px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--nw-surface-muted)] focus:bg-[color:var(--nw-surface-muted)] focus:outline-none"
              >
                <span
                  aria-hidden="true"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--nw-radius-sm)] bg-[color:var(--nw-accent-soft)] font-serif text-sm font-semibold text-accent"
                >
                  {option.glyph}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">{option.label}</span>
                  <span className="text-[11px] text-muted">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
