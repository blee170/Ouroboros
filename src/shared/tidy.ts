import type { AgentSnapshot } from './types'

export interface TidyCandidate {
  id: string
  title: string
  reason: string
}

export interface TidyOptions {
  /** Cards idle/done for longer than this are candidates (minutes). */
  olderThanMinutes: number
  /** Node ids that must never be tidied (conductors, cards with incoming/outgoing pending work). */
  protect?: Set<string>
  now?: number
}

/**
 * Pure selection of cards that can be closed safely:
 * - process already exited (ended)
 * - done/idle for longer than `olderThanMinutes` and not a conductor
 * Working / needs-you / starting cards are never candidates.
 */
export function selectTidyCandidates(agents: AgentSnapshot[], opts: TidyOptions): TidyCandidate[] {
  const now = opts.now ?? Date.now()
  const limit = Math.max(1, opts.olderThanMinutes) * 60_000
  const out: TidyCandidate[] = []
  for (const a of agents) {
    if (a.kind === 'conductor' || opts.protect?.has(a.id)) continue
    if (a.kind === 'external') continue
    if (a.status === 'ended' || !a.ptyAlive) {
      out.push({ id: a.id, title: a.title, reason: 'process exited' })
      continue
    }
    if (a.status === 'working' || a.status === 'needs-you' || a.status === 'starting') continue
    const last = a.lastEventAt ?? 0
    if (last && now - last > limit) {
      out.push({ id: a.id, title: a.title, reason: `${a.status} for ${Math.round((now - last) / 60_000)} min` })
    }
  }
  return out
}
