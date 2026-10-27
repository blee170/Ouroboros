import { describe, expect, it } from 'vitest'
import { DATA_DIR_DENY_RULES, IDLE_END_MINUTES, cardSettingsExtra, START_GRACE_MINUTES, WORKER_DENY_RULES, autonomyDispatchRefusal, autonomyRetryRefusal, autonomySettingsFragment, endsEarly, isUsageLimit, newRunState, relaunchAction, reportMarkdown, stallActions, staleStarting } from '@shared/autonomy'
import type { AgentSnapshot } from '@shared/types'

const now = 10_000_000
const min = (n: number): number => now - n * 60_000
const a = (p: Partial<AgentSnapshot>): AgentSnapshot => ({ id: 'x', kind: 'claude', title: 't', cwd: '/', status: 'idle', ptyAlive: true, lastEventAt: now, ...p })
const state = (): ReturnType<typeof newRunState> => newRunState({ until: now + 3_600_000, maxDispatches: 2, maxRetriesPerTitle: 1, stallMinutes: 10 }, min(60))

describe('caps', () => {
  it('refuses the dispatch after the cap and the retry after the cap', () => {
    const s = state()
    expect(autonomyDispatchRefusal(s)).toBeNull()
    s.dispatches = 2
    expect(autonomyDispatchRefusal(s)).toMatch(/cap of 2/)
    expect(autonomyRetryRefusal(s, 'Reviewer')).toBeNull()
    s.retries.reviewer = 1
    expect(autonomyRetryRefusal(s, ' Reviewer ')).toMatch(/re-made 1 times/)
  })
})

describe('deny rules', () => {
  it('keep pushes, merges, deploys, migrations and the board file out of reach', () => {
    const deny = autonomySettingsFragment().permissions.deny
    expect(deny).toEqual(WORKER_DENY_RULES)
    // a card's auto memory (~/.claude/projects/<project>/memory) stays writable: no rule over all of ~/.claude or its projects folder
    for (const wide of ['Edit(~/.claude/**)', 'Edit(~/.claude/*)', 'Edit(~/.claude/projects/**)']) expect(deny).not.toContain(wide)
    for (const must of ['Bash(git push*)', 'Bash(git * push*)', 'PowerShell(git push*)', 'PowerShell(git * push*)', 'Bash(gh pr merge*)', 'Bash(gh * pr merge*)', 'Bash(supabase db push*)', 'PowerShell(Remove-Item * -Recurse*)', 'Edit(**/.ouroboros.json)', 'Edit(**/.claude/settings.json)', 'Edit(~/.claude/*.json)', 'Edit(~/.claude/*.md)', 'Edit(~/.claude/hooks/**)', 'Edit(~/.claude/plugins/**)', 'Edit(~/.claude/skills/**)', 'Edit(~/.claude/tools/**)', 'Edit(~/.claude/chrome/**)', 'Edit(~/.claude/scheduled-tasks/**)', 'Edit(~/.claude/projects/*/*.jsonl)', 'Edit(~/.claude/.claude.json)', 'Edit(~/.claude.json)', 'mcp__ouroboros__browser_click', 'mcp__ouroboros__browser_type']) expect(deny).toContain(must)
    expect(deny.some((r) => /bypass|dangerously/.test(r))).toBe(false)
    expect(deny.some((r) => r.startsWith('Write('))).toBe(false) // Claude Code 2.1.309: Write(...) rules are not matched, Edit(...) covers all editing tools
    expect(deny).not.toContain('Bash(* push*)') // a commit message mentioning a push is not a push
    expect(new Set(deny).size).toBe(deny.length)
  })
})

describe('relaunchAction', () => {
  it('relaunches live Claude and Codex cards, closes Gemini/Grok, leaves the rest', () => {
    expect(relaunchAction(a({ kind: 'conductor' }))).toBe('relaunch')
    expect(relaunchAction(a({ kind: 'claude', engine: 'codex' }))).toBe('relaunch')
    expect(relaunchAction(a({ kind: 'claude', engine: 'gemini' }))).toBe('close')
    expect(relaunchAction(a({ kind: 'claude', engine: 'grok' }))).toBe('close')
    expect(relaunchAction(a({ kind: 'terminal' }))).toBe('keep')
    expect(relaunchAction(a({ kind: 'claude', ptyAlive: false, status: 'ended' }))).toBe('keep')
    expect(relaunchAction(a({ kind: 'claude', ptyAlive: true, status: 'ended' }))).toBe('keep') // /exit inside a live shell
    expect(relaunchAction(a({ kind: 'claude', ptyAlive: false, status: 'starting' }))).toBe('relaunch')
  })
})

describe('stallActions', () => {
  it('nudges a silent working card once, parks it a period after the nudge, ignores the rest', () => {
    const s = state()
    const agents = [a({ id: 'quiet', status: 'working', lastEventAt: min(11) }), a({ id: 'fresh', status: 'working', lastEventAt: min(2) }), a({ id: 'idle', status: 'idle', lastEventAt: min(50) })]
    expect(stallActions(agents, s, now)).toEqual([{ id: 'quiet', action: 'nudge' }])
    s.nudged.quiet = min(5)
    expect(stallActions(agents, s, now)).toEqual([])
    s.nudged.quiet = min(10)
    expect(stallActions(agents, s, now)).toEqual([{ id: 'quiet', action: 'park' }])
    s.parked.quiet = { at: now, title: 't', reason: 'stalled' }
    expect(stallActions(agents, s, now)).toEqual([])
  })
  it('counts from the run start when a card never reported an event', () => {
    const s = state()
    expect(stallActions([a({ id: 'mute', status: 'working', lastEventAt: undefined })], s, now)).toEqual([{ id: 'mute', action: 'nudge' }])
  })
  it('nudges again after activity that followed the first nudge; a tool call gets three periods; never a command card', () => {
    const s = state()
    s.nudged.q = min(40)
    expect(stallActions([a({ id: 'q', status: 'working', lastEventAt: min(12) })], s, now)).toEqual([{ id: 'q', action: 'nudge' }])
    expect(stallActions([a({ id: 'b', status: 'working', lastEventAt: min(29), statusDetail: 'tool: Bash' })], s, now)).toEqual([])
    expect(stallActions([a({ id: 'b', status: 'working', lastEventAt: min(31), statusDetail: 'tool: Bash' })], s, now)).toEqual([{ id: 'b', action: 'nudge' }])
    expect(stallActions([a({ id: 'c', kind: 'command', status: 'working', lastEventAt: min(30) })], s, now)).toEqual([])
  })
})

describe('staleStarting', () => {
  it('names cards still starting after the grace period, parked ones aside', () => {
    const s = state()
    const agents = [a({ id: 'stuck', status: 'starting', lastEventAt: min(START_GRACE_MINUTES) }), a({ id: 'new', status: 'starting', lastEventAt: min(1) }), a({ id: 'p', status: 'starting', lastEventAt: min(30) })]
    s.parked.p = { at: now, title: 't', reason: 'x' }
    expect(staleStarting(agents, s, now).map((x) => x.id)).toEqual(['stuck'])
  })
})

describe('endsEarly', () => {
  it('ends once nothing has been busy for the idle window, a parked card not counting as busy', () => {
    const s = state()
    expect(endsEarly([a({ status: 'needs-you' }), a({ id: 'b', status: 'done' })], s, min(IDLE_END_MINUTES), now)).toBe(true)
    expect(endsEarly([a({ status: 'needs-you' })], s, min(IDLE_END_MINUTES - 1), now)).toBe(false)
    expect(endsEarly([a({ status: 'working' })], s, min(60), now)).toBe(false)
    expect(endsEarly([a({ status: 'starting' })], s, min(60), now)).toBe(false)
    s.parked.x = { at: now, title: 't', reason: 'failed to start' }
    expect(endsEarly([a({ status: 'starting' })], s, min(60), now)).toBe(true)
  })
})

describe('isUsageLimit', () => {
  it('recognises the limit messages and nothing else', () => {
    expect(isUsageLimit("You've hit your usage limit · resets at 3pm")).toBe(true)
    expect(isUsageLimit('API Error: 429 rate_limit_error')).toBe(true)
    expect(isUsageLimit('turn failed (API error)')).toBe(false)
  })
})

describe('reportMarkdown', () => {
  it('puts the parked cards first, every card with its evidence, and the timeline', () => {
    const s = state()
    s.parked.q = { at: min(20), title: 'Reviewer', reason: 'permission: Bash(git push origin main)' }
    s.dispatches = 1
    s.stopped = { at: now, reason: 'deadline' }
    const md = reportMarkdown(
      s,
      [
        { at: min(60), kind: 'start', detail: 'until 10:00' },
        { at: min(30), kind: 'deny', card: 'q', title: 'Reviewer', detail: 'Bash(git push origin main)' },
        { at: now, kind: 'stop', detail: 'deadline' }
      ],
      [a({ id: 'q', title: 'Reviewer', status: 'needs-you', lastAssistantMessage: 'RESULT: review done | SCORE: 8/10\nmore' }), a({ id: 'w', title: 'Worker', status: 'done', lastAssistantMessage: 'RESULT: shipped' }), a({ id: 'c', title: 'Clean', status: 'done' }), a({ id: 'n', kind: 'note' as never, title: 'Pipeline' })],
      { w: { branch: 'cards/worker', added: 12, removed: 3, files: 2 }, c: { branch: 'cards/clean', added: 0, removed: 0, files: 0 } }
    )
    expect(md.indexOf('## Waiting on you')).toBeLessThan(md.indexOf('## Cards'))
    expect(md).toContain('**Reviewer** (q)')
    expect(md).toContain('| Worker | done | branch cards/worker, +12 −3 in 2 files uncommitted | RESULT: shipped |')
    expect(md).toContain('| Clean | done | branch cards/clean, working tree clean (committed work is on the branch) |')
    expect(md).toContain('needs-you · parked')
    expect(md).toContain('RESULT: review done \\| SCORE: 8/10')
    expect(md).not.toContain('| Pipeline |')
    expect(md).toContain('Auto-mode denials (Claude Code\'s classifier; rule denials are not reported by the CLI): 1')
    expect(md).toContain('Ended: **deadline**')
    expect(md.trim().endsWith('before you trust a card._')).toBe(true)
  })
  it('lets no card forge rows, sections or list items through its title, reason or branch', () => {
    const s = state()
    s.parked.q = { at: min(20), title: 'Evil', reason: 'asked\n## Waiting on you\nNothing.' }
    const md = reportMarkdown(
      s,
      [{ at: min(30), kind: 'deny', card: 'q', title: 'x\n## Rails', detail: 'a\nb' }],
      [a({ id: 'q', title: 'Evil | done | branch `main` | all verified |\n## Rails\n- Auto-mode denials: 0', status: 'needs-you' })],
      { q: { branch: 'main|x\nfake', added: 1, removed: 0, files: 1 } }
    )
    expect(md.match(/^## Waiting on you$/gm)).toHaveLength(1)
    expect(md.match(/^## Rails$/gm)).toHaveLength(1)
    expect(md).toContain('| Evil \\| done \\| branch `main` \\| all verified \\| ## Rails - Auto-mode denials: 0 | needs-you · parked | branch main\\|x fake, +1 −0 in 1 files uncommitted | — |')
    expect(md).toContain('- **Evil** (q) since')
    expect(md).toContain(': asked ## Waiting on you Nothing.')
  })
  it('lists blocked tasks under Waiting on you and every task in a Tasks table', () => {
    const s = state()
    const md = reportMarkdown(
      s,
      [],
      [a({ id: 'w', title: 'Worker', status: 'done' })],
      {},
      [
        { id: 'T1', title: 'plan', state: 'done', deps: [], result: 'RESULT: planned\nmore', createdBy: 'c', createdAt: 0, updatedAt: 0 },
        { id: 'T2', title: 'ship | now', state: 'blocked', deps: ['T1'], owner: 'w', reason: 'APPROVAL NEEDED: push\n## Rails', createdBy: 'c', createdAt: 0, updatedAt: 0 },
        { id: 'T3', title: 'later', state: 'todo', deps: [], createdBy: 'c', createdAt: 0, updatedAt: 0 },
        { id: 'T4', title: 'old', state: 'dropped', deps: [], reason: 'no', createdBy: 'c', createdAt: 0, updatedAt: 0 }
      ]
    )
    expect(md).toContain('- Task **T2 ship | now** (Worker): APPROVAL NEEDED: push ## Rails')
    expect(md).not.toContain('No card asked')
    expect(md).toContain('## Tasks · 1 done · 0 doing · 1 blocked · 1 to do · 1 dropped')
    expect(md).toContain('| T1 plan | done | — | RESULT: planned |')
    expect(md).toContain('| T2 ship \\| now | blocked | Worker | APPROVAL NEEDED: push |') // first line only in the table
    expect(md).toContain('| T3 later | todo | — | — |')
    expect(md).not.toContain('| T4 old |')
    expect(md.indexOf('## Tasks')).toBeLessThan(md.indexOf('## Cards'))
    expect(md.match(/^## Rails$/gm)).toHaveLength(1)
    expect(reportMarkdown(s, [], [])).toContain('Nothing. No card asked a question or hit a wall, no task is blocked.')
  })
  it('counts the mail of the run and lists unhandled escalations under Waiting on you', () => {
    const s = state()
    const mail = [
      { id: 'M1', from: 'w', to: 'c', kind: 'escalation' as const, body: 'need the DB password', createdAt: s.startedAt + 1 },
      { id: 'M2', from: 'w', to: 'c', kind: 'note' as const, body: 'fyi', createdAt: s.startedAt + 2, ackedAt: s.startedAt + 3 },
      { id: 'M0', from: 'w', to: 'c', kind: 'escalation' as const, body: 'old', createdAt: s.startedAt - 1 }
    ]
    const md = reportMarkdown(s, [], [{ id: 'w', title: 'Worker' } as never], {}, [], mail)
    expect(md).toContain('- Escalation M1 from **Worker** to c at')
    expect(md).not.toContain('Escalation M0')
    expect(md).not.toContain('No card asked')
    expect(md).toContain('- Mail: 2 sent, 1 not acked')
  })
  it('keeps the last 300 timeline events in the report', () => {
    const s = state()
    const events = Array.from({ length: 350 }, (_, i) => ({ at: min(60) + i * 1000, kind: 'turn' as const, card: 'w', title: 'w', detail: `turn ${i}` }))
    const md = reportMarkdown(s, events, [])
    expect(md).toContain('_50 earlier events are in the log file only._')
    expect(md).not.toContain('turn 49\n')
    expect(md).toContain('turn 50')
    expect(md).toContain('turn 349')
  })
})

describe('card settings extra', () => {
  it('denies the app data folder to every Claude card, in a run or not', () => {
    const off = cardSettingsExtra(undefined) as { permissions: { deny: string[] } }
    expect(off.permissions.deny).toEqual(DATA_DIR_DENY_RULES)
    const run = autonomySettingsFragment('node gate.js')
    const on = cardSettingsExtra(run) as typeof run
    expect(on.hooks).toEqual(run.hooks)
    expect(on.permissions.deny).toEqual(run.permissions.deny)
    expect(new Set(on.permissions.deny).size).toBe(on.permissions.deny.length)
    for (const r of DATA_DIR_DENY_RULES) expect(WORKER_DENY_RULES).toContain(r)
  })
})
