import { describe, expect, it } from 'vitest'
import { buildBoard, conductorPrompt } from '@shared/board-builder'
import { matchesCondition } from '@shared/handoff'

describe('buildBoard', () => {
  let n = 0
  const makeId = (): string => `id${++n}`
  const built = buildBoard(
    {
      projectRoot: 'C:\\Users\\me\\.claudecode\\csbadminton',
      conductor: { cwd: 'C:\\Users\\me\\.claudecode\\csbadminton', mode: 'continue' },
      roles: ['implementer', 'tester', 'reviewer', 'ops'],
      extraFolders: [{ cwd: 'C:\\Users\\me\\.claudecode\\csbadminton-api', title: 'csbadminton-api · latest', sessionId: 'sess-9' }]
    },
    makeId
  )

  it('creates note + conductor + roles + extra cards with no overlapping positions', () => {
    expect(built.nodes.map((x) => x.data.kind)).toEqual(['note', 'conductor', 'claude', 'claude', 'claude', 'claude', 'claude'])
    const conductor = built.nodes[1]
    expect(conductor.data.claude?.continue).toBe(true)
    expect(conductor.data.claude?.appendSystemPrompt).toContain('"Implementer"')
    expect(built.nodes[6].data.claude).toEqual({ resume: 'sess-9' })
    const keys = new Set(built.nodes.map((x) => `${x.position.x},${x.position.y}`))
    expect(keys.size).toBe(built.nodes.length)
  })

  it('wires implementer -> tester (auto), tester -> reviewer (auto on PASS), reviewer -> implementer (manual)', () => {
    const [impl, tester, reviewer] = built.nodes.slice(2, 5).map((x) => x.id)
    expect(built.edges.map((e) => [e.source, e.target, e.data.mode])).toEqual([
      [impl, tester, 'auto'],
      [tester, reviewer, 'auto'],
      [reviewer, impl, 'manual']
    ])
    const cond = built.edges[1].data.condition
    expect(matchesCondition(cond, 'PASS: ran vitest, 12 green')).toBe(true)
    expect(matchesCondition(cond, '2 tests failed')).toBe(false)
  })

  it('resume mode and fewer roles', () => {
    const b = buildBoard({ projectRoot: '/p', conductor: { cwd: '/p', mode: 'resume', sessionId: 'abc' }, roles: ['implementer', 'ops'], extraFolders: [] }, makeId)
    expect(b.nodes[1].data.claude?.resume).toBe('abc')
    expect(b.edges).toEqual([])
    expect(conductorPrompt({ projectRoot: '/p', conductor: { cwd: '/p', mode: 'fresh' }, roles: ['ops'], extraFolders: [] })).toContain('"Ops"')
  })
})
