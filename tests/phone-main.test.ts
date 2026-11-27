import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: class {}, Notification: class {}, clipboard: {}, dialog: {}, globalShortcut: {}, powerSaveBlocker: {}, ClipboardItem: class {}, shell: {}, safeStorage: {}, nativeImage: {}, Menu: {}, screen: {} }))

vi.mock('../src/main/diagnostics', async (importOriginal) => ({ ...(await importOriginal<object>()), log: vi.fn() }))

const { dropWake, phoneHandlers, registerInbox } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')
const { Ledger } = await import('../src/main/ledger')
const { PHONE_FILES_NOTE } = await import('../src/shared/phone')
const { IPC } = await import('../src/shared/protocol')

interface PhoneCard {
  id: string
  status: string
  promptable: boolean
  wakes?: boolean
  refusal?: string
  promptAt?: number
  restartable: boolean
  relaunch?: string
}

/** A window with these agent cards; `alive` are the ones with a live process. */
function setup(nodes: Array<{ id: string; data: Record<string, unknown> }>, alive: string[]) {
  const board = new Board()
  board.sync({ projectRoot: 'C:/p', nodes: nodes.map((n) => ({ id: n.id, data: { kind: 'claude', title: n.id, cwd: 'C:/p', sessionId: `sess-${n.id}`, ...n.data } })), edges: [] } as never)
  const live = new Set(alive)
  for (const id of alive) board.setPtyAlive(id, true)
  const writes: Array<[string, string]> = []
  const sent: Array<[string, unknown]> = []
  const s = {
    id: 1,
    board,
    ledger: new Ledger(() => {}),
    mail: { send: vi.fn((_m: { to: string; body: string }) => ({ ok: true })) },
    autonomy: { on: false, promptRefusal: (_n: unknown): string | null => null, notePhone: () => {}, noteDecision: () => {}, public: () => ({}) },
    gate: { pending: () => [] },
    decisions: { pending: () => [] },
    win: { isDestroyed: () => false, isFocused: () => false, webContents: { isCrashed: () => false, send: (channel: string, payload: unknown) => void sent.push([channel, payload]) } }
  }
  const ctx = {
    ptys: { isAlive: (id: string) => live.has(id), write: (id: string, data: string) => void writes.push([id, data]), kill: () => {} },
    store: { getSettings: (): { maxWorkersPerLead?: number } => ({}) },
    usage: { forgetCard: () => {} },
    windows: { current: () => s, forNode: () => s, all: (): Array<typeof s> => [s] }
  }
  const h = phoneHandlers(ctx as never)
  const card = (id: string): PhoneCard => (h.board() as { cards: PhoneCard[] }).cards.find((c) => c.id === id)!
  return { board, h, card, writes, s, ctx, live, sent }
}

describe('a message from the phone, on the real board', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    dropWake('zz', 'test over')
    vi.useRealTimers()
  })

  it('offers the message box to an asleep card and wakes it with the message', () => {
    const t = setup([{ id: 'zz', data: { status: 'ended', statusDetail: 'asleep', asleep: true } }], [])
    expect(t.card('zz')).toMatchObject({ promptable: true, wakes: true })
    expect(t.h.prompt('zz', 'carry on', [])).toEqual({ ok: true })
    expect(t.board.nodes.get('zz')?.data).toMatchObject({ asleep: false, status: 'starting', statusDetail: 'waking' })
    // still waking, no process yet: a second message waits with the first instead of being refused
    expect(t.card('zz')).toMatchObject({ promptable: true, wakes: false })
    expect(t.h.prompt('zz', 'and this', [])).toEqual({ ok: true })
  })

  it('sends to a card whose turn failed, into Claude Code at its prompt', () => {
    const t = setup([{ id: 'ff', data: { status: 'needs-you', statusDetail: 'failed: API Error: Request rejected (429)' } }], ['ff'])
    expect(t.card('ff')).toMatchObject({ promptable: true, wakes: false })
    expect(t.h.prompt('ff', 'try again', [])).toEqual({ ok: true })
    expect(t.writes.some(([id, d]) => id === 'ff' && d.includes('try again'))).toBe(true)
  })

  it('refuses with the reason the board shows', () => {
    const t = setup(
      [
        { id: 'pp', data: { status: 'needs-you', statusDetail: 'permission: Bash' } },
        { id: 'dd', data: { status: 'ended', statusDetail: 'exited' } }
      ],
      ['pp']
    )
    for (const id of ['pp', 'dd']) {
      const c = t.card(id)
      expect(c.promptable).toBe(false)
      expect(c.refusal).toBeTruthy()
      expect(t.h.prompt(id, 'hello', [])).toEqual({ ok: false, error: c.refusal })
    }
    expect(t.card('pp').refusal).toMatch(/answer/)
    expect(t.card('dd').refusal).toMatch(/Restart/)
    expect(t.writes).toEqual([])
  })

  it('puts the files after the text, one path per line under one line, the way the PC composer adds paths', () => {
    const t = setup([{ id: 'ww', data: { status: 'idle' } }], ['ww'])
    const paths = ['C:\\up\\ww\\0123456789abcdef.png', 'C:\\up\\ww\\fedcba9876543210.pdf']
    expect(t.h.prompt('ww', 'see these', paths)).toEqual({ ok: true })
    const typed = t.writes.find(([id]) => id === 'ww')?.[1] ?? ''
    expect(typed).toContain(`see these\n\n${PHONE_FILES_NOTE}\n${paths[0]}\n${paths[1]}`)
  })

  it('offers a Restart, not the message box, once a card’s CLI ended inside its shell (/exit)', () => {
    const t = setup([{ id: 'ex', data: { status: 'idle', statusDetail: 'ready' } }], ['ex'])
    t.board.applyHook('ex', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: 'sess-ex' })
    const c = t.card('ex')
    expect(c).toMatchObject({ status: 'ended', promptable: false, restartable: true, relaunch: 'resume' })
    expect(c.refusal).toMatch(/Restart it/)
    expect(t.h.prompt('ex', 'hello', [])).toEqual({ ok: false, error: c.refusal })
    expect(t.h.restart('ex', c.promptAt ?? 0)).toEqual({ ok: true })
    expect(t.writes).toEqual([])
  })

  it('leaves an asleep card asleep while its lead is at its live-card cap, and says so on the screen and in the answer', () => {
    const t = setup(
      [
        { id: 'lead', data: { kind: 'conductor', status: 'idle' } },
        { id: 'w1', data: { status: 'working', parentId: 'lead' } },
        { id: 'zw', data: { status: 'ended', statusDetail: 'asleep', asleep: true, parentId: 'lead' } }
      ],
      ['lead', 'w1']
    )
    t.ctx.store.getSettings = () => ({ maxWorkersPerLead: 1 })
    const c = t.card('zw')
    expect(c).toMatchObject({ promptable: false, wakes: false })
    expect(c.refusal).toMatch(/lead/)
    expect(t.h.prompt('zw', 'carry on', [])).toEqual({ ok: false, error: c.refusal })
    expect(t.board.nodes.get('zw')?.data.asleep).toBe(true)
  })

  it('leaves an asleep card asleep when the Autonomous run refuses the prompt, with the run’s reason', () => {
    const t = setup([{ id: 'zr', data: { status: 'ended', statusDetail: 'asleep', asleep: true } }], [])
    t.s.autonomy.on = true
    t.s.autonomy.promptRefusal = () => 'Autonomous mode: not this card'
    expect(t.card('zr')).toMatchObject({ promptable: false, wakes: false, refusal: 'Autonomous mode: not this card' })
    expect(t.h.prompt('zr', 'carry on', [])).toEqual({ ok: false, error: 'Autonomous mode: not this card' })
    expect(t.board.nodes.get('zr')?.data.asleep).toBe(true)
  })
})

describe('tasks that wait on the owner, on the phone', () => {
  interface PhoneTask {
    id: string
    updatedAt: number
    [k: string]: unknown
  }
  /** Window 1 (project p): an approve task with a spending limit asked by a card, and a task nobody waits on. Window 2 (project q): a do task at every size limit. */
  function twoWindows() {
    const t = setup([{ id: 'asker', data: { status: 'idle', title: '🎨 Designer' } }], ['asker'])
    const l1 = t.s.ledger
    l1.create({ title: 'Hero images' }, 'asker')
    expect(l1.update('T1', { state: 'blocked', reason: 'needs the owner', ownerAction: { kind: 'approve', ask: 'Generate the hero images?', steps: ['Generate them'], limit: 'up to 63 images, about $5' } }, 'asker').ok).toBe(true)
    l1.create({ title: 'Nobody waits on this' }, 'asker')
    const board2 = new Board()
    board2.sync({ projectRoot: 'C:/q', nodes: [], edges: [] } as never)
    const l2 = new Ledger(() => {})
    l2.create({ title: 'Migrate prod' }, 'w9')
    const big = { kind: 'do', ask: 'Run the migration on prod.', steps: Array.from({ length: 12 }, (_, i) => `${i + 1} ${'s'.repeat(290)}`), copy: [1, 2, 3].map((i) => ({ label: `SQL ${i}`, text: 'x'.repeat(8000) })), check: 'c'.repeat(300) }
    expect(l2.update('T1', { state: 'blocked', reason: 'owner only', ownerAction: big }, 'w9').ok).toBe(true)
    const w2 = { ...t.s, id: 2, board: board2, ledger: l2 }
    t.ctx.windows.all = () => [t.s, w2]
    return { ...t, l1, l2 }
  }
  const tasks = (h: ReturnType<typeof setup>['h']): PhoneTask[] => (h.board() as { tasks: PhoneTask[] }).tasks

  it('lists every window’s waiting tasks, each small enough for the 3 s poll', () => {
    const t = twoWindows()
    const list = tasks(t.h)
    expect(list.map((x) => x.id)).toEqual(['1-T1', '2-T1'])
    expect(list[0]).toMatchObject({ title: 'Hero images', kind: 'approve', ask: 'Generate the hero images?', limit: 'up to 63 images, about $5', by: '🎨 Designer', project: 'p', updatedAt: t.l1.get('T1')!.updatedAt })
    expect(list[1]).toMatchObject({ title: 'Migrate prod', kind: 'do', project: 'q', updatedAt: t.l2.get('T1')!.updatedAt })
    for (const x of list) expect(JSON.stringify(x).length).toBeLessThan(2048)
    // the steps, the text to copy and the check come only when the owner opens the task
    expect(JSON.stringify(t.h.board())).not.toContain('x'.repeat(50))
    expect(t.h.task('2-T1')).toMatchObject({ id: '2-T1', kind: 'do', steps: expect.arrayContaining([expect.stringMatching(/^12 s/)]), copy: [{ label: 'SQL 1', text: 'x'.repeat(8000) }, { label: 'SQL 2' }, { label: 'SQL 3' }], check: 'c'.repeat(300) })
    expect(t.h.task('1-T2')).toBeUndefined() // waits on nobody
    expect(t.h.task('3-T1')).toBeUndefined() // no such window
  })

  it('answers through the PC’s own rules: to the task as the phone read it, by its kind, and the card is told', () => {
    const t = twoWindows()
    const at = t.l1.get('T1')!.updatedAt
    expect(t.h.answerTask('1-T1', 'approve', 'go', at - 1)).toEqual({ ok: false, error: 'T1 changed since you read it. Read it again before you answer.' })
    expect(t.h.answerTask('2-T1', 'approve', undefined, t.l2.get('T1')!.updatedAt)).toMatchObject({ ok: false, error: expect.stringMatching(/Only you can do this one/) })
    expect(t.h.answerTask('3-T1', 'hold', undefined, at)).toMatchObject({ ok: false })
    expect(t.s.mail.send).not.toHaveBeenCalled()
    expect(t.h.answerTask('1-T1', 'approve', 'go', at)).toEqual({ ok: true })
    expect(t.l1.get('T1')).toMatchObject({ state: 'todo', reason: 'approved by the owner: go' })
    expect(t.s.mail.send.mock.calls[0][0]).toMatchObject({ to: 'asker', body: expect.stringContaining('APPROVED BY OWNER: Generate the hero images?') })
    expect(tasks(t.h).map((x) => x.id)).toEqual(['2-T1'])
    // answered meanwhile (on the PC): the phone gets the app's own words
    expect(t.h.answerTask('1-T1', 'hold', undefined, at)).toEqual({ ok: false, error: 'T1 is not waiting on you' })
  })
})

describe('a Restart from the phone, on the real board', () => {
  // a pipe name Claude Code could have made, with nothing listening on it: its Claude Code has exited
  const pipe = (id: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\LOCAL\\cc-msg-phonerestart-${id}-${process.pid}` : `/tmp/cc-msg-phonerestart-${id}-${process.pid}`)
  const restarts = (sent: Array<[string, unknown]>): unknown[] => sent.filter(([ch]) => ch === IPC.boardUpdateNode).map(([, p]) => p)

  it('is offered once a card’s CLI exits inside its shell, and asks the page for the PC’s Restart once', async () => {
    const t = setup([{ id: 'rx', data: { status: 'idle', statusDetail: 'ready' } }], ['rx'])
    expect(t.card('rx').restartable).toBe(false)
    expect(registerInbox(t.s as never, 'rx', pipe('rx'), undefined).ok).toBe(true)
    // the next message finds only the shell: nothing is typed, the card asks for a Restart
    expect(t.h.prompt('rx', 'hello', [])).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 400))
    const c = t.card('rx')
    expect(c).toMatchObject({ status: 'needs-you', promptable: false, restartable: true, relaunch: 'resume' })
    expect(c.refusal).toMatch(/Restart it/)
    expect(t.writes).toEqual([])
    expect(t.h.restart('rx', c.promptAt! - 1)).toEqual({ ok: false, error: 'the card has moved on since this screen was loaded; look again' })
    expect(restarts(t.sent)).toEqual([])
    expect(t.h.restart('rx', c.promptAt!)).toEqual({ ok: true })
    // the page is asked for the PC's Restart; the session it resumes is main's, for that launch only (reattach-main.test.ts)
    expect(restarts(t.sent)).toEqual([{ nodeId: 'rx', data: {}, restart: true }])
    expect(t.board.nodes.get('rx')?.data.claude).toBeUndefined()
    // a double tap, or a second phone: the restart already asked for is not asked again
    expect(t.h.restart('rx', c.promptAt!)).toEqual({ ok: false, error: 'It is restarting already.' })
    expect(t.card('rx').restartable).toBe(false)
    expect(restarts(t.sent)).toHaveLength(1)
  })

  it('says what the restart does to the conversation: resumed when the app knows the session, else as the launch options say', () => {
    const t = setup(
      [
        { id: 'r1', data: { status: 'ended', statusDetail: 'exited (0)', claude: { resume: 'sess-r1' } } },
        { id: 'r2', data: { status: 'ended', statusDetail: 'exited (1)', sessionId: undefined } },
        { id: 'r3', data: { status: 'ended', statusDetail: 'exited (1)', claude: { continue: true, model: 'opus' } } }
      ],
      []
    )
    expect(t.card('r1')).toMatchObject({ restartable: true, relaunch: 'resume' })
    expect(t.card('r2')).toMatchObject({ restartable: true, relaunch: 'new' })
    expect(t.h.restart('r2', t.card('r2').promptAt ?? 0)).toEqual({ ok: true })
    // no session known: the card's launch options are left as they are, the page relaunches it as the PC's Restart would
    expect(restarts(t.sent)).toEqual([{ nodeId: 'r2', data: {}, restart: true }])
    // a known session beats --continue (the latest conversation in the folder may be another card's), and the card's
    // own options stay as the owner set them: every later Restart on the PC still continues
    expect(t.card('r3')).toMatchObject({ restartable: true, relaunch: 'resume' })
    expect(t.h.restart('r3', t.card('r3').promptAt ?? 0)).toEqual({ ok: true })
    expect(restarts(t.sent)[1]).toEqual({ nodeId: 'r3', data: {}, restart: true })
    expect(t.board.nodes.get('r3')?.data.claude).toEqual({ continue: true, model: 'opus' })
  })

  it('is not offered to a running, asleep, waking or starting card', () => {
    const t = setup(
      [
        { id: 'run', data: { status: 'working' } },
        { id: 'perm', data: { status: 'needs-you', statusDetail: 'permission: Bash' } },
        { id: 'zzz', data: { status: 'ended', statusDetail: 'asleep', asleep: true } },
        { id: 'st', data: { status: 'starting', statusDetail: 'launching claude' } }
      ],
      ['run', 'perm', 'st']
    )
    for (const id of ['run', 'perm', 'zzz', 'st']) {
      expect(t.card(id).restartable).toBe(false)
      expect(t.h.restart(id, t.card(id).promptAt ?? 0)).toMatchObject({ ok: false })
    }
    expect(restarts(t.sent)).toEqual([])
    // a message wakes the asleep one; while it wakes, the phone does not restart it either
    expect(t.h.prompt('zzz', 'carry on', [])).toEqual({ ok: true })
    expect(t.card('zzz').restartable).toBe(false)
    expect(t.h.restart('zzz', t.card('zzz').promptAt ?? 0)).toMatchObject({ ok: false, error: expect.stringMatching(/waking/) })
    dropWake('zzz', 'test over')
  })
})
