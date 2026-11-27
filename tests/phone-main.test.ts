import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: class {}, Notification: class {}, clipboard: {}, dialog: {}, globalShortcut: {}, powerSaveBlocker: {}, ClipboardItem: class {}, shell: {}, safeStorage: {}, nativeImage: {}, Menu: {}, screen: {} }))

vi.mock('../src/main/diagnostics', async (importOriginal) => ({ ...(await importOriginal<object>()), log: vi.fn() }))

const { dropWake, phoneHandlers } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')
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
  const s = {
    id: 1,
    board,
    autonomy: { on: false, promptRefusal: () => null, notePhone: () => {}, public: () => ({}) },
    gate: { pending: () => [] },
    decisions: { pending: () => [] },
    win: { isDestroyed: () => false, isFocused: () => false, webContents: { isCrashed: () => false, send: () => {} } }
  }
  const ctx = {
    ptys: { isAlive: (id: string) => live.has(id), write: (id: string, data: string) => void writes.push([id, data]), kill: () => {} },
    store: { getSettings: () => ({}) },
    usage: { forgetCard: () => {} },
    windows: { current: () => s, forNode: () => s, all: () => [s] }
  }
  const h = phoneHandlers(ctx as never)
  const card = (id: string): PhoneCard => (h.board() as { cards: PhoneCard[] }).cards.find((c) => c.id === id)!
  return { board, h, card, writes }
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
