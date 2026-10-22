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
    expect(built.nodes.map((x) => x.data.kind)).toEqual(['note', 'conductor', 'claude', 'claude', 'claude', 'claude', 'browser', 'claude'])
    const conductor = built.nodes[1]
    expect(conductor.data.claude?.continue).toBe(true)
    expect(conductor.data.claude?.appendSystemPrompt).toContain('"Implementer"')
    expect(built.nodes[7].data.claude).toEqual({ resume: 'sess-9' })
    expect(built.nodes[6].data.url).toBe('https://www.google.com')
    const keys = new Set(built.nodes.map((x) => `${x.position.x},${x.position.y}`))
    expect(keys.size).toBe(built.nodes.length)
  })

  it('wires implementer -> tester (auto), tester -> reviewer (auto on PASS), reviewer -> implementer (manual)', () => {
    const [impl, tester, reviewer] = built.nodes.slice(2, 5).map((x) => x.id)
    const conductor = built.nodes[1].id
    const reports = built.edges.filter((e) => e.target === conductor)
    expect(reports.map((e) => e.source)).toEqual(built.nodes.filter((n) => n.data.kind === 'claude').map((n) => n.id))
    const flow = built.edges.filter((e) => e.target !== conductor)
    expect(flow.map((e) => [e.source, e.target, e.data.mode])).toEqual([
      [impl, tester, 'auto'],
      [tester, reviewer, 'auto'],
      [reviewer, impl, 'manual']
    ])
    const cond = flow[1].data.condition
    expect(matchesCondition(cond, 'PASS: ran vitest, 12 green')).toBe(true)
    expect(matchesCondition(cond, '2 tests failed')).toBe(false)
  })

  it('resume mode and fewer roles', () => {
    const b = buildBoard({ projectRoot: '/p', conductor: { cwd: '/p', mode: 'resume', sessionId: 'abc', initialPrompt: '  rebuild lanes ' }, roles: ['implementer', 'ops'], extraFolders: [], browser: false }, makeId)
    expect(b.nodes[1].data.initialPrompt).toBe('rebuild lanes')
    expect(b.nodes.some((x) => x.data.kind === 'browser')).toBe(false)
    expect(b.nodes[1].data.claude?.resume).toBe('abc')
    expect(b.edges.every((e) => e.target === b.nodes[1].id)).toBe(true) // only report lines
    expect(conductorPrompt({ projectRoot: '/p', conductor: { cwd: '/p', mode: 'fresh' }, roles: ['ops'], extraFolders: [] })).toContain('"Ops"')
  })
})
