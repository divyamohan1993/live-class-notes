/**
 * Auto-grow a <textarea> to fit its content, so editing notes and summaries never opens a
 * nested scrollbar inside the document. Returns a ref to attach; pass the current value so
 * the height recomputes whenever the text changes (including external/programmatic edits).
 */
import { useCallback, useLayoutEffect, useRef } from 'react'

export function useAutosize<T extends HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null)

  const resize = useCallback((el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useLayoutEffect(() => {
    resize(ref.current)
  }, [value, resize])

  return ref
}
