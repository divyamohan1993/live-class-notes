/**
 * Transcription language catalog for NoteWeave.
 *
 * The browser Web Speech API runs ONE language model per session and cannot code-switch
 * mid-stream, so there is no single "Hinglish" locale. Our strategy is the right default
 * plus easy live switching: en-IN handles Indian-accented English with embedded Hindi words
 * best, so it is first and is the store's default; hi-IN is the companion for Hindi-heavy
 * stretches. The two sit together under "Recommended" so a code-switching speaker can flip
 * between them in one tap. The remaining Indian locales follow, then the other English
 * variants for non-Indian speakers.
 *
 * The data is shaped as groups (not a flat list) so the selector's <optgroup>s come straight
 * from this catalog — the render just maps groups to optgroups. Labels carry the native
 * script where natural, which both aids recognition and reads as a deliberate, localized UI.
 *
 * BCP-47 tags only; these are the locales the Web Speech API recognizes for India plus the
 * common English variants.
 */

/** One selectable transcription language. `value` is a BCP-47 tag passed to the engine. */
export interface LanguageOption {
  value: string
  label: string
}

/** A labelled cluster of languages, rendered as an <optgroup> in the selector. */
export interface LanguageGroup {
  label: string
  options: ReadonlyArray<LanguageOption>
}

/**
 * Grouped language catalog, ordered for an Indian, Hinglish-speaking audience first.
 *
 * Invariant: en-IN is the very first option and matches the store's default `meta.lang`, so a
 * controlled <select> always has a matching option and never renders blank. Keep en-IN, en-US,
 * and en-GB present — those are the only values a previously-saved session could hold.
 */
export const LANGUAGE_GROUPS: ReadonlyArray<LanguageGroup> = [
  {
    label: 'Recommended',
    options: [
      { value: 'en-IN', label: 'English (India)' },
      { value: 'hi-IN', label: 'हिन्दी Hindi' },
    ],
  },
  {
    label: 'Indian languages',
    options: [
      { value: 'bn-IN', label: 'বাংলা Bengali' },
      { value: 'ta-IN', label: 'தமிழ் Tamil' },
      { value: 'te-IN', label: 'తెలుగు Telugu' },
      { value: 'mr-IN', label: 'मराठी Marathi' },
      { value: 'gu-IN', label: 'ગુજરાતી Gujarati' },
      { value: 'kn-IN', label: 'ಕನ್ನಡ Kannada' },
      { value: 'ml-IN', label: 'മലയാളം Malayalam' },
      { value: 'pa-IN', label: 'ਪੰਜਾਬੀ Punjabi' },
      { value: 'ur-IN', label: 'اردو Urdu' },
    ],
  },
  {
    label: 'Other English',
    options: [
      { value: 'en-US', label: 'English (US)' },
      { value: 'en-GB', label: 'English (UK)' },
    ],
  },
]
