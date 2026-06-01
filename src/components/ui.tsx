/**
 * Small, professional UI atoms shared across NoteWeave.
 *
 * Intentionally minimal and unopinionated about layout — feature agents compose these
 * and own their own component styling. Everything here is keyboard-accessible and uses
 * the design tokens from index.css (via Tailwind v4 utilities like `bg-accent`, `text-ink`).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-nw)] font-medium ' +
  'transition-colors duration-150 select-none whitespace-nowrap ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-[color:var(--nw-accent-contrast)] shadow-[var(--nw-shadow-sm)] ' +
    'hover:bg-[color:var(--nw-accent-strong)] active:translate-y-px',
  ghost:
    'bg-transparent text-ink-soft border border-[color:var(--color-hairline)] ' +
    'hover:bg-[color:var(--nw-surface-muted)] hover:text-ink',
  danger:
    'bg-transparent text-[color:var(--nw-danger)] border border-[color:var(--nw-danger)] ' +
    'hover:bg-[color:var(--nw-danger-soft)]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Optional leading icon/glyph node. */
  leading?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  leading,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
      {...rest}
    >
      {leading != null && <span className="shrink-0" aria-hidden="true">{leading}</span>}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible label — icon buttons have no visible text. */
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
}

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 w-8 text-[15px]',
  md: 'h-10 w-10 text-base',
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  children,
  type,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex items-center justify-center rounded-[var(--radius-nw)] ' +
          'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        ICON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  )
}

export interface PanelProps {
  children: ReactNode
  className?: string
  /** Inner padding preset. Use 'none' when the panel hosts its own scroll region. */
  padding?: 'none' | 'sm' | 'md'
  as?: 'div' | 'section' | 'aside'
}

const PANEL_PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
} as const

export function Panel({ children, className, padding = 'md', as = 'div' }: PanelProps) {
  const Tag = as
  return (
    <Tag
      className={cx(
        'rounded-[var(--nw-radius-lg)] border border-[color:var(--color-hairline)] ' +
          'bg-[color:var(--nw-surface)] shadow-[var(--nw-shadow-sm)]',
        PANEL_PADDING[padding],
        className,
      )}
    >
      {children}
    </Tag>
  )
}

export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'live'

const PILL_TONES: Record<PillTone, string> = {
  neutral:
    'bg-[color:var(--nw-surface-muted)] text-ink-soft border border-[color:var(--color-hairline)]',
  accent: 'bg-[color:var(--nw-accent-soft)] text-[color:var(--nw-accent-strong)]',
  success: 'bg-[color:#e6f4ec] text-[color:var(--nw-success)]',
  warning: 'bg-[color:#fbf0e3] text-[color:var(--nw-warning)]',
  danger: 'bg-[color:var(--nw-danger-soft)] text-[color:var(--nw-danger)]',
  live: 'bg-[color:var(--nw-danger-soft)] text-[color:var(--nw-danger)]',
}

export interface PillProps {
  children: ReactNode
  tone?: PillTone
  /** Show a small leading status dot (handy for connection/recording state). */
  dot?: boolean
  className?: string
}

export function Pill({ children, tone = 'neutral', dot = false, className }: PillProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        PILL_TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cx(
            'inline-block h-1.5 w-1.5 rounded-full bg-current',
            tone === 'live' && 'animate-pulse',
          )}
        />
      )}
      {children}
    </span>
  )
}
