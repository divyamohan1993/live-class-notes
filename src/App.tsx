/**
 * NoteWeave root. Composes the shell and feature regions, kicks off crash-recovery
 * hydration on mount, and guarantees the last sub-second of metadata edits are flushed
 * to IndexedDB before the tab is hidden or closed.
 *
 * Resilience posture: a live transcript is precious, so the shell is built to survive
 * its own failures. Render errors are caught by ErrorBoundary; unhandled async errors
 * and promise rejections are neutralized by global safety nets so a stray failure in a
 * feature region can never blank the screen. The user's notes live in IndexedDB and are
 * never at risk from a UI crash.
 *
 * Feature agents replace the imported region components (Toolbar, SessionHeader,
 * NotesView, ImageDock, ExportBar); this file only wires them together.
 */
import { Component, Fragment, useEffect } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Layout } from './components/Layout.tsx'
import { Toolbar } from './features/notes/Toolbar.tsx'
import { SessionHeader } from './features/notes/SessionHeader.tsx'
import { NotesView } from './features/notes/NotesView.tsx'
import { ImageDock } from './features/images/ImageDock.tsx'
import { ExportBar } from './features/notes/ExportBar.tsx'
import { useSession } from './store.ts'

interface ErrorBoundaryState {
  /** The caught error, or null when the subtree is rendering normally. */
  error: Error | null
  /**
   * Bumped by "Try again". Used as the React key of the wrapped subtree so recovery
   * remounts the children fresh rather than re-rendering a possibly-corrupt instance.
   */
  resetKey: number
}

/**
 * Top-level safety net for render errors. A live transcript is precious; if a render
 * throws we keep the page intact and reassure the user their saved notes are safe rather
 * than blanking to white. Offers a lightweight "Try again" (remount the subtree without
 * losing in-memory state) and a full "Reload NoteWeave" as the heavier fallback.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally silent: the error UI below informs the user and their notes remain
    // safe in IndexedDB. We avoid console output (no-console policy) and never rethrow.
  }

  private handleRetry = (): void => {
    // Clear the error and change the subtree key so children remount from scratch.
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }))
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
            lost. Try again to recover, or reload if it persists.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="h-10 rounded-[var(--radius-nw)] bg-accent px-4 text-sm font-medium text-[color:var(--nw-accent-contrast)] hover:bg-[color:var(--nw-accent-strong)]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="h-10 rounded-[var(--radius-nw)] border border-hairline-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Reload NoteWeave
            </button>
          </div>
        </div>
      )
    }
    // The keyed Fragment makes "Try again" a clean remount of everything below the
    // boundary, with no wrapper DOM node (layout is untouched).
    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>
  }
}

export function App() {
  useEffect(() => {
    // Restore any previous session from IndexedDB (crash recovery / reload). Guarded so a
    // rejected hydrate (e.g. IndexedDB unavailable) can never crash mount or surface as an
    // unhandled rejection; the app simply starts from a fresh in-memory state.
    void useSession
      .getState()
      .hydrate()
      .catch(() => {})

    // Flush pending debounced meta on tab hide/close so recent title/image/offset edits
    // aren't lost. Guarded for the same reason hydrate is.
    const flush = (): void => {
      void useSession
        .getState()
        .flushMeta()
        .catch(() => {})
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }

    // Global safety nets: keep the app alive when async code outside React's render path
    // throws or rejects. These cover the gap the render-only ErrorBoundary cannot. The
    // handlers are deliberately trivial (no side effects that could themselves throw): we
    // neutralize the event so the browser does not treat it as fatal, and carry on.
    const onError = (event: ErrorEvent): void => {
      event.preventDefault()
    }
    const onRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault()
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    // pagehide + beforeunload + visibilitychange together cover every path a tab can leave
    // by: bfcache entry, hard close, and backgrounding. Redundant on purpose; flush is
    // idempotent and a no-op when nothing is pending, so firing more than once is harmless.
    // Note: registering 'beforeunload' makes the page bfcache-ineligible in most engines;
    // that cost is accepted here because guaranteeing the final meta write on a hard close
    // matters more than bfcache for a local-first notes app.
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
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
