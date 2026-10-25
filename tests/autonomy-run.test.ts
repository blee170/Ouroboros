import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/board'
import { Autonomy, type AutonomyHost } from '../src/main/autonomy'
import { IDLE_END_MINUTES, LIMIT_PROMPT, NUDGE_PROMPT } from '../src/shared/autonomy'
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
  vi.setSystemTime(clock) // the board stamps lastEventAt with Date.now(): keep it on the run's clock
  return { board, auto, calls, dir, tick: (ms: number) => vi.setSystemTime((clock += ms)), host }
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
    expect(chief).toMatchObject({ resume: 'sess-1', boardTools: true })
    expect(chief).not.toHaveProperty('permissionMode') // forced at launch while the run is on, never written into the card
    const w1 = s.calls.relaunched.find(([id]) => id === 'w1')![1] as Record<string, unknown>
    expect(w1).toMatchObject({ permissionMode: 'plan' })
    expect(w1.resume).toBeUndefined()
    expect(w1.continue).toBeUndefined() // no session id and no earlier --continue: a bare --continue in the project root would clone another conversation
    expect(s.calls.removed).toEqual(['gem'])
    expect(readdirSync(s.dir).some((f) => f.endsWith('.jsonl'))).toBe(true)
  })

  it('tells a card that was mid-turn at relaunch to carry on once it is back', () => {
    s.board.setStatus('w1', { status: 'working', statusDetail: 'thinking' })
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(1500)
    expect(s.calls.prompts.filter(([id]) => id === 'w1')).toHaveLength(1)
    expect(s.calls.prompts.find(([id]) => id === 'w1')![1]).toMatch(/previous turn was cut/)
  })

  it('parks a card that never comes up and still ends early with it parked', async () => {
    s.auto.start({ until: T0 + 10 * 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'starting', statusDetail: 'launching claude' })
    s.board.setStatus('chief', { status: 'done' })
    s.tick(4 * 60_000)
    await s.auto.tick()
    expect(s.auto.public().parked[0]).toMatchObject({ id: 'w1', reason: expect.stringMatching(/failed to start/) })
    s.tick(IDLE_END_MINUTES * 60_000)
    await s.auto.tick()
    expect(s.auto.on).toBe(false)
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
    expect(s.auto.public().dispatches).toBe(0) // a check costs nothing until the card exists
    s.auto.countDispatch('Reviewer', false)
    expect(s.auto.dispatchRefusal('Reviewer', true)).toBeNull()
    s.auto.countDispatch('Reviewer', true)
    expect(s.auto.dispatchRefusal('Reviewer', true)).toMatch(/dispatch cap/)
    expect(s.auto.public().dispatches).toBe(2)
    expect(s.auto.permissionMode('default')).toBe('auto')
    expect(s.auto.permissionMode('plan')).toBe('plan')
    expect(s.auto.storedPermissionMode('plan')).toBe('plan')
    expect(s.auto.storedPermissionMode('bypassPermissions')).toBeUndefined()
    expect(s.auto.storedPermissionMode('auto')).toBeUndefined()
    expect(s.auto.settingsFragment()).toMatchObject({ permissions: { deny: expect.arrayContaining(['Bash(git push*)']) } })
  })

  it('refuses prompts to shells and to a parked permission prompt while the run is on, and nothing once it is off', async () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    expect(s.auto.promptRefusal({ kind: 'terminal', status: 'idle' })).toMatch(/terminal or command/)
    expect(s.auto.promptRefusal({ kind: 'command', status: 'idle' })).toMatch(/terminal or command/)
    expect(s.auto.promptRefusal({ kind: 'claude', status: 'needs-you', statusDetail: 'permission: Allow Bash?' })).toMatch(/permission prompt/)
    expect(s.auto.promptRefusal({ kind: 'claude', status: 'needs-you', statusDetail: 'which branch?' })).toBeNull()
    expect(s.auto.promptRefusal({ kind: 'claude', status: 'working' })).toBeNull()
    await s.auto.stop('test')
    expect(s.auto.promptRefusal({ kind: 'terminal', status: 'idle' })).toBeNull()
    expect(s.auto.storedPermissionMode('bypassPermissions')).toBe('bypassPermissions')
  })

  it('nudges a silent worker once, parks it after another silent period, and records denials', async () => {
    s.auto.start({ until: T0 + 10 * 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'working', statusDetail: 'thinking' })
    s.tick(11 * 60_000)
    await s.auto.tick()
    expect(s.calls.prompts).toContainEqual(['w1', NUDGE_PROMPT])
    s.board.applyHook('w1', { hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
    s.tick(5 * 60_000)
    await s.auto.tick()
    expect(s.auto.public().parked).toEqual([])
    s.tick(6 * 60_000)
    await s.auto.tick()
    expect(s.auto.public().parked[0]).toMatchObject({ id: 'w1', reason: 'stalled: no activity for 20 min' })
    expect(s.auto.on).toBe(false) // nothing else was busy for 20 min: the run ends with the stalled card parked
    const log = readFileSync(readdirSync(s.dir).map((f) => join(s.dir, f)).find((f) => f.endsWith('.jsonl'))!, 'utf8')
    expect(log).toMatch(/"kind":"deny".*git push origin main/)
  })

  it('lets a card inside a long tool call run three stall periods before the nudge', async () => {
    s.auto.start({ until: T0 + 10 * 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('w1', { status: 'working', statusDetail: 'tool: Bash' })
    s.tick(25 * 60_000)
    await s.auto.tick()
    expect(s.calls.prompts).toEqual([])
    s.tick(6 * 60_000)
    await s.auto.tick()
    expect(s.calls.prompts).toContainEqual(['w1', NUDGE_PROMPT])
  })

  it('stops sending the usage-limit continue once the card went on by itself', async () => {
    s.auto.start({ until: T0 + 10 * 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 0 })
    s.board.setStatus('w1', { status: 'needs-you', statusDetail: 'error: usage limit' })
    s.board.applyHook('w1', { hook_event_name: 'StopFailure', message: "You've hit your usage limit · resets at 3pm" })
    s.tick(16 * 60_000)
    await s.auto.tick()
    expect(s.calls.prompts.filter(([, t]) => t === LIMIT_PROMPT)).toHaveLength(1)
    s.board.setStatus('w1', { status: 'working' })
    s.tick(16 * 60_000)
    await s.auto.tick()
    expect(s.calls.prompts.filter(([, t]) => t === LIMIT_PROMPT)).toHaveLength(1)
  })

  it('dispose writes the report at once, without waiting for evidence', () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.auto.dispose()
    expect(s.auto.on).toBe(false)
    const report = readdirSync(s.dir).find((f) => f.endsWith('.md'))!
    expect(readFileSync(join(s.dir, report), 'utf8')).toContain('Ended: **window closed**')
    expect(s.calls.notes).toEqual([])
    expect(s.calls.toasts).toEqual([])
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
    expect(md).toContain('branch main, +3 −1 in 1 files')
    expect(s.calls.toasts[0]).toMatch(/^Autonomous run ended: deadline reached\. 1 waiting on you/)
    const report = readdirSync(s.dir).find((f) => f.endsWith('.md'))!
    expect(existsSync(join(s.dir, report))).toBe(true)
    expect(s.auto.public().ended?.reason).toBe('deadline reached')
    // a second start works after a stop
    expect(s.auto.start({ until: T0 + 10_000_000, maxDispatches: 1, maxRetriesPerTitle: 1, stallMinutes: 1 }).on).toBe(true)
  })

  it('publishes the report after the note and the toast, and a failure is a log line and a toast, never a throw', async () => {
    const published: Array<{ md: string; run: Record<string, unknown> }> = []
    let answer: Promise<{ ok: true; url: string } | { ok: false; error: string }> = Promise.resolve({ ok: true, url: 'https://www.notion.so/p1' })
    let notesBefore = 0
    let toastsBefore = 0
    s.host.publisher = () => (md, run) => {
      published.push({ md, run: run as unknown as Record<string, unknown> })
      expect(s.calls.notes.length).toBeGreaterThan(notesBefore) // the canvas has the note before Notion is asked
      expect(s.calls.toasts.length).toBeGreaterThan(toastsBefore)
      return answer
    }
    s.auto.start({ until: T0 + 60_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.auto.countDispatch('Reviewer', false)
    s.board.setStatus('w1', { status: 'needs-you', statusDetail: 'which branch?' })
    s.tick(61_000)
    await s.auto.tick()
    await Promise.resolve()
    expect(published).toHaveLength(1)
    expect(published[0].md).toBe(s.calls.notes[0][1].split('\n\n_Saved at')[0])
    expect(published[0].run).toMatchObject({ startedAt: T0, endedAt: T0 + 61_000, reason: 'deadline reached', waiting: 1, dispatches: 1, reportPath: expect.stringMatching(/run-.*\.md$/) })
    const log = readFileSync(join(s.dir, readdirSync(s.dir).find((f) => f.endsWith('.jsonl'))!), 'utf8')
    expect(log).toContain('"kind":"notion","detail":"published https://www.notion.so/p1"')
    expect(s.calls.toasts).toHaveLength(1)

    // a failed publish: said in the toast and the log; the run has still ended cleanly
    answer = Promise.resolve({ ok: false, error: 'Notion rejected the token (401)' })
    notesBefore = s.calls.notes.length
    toastsBefore = s.calls.toasts.length
    s.auto.start({ until: T0 + 10_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    await s.auto.stop('stopped by the owner')
    await Promise.resolve()
    expect(s.auto.on).toBe(false)
    expect(s.calls.toasts[s.calls.toasts.length - 1]).toMatch(/^Morning report not published to Notion: Notion rejected the token \(401\)\./)
    const logs = readdirSync(s.dir).filter((f) => f.endsWith('.jsonl'))
    expect(logs.map((f) => readFileSync(join(s.dir, f), 'utf8')).join('')).toContain('not published: Notion rejected the token (401)')

    // a host that throws synchronously, or a rejected promise: the same path
    s.host.publisher = () => () => {
      throw new Error('boom')
    }
    s.auto.start({ until: T0 + 10_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    await s.auto.stop('x')
    await Promise.resolve()
    expect(s.calls.toasts[s.calls.toasts.length - 1]).toMatch(/not published to Notion: boom/)
    s.host.publisher = () => () => Promise.reject(new Error('net down'))
    s.auto.start({ until: T0 + 10_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    await s.auto.stop('x')
    await Promise.resolve()
    expect(s.calls.toasts[s.calls.toasts.length - 1]).toMatch(/not published to Notion: net down/)
    // the window closing: nothing is sent (the process may quit under it); the log says so
    let asked = 0
    s.host.publisher = () => () => (asked++, Promise.resolve({ ok: true, url: 'u' }))
    s.auto.start({ until: T0 + 10_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.auto.dispose()
    expect(asked).toBe(0)
    const latest = readdirSync(s.dir).filter((f) => f.endsWith('.jsonl')).sort().pop()!
    expect(readFileSync(join(s.dir, latest), 'utf8')).toContain('not published: window closed')
    // publishing off: nothing asked, nothing said
    s.host.publisher = () => undefined
    s.auto.start({ until: T0 + 10_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    const before = s.calls.toasts.length
    await s.auto.stop('x')
    await Promise.resolve()
    expect(s.calls.toasts).toHaveLength(before + 1) // only the run-ended toast
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

  it('after a run, relaunches each Claude card without the rails once its turn is over', async () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('chief', { status: 'idle' })
    s.board.setStatus('w1', { status: 'working', statusDetail: 'thinking', sessionId: 'sess-2' })
    s.calls.relaunched.length = 0
    await s.auto.stop('owner stopped the run')
    expect(s.auto.settingsFragment()).toBeUndefined()
    // the idle Conductor at once, same conversation, its own permission mode; the working card is not cut
    expect(s.calls.relaunched.map(([id]) => id)).toEqual(['chief'])
    expect(s.calls.relaunched[0][1]).toMatchObject({ resume: 'sess-1', boardTools: true })
    expect(s.calls.relaunched[0][1]).not.toHaveProperty('permissionMode')
    s.board.setStatus('w1', { status: 'needs-you', statusDetail: 'permission: Bash' })
    s.board.setStatus('w1', { status: 'idle', statusDetail: 'session compact' }) // an auto-compaction mid-turn, not the end of it
    expect(s.calls.relaunched).toHaveLength(1)
    s.board.setStatus('w1', { status: 'done' })
    expect(s.calls.relaunched.map(([id]) => id)).toEqual(['chief', 'w1'])
    expect(s.calls.relaunched[1][1]).toMatchObject({ permissionMode: 'plan', resume: 'sess-2' })
    // once each: the relaunched cards' own idle/done events do nothing more
    s.board.setStatus('chief', { status: 'idle' })
    s.board.setStatus('w1', { status: 'done' })
    expect(s.calls.relaunched).toHaveLength(2)
    expect(s.calls.prompts).toEqual([]) // no brief, no "continue" after the run
  })

  it('after a run, leaves a card that ended, a failed turn waits for nothing, and a closing window relaunches nothing', async () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('chief', { status: 'working' })
    s.board.setStatus('w1', { status: 'needs-you', statusDetail: 'failed: usage limit reached', sessionId: 'sess-2' })
    s.calls.relaunched.length = 0
    await s.auto.stop('deadline reached')
    expect(s.calls.relaunched.map(([id]) => id)).toEqual(['w1'])
    s.board.setStatus('chief', { status: 'ended' })
    s.board.setStatus('chief', { status: 'idle' })
    expect(s.calls.relaunched.map(([id]) => id)).toEqual(['w1'])
    // a new run takes over; a window closing mid-run does not restart cards on the way out
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('chief', { status: 'idle' })
    s.calls.relaunched.length = 0
    s.auto.dispose()
    expect(s.calls.relaunched).toEqual([])
  })

  it('after a run, never restarts a card into a fresh conversation, and lets go of a card the owner restarted', async () => {
    s.auto.start({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 })
    s.board.setStatus('chief', { status: 'working' })
    s.board.setStatus('w1', { status: 'idle' }) // no session id, no --continue
    s.calls.relaunched.length = 0
    s.calls.toasts.length = 0
    await s.auto.stop('owner stopped the run')
    expect(s.calls.relaunched).toEqual([])
    expect(s.calls.toasts.some((m) => /still on the autonomous rails/.test(m) && /w1/.test(m))).toBe(true)
    // the owner restarts the Conductor by hand: that launch is already a plain one
    s.board.setStatus('chief', { status: 'starting' })
    s.board.setStatus('chief', { status: 'idle' })
    expect(s.calls.relaunched).toEqual([])
  })
})
