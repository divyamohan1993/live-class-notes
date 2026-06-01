/**
 * Time formatting helpers. All clock output is local time, 24-hour, zero-padded so
 * timestamps line up visually down a long transcript.
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Local wall-clock time for an epoch, as "HH:MM:SS" (24-hour).
 * Example: 09:04:37
 */
export function formatClock(epoch: number): string {
  const d = new Date(epoch)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * A duration in milliseconds as "HH:MM:SS". Hours are not capped at 24, so a 10-hour
 * lecture reads "10:00:00". Negative or non-finite input clamps to "00:00:00".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '00:00:00'
  }
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * A human date label in day-month-year order, e.g. "1 June 2026".
 * Uses local date components (no leading zero on the day).
 */
export function formatDateLabel(epoch: number): string {
  const d = new Date(epoch)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
