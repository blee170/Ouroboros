import type { AgentSnapshot } from './types'

/**
 * Asleep cards: a finished Claude card whose process (and its whole tree) was stopped. The card keeps its place, its
 * title and its Claude session id, shows status "ended" with this detail, and wakes on the same conversation
 * (--resume) when the owner presses Wake or a prompt or board message is sent to it.
 */
export const ASLEEP_DETAIL = 'asleep'

/** "Sleep finished cards after N minutes": the smallest N the setting takes (0 = off, the default). */
export const SLEEP_MIN_MINUTES = 5
export const SLEEP_MAX_MINUTES = 1440

/** The setting as used: 0 (off) or a number of minutes in range. */
export function sleepMinutes(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(SLEEP_MAX_MINUTES, Math.max(SLEEP_MIN_MINUTES, n))
}

export interface SleepView {
  kind: string
  engine?: string
  sessionId?: string
  status?: string
  ptyAlive?: boolean
  asleep?: boolean
  keep?: boolean
}

export interface SleepRules {
  /** An Autonomous run is on: nothing is put to sleep during a run. */
  autonomous?: boolean
  /** A card wired to one that is mid-turn (protectedCards). */
  protected?: boolean
  /** The card still has something open: a running subagent, a queued prompt, a role or handoff-note turn, a fresh start. */
  busy?: boolean
  /** "Sleep finished cards" and the timed sleep: a pinned card is left alone (the owner can still sleep it by hand). */
  bulk?: boolean
}

/** Why a card cannot be put to sleep now (undefined = it can). Pure. */
export function sleepRefusal(c: SleepView, rules: SleepRules = {}): string | undefined {
  if (c.asleep) return 'it is already asleep'
  if (c.kind === 'conductor') return 'a Conductor never sleeps'
  if (c.kind !== 'claude') return 'only agent cards sleep (terminal and command cards are shells)'
  if ((c.engine ?? 'claude') !== 'claude') return 'only Claude Code cards sleep: they wake on the same conversation'
  if (!c.sessionId) return 'it has no conversation to wake on yet'
  if (rules.autonomous) return 'an Autonomous run is on'
  if (!c.ptyAlive) return 'its process is not running'
  if (c.status !== 'idle' && c.status !== 'done') return `it is ${c.status ?? 'starting'}`
  if (rules.bulk && c.keep) return 'it is pinned'
  if (rules.protected) return 'a card it is wired to is mid-turn'
  if (rules.busy) return 'it still has work open'
  return undefined
}

export interface SleepSelection {
  now: number
  /** The timed sleep: only cards the owner made, done/idle at least this long. Unset: every eligible card ("Sleep finished cards"). */
  minutes?: number
  autonomous?: boolean
  protect?: ReadonlySet<string>
  busy?: ReadonlySet<string>
  /** When each card was last given a prompt or a keystroke: the timed sleep counts idle time from the later of that and its last stop. */
  lastInput?: ReadonlyMap<string, number>
}

/** The cards to put to sleep now. Pure. */
export function selectSleepCandidates(agents: AgentSnapshot[], opts: SleepSelection): string[] {
  const out: string[] = []
  for (const a of agents) {
    if (sleepRefusal(a, { autonomous: opts.autonomous, protected: opts.protect?.has(a.id), busy: opts.busy?.has(a.id), bulk: true })) continue
    if (opts.minutes !== undefined) {
      if (a.parentId) continue // dispatched cards retire through tidy
      const since = Math.max(a.lastStopAt ?? a.lastEventAt ?? 0, opts.lastInput?.get(a.id) ?? 0)
      if (!since || opts.now - since < opts.minutes * 60_000) continue
    }
    out.push(a.id)
  }
  return out
}
