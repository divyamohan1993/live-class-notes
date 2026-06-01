/**
 * Saved sessions: the archive browser.
 *
 * Completed sessions are written to permanent local storage; this dialog is how a student
 * actually gets back to them. It is an accessible modal (role="dialog", aria-modal): Escape
 * or an outside click closes it, focus moves to the close button on open and is restored to
 * the trigger on close, and Tab is trapped inside while it is open. It is app chrome
 * (data-chrome="true"), so it never appears in printed/exported notes.
 *
 * All archive access goes through the frozen store contract (archive / list / load / delete).
 * Each is awaited; failures surface as an inline message instead of crashing the dialog, and
 * the list is re-read after every open, save, and delete so what is shown stays truthful.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button, IconButton } from '../../components/ui.tsx'
import { useSession } from '../../store.ts'
import type { ArchivedSessionSummary } from '../../types.ts'

export interface SessionsPanelProps {
  open: boolean
  onClose: () => void
}

/** Newest first: createdAtEpoch is always present, so it gives a stable total order. */
function byNewest(a: ArchivedSessionSummary, b: ArchivedSessionSummary): number {
  return b.createdAtEpoch - a.createdAtEpoch
}

/** A session's saved length, e.g. "12 segments · 3 photos". */
function describeCounts(s: ArchivedSessionSummary): string {
  const seg = `${s.segmentCount} ${s.segmentCount === 1 ? 'segment' : 'segments'}`
  const img = `${s.imageCount} ${s.imageCount === 1 ? 'photo' : 'photos'}`
  return `${seg} · ${img}`
}

export function SessionsPanel({ open, onClose }: SessionsPanelProps) {
  // Each archive action is selected individually so selectors never return fresh refs.
  const archiveCurrentSession = useSession((s) => s.archiveCurrentSession)
  const listArchivedSessions = useSession((s) => s.listArchivedSessions)
  const loadArchivedSession = useSession((s) => s.loadArchivedSession)
  const deleteArchivedSession = useSession((s) => s.deleteArchivedSession)

  const [sessions, setSessions] = useState<ArchivedSessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** True while save/open/delete is in flight; blocks overlapping archive mutations. */
  const [busy, setBusy] = useState(false)
  /** Row awaiting a second click to confirm deletion (inline, no separate dialog). */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  // Element focused before the dialog opened, so we can hand focus back on close.
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()

  /** Re-read the archive. Tolerates a rejecting/absent backend without crashing. */
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listArchivedSessions()
      setSessions([...list].sort(byNewest))
    } catch {
      setError('Could not load your saved sessions. Please try again.')
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [listArchivedSessions])

  // On open: remember what had focus, reset transient UI, load the archive, and focus the
  // close button so the dialog is immediately keyboard-operable. On close: hand focus back to
  // whatever opened us (the trigger lives in the toolbar, outside this component). Because the
  // dialog traps focus while open, on any close focus was inside it, so restoring to the
  // trigger is always the right move, guarded only by the trigger still being in the DOM.
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
    setConfirmingId(null)
    setBusy(false) // A prior Open closes without resetting busy; start every open unblocked.
    void refresh()
    // Focus the close button after paint so it exists; rAF avoids a first-mount layout race.
    // The atoms aren't forwardRef, so we reach it by a marker attribute on the dialog subtree.
    const raf = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>('[data-autofocus="true"]')?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      const toRestore = restoreFocusRef.current
      restoreFocusRef.current = null
      if (toRestore && toRestore.isConnected) toRestore.focus()
    }
  }, [open, refresh])

  // Escape closes; outside (backdrop) click closes. Registered only while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /** Trap Tab within the dialog so keyboard focus can't wander to the page behind it. */
  const onDialogKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (!root) return
    const focusable = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  const onSave = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await archiveCurrentSession()
      await refresh()
    } catch {
      setError('Could not save the current session. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [busy, archiveCurrentSession, refresh])

  const onOpen = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        await loadArchivedSession(id)
        onClose()
      } catch {
        setError('Could not open that session. Please try again.')
        setBusy(false) // Stay open on failure so the user can retry; no close happened.
      }
    },
    [busy, loadArchivedSession, onClose],
  )

  const onDelete = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        await deleteArchivedSession(id)
        setConfirmingId(null)
        await refresh()
      } catch {
        setError('Could not delete that session. Please try again.')
      } finally {
        setBusy(false)
      }
    },
    [busy, deleteArchivedSession, refresh],
  )

  if (!open) return null

  const hasSessions = sessions.length > 0

  return (
    <div
      data-chrome="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[color:rgba(31,35,40,0.45)] p-4 backdrop-blur-sm sm:items-center sm:p-6"
      // Backdrop click closes; clicks inside the dialog (which stops propagation below) do not.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onDialogKeyDown}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--nw-radius-lg)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] shadow-[var(--nw-shadow-lg)]"
      >
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 border-b border-[color:var(--color-hairline)] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="font-serif text-lg font-semibold tracking-tight text-ink">
              Saved sessions
            </h2>
            <p id={descId} className="mt-0.5 text-xs text-muted">
              Completed classes are saved here. Open one to keep working on it.
            </p>
          </div>
          <IconButton
            data-autofocus="true"
            label="Close saved sessions"
            size="sm"
            onClick={onClose}
            className="shrink-0"
          >
            ✕
          </IconButton>
        </div>

        {/* ── Top action: save the current session ───────────────────────────── */}
        <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] bg-[color:var(--nw-surface-muted)]/50 px-5 py-3">
          <span className="text-xs text-muted">Keep the session you're in for later.</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onSave()}
            disabled={busy}
            leading={<span aria-hidden="true">⤓</span>}
          >
            {busy ? 'Saving…' : 'Save current session'}
          </Button>
        </div>

        {/* ── Error (non-fatal) ──────────────────────────────────────────────── */}
        {error != null && (
          <p
            role="alert"
            className="border-b border-[color:var(--nw-danger)]/30 bg-[color:var(--nw-danger-soft)] px-5 py-2.5 text-xs text-[color:var(--nw-danger)]"
          >
            {error}
          </p>
        )}

        {/* ── List / loading / empty ─────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="px-5 py-10 text-center text-sm text-muted" role="status" aria-live="polite">
              Loading saved sessions…
            </p>
          ) : !hasSessions ? (
            <div className="px-5 py-12 text-center">
              <span aria-hidden="true" className="text-2xl text-muted">
                🕑
              </span>
              <p className="mt-2 text-sm font-medium text-ink">No saved sessions yet.</p>
              <p className="mt-1 text-xs text-muted">
                Completed sessions are saved here automatically.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-hairline)]">
              {sessions.map((s) => {
                const confirming = confirmingId === s.id
                return (
                  <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink" title={s.title}>
                        {s.title || 'Untitled Class Notes'}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {s.dateLabel}
                        <span aria-hidden="true"> · </span>
                        {describeCounts(s)}
                      </p>
                    </div>

                    {confirming ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-xs text-muted">Delete?</span>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void onDelete(s.id)}
                          disabled={busy}
                        >
                          Yes, delete
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmingId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void onOpen(s.id)}
                          disabled={busy}
                        >
                          Open
                        </Button>
                        <IconButton
                          size="sm"
                          variant="danger"
                          label={`Delete ${s.title || 'untitled session'}`}
                          onClick={() => setConfirmingId(s.id)}
                          disabled={busy}
                        >
                          ✕
                        </IconButton>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
