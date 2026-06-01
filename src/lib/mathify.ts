/**
 * mathify — a conservative, dependency-free heuristic that rewrites spoken or typed
 * mathematical phrasing into LaTeX and wraps the result in `$...$` so {@link MathText}
 * can render it. It is OPT-IN: a per-segment UI action calls it on demand; it is a
 * pure string -> string function with no side effects and is never auto-applied.
 *
 * Philosophy: a false positive (mangling ordinary prose) is worse than a miss. Every
 * rule has tight operand guards and only fires on confidently-recognized spans; when
 * unsure we leave the text exactly as it was. If no rule recognizes anything, the
 * input is returned verbatim (no `$` wrapper).
 *
 * Examples (input -> output):
 *   "x squared"                       -> "$x^{2}$"
 *   "x to the power of n"             -> "$x^{n}$"
 *   "square root of y"                -> "$\sqrt{y}$"
 *   "a over b"                        -> "$\frac{a}{b}$"
 *   "integral from 0 to 1 of x d x"   -> "$\int_{0}^{1} x \, dx$"
 *   "sum from i equals 1 to n"        -> "$\sum_{i=1}^{n}$"
 *   "derivative of y with respect to x" -> "$\frac{dy}{dx}$"
 *   "alpha plus beta equals gamma"    -> "$\alpha + \beta = \gamma$"
 *   "x sub i"                         -> "$x_{i}$"
 *   "the quick brown fox"             -> "the quick brown fox"  (untouched)
 */

/**
 * Operand token for EXPLICIT constructs where a strong math cue is already present
 * (e.g. "to the power of", "square root of"): a letter/number run, optionally with an
 * existing sub/superscript so chained atoms compose.
 */
const OPERAND = '([A-Za-z0-9]+(?:\\^\\{[^}]*\\}|_\\{[^}]*\\})?)'

/**
 * Tight operand for IDIOM-PRONE bare rules ("x squared", "a over b", "x sub i"): only a
 * SINGLE variable letter or a number (optionally already-scripted). This is what people
 * literally say for a variable, and it stops English words from triggering math — e.g.
 * "she squared away" no longer becomes "she^{2} away", and "game over man" is left alone.
 */
const VAR = '([A-Za-z][0-9]*(?:\\^\\{[^}]*\\}|_\\{[^}]*\\})?|[0-9]+(?:\\.[0-9]+)?)'

/** Greek letters we recognize, mapped to their LaTeX commands. */
const GREEK: Record<string, string> = {
  alpha: '\\alpha',
  beta: '\\beta',
  gamma: '\\gamma',
  delta: '\\delta',
  epsilon: '\\epsilon',
  zeta: '\\zeta',
  eta: '\\eta',
  theta: '\\theta',
  iota: '\\iota',
  kappa: '\\kappa',
  lambda: '\\lambda',
  mu: '\\mu',
  nu: '\\nu',
  xi: '\\xi',
  omicron: 'o',
  pi: '\\pi',
  rho: '\\rho',
  sigma: '\\sigma',
  tau: '\\tau',
  upsilon: '\\upsilon',
  phi: '\\phi',
  chi: '\\chi',
  psi: '\\psi',
  omega: '\\omega',
}

/** Spelled-out ordinal powers, so "x to the third" -> exponent 3. */
const ORDINAL_POWER: Record<string, string> = {
  zeroth: '0',
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
}

/**
 * One rewrite rule. Rules run in array order; multiword/longer patterns must precede
 * shorter ones (e.g. "square root of" before "root"/"square"). Each `apply` returns
 * the text and whether it changed it, so we know if any math was recognized at all.
 */
interface Rule {
  apply(text: string): { text: string; changed: boolean }
}

/** Build a rule from a regex + replacement (string or function). */
function rule(re: RegExp, repl: string | ((...m: string[]) => string)): Rule {
  return {
    apply(text: string) {
      let changed = false
      const out = text.replace(re, (...args: string[]) => {
        changed = true
        return typeof repl === 'function' ? repl(...args) : repl
      })
      return { text: out, changed }
    },
  }
}

/**
 * Ordered pipeline. Earlier rules build LaTeX atoms (powers, roots, fractions) that
 * later rules can treat as operands; word-operator rules run last so they don't eat
 * the words inside structural phrases like "square root of".
 */
const RULES: Rule[] = [
  // --- Calculus: integrals (bounded first, then plain) ---------------------------
  // "integral from a to b of <body> d x" -> \int_{a}^{b} <body> \, dx
  rule(
    /\bintegral\s+from\s+(.+?)\s+to\s+(.+?)\s+of\s+(.+?)\s+d\s*([A-Za-z])\b/gi,
    (_m, a: string, b: string, body: string, v: string) =>
      `\\int_{${a.trim()}}^{${b.trim()}} ${body.trim()} \\, d${v}`,
  ),
  // "integral of <body> d x" -> \int <body> \, dx
  rule(
    /\bintegral\s+of\s+(.+?)\s+d\s*([A-Za-z])\b/gi,
    (_m, body: string, v: string) => `\\int ${body.trim()} \\, d${v}`,
  ),

  // --- Sums / summations ----------------------------------------------------------
  // "sum from i equals 1 to n" -> \sum_{i=1}^{n}
  rule(
    /\b(?:sum|summation)\s+from\s+([A-Za-z])\s+(?:equals|=)\s+(.+?)\s+to\s+(.+?)\b/gi,
    (_m, idx: string, lo: string, hi: string) =>
      `\\sum_{${idx}=${lo.trim()}}^{${hi.trim()}}`,
  ),

  // --- Derivatives ----------------------------------------------------------------
  // "partial derivative of u with respect to t" -> \frac{\partial u}{\partial t}
  rule(
    /\bpartial\s+derivative\s+of\s+([A-Za-z])\s+with\s+respect\s+to\s+([A-Za-z])\b/gi,
    (_m, f: string, v: string) => `\\frac{\\partial ${f}}{\\partial ${v}}`,
  ),
  // "derivative of y with respect to x" -> \frac{dy}{dx}
  rule(
    /\bderivative\s+of\s+([A-Za-z])\s+with\s+respect\s+to\s+([A-Za-z])\b/gi,
    (_m, f: string, v: string) => `\\frac{d${f}}{d${v}}`,
  ),

  // --- Roots (before "square"/"power" so "square root" wins) ----------------------
  // "square root of y" -> \sqrt{y}
  rule(/\bsquare\s+root\s+of\s+(.+?)(?=$|[,.;:]|\s(?:plus|minus|times|over|equals)\b)/gi,
    (_m, x: string) => `\\sqrt{${x.trim()}}`),
  // "cube root of y" -> \sqrt[3]{y}
  rule(/\bcube\s+root\s+of\s+(.+?)(?=$|[,.;:]|\s(?:plus|minus|times|over|equals)\b)/gi,
    (_m, x: string) => `\\sqrt[3]{${x.trim()}}`),

  // --- Powers ---------------------------------------------------------------------
  // "x squared" / "x cubed" — base restricted to a single variable/number (VAR) so
  // idioms like "she squared away" are left untouched.
  rule(new RegExp(`\\b${VAR}\\s+squared\\b`, 'g'), (_m, b: string) => `${b}^{2}`),
  rule(new RegExp(`\\b${VAR}\\s+cubed\\b`, 'g'), (_m, b: string) => `${b}^{3}`),
  // "x to the power of n" / "x to the power n" — the word "power" is a strong math cue,
  // so OPERAND (which may carry an existing script) is acceptable here.
  rule(
    new RegExp(`\\b${OPERAND}\\s+to\\s+the\\s+power\\s+of\\s+${OPERAND}\\b`, 'g'),
    (_m, b: string, e: string) => `${b}^{${e}}`,
  ),
  rule(
    new RegExp(`\\b${OPERAND}\\s+to\\s+the\\s+power\\s+${OPERAND}\\b`, 'g'),
    (_m, b: string, e: string) => `${b}^{${e}}`,
  ),
  // "x to the third" -> x^{3} — VAR base so "back to the third floor" stays prose.
  rule(
    new RegExp(`\\b${VAR}\\s+to\\s+the\\s+(${Object.keys(ORDINAL_POWER).join('|')})\\b`, 'gi'),
    (_m, b: string, ord: string) => `${b}^{${ORDINAL_POWER[ord.toLowerCase()]}}`,
  ),

  // --- Subscripts -----------------------------------------------------------------
  // "x sub i" -> x_{i} — VAR base, single-token subscript.
  rule(
    new RegExp(`\\b${VAR}\\s+sub\\s+([A-Za-z0-9]+)\\b`, 'g'),
    (_m, b: string, s: string) => `${b}_{${s}}`,
  ),

  // --- Fractions (after powers/roots so their atoms are operands) -----------------
  // "a over b" -> \frac{a}{b}
  // VAR operands keep "game over man" as prose while still handling "x squared over 2"
  // (the left side is the already-built atom x^{2}, which VAR matches).
  rule(
    new RegExp(`\\b${VAR}\\s+over\\s+${VAR}\\b`, 'g'),
    (_m, a: string, b: string) => `\\frac{${a}}{${b}}`,
  ),

  // --- Greek letters --------------------------------------------------------------
  rule(
    new RegExp(`\\b(${Object.keys(GREEK).join('|')})\\b`, 'gi'),
    (_m, g: string) => GREEK[g.toLowerCase()],
  ),

  // --- Named symbols --------------------------------------------------------------
  rule(/\binfinity\b/gi, '\\infty'),
  rule(/\bh\s*bar\b/gi, '\\hbar'),
  rule(/\b(?:nabla|del)\b/gi, '\\nabla'),
  rule(/\bdegrees?\b/gi, '^\\circ'),

  // --- Relational and arithmetic operators (multiword first) ----------------------
  rule(/\bplus\s+or\s+minus\b/gi, '\\pm'),
  rule(/\bproportional\s+to\b/gi, '\\propto'),
  rule(/\bapproximately(?:\s+equal\s+to)?\b/gi, '\\approx'),
  rule(/\bgreater\s+than\s+or\s+equal\s+to\b/gi, '\\geq'),
  rule(/\bless\s+than\s+or\s+equal\s+to\b/gi, '\\leq'),
  rule(/\bnot\s+equal\s+to\b/gi, '\\neq'),
  rule(/\bgreater\s+than\b/gi, '>'),
  rule(/\bless\s+than\b/gi, '<'),
  rule(/\bdivided\s+by\b/gi, '\\div'),
  rule(/\btimes\b/gi, '\\times'),
  rule(/\bplus\b/gi, '+'),
  rule(/\bminus\b/gi, '-'),
  rule(/\bequals\b/gi, '='),
]

/**
 * LaTeX names that are legitimately multi-letter inside math (commands, function names,
 * differentials). These must NOT count as leftover prose when we gate the result.
 */
const KNOWN_MATH_WORDS = new Set<string>([
  // common multi-letter operators/functions
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min',
  'det', 'dim', 'arg', 'deg', 'gcd', 'sup', 'inf', 'circ',
  // greek/symbol command bodies (the backslash is stripped before this check)
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota',
  'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
  'phi', 'chi', 'psi', 'omega', 'infty', 'hbar', 'nabla', 'partial', 'pm', 'times',
  'div', 'approx', 'propto', 'geq', 'leq', 'neq', 'int', 'sum', 'sqrt', 'frac',
])

/**
 * Confidence gate: is the transformed string "clean math" (safe to wrap in `$...$`),
 * or does it still contain ordinary prose (so we must leave the original untouched)?
 *
 * We strip everything that legitimately lives in math — backslash command names,
 * braces/scripts/operators/digits, single-letter variables, and differentials like
 * "dx"/"dy" — then look for any surviving multi-letter alphabetic word. A survivor
 * means prose words are mixed in (e.g. "energy", "mass", "compute"), which would render
 * as italic letter-soup; in that case the segment is NOT confidently math.
 *
 * This honors the spec's "leave the rest untouched": when unsure we change nothing at
 * all, which (with the per-segment preview/confirm UI) makes a miss nearly free while
 * avoiding the far worse outcome of corrupting prose.
 */
function isCleanMath(transformed: string): boolean {
  let s = transformed
  // Drop LaTeX command names (keep their letters out of the prose check).
  s = s.replace(/\\[A-Za-z]+/g, ' ')
  // Drop differentials "dx", "dy", "dt", … (a 'd' immediately before a single var).
  s = s.replace(/\bd[a-z]\b/g, ' ')
  // Drop structural/operator characters, braces, scripts, digits, and punctuation.
  s = s.replace(/[\\{}^_+\-*/=<>(),.;:[\]|!?]/g, ' ')
  s = s.replace(/[0-9]/g, ' ')
  // Whatever alphabetic tokens remain: single letters are variables (fine); any token
  // of length >= 2 that isn't a known math word is leftover prose.
  const tokens = s.match(/[A-Za-z]+/g) ?? []
  for (const tok of tokens) {
    if (tok.length >= 2 && !KNOWN_MATH_WORDS.has(tok.toLowerCase())) {
      return false
    }
  }
  return true
}

/**
 * Convert recognized spoken math in `text` to LaTeX wrapped in `$...$`. Returns the
 * original string unchanged when nothing is recognized OR when the result still mixes
 * in prose (the confidence gate). Pure and side-effect free.
 *
 * Examples of the gate in action:
 *   "x squared plus y squared equals r squared" -> "$x^{2} + y^{2} = r^{2}$"  (wrapped)
 *   "today we compute x squared in class"        -> unchanged  (prose words survive)
 *   "energy equals mass times c squared"         -> unchanged  ("energy"/"mass" survive)
 */
export function mathify(text: string): string {
  if (typeof text !== 'string' || text.trim() === '') {
    return text
  }
  let working = text
  let anyChange = false
  for (const r of RULES) {
    const { text: next, changed } = r.apply(working)
    working = next
    anyChange = anyChange || changed
  }
  if (!anyChange) {
    return text
  }
  // Collapse the doubled spaces our replacements can leave, but preserve the rest.
  const cleaned = working.replace(/[ \t]{2,}/g, ' ').trim()
  // Only commit if the result is confidently pure math; otherwise leave prose alone.
  if (!isCleanMath(cleaned)) {
    return text
  }
  return `$${cleaned}$`
}

/** Words/patterns whose presence suggests a span is worth offering mathify on. */
const MATH_HINTS: RegExp[] = [
  /\b(squared|cubed|to the power|square root|cube root)\b/i,
  /\b(integral|derivative|summation|sum from)\b/i,
  /\b(over|sub)\b/i,
  /\b(plus|minus|times|divided by|equals|approximately|proportional to)\b/i,
  /\b(greater than|less than|plus or minus)\b/i,
  /\b(alpha|beta|gamma|delta|theta|lambda|sigma|omega|pi|mu|phi|infinity|nabla|del|h bar)\b/i,
  // Bare symbolic content: a single letter next to a digit or operator (e.g. "x = 3").
  /[A-Za-z]\s*[=+\-*/^]\s*[A-Za-z0-9]/,
]

/**
 * Cheap presence check: does this segment look mathematical enough to offer the
 * mathify action? Errs toward offering when a clear keyword is present; otherwise
 * stays quiet. Does not transform anything.
 */
export function maybeMath(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false
  }
  return MATH_HINTS.some((re) => re.test(text))
}
