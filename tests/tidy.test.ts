import { describe, expect, it } from 'vitest'
import { selectTidyCandidates } from '@shared/tidy'
import type { AgentSnapshot } from '@shared/types'

const now = 10_000_000
const a = (p: Partial<AgentSnapshot>): AgentSnapshot => ({ id: 'x', kind: 'claude', title: 't', cwd: '/', status: 'idle', ptyAlive: true, lastEventAt: now, ...p })

describe('selectTidyCandidates', () => {
  it('picks exited cards and stale done/idle cards, never conductors/working/needs-you/protected', () => {
    const agents = [
      a({ id: 'exited', status: 'ended', ptyAlive: false }),
      a({ id: 'dead', status: 'done', ptyAlive: false }),
      a({ id: 'old-done', status: 'done', lastEventAt: now - 45 * 60_000 }),
      a({ id: 'fresh-done', status: 'done', lastEventAt: now - 5 * 60_000 }),
      a({ id: 'working', status: 'working', lastEventAt: now - 90 * 60_000 }),
      a({ id: 'needs', status: 'needs-you', lastEventAt: now - 90 * 60_000 }),
      a({ id: 'cond', kind: 'conductor', status: 'idle', lastEventAt: now - 90 * 60_000 }),
      a({ id: 'protected', status: 'idle', lastEventAt: now - 90 * 60_000 }),
      a({ id: 'no-events', status: 'idle', lastEventAt: undefined })
    ]
    const picked = selectTidyCandidates(agents, { olderThanMinutes: 30, now, protect: new Set(['protected']) }).map((c) => c.id)
    expect(picked).toEqual(['exited', 'dead', 'old-done'])
  })
})
