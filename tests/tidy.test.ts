import { describe, expect, it } from 'vitest'
import { MAX_DISPATCH_DEPTH, depthOf, descendantsOf, dispatchRefusal, protectedCards, reportedCards, selectTidyCandidates } from '@shared/tidy'
import type { AgentSnapshot } from '@shared/types'

const now = 10_000_000
const min = (n: number): number => now - n * 60_000
const a = (p: Partial<AgentSnapshot>): AgentSnapshot => ({ id: 'x', kind: 'claude', title: 't', cwd: '/', status: 'idle', ptyAlive: true, lastEventAt: now, ...p })
const base = { retireMinutes: 5, olderThanMinutes: 30, now }

describe('selectTidyCandidates', () => {
  it('retires a dispatched card once its report is in and the grace has passed; the clock alone is only a fallback', () => {
    const agents = [
      a({ id: 'reported-fresh', parentId: 'k', status: 'done', lastEventAt: min(2) }),
      a({ id: 'reported-old', parentId: 'k', status: 'done', lastEventAt: min(6) }),
      a({ id: 'unreported-idle', parentId: 'k', status: 'idle', lastEventAt: min(20) }),
      a({ id: 'unreported-stale', parentId: 'k', status: 'idle', lastEventAt: min(45) }),
      a({ id: 'exited', parentId: 'k', status: 'ended', ptyAlive: false }),
      a({ id: 'booting', parentId: 'k', status: 'starting', ptyAlive: false, lastEventAt: undefined }),
      a({ id: 'working', parentId: 'k', status: 'working', lastEventAt: min(90) }),
      a({ id: 'needs', parentId: 'k', status: 'needs-you', lastEventAt: min(90) }),
      a({ id: 'pinned', parentId: 'k', keep: true, status: 'done', lastEventAt: min(90) }),
      a({ id: 'protected', parentId: 'k', status: 'done', lastEventAt: min(90) }),
      a({ id: 'no-events', parentId: 'k', status: 'idle', lastEventAt: undefined })
    ]
    const picked = selectTidyCandidates(agents, { ...base, reported: new Set(['reported-fresh', 'reported-old']), protect: new Set(['protected']) })
    expect(picked.map((c) => c.id)).toEqual(['reported-old', 'unreported-stale', 'exited'])
    expect(picked[0].reason).toBe('reported, done for 6 min')
    expect(picked[1].reason).toBe('idle for 45 min, no report line')
  })

  it('measures the grace from the end of the turn, not from the idle nudge that follows it', () => {
    // Claude Code sends an idle notification ~60 s after Stop; that bumps lastEventAt but not lastStopAt
    const agents = [a({ id: 'w', parentId: 'k', status: 'done', lastStopAt: min(6), lastEventAt: min(5) + 1 })]
    expect(selectTidyCandidates(agents, { ...base, reported: new Set(['w']) }).map((c) => c.id)).toEqual(['w'])
  })

  it('never touches owner-made cards or conductors unless the owner asks for their own cards', () => {
    const agents = [
      a({ id: 'own-stale', status: 'done', lastEventAt: min(120) }),
      a({ id: 'own-exited', status: 'ended', ptyAlive: false }),
      a({ id: 'own-fresh', status: 'idle', lastEventAt: min(3) }),
      a({ id: 'cond', kind: 'conductor', status: 'idle', lastEventAt: min(500) }),
      a({ id: 'worker', parentId: 'cond', status: 'done', lastEventAt: min(10) })
    ]
    expect(selectTidyCandidates(agents, { ...base, reported: new Set(['worker']) }).map((c) => c.id)).toEqual(['worker'])
    expect(selectTidyCandidates(agents, { ...base, includeOwn: true, reported: new Set(['worker']) }).map((c) => c.id)).toEqual(['own-stale', 'own-exited', 'worker'])
  })

  it('a team tidies only its own workers (scope), through any depth', () => {
    const agents = [
      a({ id: 'k', kind: 'conductor' }),
      a({ id: 'teamA', parentId: 'k' }),
      a({ id: 'teamB', parentId: 'k' }),
      a({ id: 'a1', parentId: 'teamA', status: 'done', lastEventAt: min(10) }),
      a({ id: 'a1x', parentId: 'a1', status: 'done', lastEventAt: min(10) }),
      a({ id: 'b1', parentId: 'teamB', status: 'done', lastEventAt: min(10) })
    ]
    const reported = new Set(['a1', 'a1x', 'b1'])
    expect(selectTidyCandidates(agents, { ...base, reported, scope: 'teamA' }).map((c) => c.id)).toEqual(['a1', 'a1x'])
    expect(selectTidyCandidates(agents, { ...base, reported, scope: 'k' }).map((c) => c.id)).toEqual(['a1', 'a1x', 'b1'])
    expect(descendantsOf(agents, 'teamB')).toEqual(new Set(['b1']))
  })

  it('retireMinutes 0 retires as soon as the report is in', () => {
    const agents = [a({ id: 'w', parentId: 'k', status: 'done', lastEventAt: now })]
    expect(selectTidyCandidates(agents, { ...base, retireMinutes: 0, reported: new Set(['w']) })).toHaveLength(1)
    expect(selectTidyCandidates(agents, { ...base, retireMinutes: 0 })).toHaveLength(0)
  })

  it('the unattended run leaves an exited card alone until the grace has passed since the exit', () => {
    const agents = [
      a({ id: 'just-crashed', parentId: 'k', status: 'ended', ptyAlive: false, endedAt: min(1) }),
      a({ id: 'long-gone', parentId: 'k', status: 'ended', ptyAlive: false, endedAt: min(9) }),
      a({ id: 'after-reload', parentId: 'k', status: 'ended', ptyAlive: false }) // no exit seen in this process
    ]
    expect(selectTidyCandidates(agents, { ...base, auto: true }).map((c) => c.id)).toEqual(['long-gone'])
    // the dialog lists all three right away
    expect(selectTidyCandidates(agents, base)).toHaveLength(3)
  })
})

describe('reportedCards', () => {
  it('counts a line that fired after the last Stop, even when an idle nudge came later', () => {
    const agents = [
      a({ id: 'w', parentId: 'k', lastStopAt: min(10), lastEventAt: min(9) }),
      a({ id: 'resumed', parentId: 'k', lastStopAt: min(2), lastEventAt: min(2) }),
      a({ id: 'own', lastStopAt: min(10) })
    ]
    const edges = [
      { source: 'w', target: 'k', lastFiredAt: min(10) + 1000 },
      { source: 'resumed', target: 'k', lastFiredAt: min(20) }, // reported once, then given more work
      { source: 'own', target: 'k', lastFiredAt: min(10) + 1000 }, // not dispatched by k
      { source: 'w', target: 'elsewhere', lastFiredAt: now } // a line to someone else is not a report
    ]
    expect(reportedCards(agents, edges)).toEqual(new Set(['w']))
  })
})

describe('protectedCards', () => {
  it('keeps the targets of lines from mid-turn cards, the workers of a mid-turn lead and the lead of a mid-turn worker', () => {
    const agents = [
      a({ id: 'k', kind: 'conductor', status: 'working' }),
      a({ id: 'impl', parentId: 'k', status: 'done' }),
      a({ id: 'rev', parentId: 'k', status: 'needs-you' }),
      a({ id: 'other', parentId: 'team2', status: 'done' }),
      a({ id: 'team2', parentId: 'k', status: 'idle' }),
      a({ id: 'team3', parentId: 'k', status: 'done' }),
      a({ id: 'booting', parentId: 'team3', status: 'starting', ptyAlive: false })
    ]
    const edges = [
      { source: 'impl', target: 'rev' },
      { source: 'rev', target: 'impl' }, // "CHANGES REQUESTED" back to the implementer
      { source: 'other', target: 'team2' }
    ]
    // booting itself is skipped by selection (starting), so it needs no protection here; its lead team3 does
    expect(protectedCards(agents, edges)).toEqual(new Set(['impl', 'rev', 'team2', 'team3', 'k']))
    // everybody idle → nothing is protected, retirement proceeds
    expect(protectedCards(agents.map((x) => ({ ...x, status: 'idle' as const })), edges).size).toBe(0)
  })
})

describe('dispatch caps', () => {
  const chain = [a({ id: 'k', kind: 'conductor' }), a({ id: 'team', parentId: 'k' }), a({ id: 'w', parentId: 'team' }), a({ id: 'ww', parentId: 'w' })]

  it('counts the levels above a card and stops at a loop', () => {
    expect(depthOf(chain, 'k')).toBe(0)
    expect(depthOf(chain, 'team')).toBe(1)
    expect(depthOf(chain, 'ww')).toBe(3)
    expect(depthOf([a({ id: 'p', parentId: 'q' }), a({ id: 'q', parentId: 'p' })], 'p')).toBe(2)
  })

  it('allows Conductor → team → worker, refuses a worker dispatching, and counts live workers plus pending creates', () => {
    expect(MAX_DISPATCH_DEPTH).toBe(2)
    expect(dispatchRefusal(chain, 'k', 6)).toBeUndefined()
    expect(dispatchRefusal(chain, 'team', 6)).toBeUndefined() // w is level 2
    expect(dispatchRefusal(chain, 'w', 6)).toMatch(/depth cap/)
    // two running, one still starting (process not up yet) → three live; an ended one does not count
    const busy = [a({ id: 'k', kind: 'conductor' }), a({ id: '1', parentId: 'k' }), a({ id: '2', parentId: 'k' }), a({ id: '3', parentId: 'k', status: 'starting', ptyAlive: false }), a({ id: 'gone', parentId: 'k', status: 'ended', ptyAlive: false })]
    expect(dispatchRefusal(busy, 'k', 3)).toMatch(/3 live cards \(cap 3\)/)
    expect(dispatchRefusal(busy, 'k', 4)).toBeUndefined()
    expect(dispatchRefusal(busy, 'k', 4, 1)).toMatch(/4 live cards/)
    // a cap of 0 in settings still lets one through
    expect(dispatchRefusal([a({ id: 'k', kind: 'conductor' })], 'k', 0)).toBeUndefined()
  })
})
