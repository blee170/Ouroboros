import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: class {}, Notification: class {}, clipboard: {}, dialog: {}, globalShortcut: {}, powerSaveBlocker: {}, ClipboardItem: class {}, shell: {}, safeStorage: {}, nativeImage: {}, Menu: {}, screen: {} }))

vi.mock('../src/main/diagnostics', async (importOriginal) => ({ ...(await importOriginal<object>()), log: vi.fn() }))

const { dropWake, phoneHandlers } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')
const { Ledger } = await import('../src/main/ledger')
const { PHONE_FILES_NOTE } = await import('../src/shared/phone')

interface PhoneCard {
  id: string
  status: string
  promptable: boolean
  wakes?: boolean
  refusal?: string
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
    autonomy: { on: false, promptRefusal: () => null, notePhone: () => {}, noteDecision: () => {}, public: () => ({}) },
    gate: { pending: () => [] },
    decisions: { pending: () => [] },
    win: { isDestroyed: () => false, isFocused: () => false, webContents: { isCrashed: () => false, send: (channel: string, payload: unknown) => void sent.push([channel, payload]) } }
  }
  const ctx = {
    ptys: { isAlive: (id: string) => live.has(id), write: (id: string, data: string) => void writes.push([id, data]), kill: () => {} },
    store: { getSettings: () => ({}) },
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
    const files = [
      { path: 'C:\\up\\2026-11-27\\a-1234abcd.png', name: 'a.png' },
      { path: 'C:\\up\\2026-11-27\\회의 메모-5678abcd.pdf', name: '회의 메모.pdf' }
    ]
    expect(t.h.prompt('ww', 'see these', files)).toEqual({ ok: true })
    const typed = t.writes.find(([id]) => id === 'ww')?.[1] ?? ''
    expect(typed).toContain(`see these\n\n${PHONE_FILES_NOTE}\n${files[0].path}\n${files[1].path}`)
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
