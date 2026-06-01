/**
 * Notes-feature UI store (Zustand) — state shared between sibling components that the
 * app shell renders into separate Layout slots, so React context cannot reach across them.
 *
 * Two concerns live here, both owned by this feature:
 *   1. Full-text search: the query typed in the Toolbar drives match highlighting and
 *      prev/next navigation in NotesView. Toolbar writes `query`; NotesView publishes how
 *      many matches it found and which one is active, and both read the result.
 *   2. Print intent: `exportPrint()` cannot print a virtualized list (off-screen rows are
 *      not in the DOM). It raises `printRequested` so NotesView mounts a full, static,
 *      print-only copy of the document; once the browser print dialog has been handed the
 *      page we lower the flag again.
 *
 * This is transient view state only — never persisted. The durable session lives in the
 * main `useSession` store.
 */
import { create } from 'zustand'

interface NotesUiState {
  /** Current full-text query (raw, untrimmed as typed). */
  query: string
  /** Total matches NotesView found for the current query. */
  matchCount: number
  /** Index of the active match within the match list, or -1 when there are none. */
  activeMatch: number
  /**
   * Monotonically increasing token bumped whenever the user asks to jump to a match
   * (next/prev or a fresh query). NotesView watches this to (re)issue a scroll, even when
   * the active index itself did not change (e.g. wrapping a single match).
   */
  scrollNonce: number
  /** True while a print render has been requested; NotesView shows its static copy. */
  printRequested: boolean

  /** Set the query and reset navigation to the first match. */
  setQuery: (query: string) => void
  /** Publish the match total found for the current query (clamps the active match). */
  setMatchCount: (count: number) => void
  /** Advance to the next match (wraps); no-op when there are none. */
  nextMatch: () => void
  /** Go to the previous match (wraps); no-op when there are none. */
  prevMatch: () => void
  /** Ask NotesView to re-scroll to the active match without changing it. */
  requestScroll: () => void
  /** Raise/lower the print-copy flag. */
  setPrintRequested: (on: boolean) => void
}

export const useNotesUi = create<NotesUiState>()((set) => ({
  query: '',
  matchCount: 0,
  activeMatch: -1,
  scrollNonce: 0,
  printRequested: false,

  setQuery: (query) =>
    set((s) => ({
      query,
      // A new query restarts navigation; the actual count arrives from NotesView.
      activeMatch: query.trim() === '' ? -1 : 0,
      scrollNonce: s.scrollNonce + 1,
    })),

  setMatchCount: (count) =>
    set((s) => {
      if (count <= 0) return { matchCount: 0, activeMatch: -1 }
      // Keep the active match in range; default to the first match when none was active.
      const active = s.activeMatch < 0 ? 0 : Math.min(s.activeMatch, count - 1)
      return { matchCount: count, activeMatch: active }
    }),

  nextMatch: () =>
    set((s) => {
      if (s.matchCount <= 0) return {}
      const active = (Math.max(s.activeMatch, 0) + 1) % s.matchCount
      return { activeMatch: active, scrollNonce: s.scrollNonce + 1 }
    }),

  prevMatch: () =>
    set((s) => {
      if (s.matchCount <= 0) return {}
      const base = s.activeMatch < 0 ? 0 : s.activeMatch
      const active = (base - 1 + s.matchCount) % s.matchCount
      return { activeMatch: active, scrollNonce: s.scrollNonce + 1 }
    }),

  requestScroll: () => set((s) => ({ scrollNonce: s.scrollNonce + 1 })),

  setPrintRequested: (on) => set({ printRequested: on }),
}))
