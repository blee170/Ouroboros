import { describe, expect, it } from 'vitest'
import { IDLE_END_MINUTES, WORKER_DENY_RULES, autonomyDispatchRefusal, autonomyRetryRefusal, autonomySettingsFragment, endsEarly, isUsageLimit, newRunState, relaunchAction, reportMarkdown, stallActions } from '@shared/autonomy'
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
    for (const must of ['Bash(git push*)', 'Bash(gh pr merge*)', 'Bash(supabase db push*)', 'Edit(**/.ouroboros.json)', 'Write(**/.claude/settings.json)']) expect(deny).toContain(must)
    expect(deny.some((r) => /bypass|dangerously/.test(r))).toBe(false)
  })
})

describe('relaunchAction', () => {
  it('relaunches live Claude cards, closes Codex/Gemini, leaves the rest', () => {
    expect(relaunchAction(a({ kind: 'conductor' }))).toBe('relaunch')
    expect(relaunchAction(a({ kind: 'claude', engine: 'codex' }))).toBe('close')
    expect(relaunchAction(a({ kind: 'claude', engine: 'gemini' }))).toBe('close')
    expect(relaunchAction(a({ kind: 'terminal' }))).toBe('keep')
    expect(relaunchAction(a({ kind: 'claude', ptyAlive: false, status: 'ended' }))).toBe('keep')
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
})

describe('endsEarly', () => {
  it('ends once nothing has been busy for the idle window', () => {
    expect(endsEarly([a({ status: 'needs-you' }), a({ id: 'b', status: 'done' })], min(IDLE_END_MINUTES), now)).toBe(true)
    expect(endsEarly([a({ status: 'needs-you' })], min(IDLE_END_MINUTES - 1), now)).toBe(false)
    expect(endsEarly([a({ status: 'working' })], min(60), now)).toBe(false)
    expect(endsEarly([a({ status: 'starting' })], min(60), now)).toBe(false)
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
      [a({ id: 'q', title: 'Reviewer', status: 'needs-you', lastAssistantMessage: 'RESULT: review done | SCORE: 8/10\nmore' }), a({ id: 'w', title: 'Worker', status: 'done', lastAssistantMessage: 'RESULT: shipped' }), a({ id: 'n', kind: 'note' as never, title: 'Pipeline' })],
      { w: { branch: 'cards/worker', added: 12, removed: 3, files: 2 } }
    )
    expect(md.indexOf('## Waiting on you')).toBeLessThan(md.indexOf('## Cards'))
    expect(md).toContain('**Reviewer** (q)')
    expect(md).toContain('| Worker | done | branch `cards/worker`, +12 −3 in 2 files | RESULT: shipped |')
    expect(md).toContain('needs-you · parked')
    expect(md).toContain('RESULT: review done \\| SCORE: 8/10')
    expect(md).not.toContain('| Pipeline |')
    expect(md).toContain('Denied actions: 1')
    expect(md).toContain('Ended: **deadline**')
    expect(md.trim().endsWith('before you trust a card._')).toBe(true)
  })
})
