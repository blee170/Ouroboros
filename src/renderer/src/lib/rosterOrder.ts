import type { BoardNode } from '@/store/board'

/** Roster groups, ordered like Claude Code's Agent View: what needs a human first, then what is ready to review. */
export const ROSTER_GROUPS: Array<{ label: string; statuses: string[] }> = [
  { label: 'Needs you', statuses: ['needs-you'] },
  { label: 'Ready to review', statuses: ['done'] },
  { label: 'Working', statuses: ['working', 'starting'] },
  { label: 'Idle', statuses: ['idle'] },
  { label: 'Ended', statuses: ['ended'] }
]

export function isAgentCard(n: BoardNode): boolean {
  return n.data.kind !== 'note' && n.data.kind !== 'browser'
}

/** Agent cards in roster order (grouped by status), so Ctrl+1…9 and the roster rows agree. */
export function rosterOrder(nodes: BoardNode[]): BoardNode[] {
  const agents = nodes.filter(isAgentCard)
  const out: BoardNode[] = []
  for (const g of ROSTER_GROUPS) out.push(...agents.filter((n) => g.statuses.includes(n.data.status ?? 'starting')))
  for (const n of agents) if (!out.includes(n)) out.push(n)
  return out
}
