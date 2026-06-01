/**
 * NoteWeave root. Composes the shell and feature regions, kicks off crash-recovery
 * hydration on mount, and guarantees the last sub-second of metadata edits are flushed
 * to IndexedDB before the tab is hidden or closed.
 *
 * Feature agents replace the imported region components (Toolbar, SessionHeader,
 * NotesView, ImageDock, ExportBar); this file only wires them together.
 */
import { Component, useEffect } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Layout } from './components/Layout.tsx'
import { Toolbar } from './features/notes/Toolbar.tsx'
import { SessionHeader } from './features/notes/SessionHeader.tsx'
import { NotesView } from './features/notes/NotesView.tsx'
import { ImageDock } from './features/images/ImageDock.tsx'
import { ExportBar } from './features/notes/ExportBar.tsx'
import { useSession } from './store.ts'

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Top-level safety net. A live transcript is precious; if a render throws we keep the
 * page intact and tell the user their saved notes are safe rather than blanking to white.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced to the console for diagnostics; saved notes remain in IndexedDB.
    // eslint-disable-next-line no-console
    console.error('NoteWeave render error:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
          <p className="text-sm text-muted">
            The screen hit an unexpected error. Your notes are saved locally and were not
            lost. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="h-10 rounded-[var(--radius-nw)] bg-accent px-4 text-sm font-medium text-[color:var(--nw-accent-contrast)] hover:bg-[color:var(--nw-accent-strong)]"
          >
            Reload NoteWeave
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export function App() {
  useEffect(() => {
    // Restore any previous session from IndexedDB (crash recovery / reload).
    void useSession.getState().hydrate()

    // Flush pending debounced meta on tab hide/close so recent edits aren't lost.
    const flush = (): void => {
      void useSession.getState().flushMeta()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <ErrorBoundary>
      <Layout
        toolbar={<Toolbar />}
        header={<SessionHeader />}
        dock={<ImageDock />}
        exportBar={<ExportBar />}
      >
        <NotesView />
      </Layout>
    </ErrorBoundary>
  )
}
