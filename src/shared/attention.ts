/**
 * The attention model (after Orca's, RESEARCH §10.2): a finished turn is "done" only until the owner looks at the
 * card, then the card reads as idle; a card the owner has not looked at since it finished or asked is unread
 * (bold in the sidebar). "Looking at" a card = the window is focused and the card is selected. Pure: the store
 * applies it, main uses the same rule to hold back toasts for the card on screen.
 */
import type { AgentStatus } from './types'

export interface Attention {
  /** card → when its result (a finished turn, a question) arrived unseen */
  unread: Record<string, number>
  /** cards whose finished turn was looked at: they read as idle until the next turn */
  reviewed: Record<string, true>
}

export const EMPTY_ATTENTION: Attention = { unread: {}, reviewed: {} }

const without = <T,>(rec: Record<string, T>, id: string): Record<string, T> => {
  if (!(id in rec)) return rec
  const next = { ...rec }
  delete next[id]
  return next
}

/**
 * A status arrived for a card. Returns the attention after it and the status the card shows: a "done" that
 * only repeats a finished turn (`echo`: Claude Code's idle reminder) is not a new turn, every other "done"
 * is one (a prompt typed straight into a Codex card sends no "working" first), and a turn that ends while
 * the owner is looking at the card needs no mark.
 */
export function onStatus(a: Attention, id: string, prev: AgentStatus | undefined, next: AgentStatus, at: number, viewing: boolean, echo = false): { attention: Attention; shown: AgentStatus } {
  if (next === 'done') {
    if (echo) return { attention: a, shown: a.reviewed[id] ? 'idle' : prev === 'done' ? 'done' : prev ?? 'done' } // the same turn, said again
    if (viewing) return { attention: { unread: without(a.unread, id), reviewed: { ...a.reviewed, [id]: true } }, shown: 'idle' }
    return { attention: { unread: { ...a.unread, [id]: at }, reviewed: without(a.reviewed, id) }, shown: 'done' }
  }
  if (next === 'needs-you') {
    // a card that keeps asking is marked once, from its first question
    const unread = viewing ? without(a.unread, id) : id in a.unread ? a.unread : { ...a.unread, [id]: at }
    return { attention: { unread, reviewed: without(a.reviewed, id) }, shown: 'needs-you' }
  }
  // a new turn, a restart or an exit supersedes whatever was waiting to be read
  return { attention: { unread: without(a.unread, id), reviewed: without(a.reviewed, id) }, shown: next }
}

/** The owner looked at a card: its unread mark goes, and a finished turn now reads as idle. */
export function onViewed(a: Attention, id: string, status: AgentStatus | undefined): { attention: Attention; shown: AgentStatus | undefined } {
  const unread = without(a.unread, id)
  if (status === 'done') return { attention: { unread, reviewed: { ...a.reviewed, [id]: true } }, shown: 'idle' }
  return unread === a.unread ? { attention: a, shown: status } : { attention: { ...a, unread }, shown: status }
}

/**
 * The card to jump to next (Ctrl+Shift+N): the first card after the selected one that needs you, in sidebar
 * order and around the end; with none, the first unread finished turn. Undefined when nothing waits.
 */
export function nextAttention(order: Array<{ id: string; status?: string }>, unread: Record<string, number>, selectedId: string | null): string | undefined {
  const from = selectedId ? order.findIndex((n) => n.id === selectedId) : -1
  const ring = [...order.slice(from + 1), ...order.slice(0, from + 1)]
  return ring.find((n) => n.status === 'needs-you')?.id ?? ring.find((n) => n.status === 'done' && n.id in unread)?.id
}

/** A working card with no event for this long is called out ("no update for 3m"). */
export const SILENT_MS = 2 * 60_000

/** Minutes a working card has been silent, 0 while it is fresh. */
export function silentMinutes(status: AgentStatus | undefined, lastEventAt: number | undefined, now: number): number {
  if (status !== 'working' || !lastEventAt || now - lastEventAt < SILENT_MS) return 0
  return Math.floor((now - lastEventAt) / 60_000)
}
