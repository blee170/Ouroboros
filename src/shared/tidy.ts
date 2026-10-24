import type { AgentSnapshot } from './types'

export interface TidyCandidate {
  id: string
  title: string
  reason: string
}

export interface TidyOptions {
  /** Dispatched cards whose report reached their parent are retired this long after that turn ended (minutes). */
  retireMinutes: number
  /** Fallback for dispatched cards that never report (no line): done/idle longer than this (minutes). */
  olderThanMinutes: number
  /** Owner-made cards (no parent) are never candidates unless asked; then the same idle threshold applies to them. */
  includeOwn?: boolean
  /** Only cards dispatched (directly or through a team) by this card — a team tidies its own workers, not another team's. */
  scope?: string
  /**
   * The unattended once-a-minute run: an exited card is closed only `retireMinutes` after its exit was seen, so a
   * crash stays on the board long enough to be read and cards still spawning after a reload are left alone.
   */
  auto?: boolean
  /** Cards whose report line fired after their last turn ended (reportedCards). */
  reported?: Set<string>
  /** Node ids that must never be tidied (protectedCards). */
  protect?: Set<string>
  now?: number
}

interface Line {
  source: string
  target: string
  lastFiredAt?: number
}

/** A report line fires right after the Stop that set lastStopAt; this much slack covers the ordering. */
export const REPORT_SLACK_MS = 5_000

/** Dispatched cards whose line to their parent fired after their last turn ended. */
export function reportedCards(agents: AgentSnapshot[], edges: Line[], slackMs = REPORT_SLACK_MS): Set<string> {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const out = new Set<string>()
  for (const e of edges) {
    const src = byId.get(e.source)
    if (!src?.parentId || src.parentId !== e.target || !e.lastFiredAt) continue
    if (e.lastFiredAt >= (src.lastStopAt ?? src.lastEventAt ?? 0) - slackMs) out.add(e.source)
  }
  return out
}

/**
 * Cards that must stay while work is in flight around them: the target of any line whose source is mid-turn
 * (working, waiting for a human, or still starting — a reviewer about to send "CHANGES REQUESTED" back), every
 * card dispatched by a lead that is mid-turn (it may be deciding what to send them next), and a lead whose
 * worker is mid-turn (its report is still to come).
 */
export function protectedCards(agents: AgentSnapshot[], edges: Array<{ source: string; target: string }>): Set<string> {
  const midTurn = new Set(agents.filter((a) => a.status === 'working' || a.status === 'needs-you' || a.status === 'starting').map((a) => a.id))
  const out = new Set<string>()
  for (const e of edges) if (midTurn.has(e.source)) out.add(e.target)
  for (const a of agents) {
    if (!a.parentId) continue
    if (midTurn.has(a.parentId)) out.add(a.id)
    if (midTurn.has(a.id)) out.add(a.parentId)
  }
  return out
}

/** Every card dispatched by `root`, through any number of team levels. */
export function descendantsOf(agents: Array<{ id: string; parentId?: string }>, root: string): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const a of agents) if (!out.has(a.id) && a.parentId && (a.parentId === root || out.has(a.parentId))) (out.add(a.id), (grew = true))
  }
  return out
}

/** How many dispatch levels sit above a card: owner-made 0, its workers 1, their workers 2. */
export function depthOf(agents: Array<{ id: string; parentId?: string }>, id: string): number {
  const byId = new Map(agents.map((a) => [a.id, a]))
  let depth = 0
  const seen = new Set<string>()
  for (let cur = byId.get(id)?.parentId; cur && !seen.has(cur); cur = byId.get(cur)?.parentId) {
    seen.add(cur)
    depth++
  }
  return depth
}

/** Conductor → team → worker: a worker (two levels below the owner's cards) cannot dispatch further. */
export const MAX_DISPATCH_DEPTH = 2

/** A card that holds a slot: its process runs, or it is still starting. */
const isLive = (a: AgentSnapshot): boolean => a.ptyAlive || a.status === 'starting'

/**
 * Why `creator` may not dispatch another card right now (undefined = it may): too many live workers (`pending`
 * = creations still in flight), or the chain is already Conductor → team → worker deep. Enforced in code, not
 * left to the prompt.
 */
export function dispatchRefusal(agents: AgentSnapshot[], creator: string, maxWorkers: number, pending = 0): string | undefined {
  const depth = depthOf(agents, creator) + 1
  if (depth > MAX_DISPATCH_DEPTH) return `dispatch depth cap: cards go at most ${MAX_DISPATCH_DEPTH} levels below the owner's cards (Conductor → team → worker); ask the card above you to do it`
  const live = agents.filter((a) => a.parentId === creator && isLive(a)).length + pending
  const cap = Math.max(1, maxWorkers)
  if (live >= cap) return `you already have ${live} live cards (cap ${cap}); close or reuse one first (remove_agent, tidy_board, or the same title)`
  return undefined
}

/**
 * Pure selection of cards that can be closed safely. Retirement follows the completion signal, not the clock:
 * - process exited → candidate (on an auto run only `retireMinutes` after the exit was seen)
 * - dispatched card whose report line fired after its last turn, `retireMinutes` after that turn → candidate
 * - dispatched card that never reports, done/idle for `olderThanMinutes` → candidate (fallback)
 * - owner-made cards only with `includeOwn`
 * Conductors, pinned (keep), working / needs-you / starting cards and protected cards are never candidates.
 */
export function selectTidyCandidates(agents: AgentSnapshot[], opts: TidyOptions): TidyCandidate[] {
  const now = opts.now ?? Date.now()
  const retire = Math.max(0, opts.retireMinutes) * 60_000
  const stale = Math.max(1, opts.olderThanMinutes) * 60_000
  const inScope = opts.scope ? descendantsOf(agents, opts.scope) : undefined
  const out: TidyCandidate[] = []
  for (const a of agents) {
    if (a.kind === 'conductor' || a.kind === 'external' || a.keep || opts.protect?.has(a.id)) continue
    if (inScope && !inScope.has(a.id)) continue
    const dispatched = Boolean(a.parentId)
    if (!dispatched && !opts.includeOwn) continue
    // a starting card has no process yet; that is not an exit
    if (a.status === 'starting') continue
    if (a.status === 'ended' || !a.ptyAlive) {
      if (opts.auto && !(a.endedAt && now - a.endedAt >= retire)) continue
      out.push({ id: a.id, title: a.title, reason: 'process exited' })
      continue
    }
    if (a.status === 'working' || a.status === 'needs-you') continue
    const since = a.lastStopAt ?? a.lastEventAt ?? 0
    if (!since) continue
    const idleMin = Math.round((now - since) / 60_000)
    if (dispatched && opts.reported?.has(a.id)) {
      if (now - since >= retire) out.push({ id: a.id, title: a.title, reason: `reported, ${a.status} for ${idleMin} min` })
      continue
    }
    if (now - since > stale) out.push({ id: a.id, title: a.title, reason: `${a.status} for ${idleMin} min${dispatched ? ', no report line' : ''}` })
  }
  return out
}
