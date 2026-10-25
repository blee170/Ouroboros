import { describe, expect, it } from 'vitest'
import { newWatchdogState, watchdogReports } from '@shared/watchdog'
import type { AgentSnapshot } from '@shared/types'

const MIN = 60_000
const card = (over: Partial<AgentSnapshot>): AgentSnapshot => ({ id: 'a', kind: 'agent', title: 'Worker', status: 'working', ...over }) as AgentSnapshot

describe('watchdogReports', () => {
  it('reports a Working card silent for the period, and a tool call only after three periods', () => {
    const st = newWatchdogState()
    const t0 = 1_000_000
    expect(watchdogReports([card({ lastEventAt: t0 })], st, t0 + 14 * MIN, 15)).toEqual([])
    expect(watchdogReports([card({ lastEventAt: t0 })], st, t0 + 15 * MIN, 15)).toEqual([{ id: 'a', reason: 'silent', minutes: 15, escalate: false }])
    const tool = card({ id: 'b', lastEventAt: t0, statusDetail: 'tool: Bash' })
    expect(watchdogReports([tool], newWatchdogState(), t0 + 30 * MIN, 15)).toEqual([])
    expect(watchdogReports([tool], newWatchdogState(), t0 + 45 * MIN, 15)).toHaveLength(1)
  })
  it('reports a card waiting on a person, but not a failed turn, a finished card or a hookless card', () => {
    const t0 = 1_000_000
    const now = t0 + 20 * MIN
    expect(watchdogReports([card({ status: 'needs-you', statusDetail: 'permission: Bash', lastEventAt: t0 })], newWatchdogState(), now, 15)[0]?.reason).toBe('waiting')
    for (const c of [
      card({ status: 'needs-you', statusDetail: 'failed: usage limit', lastEventAt: t0 }),
      card({ status: 'done', lastEventAt: t0 }),
      card({ status: 'idle', lastEventAt: t0 }),
      card({ kind: 'terminal', lastEventAt: t0 }),
      card({ kind: 'command', lastEventAt: t0 }),
      card({ lastEventAt: undefined })
    ])
      expect(watchdogReports([c], newWatchdogState(), now, 15)).toEqual([])
  })
  it('repeats every period while the card stays quiet, escalates on the third report, then stops', () => {
    const st = newWatchdogState()
    const t0 = 1_000_000
    const c = card({ lastEventAt: t0 })
    const at = (m: number) => watchdogReports([c], st, t0 + m * MIN, 10)
    expect(at(10)).toMatchObject([{ escalate: false }])
    expect(at(15)).toEqual([]) // not a full period since the last report
    expect(at(20)).toMatchObject([{ escalate: false }])
    expect(at(30)).toMatchObject([{ escalate: true, minutes: 30 }])
    expect(at(40)).toEqual([])
    expect(at(90)).toEqual([])
  })
  it('counts stalls across quiet stretches until the card finishes a turn', () => {
    const st = newWatchdogState()
    let t = 1_000_000
    // three separate quiet stretches without a Stop in between: the third escalates
    for (const want of [false, false, true]) {
      const r = watchdogReports([card({ lastEventAt: t })], st, t + 10 * MIN, 10)
      expect(r).toMatchObject([{ escalate: want }])
      t += 11 * MIN
    }
    // a finished turn starts the count over
    const r = watchdogReports([card({ lastEventAt: t, lastStopAt: t - MIN })], st, t + 10 * MIN, 10)
    expect(r).toMatchObject([{ escalate: false }])
  })
  it('reports a Codex card only while it waits (Codex sends no hook during a turn)', () => {
    const t0 = 1_000_000
    expect(watchdogReports([card({ engine: 'codex', lastEventAt: t0 })], newWatchdogState(), t0 + 60 * MIN, 15)).toEqual([])
    expect(watchdogReports([card({ engine: 'codex', status: 'needs-you', statusDetail: 'permission: shell', lastEventAt: t0 })], newWatchdogState(), t0 + 20 * MIN, 15)[0]?.reason).toBe('waiting')
  })
  it('is off at 0 minutes and forgets cards that are gone', () => {
    const st = newWatchdogState()
    expect(watchdogReports([card({ lastEventAt: 1 })], st, 100 * MIN, 0)).toEqual([])
    watchdogReports([card({ lastEventAt: 1 })], st, 100 * MIN, 10)
    expect(Object.keys(st.cards)).toEqual(['a'])
    watchdogReports([], st, 101 * MIN, 10)
    expect(st.cards).toEqual({})
  })
})
