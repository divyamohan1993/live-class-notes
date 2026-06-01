# NoteWeave

**Your lecture, transcribed live, with your photos woven in at the exact moment you took them.**

You are in a long lecture or conference. The speaker moves fast, the board fills up, and you cannot write and listen at the same time. So you do the natural thing: you listen, and you snap a photo of the board when it matters.

NoteWeave turns that into a clean set of notes. It transcribes the talk **live**, continuously, for hours, without ever recording or storing the audio. Later you drop in the photos you took, and each one slots itself into the transcript **at the moment it was captured**, matched by the photo's timestamp to what was being said right then. Equations render as real mathematics. The result reads like a professional set of notes, and exports to PDF, Word, HTML, or Markdown.

It runs entirely on your machine, in your browser. It costs nothing.

---

## Quickstart

**Requirements:** [Node.js](https://nodejs.org) 18+ and [pnpm](https://pnpm.io) (`npm i -g pnpm`). Use **Google Chrome or Microsoft Edge** (live transcription uses the browser's Web Speech API, which only ships in Chromium browsers).

```bash
pnpm install
pnpm dev
```

Open **http://localhost:5173** in Chrome or Edge. Use the `localhost` address, not the LAN address Vite also prints (`http://10.x.x.x:5173`); the microphone and live transcription only work in a secure context, and `localhost` qualifies while a plain `http://` LAN address does not.

To create an optimized build: `pnpm build`, then `pnpm preview`.

---

## How to use it

1. **Name the session.** Set the title, course, and instructor at the top (or click **Auto-title** later and it names itself from the content).
2. **Press Record.** Allow the microphone when prompted. The talk streams in as live text, paragraph by paragraph, with a timestamp in the margin. Leave it running for the whole lecture; it keeps itself alive across pauses, network blips, and silence.
   - **Keep this tab visible while recording.** Browsers throttle and can suspend background tabs, which pauses live transcription. Keep NoteWeave in the foreground for the whole session (you can dim the screen; it holds a screen wake-lock). If the tab is backgrounded it reconnects automatically when you return, but words spoken while it was suspended are not captured. For long lectures, give it its own window.
   - **Pick the language.** It defaults to **English (India)** for Indian-accented speech, and offers Hindi plus nine more Indian languages and US/UK English, grouped in the selector. For **Hinglish** (mixed Hindi and English), English (India) handles the blend best; switch to Hindi for Hindi-heavy stretches. You can change it live, mid-recording.
3. **Take photos as usual** on your phone or camera during class. Do nothing else with them yet.
4. **Import the photos afterwards** (drag them onto the Photos panel, or click to choose). Each photo reads its own EXIF capture time and lands next to the words that were being spoken at that moment.
5. **Calibrate if a photo lands by the wrong sentence.** Your camera's clock is rarely in perfect sync with this computer's. Drag the **Camera clock offset** slider and watch the photos slide into place live. Photos with no timestamp wait in the **Unplaced** tray; pin them where you want.
6. **Make it shine.** Click a paragraph to edit it. Hit **∑ Format math** on any line to turn spoken math ("x squared plus y squared equals r squared") into a real equation. Click **Summarize** for a quick recap. **Search** the whole transcript from the top bar.
7. **Export** to PDF, Word, HTML, or Markdown.

Your notes autosave continuously to a local database, and a session **auto-completes after 5 minutes of silence**. Close the tab at hour nine and reopen it and everything is still there. **New session** starts a fresh class (the current one is saved first), and **Sessions** reopens any past session. Nothing is ever lost.

---

## What makes it work

- **Live, continuous transcription, no audio stored.** Speech is transcribed in real time and only the *text* is kept, designed for 10+ hour sessions.
- **Self-healing capture.** It survives what real lectures throw at it: the recognizer is recycled before the browser's silent ~60s cut-off, a wedged recognizer is force-reset, a dropped connection reconnects automatically (and the last words spoken are saved the instant it drops), a busy or locked microphone recovers the moment it frees, online/offline is handled, and slurred or low-confidence speech is still captured as the best guess. A screen wake-lock keeps the display on, and 5 minutes of silence auto-completes the session.
- **Speaks your languages.** Defaults to Indian English; also Hindi and nine more Indian languages (Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu) plus US/UK English, switchable live. For Hinglish, keep English (India) for the mixed speech and switch to Hindi for Hindi-heavy stretches.
- **Time-anchored photos.** Every transcript line carries the wall-clock time it was spoken. Every photo carries its EXIF capture time. NoteWeave matches the two, with a calibration offset to absorb camera-clock drift. This is the core idea.
- **Real mathematics.** Type `$...$` or `$$...$$` and it renders as a true equation via [KaTeX](https://katex.org) (with MathML, so screen readers can read it). A conservative spoken-math-to-LaTeX helper is available per line, opt-in, and never rewrites your words on its own.
- **Crash-proof autosave.** Each finalized line is written to IndexedDB the instant it is final, never re-serializing the whole transcript. A reload or crash recovers the full session.
- **Never lose a session.** Completed sessions are archived to permanent local storage. Starting a new session or opening an old one always saves the current one first, so nothing is overwritten. Browse and reopen past sessions from **Sessions**.
- **Built for length.** The notes view is virtualized, so a ten-hour transcript scrolls smoothly.
- **Search, auto-title, summary** of the full transcript, all computed locally.
- **Export** to PDF (print), Word (`.docx`), self-contained HTML (math as native MathML, no external fonts needed), and Markdown.

---

## Privacy and the one honest caveat

NoteWeave is local-first: your transcript, photos, and notes live only in your browser, on your machine. The app never uploads them anywhere and never stores audio.

**However**, the live transcription itself uses the browser's built-in Web Speech API, which (in Chrome and Edge) streams microphone audio to the **browser vendor's speech servers** (Google / Microsoft) to turn it into text. That audio leaves your machine in transit, the same way browser dictation does, and it requires an internet connection. NoteWeave never receives or keeps that audio, but you should know it is not fully on-device.

The transcription engine sits behind a small swappable interface (`src/features/transcription/engine.ts`) precisely so a fully on-device engine (for example Whisper compiled to WebAssembly) can be dropped in later with no other changes. That is the natural next step for true offline, private transcription.

**Other notes:** HEIC photos from iPhones place correctly by their timestamp, but Chrome/Firefox cannot draw a HEIC thumbnail on a `<canvas>`, so those show a labelled placeholder instead of a preview (the photo itself still exports fine).

---

## Tech

Vite, React 18, TypeScript (strict), Tailwind v4, Zustand, `idb` (IndexedDB), `exifr`, `@tanstack/react-virtual`, KaTeX, `docx`. No backend, no accounts, no paid APIs.

```
src/
  store.ts                  # Zustand session store + incremental persistence
  types.ts                  # shared data model
  lib/                      # db (IndexedDB), alignment (time-anchoring), time, id,
                            # mathify, summarize, autotitle, search
  components/               # MathText (KaTeX), Layout, ui atoms
  features/
    transcription/          # swappable engine, useSpeechRecognition, wake lock, controls
    images/                 # EXIF read, downscaling, import dock + calibration
    notes/                  # the notes view, masthead, toolbar, export
```

| Script | Does |
| --- | --- |
| `pnpm dev` | Run the app locally (http://localhost:5173) |
| `pnpm build` | Type-check and produce a production build |
| `pnpm preview` | Serve the production build |
| `pnpm typecheck` | Type-check only |

Built as a parallel multi-agent effort: a foundation contract first, then transcription, images, math/intelligence, and notes/export in parallel.
