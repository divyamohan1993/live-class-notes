/**
 * summarize — a fully local, dependency-free extractive summary of a finalized
 * transcript. No network, no model: we score sentences by normalized term frequency
 * (excluding stopwords, lightly favoring domain/math vocabulary) and return the
 * top-N in their ORIGINAL order so the summary reads in sequence.
 *
 * Complexity is ~linear in transcript size: one pass to build the term-frequency
 * map, one pass to score sentences, then an O(S log S) sort of sentences (S =
 * sentence count, far smaller than word count). This stays fast on a 10-hour
 * transcript with tens of thousands of segments. We additionally cap the scanned
 * text length so a pathological transcript can't blow up memory.
 */
import type { TranscriptSegment } from '../types.ts'

/** Hard cap on characters scored, so summarize stays bounded on huge transcripts. */
const MAX_CHARS = 2_000_000

/** Common English words that carry little topical signal. */
const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'like',
  'me', 'my', 'no', 'not', 'now', 'of', 'on', 'one', 'or', 'our', 'out', 'over',
  'said', 'she', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'us',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why',
  'will', 'with', 'would', 'you', 'your', 'okay', 'right', 'well', 'going', 'get',
  'got', 'let', 'lets', 'thing', 'things', 'really', 'actually', 'basically',
])

/** Vocabulary that signals substantive technical content; given a small weight boost. */
const DOMAIN_KEYWORDS = new Set<string>([
  'equation', 'theorem', 'proof', 'function', 'derivative', 'integral', 'matrix',
  'vector', 'force', 'energy', 'velocity', 'acceleration', 'momentum', 'field',
  'wave', 'frequency', 'voltage', 'current', 'resistance', 'algorithm', 'complexity',
  'probability', 'distribution', 'variable', 'gradient', 'limit', 'series',
  'mass', 'charge', 'quantum', 'entropy', 'reaction', 'molecule', 'frequency',
  'definition', 'example', 'formula', 'result', 'solution', 'value', 'coefficient',
])

/** Boost factor applied to a domain keyword's frequency contribution. */
const DOMAIN_BOOST = 1.6

/** Tokenize to lowercase alphanumeric words. Shared by frequency and scoring passes. */
function words(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g)
  return matches ?? []
}

/**
 * Split one segment's text into sentence units. Live speech recognition (Web Speech)
 * does NOT add terminal punctuation, so a segment is itself the natural unit; we only
 * sub-split when the segment happens to contain internal sentence punctuation (e.g.
 * pasted/edited text). This is why we DON'T join everything and split on `[.!?]` —
 * that would collapse a punctuation-free transcript into a single giant "sentence."
 */
function splitSegmentText(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function summarize(
  segments: TranscriptSegment[],
  maxSentences = 5,
): string {
  if (!Array.isArray(segments) || segments.length === 0 || maxSentences <= 0) {
    return ''
  }

  // Build sentence units from segment boundaries (each finalized segment is one
  // utterance), and a parallel `doc` string for the term-frequency pass. Bounded by
  // MAX_CHARS so a multi-hour transcript stays memory-safe.
  const sentences: string[] = []
  let docLen = 0
  const docParts: string[] = []
  for (const seg of segments) {
    if (!seg || typeof seg.text !== 'string') {
      continue
    }
    const piece = seg.text.trim()
    if (!piece) {
      continue
    }
    for (const unit of splitSegmentText(piece)) {
      sentences.push(unit)
      docParts.push(unit)
      docLen += unit.length + 1
    }
    if (docLen >= MAX_CHARS) {
      break
    }
  }
  const doc = docParts.join(' ')

  if (sentences.length === 0) {
    return ''
  }
  if (sentences.length <= maxSentences) {
    // Nothing to trim — return the whole thing, normalized for spacing.
    return sentences.join(' ')
  }

  // Pass 1: term frequency across the whole document (stopwords excluded).
  const freq = new Map<string, number>()
  for (const w of words(doc)) {
    if (w.length < 2 || STOPWORDS.has(w)) {
      continue
    }
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  if (freq.size === 0) {
    return sentences.slice(0, maxSentences).join(' ')
  }

  // Normalize term weights to [0,1] by the max frequency, then apply domain boost.
  let maxFreq = 0
  for (const c of freq.values()) {
    if (c > maxFreq) {
      maxFreq = c
    }
  }

  // Pass 2: score each sentence by mean normalized term weight (normalization by
  // word count keeps long sentences from dominating purely on length).
  const scored = sentences.map((sentence, index) => {
    const toks = words(sentence)
    let sum = 0
    let counted = 0
    for (const w of toks) {
      if (w.length < 2 || STOPWORDS.has(w)) {
        continue
      }
      const weight = (freq.get(w) ?? 0) / maxFreq
      sum += DOMAIN_KEYWORDS.has(w) ? weight * DOMAIN_BOOST : weight
      counted += 1
    }
    const score = counted > 0 ? sum / counted : 0
    return { index, sentence, score }
  })

  // Pick the top-N by score, then restore original document order for readability.
  const top = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)

  return top.map((s) => s.sentence).join(' ')
}
