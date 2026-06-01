# Changelog

All notable changes to NoteWeave are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
