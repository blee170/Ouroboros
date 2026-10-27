import type { AgentSnapshot } from './types'
import { summarizeTasks, type Task } from './ledger'
import type { Mail } from './mail'

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
/** A relaunched or new card that shows no session after this long never came up (stale --resume id, trust prompt, crash). */
export const START_GRACE_MINUTES = 3

export type RunEventKind = 'start' | 'relaunch' | 'closed' | 'park' | 'unpark' | 'dispatch' | 'refused' | 'retry' | 'deny' | 'stall' | 'nudge' | 'limit' | 'turn' | 'stop' | 'notion' | 'gate' | 'phone' | 'decision' | 'relay'

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
/**
 * Shell command prefixes denied during a run. Claude Code matches a rule against the command as typed
 * (compound commands split, env prefixes and wrappers like `timeout` stripped), so `git push` is caught
 * but `git -C x push`, an alias, a script that pushes or a nested `bash -c` is not: these are a guard
 * against the obvious, not a sandbox.
 */
const SHELL_DENY_PREFIXES = [
  'git push',
  'git send-pack',
  'git merge',
  'git rebase',
  'git reset --hard',
  'git branch -D',
  'git branch -d',
  'git branch --delete',
  'git worktree remove',
  'git worktree prune',
  'git clean',
  'git stash drop',
  'git stash clear',
  'git tag -d',
  'git update-ref -d',
  'git reflog expire',
  'git gc --prune',
  'git filter-branch',
  'git filter-repo',
  'git add -f',
  'git add --force',
  'gh pr merge',
  'gh workflow run',
  'gh release',
  'gh api',
  'gh repo delete',
  'gh alias set',
  'gh alias import',
  'gh secret',
  'gh variable',
  'npm publish',
  'pnpm publish',
  'docker push',
  'vercel',
  'npx vercel',
  'wrangler',
  'npx wrangler',
  'firebase deploy',
  'netlify deploy',
  'fly deploy',
  'terraform apply',
  'supabase db push',
  'npx supabase db push',
  'supabase db reset',
  'npx supabase db reset',
  'supabase migration up',
  'npx prisma migrate deploy',
  'npx prisma migrate reset',
  'npx prisma db push',
  'prisma migrate deploy',
  'prisma migrate reset',
  'rm -rf /',
  'rm -rf ~',
  'rm -fr /',
  'rm -fr ~'
]

/** `git -C x push` and `gh -R r pr merge` put options before the subcommand: a second, mid-pattern rule (verified on 2.1.309: it catches those and not `git commit -m "push notes"`). */
const withOptionsBefore = (p: string): string[] => {
  const m = /^(git|gh) (.+)$/.exec(p)
  return m ? [p, `${m[1]} * ${m[2]}`] : [p]
}

/**
 * The app's own settings (a program path there is run by the app, a switch there lets Grok Bot send without asking) and
 * data, on Windows and macOS. Denied to every Claude card, in a run or not. Edit rules only: a shell command that writes
 * the file is not caught (outside a run the owner still sees Claude Code's prompt for it).
 */
export const DATA_DIR_DENY_RULES = ['Edit(~/AppData/Roaming/Ouroboros/**)', 'Edit(~/Library/Application Support/Ouroboros/**)']

/** A Claude card's extra `--settings`: the run's fragment when one is on, and the data-folder rules always. */
export function cardSettingsExtra(runFragment?: Record<string, unknown>): Record<string, unknown> {
  const run = (runFragment ?? {}) as { permissions?: { deny?: string[] } }
  const deny = [...new Set([...(run.permissions?.deny ?? []), ...DATA_DIR_DENY_RULES])]
  return { ...run, permissions: { ...run.permissions, deny } }
}

export const WORKER_DENY_RULES: string[] = [
  // Claude Code's PowerShell tool has its own rule namespace (the CLI itself writes every rule twice); a run must hold in both
  ...SHELL_DENY_PREFIXES.flatMap(withOptionsBefore).flatMap((p) => [`Bash(${p}*)`, `PowerShell(${p}*)`]),
  'PowerShell(Remove-Item * -Recurse*)',
  'PowerShell(Remove-Item -Recurse*)',
  'PowerShell(rm * -r*)',
  // Edit(...) rules cover every file-editing tool (Write included); a Write(...) rule only draws a warning at launch.
  // Relative patterns are matched from the card's own folder; ~/.claude is the owner's: a planted hook there outlives the night.
  // In ~/.claude a card's auto memory (projects/<project>/memory) stays writable; denied is what Claude Code, its hooks
  // (scripts in tools/ and elsewhere) or Chrome run, and what later sessions load or resume. Gitignore patterns have no
  // "except" (a `~/.claude/*` would match the projects folder as a whole; `[!x]` classes did not work on 2.1.310), so this is
  // a list: a folder nobody listed is not covered.
  'Edit(**/.ouroboros.json)',
  ...DATA_DIR_DENY_RULES,
  'Edit(**/.claude/settings.json)',
  'Edit(**/.claude/settings.local.json)',
  ...['*.json', '*.md', '*.sh', '*.ps1', '*.cmd', '*.bat', '*.js', '*.cjs', '*.mjs', '*.ts', '*.py', 'statusline*', '.claude.json', '.credentials.json'].map((f) => `Edit(~/.claude/${f})`),
  ...['hooks', 'plugins', 'skills', 'agents', 'commands', 'output-styles', 'rules', 'scripts', 'bin', 'tools', 'chrome', 'scheduled-tasks', 'ck', 'daemon', 'jobs', 'shell-snapshots', 'session-env', 'ide'].map((d) => `Edit(~/.claude/${d}/**)`),
  'Edit(~/.claude/projects/*/*.jsonl)',
  'Edit(~/.claude.json)',
  // the board's browser is the owner's signed-in browser: reading is fine, clicking Merge or Redeploy is not
  'mcp__ouroboros__browser_click',
  'mcp__ouroboros__browser_type'
]

/** Decided by the action gate instead of denied outright, when the gate hook is installed (src/shared/gate.ts). */
export const GATED_PREFIXES = ['git push', 'git send-pack', 'gh pr merge', 'supabase db reset', 'npx supabase db reset']

/**
 * Kept denied even with the gate: if the hook cannot run at all (node gone, the script missing, a timeout), Claude
 * Code lets the command through, so the forms the gate always refuses stay on the deny list as a second rail. None of
 * them can be an allowed push (those name a claude/* or card/* branch).
 */
const GATE_BACKSTOP = ['git push -f', 'git push --force', 'git push --delete', 'git push -d', 'git push --mirror', 'git push --all', 'git push --tags', 'git push --prune', 'git push origin main', 'git push origin master', 'git push origin HEAD:main', 'git push origin HEAD:master', 'git push origin +', 'git push origin :', 'git send-pack', 'supabase db reset --linked', 'supabase db reset --db-url', 'npx supabase db reset --linked', 'npx supabase db reset --db-url']

/**
 * The settings fragment merged into a card's `--settings` file during a run. With a gate command (the PreToolUse
 * helper that asks the app), pushes and PR merges come off the deny list: a hook's allow cannot override a deny rule.
 * Without one (no node binary to run it), they stay denied.
 */
export function autonomySettingsFragment(gateCommand?: string): { permissions: { deny: string[] }; hooks?: Record<string, unknown[]> } {
  if (!gateCommand) return { permissions: { deny: [...WORKER_DENY_RULES] } }
  const gated = new Set(GATED_PREFIXES.flatMap(withOptionsBefore).flatMap((p) => [`Bash(${p}*)`, `PowerShell(${p}*)`]))
  return {
    permissions: { deny: [...WORKER_DENY_RULES.filter((r) => !gated.has(r)), ...GATE_BACKSTOP.flatMap((p) => [`Bash(${p}*)`, `PowerShell(${p}*)`])] },
    hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: gateCommand, timeout: 15 }] }] }
  }
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
 * Engines a run keeps: Claude (auto mode, deny rules, the action gate) and Codex (its own sandbox: workspace-write
 * with no network and a read-only .git, never asking). Gemini and Grok have neither rails nor a sandbox to rely on.
 */
export function engineJoinsRun(engine: string | undefined): boolean {
  return engine === undefined || engine === 'claude' || engine === 'codex'
}

/**
 * What the toggle does to each live card: Claude and Codex cards are relaunched with the run's rails (same
 * conversation where there is a session to resume), Gemini and Grok cards are closed (no such guarantees there),
 * terminals and command cards are left alone.
 */
export function relaunchAction(a: Pick<AgentSnapshot, 'kind' | 'engine' | 'ptyAlive' | 'status'>): RelaunchAction {
  if (a.status === 'ended') return 'keep' // /exit or a crash inside a live shell is still an ended card
  if (!a.ptyAlive && a.status !== 'starting') return 'keep'
  if (a.kind !== 'claude' && a.kind !== 'conductor') return 'keep'
  return engineJoinsRun(a.engine) ? 'relaunch' : 'close'
}

export interface StallAction {
  id: string
  action: 'nudge' | 'park'
}

/**
 * Working Claude cards silent for a stall period: nudge once; one more silent period after the nudge parks
 * them. A card in the middle of a tool call (statusDetail "tool: …", a long build or test run) gets three
 * periods, and command cards cannot take a nudge at all. Activity after a nudge resets it.
 */
export function stallActions(agents: AgentSnapshot[], state: RunState, now: number): StallAction[] {
  const base = state.config.stallMinutes * 60_000
  if (base <= 0) return []
  const out: StallAction[] = []
  for (const a of agents) {
    if (a.status !== 'working' || state.parked[a.id] || a.kind === 'command' || a.kind === 'terminal') continue
    const period = /^tool\b/.test(a.statusDetail ?? '') ? 3 * base : base
    const last = a.lastEventAt ?? state.startedAt
    if (now - last < period) continue
    const nudgedAt = state.nudged[a.id]
    if (nudgedAt === undefined || last > nudgedAt) out.push({ id: a.id, action: 'nudge' })
    else if (now - nudgedAt >= period) out.push({ id: a.id, action: 'park' })
  }
  return out
}

/** Cards still 'starting' with no session event for START_GRACE_MINUTES: the launch never came up. */
export function staleStarting(agents: AgentSnapshot[], state: RunState, now: number): AgentSnapshot[] {
  return agents.filter((a) => a.status === 'starting' && !state.parked[a.id] && now - (a.lastEventAt ?? state.startedAt) >= START_GRACE_MINUTES * 60_000)
}

/** Nothing (parked cards aside) has been working or starting for IDLE_END_MINUTES: the run has nothing left to do. */
export function endsEarly(agents: AgentSnapshot[], state: Pick<RunState, 'parked'>, lastBusyAt: number, now: number): boolean {
  const busy = agents.some((a) => !state.parked[a.id] && (a.status === 'working' || a.status === 'starting'))
  return !busy && now - lastBusyAt >= IDLE_END_MINUTES * 60_000
}

/** A StopFailure whose message says the plan's usage limit or the API's rate limit is the reason. */
export function isUsageLimit(detail: string | undefined): boolean {
  return /rate.?limit|usage limit|limit reached|overloaded|429|resets? at|try again (in|at)/i.test(detail ?? '')
}

export const NUDGE_PROMPT = 'Autonomous mode check-in: no activity from you for a while. If you are done, end your reply with RESULT: and the markers your role asks for. If you are stuck, say BLOCKED: and why, then stop. Do not wait for the owner; nobody is here until the run ends.'
export const LIMIT_PROMPT = 'Autonomous mode: the limit may have reset. Continue where you left off; if it is still blocked, say BLOCKED: usage limit and stop.'
export const RESUME_PROMPT = 'Autonomous mode started and restarted this session in auto mode; your previous turn was cut. Continue the task you were on from where it stands (check the files, do not redo finished work), and end with your report markers as usual.'

export function autonomyBrief(until: number, maxDispatches: number): string {
  const end = new Date(until)
  const hhmm = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
  return [
    `AUTONOMOUS MODE is on until ${hhmm}. The owner is away and will not answer until then; the app enforces the rails, you keep the work moving.`,
    '- Never wait for the owner. A card that asks a question or needs a permission is parked by the app (its report line says "needs input"): mark its task blocked with the reason (task_update), do not answer for the owner, and move on to work that does not depend on it. If everything left depends on the owner, say so in one reply and stop; the run ends on its own.',
    '- Human gates stay gates: no push, merge, deploy, production data change or spend; those are refused by the app anyway. Prepare them (branch, commands, rollback) and list them for the morning.',
    `- Caps: ${maxDispatches} new cards for the whole run, a role may be re-made 3 times; reuse cards by title. A card silent too long is nudged once, then parked.`,
    '- Every stage must leave evidence: a branch and commit on its own worktree, tests run, a diff you reviewed with get_changes. "Tests green" is not "done": say what was verified and what was not.',
    '- When the run ends you get no more turns; keep the task ledger current after every event (task_update: done with the result, blocked with the reason) so the morning report, which the app builds from the ledger, the log and the board, says what you know.'
  ].join('\n')
}

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const mins = (ms: number): string => `${Math.max(0, Math.round(ms / 60_000))} min`
const firstLine = (s: string | undefined): string => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 160) ?? ''
// titles, reasons and branch names come from cards (a Conductor names cards and can rename them): no card gets to add
// its own rows, sections or list items to the report
const oneLine = (s: string | undefined): string => (s ?? '').replace(/[\r\n]+/g, ' ').trim()
const cell = (s: string | undefined): string => oneLine(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
/** The last events kept in the report; the JSONL log has every one. */
const TIMELINE_MAX = 300

export interface CardEvidence {
  branch?: string
  added?: number
  removed?: number
  files?: number
}

/**
 * The morning report: what waits on the owner first, then every card's outcome with its evidence
 * (branch, diff size, last reply line), the denials and stalls, the caps, and the timeline. Built from
 * the event log and the board; the Tasks table is what the cards recorded in the ledger and is marked as such.
 */
export function reportMarkdown(state: RunState, events: RunEvent[], agents: AgentSnapshot[], evidence: Record<string, CardEvidence> = {}, tasks: Task[] = [], mail: Mail[] = []): string {
  const titleOf = (id: string | undefined): string => (id ? (agents.find((a) => a.id === id)?.title ?? id) : '—')
  const end = state.stopped?.at ?? Date.now()
  const lines: string[] = []
  lines.push(`# Autonomous run · ${new Date(state.startedAt).toLocaleDateString()} ${hhmm(state.startedAt)} → ${hhmm(end)} (${mins(end - state.startedAt)})`)
  lines.push('')
  lines.push(`Ended: **${state.stopped?.reason ?? 'running'}** · dispatches ${state.dispatches}/${state.config.maxDispatches} · parked ${Object.keys(state.parked).length} · events ${events.length}`)
  lines.push('')
  const parked = Object.entries(state.parked)
  lines.push('## Waiting on you')
  const blocked = tasks.filter((t) => t.state === 'blocked')
  const gates = events.filter((e) => e.kind === 'gate')
  const askedIds = new Map<string, RunEvent>()
  for (const e of gates) {
    const m = /^approval asked \((A\d+)\)/.exec(e.detail ?? '')
    if (m) askedIds.set(m[1], e)
    const d = /^(?:approved|denied) by owner \((A\d+)\)/.exec(e.detail ?? '')
    if (d) askedIds.delete(d[1])
  }
  const escalations = mail.filter((m) => m.kind === 'escalation' && !m.ackedAt && m.createdAt >= state.startedAt)
  // ask_owner questions: "asked (D3): …" until "answered (D3): …" / "expired (D3)" / "withdrawn (D3)"
  const questionEvents = events.filter((e) => e.kind === 'decision')
  const openQuestions = new Map<string, RunEvent>()
  for (const e of questionEvents) {
    const m = /^asked \((D\d+)\)/.exec(e.detail ?? '')
    if (m) openQuestions.set(m[1], e)
    const d = /^(?:answered|expired|withdrawn)[^(]*\((D\d+)\)/.exec(e.detail ?? '')
    if (d) openQuestions.delete(d[1])
  }
  if (parked.length === 0 && blocked.length === 0 && escalations.length === 0 && askedIds.size === 0 && openQuestions.size === 0) lines.push('Nothing. No card asked a question or hit a wall, no task is blocked.')
  for (const t of blocked) lines.push(`- Task **${t.id} ${oneLine(t.title)}**${t.owner ? ` (${oneLine(titleOf(t.owner))})` : ''}: ${oneLine(t.reason)}`)
  for (const [id, p] of parked) lines.push(`- **${oneLine(p.title)}** (${id}) since ${hhmm(p.at)}: ${oneLine(p.reason)}`)
  for (const e of askedIds.values()) lines.push(`- Approval for **${oneLine(e.title ?? e.card)}** since ${hhmm(e.at)}: ${oneLine((e.detail ?? '').replace(/^approval asked /, ''))} (Approve or Deny in the Autonomy panel)`)
  for (const e of openQuestions.values()) lines.push(`- Question from **${oneLine(e.title ?? e.card)}** since ${hhmm(e.at)}: ${oneLine((e.detail ?? '').replace(/^asked /, ''))} (answer it in Today or on the phone)`)
  for (const m of escalations) lines.push(`- Escalation ${m.id} from **${oneLine(titleOf(m.from))}** to ${oneLine(titleOf(m.to))} at ${hhmm(m.createdAt)}, not handled: ${oneLine(m.body)}`)
  lines.push('')
  if (gates.length) {
    const count = (re: RegExp): RunEvent[] => gates.filter((e) => re.test(e.detail ?? ''))
    const auto = count(/^auto:/)
    const never = count(/^never:/)
    const approved = count(/^approved/)
    const denied = count(/^denied by owner/)
    lines.push(`## Gates · ${auto.length} allowed by policy · ${askedIds.size} waiting on you · ${never.length} refused${approved.length ? ` · ${approved.length} approved by you` : ''}${denied.length ? ` · ${denied.length} denied by you` : ''}`)
    for (const e of never.slice(0, 10)) lines.push(`- Refused: **${oneLine(e.title ?? e.card)}** tried ${cell(oneLine((e.detail ?? '').replace(/^never: /, '')).slice(0, 160))} at ${hhmm(e.at)}`)
    for (const e of auto.filter((x) => !/left to the permission flow/.test(x.detail ?? '')).slice(0, 10)) lines.push(`- Allowed: ${oneLine(e.title ?? e.card)}: ${oneLine((e.detail ?? '').replace(/^auto: /, '')).slice(0, 160)}`)
    lines.push('')
  }
  const relays = events.filter((e) => e.kind === 'relay' && !/^asked the owner/.test(e.detail ?? ''))
  if (relays.length) {
    lines.push(`## Fresh starts · ${relays.filter((e) => /^fresh start/.test(e.detail ?? '')).length} of ${relays.length}`)
    for (const e of relays.slice(0, 20)) lines.push(`- ${oneLine(e.title ?? e.card)} at ${hhmm(e.at)}: ${oneLine(e.detail).slice(0, 200)}`)
    lines.push('')
  }
  const answered = questionEvents.filter((e) => /^answered/.test(e.detail ?? ''))
  if (answered.length) {
    lines.push(`## Decisions · ${answered.length} answered`)
    for (const e of answered.slice(0, 20)) lines.push(`- ${oneLine(e.title ?? e.card)} at ${hhmm(e.at)}: ${oneLine((e.detail ?? '').replace(/^answered /, '')).slice(0, 300)}`)
    lines.push('')
  }
  if (tasks.length) {
    const c = summarizeTasks(tasks)
    lines.push(`## Tasks · ${c.done} done · ${c.doing} doing · ${c.blocked} blocked · ${c.todo} to do${c.dropped ? ` · ${c.dropped} dropped` : ''}`)
    lines.push('As the Conductor and its cards recorded it; rows the owner changed say *by owner*.', '')
    lines.push('| Task | State | Owner | Result / reason |')
    lines.push('|---|---|---|---|')
    for (const t of tasks) {
      if (t.state === 'dropped') continue
      lines.push(`| ${t.id} ${cell(t.title)} | ${t.state}${t.updatedBy === 'owner' ? ' *by owner*' : ''} | ${cell(titleOf(t.owner))} | ${cell(firstLine(t.state === 'done' ? t.result : t.reason)) || '—'} |`)
    }
    lines.push('')
  }
  lines.push('## Cards')
  lines.push('| Card | Status | Evidence | Last reply |')
  lines.push('|---|---|---|---|')
  for (const a of agents) {
    if (a.kind === 'note' || a.kind === 'browser') continue
    const ev = evidence[a.id]
    const evidenceText = [ev?.branch ? `branch ${cell(ev.branch)}` : '', ev && ev.files ? `+${ev.added ?? 0} −${ev.removed ?? 0} in ${ev.files} files uncommitted` : '', ev && !ev.files ? 'working tree clean (committed work is on the branch)' : ''].filter(Boolean).join(', ') || '—'
    const parkedMark = state.parked[a.id] ? ' · parked' : ''
    lines.push(`| ${cell(a.title)} | ${a.status}${parkedMark} | ${evidenceText} | ${cell(firstLine(a.lastAssistantMessage)) || '—'} |`)
  }
  lines.push('')
  const denies = events.filter((e) => e.kind === 'deny')
  const refused = events.filter((e) => e.kind === 'refused')
  const stalls = events.filter((e) => e.kind === 'stall' || e.kind === 'nudge')
  const limits = events.filter((e) => e.kind === 'limit')
  const who = (e: RunEvent): string => oneLine(e.title ?? e.card)
  lines.push('## Rails')
  lines.push(`- Auto-mode denials (Claude Code's classifier; rule denials are not reported by the CLI): ${denies.length}${denies.length ? ' — ' + denies.slice(0, 8).map((e) => `${who(e)}: ${oneLine(e.detail)}`).join('; ') : ''}`)
  lines.push(`- Refused dispatches: ${refused.length}${refused.length ? ' — ' + refused.slice(0, 5).map((e) => oneLine(e.detail)).join('; ') : ''}`)
  lines.push(`- Stalls: ${stalls.length}${stalls.length ? ' — ' + stalls.slice(0, 8).map((e) => `${who(e)} ${e.kind} at ${hhmm(e.at)}`).join('; ') : ''}`)
  const runMail = mail.filter((m) => m.createdAt >= state.startedAt)
  lines.push(`- Mail: ${runMail.length} sent, ${runMail.filter((m) => !m.ackedAt).length} not acked`)
  lines.push(`- Usage limits: ${limits.length}${limits.length ? ' — ' + limits.slice(0, 5).map((e) => `${who(e)} at ${hhmm(e.at)}`).join('; ') : ''}`)
  lines.push('')
  lines.push('## Timeline')
  if (events.length > TIMELINE_MAX) lines.push(`_${events.length - TIMELINE_MAX} earlier events are in the log file only._`)
  for (const e of events.slice(-TIMELINE_MAX)) lines.push(`- ${hhmm(e.at)} ${e.kind}${e.title ? ` · ${oneLine(e.title)}` : ''}${e.detail ? ` — ${oneLine(e.detail)}` : ''}`)
  lines.push('')
  lines.push('_A green status is not success: open the branch and the diff before you trust a card._')
  return lines.join('\n')
}
