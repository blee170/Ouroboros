import { describe, expect, it } from 'vitest'
import { RESULT_SECTION, buildBoard, conductorPrompt } from '@shared/board-builder'
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

  it('specialist cards sit in rows of four under the roles, carry their role id and prompt, report to the Conductor, and push the folder row down', () => {
    let k = 0
    const specialists = Array.from({ length: 5 }, (_, i) => ({ id: `role-${i}`, name: `Role ${i}`, prompt: `You are role ${i}.`, emoji: i === 0 ? '🖥️' : undefined }))
    const b = buildBoard({ projectRoot: '/p', conductor: { cwd: '/p', mode: 'fresh' }, roles: ['implementer'], specialists, extraFolders: [{ cwd: '/q', title: 'q' }], browser: false }, () => `s${++k}`)
    const cards = b.nodes.filter((x) => typeof x.data.role === 'string')
    expect(cards).toHaveLength(5)
    expect(cards[0].data.title).toBe('🖥️ Role 0')
    expect(cards[1].data.title).toBe('🎭 Role 1')
    expect(cards[0].data.claude?.appendSystemPrompt).toBe('You are role 0.')
    expect(cards[0].data.cwd).toBe('/p')
    expect(cards.map((x) => x.position.y)).toEqual([1000, 1000, 1000, 1000, 1500])
    expect(cards.map((x) => x.position.x)).toEqual([0, 620, 1240, 1860, 0])
    const folder = b.nodes.find((x) => x.data.title === 'q')!
    expect(folder.position.y).toBe(2000)
    const keys = new Set(b.nodes.map((x) => `${x.position.x},${x.position.y}`))
    expect(keys.size).toBe(b.nodes.length)
    const conductor = b.nodes[1]
    expect(cards.every((c) => b.edges.some((e) => e.source === c.id && e.target === conductor.id && e.data?.mode === 'auto'))).toBe(true)
    expect(conductor.data.claude?.appendSystemPrompt).toContain('"🖥️ Role 0": specialist card (role role-0)')
  })

  it('one worker and one reviewer: without a Tester the Implementer hands a finished RESULT straight to the Reviewer', () => {
    let k = 0
    const input = { projectRoot: '/p', conductor: { cwd: '/p', mode: 'fresh' as const }, roles: ['implementer' as const, 'reviewer' as const], extraFolders: [], browser: false }
    const b = buildBoard(input, () => `w${++k}`)
    const conductor = b.nodes[1].id
    const [impl, reviewer] = b.nodes.slice(2, 4).map((x) => x.id)
    const flow = b.edges.filter((e) => e.target !== conductor)
    expect(flow.map((e) => [e.source, e.target, e.data.mode])).toEqual([
      [impl, reviewer, 'auto'],
      [reviewer, impl, 'manual']
    ])
    const cond = flow[0].data.condition
    expect(cond).toBe(RESULT_SECTION)
    // however the model writes the label, a finished report reaches the Reviewer
    for (const reply of [
      'Done.\n\nRESULT: changed src/a.ts, ran vitest (12 green)',
      'Done.\n\n**RESULT:** changed src/a.ts',
      'Done.\n\n**RESULT**: changed src/a.ts',
      'Done.\n\n## RESULT\n- changed src/a.ts',
      'Done.\r\n\r\n### Result\r\n- changed src/a.ts',
      'Result: changed src/a.ts',
      'Done.\n- RESULT — changed src/a.ts',
      '> RESULT : changed src/a.ts',
      '다 했습니다.\n\n결과: src/a.ts 수정, vitest 통과',
      'RESULT：全角コロン'
    ])
      expect(matchesCondition(cond, reply), reply).toBe(true)
    // a question or a progress note from the Implementer is not a review request
    for (const reply of [
      'Which of the two approaches do you want?',
      'Should I add a RESULT: section to the README?',
      'Running the tests; I will post RESULT: when they are done.',
      'Result of the first attempt was a timeout, which way do you want to go?',
      'Results: 3 of 12 failed so far',
      'FINAL_RESULT: x',
      'Result-oriented summary follows later',
      ''
    ])
      expect(matchesCondition(cond, reply), reply).toBe(false)
    // a card's text cannot make the match slow
    const t0 = Date.now()
    expect(matchesCondition(cond, '\n'.repeat(200_000) + ' \t'.repeat(50_000) + 'x')).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(flow[0].data.template).toContain('{{last_assistant_message}}')
    expect(flow[0].data.template).toContain('any new commits')
    const prompt = conductorPrompt(input)
    expect(prompt).not.toContain('Tester')
    expect(prompt).toContain('the Reviewer follows automatically')
    expect(prompt).not.toContain('Ops handles')
    const note = b.nodes[0].data.note ?? ''
    expect(note).not.toContain('Tester')
    expect(note).toContain('Implementer → Reviewer')
    expect(b.nodes[2].data.claude?.appendSystemPrompt).not.toContain('Tester')
  })

  it('the routing rules name only the roles on the board', () => {
    const base = { projectRoot: '/p', conductor: { cwd: '/p', mode: 'fresh' as const }, extraFolders: [] }
    const all = conductorPrompt({ ...base, roles: ['implementer', 'tester', 'reviewer', 'ops'] })
    // the four-role board reads exactly as it did before the rules became role-aware
    expect(all.split('\n').pop()).toBe(
      'Routing rules: implementation work goes to the Implementer; after it reports RESULT the Tester runs automatically through a handoff line and the Reviewer follows when tests PASS. If the Reviewer says CHANGES REQUESTED, send the findings back to the Implementer with send_prompt. Ops handles deploys and health checks only. Keep your own replies to the human short: what was dispatched, what is waiting on them, what finished.'
    )
    // no Implementer: the Tester → Reviewer line is still drawn, so the rules still say it
    const noImpl = conductorPrompt({ ...base, roles: ['tester', 'reviewer'] })
    expect(noImpl).toContain('When the Tester reports PASS the Reviewer runs automatically through a handoff line.')
    expect(noImpl).not.toContain('Implementer')
    const testerOnly = conductorPrompt({ ...base, roles: ['implementer', 'tester'] })
    expect(testerOnly).toContain('the Tester runs automatically through a handoff line')
    expect(testerOnly).not.toContain('Reviewer')
    const none = conductorPrompt({ ...base, roles: [] })
    expect(none).not.toMatch(/Implementer|Tester|Reviewer|Ops handles/)
    expect(none).toContain('Keep your own replies to the human short')
  })
})
