import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/board'
import { Autonomy, type AutonomyHost } from '../src/main/autonomy'
import { IDLE_END_MINUTES, NUDGE_PROMPT } from '../src/shared/autonomy'
import type { NodeData } from '../src/shared/types'

const T0 = 1_800_000_000_000

function node(id: string, data: Partial<NodeData>): { id: string; position: { x: number; y: number }; data: NodeData } {
  return { id, position: { x: 0, y: 0 }, data: { kind: 'claude', title: id, cwd: 'C:/p', ...data } }
}

function setup() {
  const board = new Board()
  board.sync({
    projectRoot: 'C:/p',
    nodes: [node('chief', { kind: 'conductor', sessionId: 'sess-1', claude: { boardTools: true } }), node('w1', { parentId: 'chief', claude: { permissionMode: 'plan' } }), node('gem', { engine: 'gemini' }), node('sh', { kind: 'terminal' }), node('old', { engine: 'claude' })],
    edges: []
  })
  for (const id of ['chief', 'w1', 'gem', 'sh']) board.setPtyAlive(id, true)
  const calls = { prompts: [] as Array<[string, string]>, removed: [] as string[], relaunched: [] as Array<[string, unknown]>, notes: [] as Array<[string, string]>, toasts: [] as string[], changed: 0, awake: 0 }
  const dir = mkdtempSync(join(tmpdir(), 'ouro-auto-'))
  let clock = T0
  const host: AutonomyHost = {
    board,
    agents: () => board.snapshot(),
    sendPrompt: (id, text) => (calls.prompts.push([id, text]), true),
    removeCard: (id) => calls.removed.push(id),
    relaunch: (id, claude) => calls.relaunched.push([id, claude]),
    addNote: (title, note) => calls.notes.push([title, note]),
    changed: () => calls.changed++,
    toast: (t, b) => calls.toasts.push(`${t}: ${b}`),
    keepAwake: () => (calls.awake++, () => calls.awake--),
    dir,
    evidence: async (cwd) => (cwd === 'C:/p' ? { branch: 'main', added: 3, removed: 1, files: 1 } : undefined),
    now: () => clock
  }
  const auto = new Autonomy(host)
  return { board, auto, calls, dir, tick: (ms: number) => (clock += ms), host }
}

describe('Autonomy run', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => {
    vi.useFakeTimers()
    s = setup()
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('starts: keeps the machine awake, relaunches live Claude cards in auto mode, closes Gemini, leaves terminals and dead cards', () => {
    const pub = s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    expect(pub.on).toBe(true)
    expect(s.calls.awake).toBe(1)
    expect(s.calls.relaunched.map(([id]) => id).sort()).toEqual(['chief', 'w1'])
    const chief = s.calls.relaunched.find(([id]) => id === 'chief')![1] as Record<string, unknown>
    expect(chief).toMatchObject({ permissionMode: 'auto', resume: 'sess-1', boardTools: true })
    const w1 = s.calls.relaunched.find(([id]) => id === 'w1')![1] as Record<string, unknown>
    expect(w1).toMatchObject({ permissionMode: 'plan', continue: true })
    expect(s.calls.removed).toEqual(['gem'])
    expect(readdirSync(s.dir).some((f) => f.endsWith('.jsonl'))).toBe(true)
  })

  it('briefs a relaunched Conductor once it is idle again', () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('chief', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(1500)
    expect(s.calls.prompts.filter(([id]) => id === 'chief')).toHaveLength(1)
    expect(s.calls.prompts[0][1]).toMatch(/AUTONOMOUS MODE is on until/)
    s.board.setStatus('chief', { status: 'idle' })
    vi.advanceTimersByTime(1500)
    expect(s.calls.prompts.filter(([id]) => id === 'chief')).toHaveLength(1)
  })

  it('parks a card that needs the owner, unparks it when a lead answers, and caps dispatches and retries', () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 2, maxRetriesPerTitle: 1, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'needs-you', statusDetail: 'permission: Bash(git push)' })
    expect(s.auto.public().parked).toEqual([{ id: 'w1', title: 'w1', reason: 'permission: Bash(git push)', at: T0 }])
    s.board.setStatus('w1', { status: 'working' })
    expect(s.auto.public().parked).toEqual([])
    expect(s.auto.dispatchRefusal('Reviewer', false)).toBeNull()
    expect(s.auto.dispatchRefusal('Reviewer', true)).toBeNull()
    expect(s.auto.dispatchRefusal('Reviewer', true)).toMatch(/dispatch cap/)
    expect(s.auto.public().dispatches).toBe(2)
    expect(s.auto.permissionMode('default')).toBe('auto')
    expect(s.auto.permissionMode('plan')).toBe('plan')
    expect(s.auto.settingsFragment()).toMatchObject({ permissions: { deny: expect.arrayContaining(['Bash(git push*)']) } })
  })

  it('nudges a silent worker once, parks it after another silent period, and records denials', async () => {
    s.auto.start({ until: T0 + 10 * 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'working', statusDetail: 'thinking' })
    s.tick(11 * 60_000)
    await s.auto.tick()
    expect(s.calls.prompts).toContainEqual(['w1', NUDGE_PROMPT])
    s.tick(5 * 60_000)
    await s.auto.tick()
    expect(s.auto.public().parked).toEqual([])
    s.tick(6 * 60_000)
    await s.auto.tick()
    expect(s.auto.public().parked[0]).toMatchObject({ id: 'w1', reason: 'stalled: no activity for 20 min' })
    s.board.applyHook('w1', { hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
    const log = readFileSync(readdirSync(s.dir).map((f) => join(s.dir, f)).find((f) => f.endsWith('.jsonl'))!, 'utf8')
    expect(log).toMatch(/"kind":"deny".*git push origin main/)
  })

  it('stops at the deadline: releases keep-awake, writes the report, puts it on the canvas as a note', async () => {
    s.auto.start({ until: T0 + 60_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'needs-you', statusDetail: 'which branch?' })
    s.tick(61_000)
    await s.auto.tick()
    expect(s.auto.on).toBe(false)
    expect(s.calls.awake).toBe(0)
    const md = s.calls.notes[0][1]
    expect(s.calls.notes[0][0]).toBe('Morning report')
    expect(md).toContain('Ended: **deadline reached**')
    expect(md).toContain('**w1** (w1)')
    expect(md).toContain('branch `main`, +3 −1 in 1 files')
    expect(s.calls.toasts[0]).toMatch(/^Autonomous run ended: deadline reached\. 1 waiting on you/)
    const report = readdirSync(s.dir).find((f) => f.endsWith('.md'))!
    expect(existsSync(join(s.dir, report))).toBe(true)
    expect(s.auto.public().ended?.reason).toBe('deadline reached')
    // a second start works after a stop
    expect(s.auto.start({ until: T0 + 10_000_000, maxDispatches: 1, maxRetriesPerTitle: 1, stallMinutes: 1 }).on).toBe(true)
  })

  it('ends early once nothing has been busy for the idle window', async () => {
    s.auto.start({ until: T0 + 10 * 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    for (const id of ['chief', 'w1']) s.board.setStatus(id, { status: 'done' })
    s.tick((IDLE_END_MINUTES - 1) * 60_000)
    await s.auto.tick()
    expect(s.auto.on).toBe(true)
    s.tick(2 * 60_000)
    await s.auto.tick()
    expect(s.auto.on).toBe(false)
    expect(s.auto.public().ended?.reason).toMatch(/nothing left to do/)
  })
})
