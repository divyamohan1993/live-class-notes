/**
 * generateTitle — derive a concise, human title for a session so files auto-name
 * themselves (the user can always rename). Fully local and dependency-free.
 *
 * Strategy:
 *   1. Detect a subject hint (Physics, Mathematics, Engineering, Chemistry, Biology,
 *      Economics, Computer Science) from keyword hits across early, high-signal text.
 *   2. Pick the single most salient topical keyword from the opening of the lecture
 *      (where the speaker usually states the topic), excluding stopwords.
 *   3. Combine subject + topic + date label.
 *
 * Output uses a colon/comma separator (not an em dash) to match the project writing
 * style, e.g. "Physics: Wave Equations, 1 June 2026". Never returns an empty string.
 *
 * Examples:
 *   physics-heavy opening about waves -> "Physics: Wave Equations, 1 June 2026"
 *   no clear subject, topic "matrices" -> "Matrices, 1 June 2026"
 *   empty transcript, no course       -> "Class Notes, 1 June 2026"
 */
import type { SessionMeta, TranscriptSegment } from '../types.ts'

/** Only the first N segments are scanned — the topic is stated early, and this keeps
 *  title generation O(1) with respect to a multi-hour transcript. */
const SCAN_SEGMENTS = 25

/** Subject buckets: a subject wins if its keywords appear most across the scanned text. */
const SUBJECTS: ReadonlyArray<{ name: string; keywords: string[] }> = [
  {
    name: 'Physics',
    keywords: [
      'force', 'energy', 'velocity', 'acceleration', 'momentum', 'mass', 'gravity',
      'wave', 'frequency', 'quantum', 'particle', 'electron', 'voltage', 'current',
      'magnetic', 'electric', 'relativity', 'thermodynamics', 'entropy', 'photon',
      'newton', 'joule', 'kinetic', 'potential', 'field', 'charge',
    ],
  },
  {
    name: 'Mathematics',
    keywords: [
      'theorem', 'proof', 'equation', 'derivative', 'integral', 'matrix', 'vector',
      'function', 'limit', 'series', 'polynomial', 'algebra', 'calculus', 'geometry',
      'topology', 'probability', 'differential', 'eigenvalue', 'gradient', 'lemma',
      'continuity', 'convergence', 'set', 'group', 'ring',
    ],
  },
  {
    name: 'Engineering',
    keywords: [
      'circuit', 'signal', 'system', 'control', 'stress', 'strain', 'beam', 'load',
      'torque', 'fluid', 'thermal', 'mechanical', 'structural', 'transistor',
      'amplifier', 'feedback', 'bandwidth', 'impedance', 'turbine', 'actuator',
    ],
  },
  {
    name: 'Chemistry',
    keywords: [
      'reaction', 'molecule', 'atom', 'bond', 'compound', 'acid', 'base', 'ion',
      'oxidation', 'reduction', 'catalyst', 'enthalpy', 'equilibrium', 'mole',
      'solution', 'organic', 'electrons', 'valence', 'isotope', 'reagent',
    ],
  },
  {
    name: 'Biology',
    keywords: [
      'cell', 'gene', 'protein', 'enzyme', 'dna', 'rna', 'organism', 'evolution',
      'species', 'tissue', 'membrane', 'mitosis', 'neuron', 'chromosome', 'bacteria',
      'metabolism', 'photosynthesis', 'genome', 'antibody', 'virus',
    ],
  },
  {
    name: 'Economics',
    keywords: [
      'market', 'demand', 'supply', 'price', 'cost', 'utility', 'inflation', 'gdp',
      'equilibrium', 'monopoly', 'elasticity', 'capital', 'revenue', 'interest',
      'trade', 'fiscal', 'monetary', 'profit', 'margin', 'tax',
    ],
  },
  {
    name: 'Computer Science',
    keywords: [
      'algorithm', 'data', 'structure', 'complexity', 'recursion', 'graph', 'tree',
      'array', 'pointer', 'memory', 'process', 'thread', 'compiler', 'database',
      'network', 'protocol', 'encryption', 'cache', 'binary', 'sorting', 'hash',
    ],
  },
]

/** Stopwords plus filler that should never be picked as the salient topic word. */
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those', 'it',
  'its', 'we', 'you', 'i', 'they', 'he', 'she', 'so', 'as', 'by', 'from', 'into',
  'about', 'today', 'okay', 'right', 'well', 'now', 'going', 'lets', 'let', 'gonna',
  'want', 'talk', 'discuss', 'lecture', 'class', 'chapter', 'topic', 'start', 'begin',
  'welcome', 'good', 'morning', 'afternoon', 'everyone', 'hello', 'will', 'can',
  'look', 'see', 'think', 'know', 'just', 'like', 'some', 'thing', 'things',
])

/** Title-case a single word ("waves" -> "Waves"). */
function titleCaseWord(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** Collect lowercase alphabetic words (length >= 3) from the scanned opening text. */
function openingWords(segments: TranscriptSegment[]): string[] {
  const out: string[] = []
  const limit = Math.min(SCAN_SEGMENTS, segments.length)
  for (let i = 0; i < limit; i += 1) {
    const seg = segments[i]
    if (!seg || typeof seg.text !== 'string') {
      continue
    }
    const matches = seg.text.toLowerCase().match(/[a-z]{3,}/g)
    if (matches) {
      out.push(...matches)
    }
  }
  return out
}

/** Pick the subject whose keywords appear most; null if none appear. */
function detectSubject(tokens: string[]): string | null {
  const counts = new Map<string, number>()
  for (const subject of SUBJECTS) {
    counts.set(subject.name, 0)
  }
  const keywordToSubject = new Map<string, string>()
  for (const subject of SUBJECTS) {
    for (const kw of subject.keywords) {
      // First subject claiming a keyword owns it (buckets are largely disjoint).
      if (!keywordToSubject.has(kw)) {
        keywordToSubject.set(kw, subject.name)
      }
    }
  }
  for (const tok of tokens) {
    const subj = keywordToSubject.get(tok)
    if (subj) {
      counts.set(subj, (counts.get(subj) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestCount = 0
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return bestCount > 0 ? best : null
}

/** Pick the most frequent non-stopword from the opening as the topic phrase. */
function detectTopic(tokens: string[]): string | null {
  const freq = new Map<string, number>()
  for (const tok of tokens) {
    if (STOPWORDS.has(tok)) {
      continue
    }
    freq.set(tok, (freq.get(tok) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [word, count] of freq) {
    if (count > bestCount) {
      best = word
      bestCount = count
    }
  }
  // Require the topic to actually recur (count >= 2) so a one-off filler word in a
  // short opening doesn't become the title; otherwise leave topic unset.
  return bestCount >= 2 ? best : null
}

export function generateTitle(
  segments: TranscriptSegment[],
  meta: SessionMeta,
): string {
  const date = meta?.dateLabel?.trim() || ''
  const safeSegments = Array.isArray(segments) ? segments : []
  const tokens = openingWords(safeSegments)

  const subject = detectSubject(tokens)
  const topic = detectTopic(tokens)

  // Build "<Subject>: <Topic>" / "<Subject>" / "<Topic>" from whatever we found.
  let core = ''
  const topicLabel = topic ? titleCaseWord(topic) : ''
  if (subject && topicLabel) {
    core = `${subject}: ${topicLabel}`
  } else if (subject) {
    core = subject
  } else if (topicLabel) {
    core = topicLabel
  }

  // Fallbacks when we couldn't infer anything from the transcript.
  if (!core) {
    const course = meta?.course?.trim()
    core = course || 'Class Notes'
  }

  return date ? `${core}, ${date}` : core
}
