import { describe, expect, it } from 'vitest'
import { SLEEP_MAX_MINUTES, SLEEP_MIN_MINUTES, selectSleepCandidates, sleepMinutes, sleepRefusal } from '@shared/sleep'
import { selectTidyCandidates } from '@shared/tidy'
import { diffPrivileges, privilegeView } from '@shared/board-trust'
import type { AgentSnapshot, NodeData } from '@shared/types'

const now = 10_000_000
const min = (n: number): number => now - n * 60_000
const a = (p: Partial<AgentSnapshot>): AgentSnapshot => ({ id: 'x', kind: 'claude', title: 't', cwd: '/', status: 'done', ptyAlive: true, sessionId: 's-1', lastStopAt: min(60), ...p })

describe('sleepRefusal', () => {
  it('lets a finished Claude card with a conversation sleep', () => {
    expect(sleepRefusal(a({ status: 'done' }))).toBeUndefined()
    expect(sleepRefusal(a({ status: 'idle' }))).toBeUndefined()
  })

  it('never sleeps a Conductor, a shell, another engine, or a card with no session to resume', () => {
    expect(sleepRefusal(a({ kind: 'conductor' }))).toMatch(/Conductor/)
    expect(sleepRefusal(a({ kind: 'terminal' }))).toMatch(/shells/)
    expect(sleepRefusal(a({ kind: 'command' }))).toMatch(/shells/)
    expect(sleepRefusal(a({ engine: 'codex' }))).toMatch(/Claude Code/)
    expect(sleepRefusal(a({ sessionId: undefined }))).toMatch(/no conversation/)
  })

  it('never sleeps a card that is working, starting or asking, nor one already stopped', () => {
    expect(sleepRefusal(a({ status: 'working' }))).toBe('it is working')
    expect(sleepRefusal(a({ status: 'starting' }))).toBe('it is starting')
    expect(sleepRefusal(a({ status: 'needs-you' }))).toBe('it is needs-you')
    expect(sleepRefusal(a({ status: 'ended', ptyAlive: false }))).toMatch(/not running/)
    expect(sleepRefusal(a({ asleep: true }))).toMatch(/already asleep/)
  })

  it('never sleeps during an Autonomous run, nor a protected or busy card; a pinned card only by hand', () => {
    expect(sleepRefusal(a({}), { autonomous: true })).toMatch(/Autonomous/)
    expect(sleepRefusal(a({}), { protected: true })).toMatch(/mid-turn/)
    expect(sleepRefusal(a({}), { busy: true })).toMatch(/work open/)
    expect(sleepRefusal(a({ keep: true }), { bulk: true })).toMatch(/pinned/)
    expect(sleepRefusal(a({ keep: true }))).toBeUndefined()
  })
})

describe('sleepMinutes', () => {
  it('is off by default and keeps a sane minimum', () => {
    expect(sleepMinutes(undefined)).toBe(0)
    expect(sleepMinutes(0)).toBe(0)
    expect(sleepMinutes('')).toBe(0)
    expect(sleepMinutes(-3)).toBe(0)
    expect(sleepMinutes(1)).toBe(SLEEP_MIN_MINUTES)
    expect(sleepMinutes('45')).toBe(45)
    expect(sleepMinutes(99_999)).toBe(SLEEP_MAX_MINUTES)
  })
})

describe('selectSleepCandidates', () => {
  const board = [
    a({ id: 'own-done-old', status: 'done', lastStopAt: min(40) }),
    a({ id: 'own-idle-old', status: 'idle', lastStopAt: undefined, lastEventAt: min(40) }),
    a({ id: 'own-fresh', status: 'done', lastStopAt: min(5) }),
    a({ id: 'own-no-time', status: 'idle', lastStopAt: undefined, lastEventAt: undefined }),
    a({ id: 'dispatched', parentId: 'cond', status: 'done', lastStopAt: min(40) }),
    a({ id: 'cond', kind: 'conductor', status: 'idle', lastStopAt: min(400) }),
    a({ id: 'shell', kind: 'terminal', status: 'idle', sessionId: undefined, lastStopAt: min(400) }),
    a({ id: 'cmd', kind: 'command', status: 'done', lastStopAt: min(400) }),
    a({ id: 'pinned', keep: true, status: 'done', lastStopAt: min(400) }),
    a({ id: 'working', status: 'working', lastStopAt: min(400) }),
    a({ id: 'asking', status: 'needs-you', lastStopAt: min(400) }),
    a({ id: 'booting', status: 'starting', lastStopAt: min(400) }),
    a({ id: 'wired', status: 'done', lastStopAt: min(400) }),
    a({ id: 'subagent', status: 'done', lastStopAt: min(400) }),
    a({ id: 'codex', engine: 'codex', status: 'done', lastStopAt: min(400) }),
    a({ id: 'asleep', status: 'ended', ptyAlive: false, asleep: true, lastStopAt: min(400) })
  ]
  const rules = { now, protect: new Set(['wired']), busy: new Set(['subagent']) }

  it('the timed sleep takes only owner-made finished cards past N minutes and never an excluded card', () => {
    expect(selectSleepCandidates(board, { ...rules, minutes: 30 })).toEqual(['own-done-old', 'own-idle-old'])
  })

  it('"Sleep finished cards" takes every eligible card, dispatched or not, whatever the time', () => {
    expect(selectSleepCandidates(board, rules)).toEqual(['own-done-old', 'own-idle-old', 'own-fresh', 'own-no-time', 'dispatched'])
  })

  it('the timed sleep counts idle time from the last prompt or keystroke when that is later than the last stop', () => {
    const lastInput = new Map([['own-done-old', min(2)]])
    expect(selectSleepCandidates(board, { ...rules, minutes: 30, lastInput })).toEqual(['own-idle-old'])
  })

  it('takes nothing during an Autonomous run', () => {
    expect(selectSleepCandidates(board, { ...rules, autonomous: true })).toEqual([])
    expect(selectSleepCandidates(board, { ...rules, minutes: 30, autonomous: true })).toEqual([])
  })
})

describe('asleep cards elsewhere', () => {
  it('tidy does not take an asleep card for an exited one', () => {
    const agents = [a({ id: 'own-asleep', status: 'ended', ptyAlive: false, asleep: true, lastStopAt: min(10) }), a({ id: 'own-exited', status: 'ended', ptyAlive: false })]
    expect(selectTidyCandidates(agents, { retireMinutes: 5, olderThanMinutes: 30, includeOwn: true, now }).map((c) => c.id)).toEqual(['own-exited'])
    const old = [a({ id: 'w', parentId: 'k', status: 'ended', ptyAlive: false, asleep: true, lastStopAt: min(45) })]
    expect(selectTidyCandidates(old, { retireMinutes: 5, olderThanMinutes: 30, now })[0].reason).toBe('asleep for 45 min, no report line')
  })

  it('board trust does not hold a card because it was put to sleep (or woken on its session)', () => {
    const data = { kind: 'claude', title: 'w', cwd: 'C:/p', sessionId: 's-1' } as NodeData
    const trusted = { w: privilegeView(data, 'w', []) }
    expect(diffPrivileges(trusted, [{ id: 'w', data: { ...data, asleep: true } }])).toEqual([])
    expect(diffPrivileges(trusted, [{ id: 'w', data: { ...data, asleep: false } }])).toEqual([])
  })
})
