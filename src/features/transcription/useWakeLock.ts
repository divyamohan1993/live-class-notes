/**
 * Screen Wake Lock hook.
 *
 * A multi-hour lecture must not be cut short by the display sleeping mid-sentence, which
 * would also suspend the page (and the recognizer) on many devices. While held, we keep a
 * `screen` wake lock and transparently re-acquire it when the tab becomes visible again —
 * the OS releases the lock automatically whenever the page is hidden, so a held lock must
 * be re-requested on every visibility regain.
 *
 * The Screen Wake Lock API is absent on some browsers (notably older Safari) and rejects in
 * insecure contexts; every interaction is wrapped so its absence is a silent no-op and never
 * throws. The lock is a best-effort endurance aid, not a correctness dependency.
 */
import { useCallback, useEffect, useRef } from 'react'

export function useWakeLock(): { request: () => void; release: () => void } {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  /** True while the caller wants the lock held; drives re-acquire on visibility regain. */
  const wantedRef = useRef(false)

  const acquire = useCallback(async () => {
    if (!wantedRef.current) return
    if (sentinelRef.current) return
    const wakeLock = navigator.wakeLock
    if (!wakeLock) return
    try {
      const sentinel = await wakeLock.request('screen')
      // If the caller released while we were awaiting, immediately let this one go.
      if (!wantedRef.current) {
        void sentinel.release().catch(() => {})
        return
      }
      sentinel.addEventListener('release', () => {
        // The OS dropped it (tab hidden, etc.). Clear our handle; visibility regain re-acquires.
        if (sentinelRef.current === sentinel) sentinelRef.current = null
      })
      sentinelRef.current = sentinel
    } catch {
      // Permission denied, insecure context, or unsupported — endurance is best-effort.
    }
  }, [])

  const request = useCallback(() => {
    wantedRef.current = true
    void acquire()
  }, [acquire])

  const release = useCallback(() => {
    wantedRef.current = false
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    if (sentinel) void sentinel.release().catch(() => {})
  }, [])

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && wantedRef.current) {
        void acquire()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      // Release on unmount so we never leak a held lock past the hook's lifetime.
      wantedRef.current = false
      const sentinel = sentinelRef.current
      sentinelRef.current = null
      if (sentinel) void sentinel.release().catch(() => {})
    }
  }, [acquire])

  return { request, release }
}
