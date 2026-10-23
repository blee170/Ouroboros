import type { AgentSnapshot } from './types'

/**
 * Autonomous mode ("Governor-lite"): the board keeps working for hours while the owner sleeps or is out.
 * The app, not a prompt, holds the rails: a wall-clock end, a dispatch cap, retries per role, keep-awake,
 * a Stop button, deny rules for every card launched during the run, a stall watchdog, and a card that
 * asks a question is *parked* (never answered for the owner) while the rest goes on. Everything that
 * happens is appended to an event log, and the morning report is rendered from that log plus the board.
 * Pure helpers live here; the main process drives them (src/main/autonomy.ts).
 */

export interface AutonomyConfig {
  /** Wall-clock end (ms epoch): the run stops here whatever is in flight. */
  until: number
  /** create_agent calls allowed during the run (reused cards do not count). */
  maxDispatches: number
  /** The same role title may be replaced (a worker re-made after it ended) this many times. */
  maxRetriesPerTitle: number
  /** A working card with no event for this long is nudged once, then parked. */
  stallMinutes: number
}

export const DEFAULT_AUTONOMY: Omit<AutonomyConfig, 'until'> = { maxDispatches: 20, maxRetriesPerTitle: 3, stallMinutes: 10 }
/** No card working or starting for this long ends the run early: everything is parked, idle or done. */
export const IDLE_END_MINUTES = 15
/** A card paused by a usage limit is told to continue this often. */
export const LIMIT_RETRY_MINUTES = 15

export type RunEventKind = 'start' | 'relaunch' | 'closed' | 'park' | 'unpark' | 'dispatch' | 'refused' | 'retry' | 'deny' | 'stall' | 'nudge' | 'limit' | 'turn' | 'stop'

export interface RunEvent {
  at: number
  kind: RunEventKind
  card?: string
  title?: string
  detail?: string
}

export interface ParkedCard {
  at: number
  title: string
  /** what the card asked or why it stopped (statusDetail) */
  reason: string
}

export interface RunState {
  startedAt: number
  config: AutonomyConfig
  dispatches: number
  /** title (lower-cased) → times it was re-made during the run */
  retries: Record<string, number>
  parked: Record<string, ParkedCard>
  /** card → when it was nudged for a stall (parked if still silent one stall period later) */
  nudged: Record<string, number>
  /** card → when its usage-limit continue was last sent */
  limited: Record<string, number>
  stopped?: { at: number; reason: string }
}

/** What the renderer sees of a run (toolbar pill, preflight sheet). */
export interface AutonomyPublic {
  on: boolean
  startedAt?: number
  until?: number
  dispatches: number
  maxDispatches?: number
  parked: Array<{ id: string; title: string; reason: string; at: number }>
  /** why the last run ended, and where its report went */
  ended?: { at: number; reason: string; reportPath: string }
}

export function newRunState(config: AutonomyConfig, now = Date.now()): RunState {
  return { startedAt: now, config, dispatches: 0, retries: {}, parked: {}, nudged: {}, limited: {} }
}

/**
 * Claude Code `permissions.deny` rules written into every card launched during a run (workers and
 * relaunched cards alike). Code-level, so no prompt can argue them away: nothing leaves this machine
 * (push, PR merge, deploys, production migrations), nothing destroys history, and no card edits the
 * board or its own permission files. Paths outside a worktree are not expressible as a rule; the
 * worktree itself and `git` keep the blast radius.
 */
export const WORKER_DENY_RULES: string[] = [
  'Bash(git push*)',
  'Bash(git merge*)',
  'Bash(git reset --hard*)',
  'Bash(git branch -D*)',
  'Bash(git branch -d*)',
  'Bash(git worktree remove*)',
  'Bash(git clean*)',
  'Bash(gh pr merge*)',
  'Bash(gh workflow run*)',
  'Bash(gh release*)',
  'Bash(vercel*)',
  'Bash(wrangler deploy*)',
  'Bash(npx wrangler deploy*)',
  'Bash(supabase db push*)',
  'Bash(npx supabase db push*)',
  'Bash(supabase migration up*)',
  'Bash(npx prisma migrate deploy*)',
  'Bash(npx prisma db push*)',
  'Bash(rm -rf /*)',
  'Bash(rm -rf ~*)',
  'Bash(Remove-Item -Recurse*)',
  'Edit(**/.ouroboros.json)',
  'Write(**/.ouroboros.json)',
  'Edit(**/.claude/settings.json)',
  'Write(**/.claude/settings.json)',
  'Edit(**/.claude/settings.local.json)',
  'Write(**/.claude/settings.local.json)'
]

/** The settings fragment merged into a card's `--settings` file during a run. */
export function autonomySettingsFragment(): { permissions: { deny: string[] } } {
  return { permissions: { deny: [...WORKER_DENY_RULES] } }
}

/** Why a create_agent call is refused during the run, or null. */
export function autonomyDispatchRefusal(state: RunState): string | null {
  if (state.dispatches >= state.config.maxDispatches) return `Autonomous mode: the run's dispatch cap of ${state.config.maxDispatches} new cards is reached. Reuse a card by title or wait for the owner.`
  return null
}

/** Why re-making a card with this title (after it ended) is refused during the run, or null. */
export function autonomyRetryRefusal(state: RunState, title: string): string | null {
  const n = state.retries[title.trim().toLowerCase()] ?? 0
  if (n >= state.config.maxRetriesPerTitle) return `Autonomous mode: "${title}" was already re-made ${n} times this run (cap ${state.config.maxRetriesPerTitle}). It is parked for the owner; move on to other work.`
  return null
}

export type RelaunchAction = 'relaunch' | 'close' | 'keep'

/**
 * What the toggle does to each live card: Claude cards are relaunched in auto mode with the deny rules
 * (same conversation via --resume), Codex and Gemini cards are closed (no such guarantees there),
 * terminals and command cards are left alone.
 */
export function relaunchAction(a: Pick<AgentSnapshot, 'kind' | 'engine' | 'ptyAlive' | 'status'>): RelaunchAction {
  if (!a.ptyAlive && a.status !== 'starting') return 'keep'
  if (a.kind !== 'claude' && a.kind !== 'conductor') return 'keep'
  return a.engine === 'codex' || a.engine === 'gemini' ? 'close' : 'relaunch'
}

export interface StallAction {
  id: string
  action: 'nudge' | 'park'
}

/** Working cards silent for a stall period: nudge once; one more silent period after the nudge parks them. */
export function stallActions(agents: AgentSnapshot[], state: RunState, now: number): StallAction[] {
  const period = state.config.stallMinutes * 60_000
  if (period <= 0) return []
  const out: StallAction[] = []
  for (const a of agents) {
    if (a.status !== 'working' || state.parked[a.id]) continue
    const last = a.lastEventAt ?? state.startedAt
    if (now - last < period) continue
    const nudgedAt = state.nudged[a.id]
    if (nudgedAt === undefined) out.push({ id: a.id, action: 'nudge' })
    else if (now - nudgedAt >= period) out.push({ id: a.id, action: 'park' })
  }
  return out
}

/** Nothing has been working or starting for IDLE_END_MINUTES: the run has nothing left to do. */
export function endsEarly(agents: AgentSnapshot[], lastBusyAt: number, now: number): boolean {
  const busy = agents.some((a) => a.status === 'working' || a.status === 'starting')
  return !busy && now - lastBusyAt >= IDLE_END_MINUTES * 60_000
}

/** A StopFailure whose message says the plan's usage limit or the API's rate limit is the reason. */
export function isUsageLimit(detail: string | undefined): boolean {
  return /rate.?limit|usage limit|limit reached|overloaded|429|resets? at|try again (in|at)/i.test(detail ?? '')
}

export const NUDGE_PROMPT = 'Autonomous mode check-in: no activity from you for a while. If you are done, end your reply with RESULT: and the markers your role asks for. If you are stuck, say BLOCKED: and why, then stop. Do not wait for the owner; nobody is here until the run ends.'
export const LIMIT_PROMPT = 'Autonomous mode: the limit may have reset. Continue where you left off; if it is still blocked, say BLOCKED: usage limit and stop.'

export function autonomyBrief(until: number, maxDispatches: number): string {
  const end = new Date(until)
  const hhmm = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
  return [
    `AUTONOMOUS MODE is on until ${hhmm}. The owner is away and will not answer until then; the app enforces the rails, you keep the work moving.`,
    '- Never wait for the owner. A card that asks a question or needs a permission is parked by the app (its report line says "needs input"): note it in the Pipeline note under "Waiting on you", do not answer for the owner, and move on to work that does not depend on it. If everything left depends on the owner, say so in one reply and stop; the run ends on its own.',
    '- Human gates stay gates: no push, merge, deploy, production data change or spend; those are refused by the app anyway. Prepare them (branch, commands, rollback) and list them for the morning.',
    `- Caps: ${maxDispatches} new cards for the whole run, a role may be re-made 3 times; reuse cards by title. A card silent too long is nudged once, then parked.`,
    '- Every stage must leave evidence: a branch and commit on its own worktree, tests run, a diff you reviewed with get_changes. "Tests green" is not "done": say what was verified and what was not.',
    '- When the run ends you get no more turns; keep the Pipeline note current after every event so the morning report (built by the app from the log and the board) and the note agree.'
  ].join('\n')
}

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const mins = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))} min`
const firstLine = (s: string | undefined): string => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 160) ?? ''

export interface CardEvidence {
  branch?: string
  added?: number
  removed?: number
  files?: number
}

/**
 * The morning report: what waits on the owner first, then every card's outcome with its evidence
 * (branch, diff size, last reply line), the denials and stalls, the caps, and the timeline. Built from
 * the event log and the board, never from a card's own claims.
 */
export function reportMarkdown(state: RunState, events: RunEvent[], agents: AgentSnapshot[], evidence: Record<string, CardEvidence> = {}): string {
  const end = state.stopped?.at ?? Date.now()
  const lines: string[] = []
  lines.push(`# Autonomous run · ${new Date(state.startedAt).toLocaleDateString()} ${hhmm(state.startedAt)} → ${hhmm(end)} (${mins(end - state.startedAt)})`)
  lines.push('')
  lines.push(`Ended: **${state.stopped?.reason ?? 'running'}** · dispatches ${state.dispatches}/${state.config.maxDispatches} · parked ${Object.keys(state.parked).length} · events ${events.length}`)
  lines.push('')
  const parked = Object.entries(state.parked)
  lines.push('## Waiting on you')
  if (parked.length === 0) lines.push('Nothing. No card asked a question or hit a wall.')
  else for (const [id, p] of parked) lines.push(`- **${p.title}** (${id}) since ${hhmm(p.at)}: ${p.reason}`)
  lines.push('')
  lines.push('## Cards')
  lines.push('| Card | Status | Evidence | Last reply |')
  lines.push('|---|---|---|---|')
  for (const a of agents) {
    if (a.kind === 'note' || a.kind === 'browser') continue
    const ev = evidence[a.id]
    const evidenceText = [ev?.branch ? `branch \`${ev.branch}\`` : '', ev && (ev.added || ev.removed) ? `+${ev.added ?? 0} −${ev.removed ?? 0} in ${ev.files ?? 0} files` : '', ev && !ev.added && !ev.removed ? 'no uncommitted changes' : ''].filter(Boolean).join(', ') || '—'
    const parkedMark = state.parked[a.id] ? ' · parked' : ''
    lines.push(`| ${a.title} | ${a.status}${parkedMark} | ${evidenceText} | ${firstLine(a.lastAssistantMessage).replace(/\|/g, '\\|') || '—'} |`)
  }
  lines.push('')
  const denies = events.filter((e) => e.kind === 'deny')
  const refused = events.filter((e) => e.kind === 'refused')
  const stalls = events.filter((e) => e.kind === 'stall' || e.kind === 'nudge')
  const limits = events.filter((e) => e.kind === 'limit')
  lines.push('## Rails')
  lines.push(`- Denied actions: ${denies.length}${denies.length ? ' — ' + denies.slice(0, 8).map((e) => `${e.title ?? e.card}: ${e.detail ?? ''}`).join('; ') : ''}`)
  lines.push(`- Refused dispatches: ${refused.length}${refused.length ? ' — ' + refused.slice(0, 5).map((e) => e.detail ?? '').join('; ') : ''}`)
  lines.push(`- Stalls: ${stalls.length}${stalls.length ? ' — ' + stalls.slice(0, 8).map((e) => `${e.title ?? e.card} ${e.kind} at ${hhmm(e.at)}`).join('; ') : ''}`)
  lines.push(`- Usage limits: ${limits.length}${limits.length ? ' — ' + limits.slice(0, 5).map((e) => `${e.title ?? e.card} at ${hhmm(e.at)}`).join('; ') : ''}`)
  lines.push('')
  lines.push('## Timeline')
  for (const e of events) lines.push(`- ${hhmm(e.at)} ${e.kind}${e.title ? ` · ${e.title}` : ''}${e.detail ? ` — ${e.detail}` : ''}`)
  lines.push('')
  lines.push('_A green status is not success: open the branch and the diff before you trust a card._')
  return lines.join('\n')
}
