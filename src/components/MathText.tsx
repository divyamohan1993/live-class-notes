/**
 * MathText — renders transcript prose with embedded math turned into real KaTeX.
 *
 * Inline math is delimited by `$...$` or `\(...\)`; display (block) math by
 * `$$...$$` or `\[...\]`. Everything outside a recognized, well-formed delimiter
 * pair is rendered as plain, escaped text via React text nodes — user prose is
 * NEVER injected as HTML, so a stray `<script>` in a transcript can do nothing.
 * Only KaTeX's own output (with its default `trust:false`, which escapes the math
 * source) goes through `dangerouslySetInnerHTML`.
 *
 * Robustness is the contract: malformed LaTeX must never throw. We pass
 * `throwOnError:false` to KaTeX and additionally wrap every render in try/catch,
 * falling back to the literal source so a bad segment degrades to readable text
 * rather than blanking the transcript.
 *
 * Accessibility: KaTeX runs in `htmlAndMathml` mode, so every equation carries
 * visually-hidden MathML that screen readers announce aloud (WCAG 2.2 AA).
 *
 * Example: "Energy is $E = mc^2$, and $$\int_0^1 x\,dx = \tfrac12$$."
 *   -> prose + inline equation + prose + a centered display equation.
 */
import { memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import katex from 'katex'

/** A parsed run of the input: either prose (escaped as text) or math (rendered). */
type Token =
  | { kind: 'text'; value: string }
  | { kind: 'math'; latex: string; display: boolean }

/**
 * Delimiter pairs, longest-open-first so `$$` is tried before `$` and `\[`
 * before `\(`. Each pair knows whether it produces display (block) math.
 */
const DELIMITERS: ReadonlyArray<{ open: string; close: string; display: boolean }> = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
]

/**
 * Split `text` into prose and math tokens. Scans left to right; at each position
 * tries the delimiter list in order. An opening delimiter with no matching close
 * (or an empty body) is treated as ordinary text, so the scanner always advances
 * and never hangs hunting for a delimiter that isn't there.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let buffer = ''
  let i = 0

  const flush = () => {
    if (buffer) {
      tokens.push({ kind: 'text', value: buffer })
      buffer = ''
    }
  }

  while (i < text.length) {
    let matched = false

    for (const { open, close, display } of DELIMITERS) {
      if (!text.startsWith(open, i)) {
        continue
      }
      // Search for the closing delimiter after the opener.
      const bodyStart = i + open.length
      const closeIdx = text.indexOf(close, bodyStart)
      if (closeIdx === -1) {
        // No close — not a real math span; fall through to literal text.
        break
      }
      const latex = text.slice(bodyStart, closeIdx)
      if (latex.trim() === '') {
        // Empty body (e.g. "$$") — treat the opener as literal text.
        break
      }
      flush()
      tokens.push({ kind: 'math', latex, display })
      i = closeIdx + close.length
      matched = true
      break
    }

    if (!matched) {
      buffer += text[i]
      i += 1
    }
  }

  flush()
  return tokens
}

/** Render one LaTeX string to an HTML string, degrading to the literal source. */
function renderMath(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: display,
      // htmlAndMathml emits visually-hidden MathML alongside the HTML so screen
      // readers can read the equation aloud (WCAG 2.2 AA); the visible HTML renders
      // identically. KaTeX still escapes its own source, so the output stays XSS-safe.
      output: 'htmlAndMathml',
    })
  } catch {
    // KaTeX shouldn't throw with throwOnError:false, but never let it blank the
    // line — show the raw source so the reader still sees the intended math.
    return ''
  }
}

function MathTextInner({ text, block }: { text: string; block?: boolean }) {
  // Both parsing AND the (expensive) KaTeX rendering are memoized on [text, block], so a
  // live transcript re-rendering on every interim update does not re-run KaTeX for
  // already-rendered, unchanged equations. The export is wrapped in React.memo below.
  const children = useMemo<ReactNode[]>(() => {
    const safe = typeof text === 'string' ? text : ''
    const parsed = tokenize(safe)
    // `block` lets a caller pass a bare LaTeX equation with no delimiters and have it
    // rendered as a single display equation. If delimiters were present we honor those
    // instead (each at its own inline/display level).
    const hasMath = parsed.some((t) => t.kind === 'math')
    const tokens: Token[] =
      block && !hasMath && safe.trim() !== ''
        ? [{ kind: 'math', latex: safe, display: true }]
        : parsed

    return tokens.map((token, idx) => {
      if (token.kind === 'text') {
        // Plain text node — React escapes it; no HTML injection possible.
        return <span key={idx}>{token.value}</span>
      }
      const html = renderMath(token.latex, token.display)
      if (html === '') {
        // Render the literal source as escaped text when KaTeX produced nothing.
        return <span key={idx}>{token.latex}</span>
      }
      return (
        <span
          key={idx}
          // Only KaTeX-generated, self-escaping markup reaches this sink.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )
    })
  }, [text, block])

  if (block) {
    return <div className="whitespace-pre-wrap">{children}</div>
  }
  return <span className="whitespace-pre-wrap">{children}</span>
}

/**
 * Memoized so a parent re-render with identical props skips re-rendering entirely. Props
 * are two primitives (`text`, `block`), so the default shallow comparison is exact.
 */
export const MathText = memo(MathTextInner)
