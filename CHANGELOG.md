# Changelog

All notable changes to NoteWeave are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-06-01

### Added
- **Multilingual transcription**: Indian English default, plus Hindi and nine more Indian languages (Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu) and US/UK English, in a grouped selector with an accessible Hinglish guidance hint. Switchable live, mid-recording.
- **Permanent multi-session archive**: completed sessions are saved to IndexedDB; starting a New session or opening an archived one always archives the current session first (nothing is ever overwritten). A "Sessions" panel browses, opens, and deletes past sessions.
- **5-minute idle auto-complete**: a session with no speech for 5 minutes finalizes automatically.
- **In-document recovery status**: calm "Reconnecting, your notes are saved", "Reconnected", "Session complete. Saved.", and microphone-blocked messages, shown without re-rendering the transcript.

### Changed
- **Transcription resilience overhaul** for multi-hour, Indian-accented, Hinglish use: proactive recognizer cycling before the browser's silent cut-off; a start-timeout that force-resets a wedged recognizer (fixes "stuck reconnecting"); a watchdog that heals a fully-down engine; the last interim text is flushed to a saved segment on any drop; "Reconnecting" shows only on a genuine stall, never on healthy cycles; a busy or locked microphone (audio-capture) auto-recovers; slurred or low-confidence speech is captured as the best guess (maxAlternatives).
- **Durability**: IndexedDB writes serialized and retried; hydrate degrades gracefully on corrupt data; quota errors handled.
- **App shell**: global error and unhandledrejection nets, a beforeunload flush, and a recoverable "Try again" error boundary.
- HTML export renders math as native MathML (truly self-contained, no fonts needed).
- Default transcription language set to Indian English (en-IN).

## [0.1.0] - 2026-06-01

### Added
- **Live continuous transcription** via the Web Speech API behind a swappable `TranscriptionEngine` interface. Built for 10+ hour sessions: guarded auto-restart with capped backoff, an 8s stall watchdog, online/offline handling, screen wake-lock, seam de-duplication, and a chronological-order guarantee on committed segments. No audio is ever stored.
- **Time-anchored photo placement.** Imported photos read their EXIF capture time and are woven into the transcript at the matching spoken moment. Photos without a timestamp collect in an Unplaced tray.
- **Live camera-clock calibration.** An offset slider (with nudge buttons and a minutes:seconds field) re-places photos live to absorb camera-vs-computer clock drift.
- **Real math rendering** via KaTeX (`$...$` / `$$...$$`), output as HTML + MathML for screen-reader accessibility. Opt-in, per-line spoken-math-to-LaTeX helper that never rewrites stored text automatically.
- **Professional notes view**: serif document layout with margin timestamps, virtualized for long transcripts, inline editable segments, inline photo figures with captions, a live interim line, and a jump-to-live control.
- **Editable masthead** with auto-title, full-transcript search with match navigation, and a local extractive summary.
- **Export** to PDF (print), Word (`.docx`), self-contained HTML (math as native MathML), and Markdown.
- **Incremental IndexedDB persistence** with crash-recovery on reload, plus a New session control to start fresh.
- Accessible, keyboard-navigable UI throughout; favicon and metadata.

### Notes
- Live transcription requires Chrome or Edge and an internet connection; the Web Speech API streams audio to the browser vendor's servers for recognition (not on-device). The engine interface allows a future on-device (Whisper/WASM) replacement.
- HEIC photos place correctly by timestamp but show a placeholder thumbnail in Chrome/Firefox (canvas cannot decode HEIC).
