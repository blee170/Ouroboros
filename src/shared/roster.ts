/** What the sidebar order needs of a card; the renderer's BoardNode satisfies it. */
export interface RosterNode {
  id: string
  data: { kind: string; status?: string; parentId?: string }
}

/** Sidebar sections, ordered like Claude Code's Agent View: what needs a human first, then what is ready to review. */
export const ROSTER_GROUPS: Array<{ label: string; statuses: string[] }> = [
  { label: 'Needs you', statuses: ['needs-you'] },
  { label: 'Ready to review', statuses: ['done'] },
  { label: 'Working', statuses: ['working', 'starting'] },
  { label: 'Idle', statuses: ['idle'] },
  { label: 'Ended', statuses: ['ended'] }
]

export function isAgentCard(n: RosterNode): boolean {
  return n.data.kind !== 'note' && n.data.kind !== 'browser'
}

/**
 * The rows of one section: a card, then the cards that report to it (parentId) when they sit in the same
 * section, indented one level per hop (Conductor → team lead → worker). A worker whose Conductor is elsewhere
 * (idle while the worker needs you) stays a flat row, so the attention order of the sections is never hidden
 * by the hierarchy. A parent cycle starts flat at the end, its members under the first of them.
 */
export function groupRows<T extends RosterNode>(members: T[]): Array<{ node: T; depth: number }> {
  const ids = new Set(members.map((n) => n.id))
  const out: Array<{ node: T; depth: number }> = []
  const placed = new Set<string>()
  const place = (n: T, depth: number): void => {
    if (placed.has(n.id)) return
    placed.add(n.id)
    out.push({ node: n, depth })
    for (const c of members) if (c.data.parentId === n.id && c.id !== n.id) place(c, depth + 1)
  }
  for (const n of members) {
    const parent = n.data.parentId
    if (parent && parent !== n.id && ids.has(parent)) continue // placed under its parent
    place(n, 0)
  }
  for (const n of members) if (!placed.has(n.id)) place(n, 0)
  return out
}

/** Agent cards in sidebar order (grouped by status, workers under their Conductor), so Ctrl+1…9 and the rows agree. */
export function rosterOrder<T extends RosterNode>(nodes: T[]): T[] {
  const agents = nodes.filter(isAgentCard)
  const out: T[] = []
  for (const g of ROSTER_GROUPS) out.push(...groupRows(agents.filter((n) => g.statuses.includes(n.data.status ?? 'starting'))).map((r) => r.node))
  for (const n of agents) if (!out.includes(n)) out.push(n)
  return out
}
