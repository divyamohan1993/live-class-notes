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
import { LANGUAGE_GROUPS } from './languages.ts'
import { useEnginePref } from './enginePref.ts'
import type { EngineKind } from './enginePref.ts'

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

/**
 * Engine picker — lets the user choose between the browser's Web Speech API (fast, needs
 * internet, audio leaves the machine) and the on-device Whisper engine (private, accurate, one
 * ~150MB model download on first use). Reads/writes the persisted useEnginePref store.
 *
 * Disabled while recording: changing the engine rebuilds the whole recognition effect (a full
 * teardown of the live session's engine, watchdog, and subscriptions), so we only allow the
 * switch when stopped and say so. The selection takes effect on the next Record.
 */
function EnginePicker({ disabled }: { disabled: boolean }): ReactElement {
  const engine = useEnginePref((s) => s.engine)
  const setEngine = useEnginePref((s) => s.setEngine)
  const selectId = useId()
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={selectId} className="text-xs text-muted" title="Transcription engine">
        <span aria-hidden="true">⚙</span>
        <span className="sr-only">Transcription engine</span>
      </label>
      <select
        id={selectId}
        value={engine}
        disabled={disabled}
        onChange={(e) => setEngine(e.target.value as EngineKind)}
        title={
          disabled
            ? 'Stop recording to change the transcription engine. The change takes effect on the next recording.'
            : 'Choose how speech is transcribed'
        }
        className="h-8 rounded-[var(--radius-nw)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] px-2 text-[13px] text-ink-soft focus:border-[color:var(--nw-accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="web-speech">Browser (fast, needs internet)</option>
        <option value="whisper">On-device Whisper (accurate, private)</option>
      </select>
    </div>
  )
}

export function LiveTranscriber(): ReactElement {
  const { supported, listening, error, modelStatus, start, stop } = useSpeechRecognition()
  const { request: requestWakeLock, release: releaseWakeLock } = useWakeLock()

  const status = useSession((s) => s.status)
  const connection = useSession((s) => s.connection)
  const segmentCount = useSession((s) => s.segments.length)
  const lang = useSession((s) => s.meta.lang)
  const setMeta = useSession((s) => s.setMeta)
  const commitSegment = useSession((s) => s.commitSegment)

  const [manualText, setManualText] = useState('')
  const langSelectId = useId()
  const langHintId = useId()
  const manualInputId = useId()

  // Switching engines rebuilds the recognition effect, so only permit it when no session is open.
  const switchingDisabled = status === 'recording' || status === 'paused'

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

  // --- Selected engine unsupported here: keep the app usable with manual note entry, but still
  // surface the engine picker so a user on (say) Firefox, where the default Browser engine is
  // unsupported, can switch to On-device Whisper, which works wherever getUserMedia + a worker do.
  // The hint names the engine that would work rather than assuming the browser. ---
  if (!supported) {
    return (
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <Pill tone="warning" dot>
          This engine is not available here. Try On-device Whisper, or use Chrome or Edge.
        </Pill>
        <EnginePicker disabled={false} />
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

      {/*
        On-device model download progress. Non-null only while the Whisper model is loading
        (first use downloads ~150MB once, then it is cached). Announced politely so screen-reader
        users hear the percentage advance without it stealing focus.
      */}
      {modelStatus != null && (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 text-xs text-muted"
        >
          <span aria-hidden="true">⬇</span>
          <span>
            {modelStatus.status} {Math.round(modelStatus.progress * 100)}%
          </span>
        </span>
      )}

      {/*
        Language selector — always rendered (switchable while recording); changing it bounces
        the engine live via the store's lang subscription. Grouped with <optgroup> so the long
        Indian-language list stays scannable, and described by an accessible Hinglish hint.

        Web Speech runs one language model at a time and cannot code-switch mid-session, so the
        right play for Hinglish is a good default (English (India), which handles Indian-accented
        English plus embedded Hindi words best) with a one-tap switch to Hindi for Hindi-heavy
        stretches. The ⓘ surfaces that guidance for sighted users; aria-describedby delivers the
        same hint to screen readers when the select is focused.
      */}
      {/* Engine picker, placed beside the language selector. Disabled mid-session (switching
          rebuilds the engine); its title explains the change applies on the next recording. */}
      <EnginePicker disabled={switchingDisabled} />

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
          aria-describedby={langHintId}
          className="h-8 rounded-[var(--radius-nw)] border border-[color:var(--color-hairline)] bg-[color:var(--nw-surface)] px-2 text-[13px] text-ink-soft focus:border-[color:var(--nw-accent)] focus:outline-none"
        >
          {LANGUAGE_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {/*
          Info affordance for the Hinglish guidance. The visible ⓘ carries a mouse-hover title;
          the hint text itself lives in a visually-hidden element referenced by the select's
          aria-describedby so screen-reader users hear it on focus without it being announced
          twice. Both convey the same recommendation.
        */}
        <span
          className="cursor-help text-xs text-muted"
          tabIndex={0}
          role="img"
          aria-label="Language tip"
          title="Speaking Hinglish? English (India) handles mixed Hindi-English best. Switch to Hindi for Hindi-heavy stretches."
        >
          <span aria-hidden="true">ⓘ</span>
        </span>
        <span id={langHintId} className="sr-only">
          Speaking Hinglish? English (India) handles mixed Hindi-English best. Switch to Hindi
          for Hindi-heavy stretches.
        </span>
      </div>
    </div>
  )
}
