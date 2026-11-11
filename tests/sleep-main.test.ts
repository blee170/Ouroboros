import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: class {}, Notification: class {}, clipboard: {}, dialog: {}, globalShortcut: {}, powerSaveBlocker: {}, ClipboardItem: class {}, shell: {}, safeStorage: {}, nativeImage: {}, Menu: {}, screen: {} }))

vi.mock('../src/main/diagnostics', async (importOriginal) => ({ ...(await importOriginal<object>()), log: vi.fn() }))

const { dropWake, installWakeDelivery, sendPrompt, sleepCard, sleepFinished, wakeCard } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')
const { IPC } = await import('../src/shared/protocol')
const { log } = await import('../src/main/diagnostics')

type BoardT = InstanceType<typeof Board>

function setup(data: Record<string, unknown> = {}, others: Array<{ id: string; data: Record<string, unknown> }> = []) {
  const board = new Board()
  board.sync({ projectRoot: 'C:/p', nodes: [{ id: 'w1', data: { kind: 'claude', title: 'Worker', cwd: 'C:/p', sessionId: 'sess-1', status: 'done', ...data } }, ...others], edges: [] } as never)
  board.setPtyAlive('w1', true)
  for (const o of others) board.setPtyAlive(o.id, true)
  const alive = new Set(['w1'])
  const sent: Array<[string, unknown]> = []
  const ctx = {
    ptys: { kill: vi.fn((id: string) => alive.delete(id)), isAlive: (id: string) => alive.has(id), write: vi.fn() },
    usage: { forgetCard: vi.fn() },
    store: { getSettings: () => ({}) }
  }
  const s = {
    board,
    autonomy: { on: false, promptRefusal: () => undefined },
    win: { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) } }
  }
  return { board: board as BoardT, alive, sent, ctx: ctx as never, raw: ctx, s: s as never }
}

describe('sleep and wake', () => {
  // main keeps per-card state across windows (keyed by card id, and every test's card is w1): each test starts an
  // hour after the last, so a prompt time of the one before never counts as recent, and a wake left open is closed
  let clock = Date.now()
  beforeEach(() => {
    clock += 3_600_000
    vi.useFakeTimers({ now: clock })
  })
  afterEach(() => {
    dropWake('w1', 'test over')
    vi.useRealTimers()
  })

  it('sleep stops the process and keeps the card, its title and its session id', () => {
    const t = setup()
    expect(sleepCard(t.ctx, t.s, 'w1')).toEqual({ ok: true })
    expect(t.raw.ptys.kill).toHaveBeenCalledWith('w1')
    const n = t.board.nodes.get('w1')
    expect(n?.data).toMatchObject({ title: 'Worker', sessionId: 'sess-1', asleep: true, status: 'ended', statusDetail: 'asleep' })
    expect(t.board.ptyAlive.has('w1')).toBe(false)
    expect(t.board.snapshot()[0]).toMatchObject({ id: 'w1', asleep: true, status: 'ended', statusDetail: 'asleep', sessionId: 'sess-1' })
    expect(t.sent).toContainEqual([IPC.boardUpdateNode, { nodeId: 'w1', data: { asleep: true }, restart: false }])
  })

  it('refuses a card that is working, and a card with no session to resume', () => {
    const working = setup({ status: 'working' })
    expect(sleepCard(working.ctx, working.s, 'w1').ok).toBe(false)
    expect(working.raw.ptys.kill).not.toHaveBeenCalled()
    const fresh = setup({ sessionId: undefined })
    expect(sleepCard(fresh.ctx, fresh.s, 'w1').error).toMatch(/no conversation/)
  })

  it('wake relaunches through the restart path with --resume of the session id', () => {
    const t = setup()
    sleepCard(t.ctx, t.s, 'w1')
    expect(wakeCard(t.ctx, t.s, 'w1')).toBe(true)
    expect(t.board.nodes.get('w1')?.data).toMatchObject({ asleep: false, claude: { resume: 'sess-1' }, status: 'starting' })
    expect(t.sent).toContainEqual([IPC.boardUpdateNode, { nodeId: 'w1', data: { asleep: false, claude: { resume: 'sess-1', continue: undefined } }, restart: true }])
    expect(wakeCard(t.ctx, t.s, 'w1')).toBe(false) // only an asleep card wakes
  })

  it('a stale renderer sync does not undo sleep in main', () => {
    const t = setup()
    sleepCard(t.ctx, t.s, 'w1')
    t.board.sync({ projectRoot: 'C:/p', nodes: [{ id: 'w1', data: { kind: 'claude', title: 'Worker', cwd: 'C:/p', sessionId: 'sess-1' } }], edges: [] } as never)
    expect(t.board.nodes.get('w1')?.data.asleep).toBe(true)
  })

  it('a prompt to an asleep card wakes it and is delivered only once the card is up', () => {
    const t = setup()
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    expect(sendPrompt(t.ctx, t.s, 'w1', 'next task')).toBe(true)
    expect(t.board.nodes.get('w1')?.data.claude?.resume).toBe('sess-1')
    // the relaunch: the shell is up but the CLI is still starting; nothing is typed into it
    t.alive.add('w1')
    t.board.setPtyAlive('w1', true)
    t.board.setStatus('w1', { status: 'starting', statusDetail: 'launching claude' })
    vi.advanceTimersByTime(5000)
    expect(t.raw.ptys.write).not.toHaveBeenCalled()
    // ready (its inbox registered, or the TUI drew): the prompt goes in
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(1000)
    expect(t.raw.ptys.write).toHaveBeenCalled()
    expect(String(t.raw.ptys.write.mock.calls[0][1])).toContain('next task')
  })

  it('the prompt of a woken card with a role waits for the role turn to end', () => {
    const t = setup()
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    sendPrompt(t.ctx, t.s, 'w1', 'next task')
    // a role turn on relaunch: the prompt waits for its Stop
    t.board.markRoleTurn('w1')
    t.alive.add('w1')
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(2000)
    expect(t.raw.ptys.write).not.toHaveBeenCalled()
    t.board.endRoleTurn('w1')
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready (role acknowledged)' })
    vi.advanceTimersByTime(1000)
    expect(t.raw.ptys.write).toHaveBeenCalled()
  })

  /** The relaunch of a woken card: the shell is up, the CLI still starting. */
  function relaunching(t: ReturnType<typeof setup>): void {
    t.alive.add('w1')
    t.board.setPtyAlive('w1', true)
    t.board.setStatus('w1', { status: 'starting', statusDetail: 'launching claude' })
  }

  it('a woken card idles from its wake, not from the stop before it slept, so the timed sleep leaves it alone', () => {
    const t = setup({ lastStopAt: Date.now() - 60 * 60_000 })
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    wakeCard(t.ctx, t.s, 'w1')
    expect(t.board.nodes.get('w1')?.data.lastStopAt).toBe(Date.now())
    relaunching(t)
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(60_000)
    expect(t.raw.ptys.write).not.toHaveBeenCalled() // woken without a prompt: nothing is typed in
    expect(sleepFinished(t.ctx, t.s, 10)).toBe(0)
    expect(t.board.nodes.get('w1')?.data.asleep).toBe(false)
  })

  it('a second prompt sent while the card is waking waits too, and both go in once it is up', () => {
    const t = setup()
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    expect(sendPrompt(t.ctx, t.s, 'w1', 'first')).toBe(true)
    relaunching(t)
    expect(sendPrompt(t.ctx, t.s, 'w1', 'second')).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(t.raw.ptys.write).not.toHaveBeenCalled()
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(1000)
    const pasted = t.raw.ptys.write.mock.calls.map((c) => String(c[1])).filter((d) => d.includes('second'))
    expect(pasted).toHaveLength(1) // one paste (then Enter), with both prompts
    expect(pasted[0]).toMatch(/first[\s\S]*second/)
  })

  it('a prompt sent to a card woken without one (Wake, board mail) waits until it is up', () => {
    const t = setup()
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    wakeCard(t.ctx, t.s, 'w1')
    relaunching(t)
    expect(sendPrompt(t.ctx, t.s, 'w1', 'later')).toBe(true)
    expect(t.raw.ptys.write).not.toHaveBeenCalled()
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(1000)
    expect(String(t.raw.ptys.write.mock.calls[0][1])).toContain('later')
  })

  it('a woken card that does not come up drops its prompt instead of typing it at a later start', () => {
    const t = setup()
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    sendPrompt(t.ctx, t.s, 'w1', 'stale task')
    dropWake('w1', 'launch refused (held)')
    // the owner fixes it and restarts the card: it comes up with nothing typed in
    relaunching(t)
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    vi.advanceTimersByTime(1000)
    expect(t.raw.ptys.write).not.toHaveBeenCalled()
  })

  it('says so when a woken card is up but refuses the prompt it was woken with', () => {
    const t = setup()
    installWakeDelivery(t.ctx, t.s)
    sleepCard(t.ctx, t.s, 'w1')
    sendPrompt(t.ctx, t.s, 'w1', 'task')
    relaunching(t)
    t.board.setStatus('w1', { status: 'idle', statusDetail: 'ready' })
    t.alive.delete('w1') // gone within the delivery delay
    vi.mocked(log).mockClear()
    vi.advanceTimersByTime(1000)
    expect(vi.mocked(log).mock.calls.some(([line]) => /w1 was up but refused the prompt/.test(line))).toBe(true)
  })

  it('a card just given a prompt is not put to sleep before its turn starts', () => {
    const t = setup({ status: 'idle' })
    expect(sendPrompt(t.ctx, t.s, 'w1', 'go')).toBe(true)
    expect(sleepCard(t.ctx, t.s, 'w1').error).toMatch(/work open/)
    vi.advanceTimersByTime(11_000)
    expect(sleepCard(t.ctx, t.s, 'w1')).toEqual({ ok: true })
  })

  it("an agent's wake of a dispatched card is refused while its lead is at the live-card cap; the owner's Wake is not", () => {
    const team = [{ id: 'lead', data: { kind: 'claude', title: 'Lead', cwd: 'C:/p', status: 'idle' } }]
    for (let i = 0; i < 6; i++) team.push({ id: `n${i}`, data: { kind: 'claude', title: `New ${i}`, cwd: 'C:/p', status: 'working', parentId: 'lead' } as never })
    const t = setup({ parentId: 'lead' }, team)
    sleepCard(t.ctx, t.s, 'w1')
    expect(sendPrompt(t.ctx, t.s, 'w1', 'more')).toBe(false)
    expect(wakeCard(t.ctx, t.s, 'w1')).toBe(false)
    expect(t.board.nodes.get('w1')?.data.asleep).toBe(true)
    expect(wakeCard(t.ctx, t.s, 'w1', undefined, true)).toBe(true)
  })
})
