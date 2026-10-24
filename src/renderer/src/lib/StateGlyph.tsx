import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react'
import type { AgentStatus } from '@shared/types'
import { STATUS_LABEL } from '@shared/status'

/**
 * A card's state as one glyph, the only place the chrome uses colour: a spinning ring while it works (yellow),
 * an orange "?" when it needs you, a green check when a turn is done, a quiet dot otherwise. The shape differs
 * too, so the state reads without the colour.
 */
export function StateGlyph({ status, size = 14, title, decorative }: { status: AgentStatus; size?: number; title?: string; /** true when the state is also written next to it: the glyph then says nothing to a screen reader */ decorative?: boolean }) {
  const label = title ?? STATUS_LABEL[status] ?? String(status)
  const box = { width: size, height: size }
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label }
  switch (status) {
    case 'working':
      return (
        <span className="sg sg-working" style={box} title={label} {...a11y}>
          <LoaderCircle size={size} aria-hidden="true" />
        </span>
      )
    case 'needs-you':
      return (
        <span className="sg" style={box} title={label} {...a11y}>
          <span className="sg-needs" style={{ width: size - 2, height: size - 2, fontSize: Math.round(size * 0.68) }}>
            ?
          </span>
        </span>
      )
    case 'done':
      return (
        <span className="sg sg-done" style={box} title={label} {...a11y}>
          <CircleCheck size={size} aria-hidden="true" />
        </span>
      )
    case 'starting':
      return (
        <span className="sg sg-starting" style={box} title={label} {...a11y}>
          <CircleDashed size={size} aria-hidden="true" />
        </span>
      )
    case 'ended':
      return (
        <span className="sg" style={box} title={label} {...a11y}>
          <span className="sg-dot ended" style={{ width: Math.round(size / 2), height: Math.round(size / 2) }} />
        </span>
      )
    default:
      // idle, and any status an older or newer board file carries that this build does not know
      return (
        <span className="sg" style={box} title={label} {...a11y}>
          <span className="sg-dot" style={{ width: Math.round(size / 2), height: Math.round(size / 2) }} />
        </span>
      )
  }
}
