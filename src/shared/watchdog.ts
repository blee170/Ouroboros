import type { AgentSnapshot } from './types'
import { failureOf } from './status'

/**
 * Stall watchdog (RESEARCH §9.6, roadmap D): outside an autonomous run, a card that is Working with no hook
 * event for a while, or that has waited on a person for a while, is reported to the Conductor it reports to;
 * the third report for the same card since its last finished turn also goes to the owner. Pure: the caller
 * keeps the state and sends the messages.
 */
export const DEFAULT_STALL_MINUTES = 15
/** From this many reports since the card last finished a turn, the owner is told too. */
export const ESCALATE_AFTER = 3

export type StallReason = 'silent' | 'waiting'

export interface StallReport {
  id: string
  reason: StallReason
  /** Minutes since the card's last hook event. */
  minutes: number
  /** The owner is told as well (third report or later since the last finished turn). */
  escalate: boolean
}

export interface WatchdogState {
  /** Per card: the quiet stretch (its lastEventAt), when it was last reported, and the count since the last Stop. */
  cards: Record<string, { event: number; at: number; count: number; since: number }>
}

export const newWatchdogState = (): WatchdogState => ({ cards: {} })

/**
 * Cards to report now, updating `state`. A tool call in progress ("tool: …", a long build or test) gets three
 * periods; terminal and command cards have no hooks and are never reported; a "failed:" needs-you is an ended
 * turn, not a wait. A quiet card is reported again every period until the escalation, then not again until a
 * new hook event starts a new quiet stretch.
 */
export function watchdogReports(agents: AgentSnapshot[], state: WatchdogState, now: number, minutes: number): StallReport[] {
  const base = minutes * 60_000
  const live = new Set(agents.map((a) => a.id))
  for (const id of Object.keys(state.cards)) if (!live.has(id)) delete state.cards[id]
  if (base <= 0) return []
  const out: StallReport[] = []
  for (const a of agents) {
    if (a.kind === 'terminal' || a.kind === 'command' || a.kind === 'browser' || a.kind === 'note') continue
    const last = a.lastEventAt
    if (!last) continue
    let reason: StallReason
    if (a.status === 'working') reason = 'silent'
    else if (a.status === 'needs-you' && !failureOf(a.statusDetail)) reason = 'waiting'
    else continue
    const period = reason === 'silent' && /^tool\b/.test(a.statusDetail ?? '') ? 3 * base : base
    if (now - last < period) continue
    const prev = state.cards[a.id]
    if (prev && prev.event === last && (now - prev.at < period || prev.count >= ESCALATE_AFTER)) continue
    // the count starts over once the card finishes a turn after the last report
    const fresh = !prev || (a.lastStopAt ?? 0) > prev.since
    const count = fresh ? 1 : prev.count + 1
    state.cards[a.id] = { event: last, at: now, count, since: fresh ? now : prev.since }
    out.push({ id: a.id, reason, minutes: Math.floor((now - last) / 60_000), escalate: count >= ESCALATE_AFTER })
  }
  return out
}
