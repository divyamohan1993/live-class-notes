/**
 * search — full-text search across finalized transcript segments, fully local.
 *
 * Matching is case-insensitive and term-based: the query is split on whitespace and
 * a segment matches only if EVERY term is present as a substring. (This subsumes the
 * simple substring case: a single-term query is just "this substring is present".)
 *
 * We deliberately use `indexOf` on lowercased strings, never `new RegExp(query)`:
 * building a regex from user input would throw on inputs like "(" and is a ReDoS
 * vector. Lowercasing each segment once per call keeps it linear in total text size,
 * which stays fast even on a multi-hour transcript.
 *
 * Examples:
 *   searchSegments(segs, "wave equation") -> segments containing both "wave" and
 *     "equation", each with a snippet centered on the first matched term.
 *   highlightRanges("the wave is a wave", "wave") -> [[4,8],[14,18]]
 *   highlightRanges(text, "")                      -> []
 */
import type { TranscriptSegment } from '../types.ts'

/** Characters of context to show on each side of the first hit in a snippet. */
const SNIPPET_RADIUS = 60

/** Split a query into lowercased, non-empty terms. */
function queryTerms(query: string): string[] {
  if (typeof query !== 'string') {
    return []
  }
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
}

/** Build a snippet around `hitIndex` in `text`, adding ellipses when truncated. */
function makeSnippet(text: string, hitIndex: number, hitLen: number): string {
  const start = Math.max(0, hitIndex - SNIPPET_RADIUS)
  const end = Math.min(text.length, hitIndex + hitLen + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end).trim() + suffix
}

export function searchSegments(
  segments: TranscriptSegment[],
  query: string,
): { segmentId: string; snippet: string }[] {
  const terms = queryTerms(query)
  if (terms.length === 0 || !Array.isArray(segments)) {
    return []
  }

  const results: { segmentId: string; snippet: string }[] = []
  for (const seg of segments) {
    if (!seg || typeof seg.text !== 'string' || seg.text.length === 0) {
      continue
    }
    const lower = seg.text.toLowerCase()

    // Every term must be present; track the earliest hit for the snippet anchor.
    let allPresent = true
    let firstHit = -1
    let firstHitLen = 0
    for (const term of terms) {
      const idx = lower.indexOf(term)
      if (idx === -1) {
        allPresent = false
        break
      }
      if (firstHit === -1 || idx < firstHit) {
        firstHit = idx
        firstHitLen = term.length
      }
    }
    if (!allPresent) {
      continue
    }

    results.push({
      segmentId: seg.id,
      snippet: makeSnippet(seg.text, firstHit, firstHitLen),
    })
  }
  return results
}

export function highlightRanges(text: string, query: string): [number, number][] {
  if (typeof text !== 'string' || text.length === 0) {
    return []
  }
  const terms = queryTerms(query)
  if (terms.length === 0) {
    return []
  }
  const lower = text.toLowerCase()

  // Collect every occurrence of every term as a [start, end) range.
  const ranges: [number, number][] = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const idx = lower.indexOf(term, from)
      if (idx === -1) {
        break
      }
      ranges.push([idx, idx + term.length])
      from = idx + term.length
    }
  }
  if (ranges.length === 0) {
    return []
  }

  // Sort by start, then merge overlapping/adjacent ranges into non-overlapping spans.
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = [ranges[0]]
  for (let i = 1; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1]
    const cur = ranges[i]
    if (cur[0] <= last[1]) {
      // Overlapping or touching — extend the previous span.
      if (cur[1] > last[1]) {
        last[1] = cur[1]
      }
    } else {
      merged.push(cur)
    }
  }
  return merged
}
