/**
 * NoteWeave application shell.
 *
 * Responsibilities (and nothing more — feature agents own what goes *inside* the slots):
 *   - A sticky top toolbar region, marked [data-chrome] so it is hidden on print.
 *   - A centered, scrollable "paper" notes column (max-width ~820px) marked
 *     [data-print-page] so print CSS can expand it full-width with black-on-white ink.
 *   - A companion image dock: a right rail on wide screens, stacked below on narrow ones.
 *     Also chrome (excluded from print) since exporters embed images inline themselves.
 *
 * The shell is responsive and uses only the shared design tokens.
 */
import type { ReactNode } from 'react'

export interface LayoutProps {
  /** Top app bar (title, recording controls, status). Hidden on print. */
  toolbar: ReactNode
  /** Session header card (title, course, instructor, date). Part of the printed page. */
  header?: ReactNode
  /** The transcript / notes body. The main printed content. */
  children: ReactNode
  /** Image import + alignment panel. Chrome; stacked below notes on narrow screens. */
  dock?: ReactNode
  /** Export controls row, rendered at the foot of the notes column. Hidden on print. */
  exportBar?: ReactNode
}

export function Layout({ toolbar, header, children, dock, exportBar }: LayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-[color:var(--nw-paper)]">
      <header
        data-chrome="true"
        className="sticky top-0 z-30 border-b border-[color:var(--color-hairline)] bg-[color:var(--nw-paper)]/95 backdrop-blur supports-[backdrop-filter]:bg-[color:var(--nw-paper)]/80"
      >
        {toolbar}
      </header>

      <div className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col gap-6 px-4 py-6 lg:flex-row lg:items-start lg:px-6">
        {/* Notes column — the printed page. */}
        <main className="min-w-0 flex-1">
          <article
            data-print-page="true"
            className="mx-auto w-full max-w-[820px] rounded-[var(--nw-radius-lg)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] shadow-[var(--nw-shadow-md)]"
          >
            {header}
            <div className="px-6 pb-8 pt-2 sm:px-10">{children}</div>
            {exportBar && (
              <div
                data-chrome="true"
                className="border-t border-[color:var(--color-hairline)] px-6 py-3 sm:px-10"
              >
                {exportBar}
              </div>
            )}
          </article>
        </main>

        {/* Image dock — right rail on desktop, stacked below on narrow screens. */}
        {dock && (
          <aside
            data-chrome="true"
            className="w-full shrink-0 lg:sticky lg:top-[5.5rem] lg:max-h-[calc(100vh-7rem)] lg:w-[340px] lg:overflow-y-auto"
          >
            {dock}
          </aside>
        )}
      </div>
    </div>
  )
}
