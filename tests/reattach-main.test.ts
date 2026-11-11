import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// registerIpc's handlers are closures: the electron mock keeps each one by channel, and the tests call them as the page would
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn), on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: class {},
  Notification: class {},
  clipboard: {},
  dialog: {},
  globalShortcut: {},
  powerSaveBlocker: {},
  ClipboardItem: class {},
  shell: {},
  safeStorage: {},
  nativeImage: {},
  Menu: {},
  screen: {}
}))
vi.mock('../src/main/diagnostics', async (importOriginal) => ({ ...(await importOriginal<object>()), log: vi.fn() }))
// the launch line itself is not what these tests are about (and a role card's launch carries its role as the first message)
vi.mock('../src/main/claude-launcher', async (importOriginal) => ({ ...(await importOriginal<object>()), prepareLaunch: () => ({ command: 'claude', initialPrompt: 'ROLE: you are the tester' }) }))
// never read the owner's Claude sign-in files from a test
vi.mock('../src/main/engines', async (importOriginal) => ({ ...(await importOriginal<object>()), claudeLoginFromFiles: () => false }))

const { registerIpc, createApiHandlers, wakeCard } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')
const { IPC } = await import('../src/shared/protocol')

const ROOT = join(tmpdir(), `ouro-reattach-none-${process.pid}`) // never created: no board file, readWorkspace gives null
const OTHER = join(tmpdir(), `ouro-reattach-other-${process.pid}`)
const ev = { sender: { id: 1 } }

const alive = new Set<string>()
const spawns: string[] = []
const ptys = Object.assign(new EventEmitter(), {
  spawn: (o: { nodeId: string }) => {
    spawns.push(o.nodeId)
    alive.add(o.nodeId)
  },
  isAlive: (id: string) => alive.has(id),
  kill: (id: string) => void alive.delete(id),
  write: vi.fn(),
  resize: vi.fn()
})
let crashed = false
const sent: Array<[string, unknown]> = []
let held: unknown[] = []
const board = new Board()
const s = {
  id: 1,
  win: { isDestroyed: () => false, webContents: { isCrashed: () => crashed, send: (ch: string, p: unknown) => sent.push([ch, p]) } },
  board,
  selectedNodeId: 'x' as string | null,
  initialProject: undefined as string | undefined,
  ledger: { flush: vi.fn(), load: vi.fn(), cardStopped: vi.fn(), release: vi.fn(), data: { tasks: [] } },
  mail: { load: vi.fn() },
  routines: { load: vi.fn(), list: () => [] },
  gate: { load: vi.fn() },
  decisions: { load: vi.fn(() => []), withdraw: () => [] },
  autonomy: { on: false, noteDecision: vi.fn(), permissionMode: (m: unknown) => m, settingsFragment: () => undefined, storedPermissionMode: (m: unknown) => m, dispatchRefusal: () => undefined, countDispatch: vi.fn(), promptRefusal: () => undefined },
  taskSync: undefined
}
const ctx = {
  ptys,
  windows: {
    get: (id: number) => (id === 1 ? s : undefined),
    forNode: () => s,
    forProject: (root: string) => (board.projectRoot === root ? s : undefined),
    all: () => [s],
    current: () => s,
    bindNode: vi.fn(),
    unbindNode: vi.fn()
  },
  usage: { onChange: vi.fn(), forgetCard: vi.fn(), snapshot: async () => ({}) },
  cliWatch: { on: vi.fn() },
  updater: { on: vi.fn() },
  store: { getSettings: () => ({}), getRecent: () => [], pushRecent: vi.fn() },
  boardTrust: { isHeld: () => false, heldNow: () => held, check: () => [] },
  hookServer: { baseUrl: 'http://127.0.0.1:9', port: 9, hookToken: () => 'h', apiToken: () => 'a', mailToken: () => 'm' },
  browsers: { has: () => true, get: () => undefined },
  tmpDir: tmpdir(),
  mcpScriptPath: 'mcp-server.js'
}

const call = <T = any>(ch: string, ...args: unknown[]): T => handlers.get(ch)!(ev, ...args) as T // eslint-disable-line @typescript-eslint/no-explicit-any
const card = (id: string, kind = 'terminal', extra: Record<string, unknown> = {}) => ({ id, data: { kind, title: id, cwd: ROOT, ...extra } })
/** The board as the page last synced it, with these cards; `running` have a live process. */
function boardWith(cards: ReturnType<typeof card>[], running: string[] = []) {
  board.sync({ projectRoot: ROOT, nodes: cards, edges: [] } as never)
  for (const id of running) {
    alive.add(id)
    board.setPtyAlive(id, true)
  }
}

beforeAll(() => {
  // registerIpc starts a minute timer: kept off the real clock
  vi.useFakeTimers()
  registerIpc(ctx as never)
  vi.useRealTimers()
})
beforeEach(() => {
  crashed = false
  sent.length = 0
  held = []
  board.projectRoot = ROOT
  vi.clearAllMocks()
})

describe('boardSync from a page that has not opened its project', () => {
  it("ignores an empty sync with no projectRoot: main keeps the window's cards and their output", () => {
    boardWith([card('a'), card('b')])
    board.appendOutput('a', 'kept')
    call(IPC.boardSync, { projectRoot: '', nodes: [], edges: [] })
    expect([...board.nodes.keys()]).toEqual(['a', 'b'])
    expect(board.getOutput('a')).toBe('kept')
    call(IPC.boardSync, { projectRoot: ROOT, nodes: [card('a')], edges: [] })
    expect([...board.nodes.keys()]).toEqual(['a'])
  })
})

describe('workspaceLoad on the project the window still has (reloaded page)', () => {
  it('returns main\'s board, the running cards and the held ones, and loads nothing again', () => {
    boardWith([card('r1'), card('dead1'), card('nap1', 'claude', { asleep: true })], ['r1'])
    held = [{ nodeId: 'dead1', title: 'dead1', added: false, changes: [] }]
    const r = call(IPC.workspaceLoad, ROOT)
    expect(r.live).toEqual(['r1'])
    expect(r.held).toEqual(held)
    expect(r.workspace.nodes.map((n: { id: string }) => n.id)).toEqual(['r1', 'dead1', 'nap1'])
    expect(s.selectedNodeId).toBeNull()
    expect(s.ledger.load).not.toHaveBeenCalled()
    expect(s.mail.load).not.toHaveBeenCalled()
    expect(s.decisions.load).not.toHaveBeenCalled()
  })
  it('another project, or an empty board, is a plain open', () => {
    boardWith([card('p1')], ['p1'])
    const r = call(IPC.workspaceLoad, OTHER)
    expect(r.live).toBeUndefined()
    expect(s.ledger.load).toHaveBeenCalled()
    expect(s.decisions.load).toHaveBeenCalled()
    board.projectRoot = ROOT
    board.sync({ projectRoot: ROOT, nodes: [], edges: [] } as never)
    vi.clearAllMocks()
    expect(call(IPC.workspaceLoad, ROOT).live).toBeUndefined()
    expect(s.ledger.load).toHaveBeenCalled()
  })
})

describe('pty.attach', () => {
  it('refuses a bad or unknown id and an asleep card with nothing to launch; an ended process is launched', async () => {
    boardWith([card('nap2', 'claude', { asleep: true }), card('ended2')])
    expect(await call(IPC.ptyAttach, 42)).toEqual({ ok: false })
    expect(await call(IPC.ptyAttach, 'nope')).toEqual({ ok: false })
    expect(await call(IPC.ptyAttach, 'nap2')).toEqual({ ok: false })
    expect(await call(IPC.ptyAttach, 'ended2')).toEqual({ ok: false, launch: true })
  })
  it('a card removed or put to sleep after the page loaded is not launched again', async () => {
    boardWith([card('rm3'), card('sl3', 'claude', { sessionId: 'sess', status: 'done' })], ['rm3', 'sl3'])
    expect(call(IPC.workspaceLoad, ROOT).live).toEqual(['rm3', 'sl3'])
    await createApiHandlers(ctx as never, s as never).removeAgent('rm3')
    s.board.nodes.get('sl3')!.data.asleep = true // putToSleep marks it first, then kills it
    alive.delete('sl3')
    expect(await call(IPC.ptyAttach, 'rm3')).toEqual({ ok: false })
    expect(await call(IPC.ptyAttach, 'sl3')).toEqual({ ok: false })
  })
  it('repaints from the buffer, with the batched output sent to the page first', async () => {
    boardWith([card('live4')], ['live4'])
    ptys.emit('data', 'live4', 'chunk-1')
    expect(sent.some(([ch]) => ch === IPC.ptyData)).toBe(false) // still batched
    const r = await call(IPC.ptyAttach, 'live4')
    expect(r).toEqual({ ok: true, output: 'chunk-1' })
    expect(sent).toContainEqual([IPC.ptyData, { nodeId: 'live4', data: 'chunk-1' }])
  })
})

describe('a spawn still queued when the page died', () => {
  it('counts as running and is waited for: the card is started once', async () => {
    boardWith([card('q5')])
    const first = call<Promise<{ ok: boolean }>>(IPC.ptySpawn, { nodeId: 'q5', cwd: ROOT, cols: 80, rows: 24 }) // the old page's call, still queued
    expect(alive.has('q5')).toBe(false)
    expect(call(IPC.workspaceLoad, ROOT).live).toEqual(['q5'])
    expect(await call(IPC.ptyAttach, 'q5')).toMatchObject({ ok: true })
    expect(await first).toEqual({ ok: true })
    expect(spawns.filter((id) => id === 'q5')).toHaveLength(1)
  })
})

describe('a restart main asked for while the page was dead', () => {
  it('is not lost: the card is left out of live and attach says launch, until its next launch', async () => {
    boardWith([card('rs6', 'claude', { sessionId: 'sess-6' })], ['rs6'])
    crashed = true
    expect(createApiHandlers(ctx as never, s as never).updateAgent('rs6', { board_tools: true, restart: true })).toBe(true)
    expect(sent).toEqual([]) // a crashed renderer is sent nothing
    crashed = false
    expect(call(IPC.workspaceLoad, ROOT).live).toEqual([])
    expect(await call(IPC.ptyAttach, 'rs6')).toEqual({ ok: false, launch: true })
    await call(IPC.ptySpawn, { nodeId: 'rs6', cwd: ROOT, cols: 80, rows: 24 })
    expect(call(IPC.workspaceLoad, ROOT).live).toEqual(['rs6'])
    expect(await call(IPC.ptyAttach, 'rs6')).toMatchObject({ ok: true })
  })
  it('a wake counts too', () => {
    boardWith([card('wk7', 'claude', { asleep: true, sessionId: 'sess-7' })])
    expect(wakeCard(ctx as never, s as never, 'wk7', undefined, true)).toBe(true)
    alive.add('wk7') // say the old process were still there: it is not the woken card's
    expect(call(IPC.workspaceLoad, ROOT).live).toEqual([])
    alive.delete('wk7')
  })
})

describe('what main sends the page while it is dead is kept in main', () => {
  it("a role card's first message is on main's board for the reattached card", async () => {
    boardWith([card('role8', 'claude')])
    crashed = true
    const r = await call<Promise<{ ok: boolean }>>(IPC.claudeLaunch, { nodeId: 'role8', cwd: ROOT, shell: 'cmd', cols: 80, rows: 24, kind: 'claude', engine: 'claude', claude: {}, title: 'role8' })
    expect(r).toEqual({ ok: true })
    expect(sent).toEqual([])
    expect(board.hasRoleTurn('role8')).toBe(true)
    crashed = false
    const load = call(IPC.workspaceLoad, ROOT)
    expect(load.live).toEqual(['role8'])
    expect(load.workspace.nodes[0].data.initialPrompt).toBe('ROLE: you are the tester')
  })
  it('a browser card made by main is on its board', async () => {
    boardWith([card('t9')])
    crashed = true
    const { id } = await createApiHandlers(ctx as never, s as never).browser.create({ title: 'Docs', url: 'https://example.com/docs' })
    expect(board.nodes.get(id)?.data).toMatchObject({ kind: 'browser', title: 'Docs', url: 'https://example.com/docs' })
  })
})

describe('appInfo.initialProject', () => {
  it("is the project the window has, else the one it was opened with", async () => {
    s.initialProject = OTHER
    board.projectRoot = ROOT
    expect((await call(IPC.appInfo)).initialProject).toBe(ROOT)
    board.projectRoot = ''
    expect((await call(IPC.appInfo)).initialProject).toBe(OTHER)
  })
})
