/**
 * LiveTranscriber — the live recording control surface that lives in the toolbar chrome.
 *
 * It owns the recording lifecycle UI: the Record / Pause / Resume / Stop controls, a live
 * elapsed timer, the connection-health pill, segment count, and the language selector. The
 * actual recognition engine and all its endurance policy live in useSpeechRecognition; this
 * component is the human-facing surface that drives the session store and the screen wake
 * lock. The live partial (interim) transcript is rendered by NotesView, not here.
 *
 * Resilience: on an unsupported browser it degrades to a manual note entry so the app stays
 * useful; after a reload mid-recording it offers a Resume prompt rather than auto-starting
 * the microphone (browsers require a user gesture to capture audio).
 */
import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { Button, Pill } from '../../components/ui.tsx'
import type { PillTone } from '../../components/ui.tsx'
import type { ConnectionStatus, RecordingStatus } from '../../types.ts'
import { useSession } from '../../store.ts'
import { formatDuration } from '../../lib/time.ts'
import { useSpeechRecognition } from './useSpeechRecognition.ts'
import { useWakeLock } from './useWakeLock.ts'

/** Supported transcription languages. Web Speech accepts BCP-47 tags. */
const LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
]

/** Map connection status to a pill tone + human label for the status indicator. */
function connectionPresentation(
  connection: ConnectionStatus,
  status: RecordingStatus,
): { tone: PillTone; label: string; dot: boolean } {
  if (status === 'paused') return { tone: 'warning', label: 'Paused', dot: false }
  switch (connection) {
    case 'live':
      return { tone: 'live', label: 'Live', dot: true }
    case 'reconnecting':
      return { tone: 'warning', label: 'Reconnecting…', dot: true }
    case 'offline':
      return { tone: 'danger', label: 'Offline', dot: true }
    case 'error':
      return { tone: 'danger', label: 'Error', dot: false }
    default:
      return { tone: 'neutral', label: 'Idle', dot: false }
  }
}

/** Live elapsed-time display, ticking once a second while a session is open. */
function ElapsedTimer(): ReactElement {
  const startedAtEpoch = useSession((s) => s.startedAtEpoch)
  const status = useSession((s) => s.status)
  const [, force] = useState(0)

  useEffect(() => {
    if (status !== 'recording') return
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [status])

  const elapsed = startedAtEpoch == null ? 0 : Date.now() - startedAtEpoch
  return (
    <span
      className="font-mono text-sm tabular-nums text-ink-soft"
      aria-label={`Elapsed recording time ${formatDuration(elapsed)}`}
    >
      {formatDuration(elapsed)}
    </span>
  )
}

export function LiveTranscriber(): ReactElement {
  const { supported, listening, error, start, stop } = useSpeechRecognition()
  const { request: requestWakeLock, release: releaseWakeLock } = useWakeLock()

  const status = useSession((s) => s.status)
  const connection = useSession((s) => s.connection)
  const segmentCount = useSession((s) => s.segments.length)
  const lang = useSession((s) => s.meta.lang)
  const setMeta = useSession((s) => s.setMeta)
  const commitSegment = useSession((s) => s.commitSegment)

  const [manualText, setManualText] = useState('')
  const langSelectId = useId()
  const manualInputId = useId()

  // Wire the screen wake lock to the actual recording lifecycle (covers reload-resume too).
  // The wake-lock callbacks are stable, so this re-runs only when the status changes.
  useEffect(() => {
    if (status === 'recording') requestWakeLock()
    else releaseWakeLock()
  }, [status, requestWakeLock, releaseWakeLock])

  // A reloaded session can return as status==='recording' while the engine is NOT running
  // (connection idle, not listening). Offer an explicit Resume rather than auto-starting.
  const needsResume = status === 'recording' && !listening && connection === 'idle'

  const handleManualSubmit = (event: FormEvent): void => {
    event.preventDefault()
    const text = manualText.trim()
    if (text === '') return
    const now = Date.now()
    commitSegment(text, now, now)
    setManualText('')
  }

  // --- Unsupported browser: keep the app usable with manual note entry. ---
  if (!supported) {
    return (
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <Pill tone="warning" dot>
          Live transcription needs Chrome or Edge
        </Pill>
        <form onSubmit={handleManualSubmit} className="flex items-center gap-2">
          <label htmlFor={manualInputId} className="sr-only">
            Add a note manually
          </label>
          <input
            id={manualInputId}
            type="text"
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="Type a note and press Enter"
            className="h-9 w-56 rounded-[var(--radius-nw)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] px-3 text-sm text-ink placeholder:text-muted focus:border-[color:var(--nw-accent)] focus:outline-none"
          />
          <Button type="submit" size="sm" disabled={manualText.trim() === ''}>
            Add note
          </Button>
        </form>
      </div>
    )
  }

  const conn = connectionPresentation(connection, status)
  const isRecording = status === 'recording'
  const isPaused = status === 'paused'

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/*
        Primary controls. When a reloaded session needs resuming, the engine is NOT running
        even though status is 'recording', so we suppress Pause/Stop here and show only the
        Resume prompt below — otherwise the user would see a Pause button for silence.
      */}
      {needsResume ? null : !isRecording && !isPaused ? (
        <Button
          variant="primary"
          size="sm"
          onClick={start}
          leading={<span className="text-[color:var(--nw-danger)]">●</span>}
        >
          Record
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          {isPaused ? (
            <Button variant="primary" size="sm" onClick={start} leading={<span>▶</span>}>
              Resume
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => useSession.getState().pauseRecording()}
              leading={<span>❚❚</span>}
            >
              Pause
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={stop} leading={<span>■</span>}>
            Stop
          </Button>
        </div>
      )}

      {/* Elapsed time while a session is open. */}
      {(isRecording || isPaused) && <ElapsedTimer />}

      {/* Connection / recording status, announced politely to assistive tech. */}
      <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
        <Pill tone={conn.tone} dot={conn.dot}>
          {conn.label}
        </Pill>
        <span className="text-xs text-muted">
          {segmentCount} {segmentCount === 1 ? 'segment' : 'segments'}
        </span>
      </span>

      {/*
        Keep-visible nudge. Browsers throttle (and can suspend) background tabs, which pauses
        Web Speech; the screen wake lock keeps the display on but does NOT stop tab-switch
        throttling. For a multi-hour lecture the safe operating mode is "leave this tab in the
        foreground", so we say so plainly while recording.
      */}
      {isRecording && (
        <span
          className="inline-flex items-center gap-1 text-xs text-muted"
          title="Browsers slow down or pause background tabs, which can pause live transcription. Keep this tab visible (you can dim the screen) for the whole session."
        >
          <span aria-hidden="true">👁</span>
          Keep this tab visible
        </span>
      )}

      {/* Resume-after-reload prompt: never auto-starts the mic without a gesture. */}
      {needsResume && (
        <span className="inline-flex items-center gap-2 rounded-[var(--radius-nw)] bg-[color:var(--nw-accent-soft)] px-2.5 py-1 text-xs text-[color:var(--nw-accent-strong)]">
          <span>Recording was interrupted.</span>
          <Button size="sm" variant="primary" onClick={start}>
            Resume
          </Button>
          <Button size="sm" variant="ghost" onClick={stop}>
            Stop
          </Button>
        </span>
      )}

      {/* Microphone-permission or hard error message. */}
      {error != null && (
        <span className="text-xs text-[color:var(--nw-danger)]" role="alert">
          {error}
        </span>
      )}

      {/* Language selector — restarts the engine on change while recording. */}
      <div className="flex items-center gap-1.5">
        <label
          htmlFor={langSelectId}
          className="text-xs text-muted"
          title="Transcription language"
        >
          <span aria-hidden="true">🌐</span>
          <span className="sr-only">Transcription language</span>
        </label>
        <select
          id={langSelectId}
          value={lang}
          onChange={(e) => setMeta({ lang: e.target.value })}
          className="h-8 rounded-[var(--radius-nw)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] px-2 text-[13px] text-ink-soft focus:border-[color:var(--nw-accent)] focus:outline-none"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
