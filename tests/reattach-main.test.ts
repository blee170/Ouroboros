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
const launches = vi.hoisted(() => [] as Array<{ nodeId: string; settingsExtra?: unknown }>)
vi.mock('../src/main/claude-launcher', async (importOriginal) => ({ ...(await importOriginal<object>()), prepareLaunch: (p: { nodeId: string; settingsExtra?: unknown }) => (launches.push(p), { command: 'claude', initialPrompt: 'ROLE: you are the tester' }) }))
// never read the owner's Claude sign-in files from a test
vi.mock('../src/main/engines', async (importOriginal) => ({ ...(await importOriginal<object>()), claudeLoginFromFiles: () => false }))
// an inbox that fails without being gone (too slow, an error after it opened): a real pipe on Windows always reports ok
const failingInboxes = vi.hoisted(() => new Set<string>())
vi.mock('../src/main/claude-inbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/claude-inbox')>()
  return { ...real, deliverInbox: (...a: Parameters<typeof real.deliverInbox>) => (failingInboxes.has(a[0].socket) ? Promise.resolve('failed' as const) : real.deliverInbox(...a)) }
})

const { registerIpc, createApiHandlers, wakeCard, registerInbox, sendPrompt, routeHook, phoneHandlers } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')
const { IPC } = await import('../src/shared/protocol')
const { log } = await import('../src/main/diagnostics')
const { mapCodexNotify } = await import('../src/main/agent-hook')
const { phoneFilesReadRule } = await import('../src/shared/phone')
const { app } = await import('electron')

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
/** cards whose board entry was changed outside the app: their launch is refused */
const heldCards = new Set<string>()
const board = new Board()
const s = {
  id: 1,
  win: { isDestroyed: () => false, webContents: { isCrashed: () => crashed, send: (ch: string, p: unknown) => sent.push([ch, p]) } },
  board,
  selectedNodeId: 'x' as string | null,
  initialProject: undefined as string | undefined,
  ledger: { flush: vi.fn(), load: vi.fn(), cardStopped: vi.fn(), release: vi.fn(), data: { tasks: [] } },
  mail: { load: vi.fn(), hasUndelivered: () => false },
  routines: { load: vi.fn(), list: () => [] },
  gate: { load: vi.fn(), pending: () => [] },
  decisions: { load: vi.fn(() => []), withdraw: () => [], pending: () => [] },
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
  boardTrust: { isHeld: (_root: string, id: string) => heldCards.has(id), heldNow: () => held, check: () => [] },
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

describe("a Claude card's settings", () => {
  it('let it read the files a phone sent to it, and no other card\'s', async () => {
    boardWith([card('rd1', 'claude'), card('rd2', 'claude')])
    for (const id of ['rd1', 'rd2']) expect(await call(IPC.claudeLaunch, { nodeId: id, cwd: ROOT, shell: 'cmd', cols: 80, rows: 24, kind: 'claude', engine: 'claude', claude: {}, title: id })).toEqual({ ok: true })
    const allowed = (id: string): string[] | undefined => (launches.filter((l) => l.nodeId === id).at(-1)?.settingsExtra as { permissions: { allow?: string[] } }).permissions.allow
    const uploads = join(app.getPath('userData'), 'phone-uploads')
    expect(allowed('rd1')).toEqual([phoneFilesReadRule(join(uploads, 'rd1'))])
    expect(allowed('rd2')).toEqual([phoneFilesReadRule(join(uploads, 'rd2'))])
  })
})

describe('a Claude card launched for the phone', () => {
  interface PhoneCard { id: string; status: string; promptable: boolean; refusal?: string; promptAt?: number; restartable: boolean; relaunch?: string; resumeFailed?: boolean }
  const phone = phoneHandlers(ctx as never)
  const view = (id: string): PhoneCard => (phone.board() as { cards: PhoneCard[] }).cards.find((c) => c.id === id)!
  /** the page's launch of the card, with the card's own launch options */
  const launch = (id: string, claude: Record<string, unknown> = {}) => call<Promise<{ ok: boolean; error?: string }>>(IPC.claudeLaunch, { nodeId: id, cwd: ROOT, shell: 'cmd', cols: 80, rows: 24, kind: 'claude', engine: 'claude', claude, title: id })
  /** the options the card's latest launch was prepared with */
  const launched = (id: string) => (launches.filter((l) => l.nodeId === id).at(-1) as unknown as { claude: { resume?: string; continue?: boolean; model?: string } }).claude
  const exited = (id: string): void => {
    alive.delete(id)
    ptys.emit('exit', id, 1)
  }

  it('says why the PC refused its launch and offers the Restart again; a second refusal says so again', async () => {
    boardWith([card('rf1', 'claude', { asleep: true, sessionId: 'sess-rf1' })])
    heldCards.add('rf1')
    try {
      expect(phone.prompt('rf1', 'carry on', [])).toEqual({ ok: true }) // it wakes: the page launches it
      expect(await launch('rf1')).toMatchObject({ ok: false, error: expect.stringMatching(/^held:/) })
      const c = view('rf1')
      expect(c).toMatchObject({ status: 'starting', promptable: false, restartable: true })
      expect(c.refusal).toMatch(/^The PC did not start it: held:/)
      expect(phone.prompt('rf1', 'hello', [])).toEqual({ ok: false, error: c.refusal })
      expect(phone.restart('rf1', c.promptAt ?? 0)).toEqual({ ok: true })
      expect(view('rf1').restartable).toBe(false) // asked for, until its launch
      expect(await launch('rf1')).toMatchObject({ ok: false })
      expect(view('rf1')).toMatchObject({ restartable: true, refusal: c.refusal })
    } finally {
      heldCards.delete('rf1')
    }
    expect(await launch('rf1')).toEqual({ ok: true })
    expect(view('rf1')).toMatchObject({ status: 'starting', restartable: false })
    expect(view('rf1').refusal).toBeUndefined()
  })

  it('resumes the session main knows for the one launch the phone asked for; the card’s own options stay as they are', async () => {
    const own = { continue: true, model: 'opus' }
    boardWith([card('pr1', 'claude', { status: 'ended', statusDetail: 'exited (1)', sessionId: 'sess-pr1', claude: own })])
    expect(view('pr1')).toMatchObject({ restartable: true, relaunch: 'resume' })
    expect(phone.restart('pr1', view('pr1').promptAt ?? 0)).toEqual({ ok: true })
    expect(sent.filter(([ch]) => ch === IPC.boardUpdateNode).map(([, p]) => p)).toEqual([{ nodeId: 'pr1', data: {}, restart: true }])
    expect(await launch('pr1', own)).toEqual({ ok: true })
    expect(launched('pr1')).toMatchObject({ resume: 'sess-pr1', model: 'opus' })
    expect(launched('pr1').continue).toBeFalsy()
    expect(board.nodes.get('pr1')?.data.claude).toEqual(own)
    // the launch after it (the PC's Restart) is the card's own again
    expect(await launch('pr1', own)).toEqual({ ok: true })
    expect(launched('pr1')).toMatchObject({ continue: true, model: 'opus' })
    expect(launched('pr1').resume).toBeUndefined()
  })

  it('after a resume that did not come up, restarts as the card’s own options say and says so, until its CLI reports', async () => {
    boardWith([card('pr2', 'claude', { status: 'ended', statusDetail: 'exited (1)', sessionId: 'sess-pr2', claude: { continue: true } })])
    expect(phone.restart('pr2', view('pr2').promptAt ?? 0)).toEqual({ ok: true })
    await launch('pr2', { continue: true })
    expect(launched('pr2').resume).toBe('sess-pr2')
    exited('pr2') // the session could not be resumed
    const c = view('pr2')
    expect(c).toMatchObject({ restartable: true, relaunch: 'continue', resumeFailed: true })
    expect(phone.restart('pr2', c.promptAt ?? 0)).toEqual({ ok: true })
    await launch('pr2', { continue: true })
    expect(launched('pr2')).toMatchObject({ continue: true })
    expect(launched('pr2').resume).toBeUndefined()
    // its CLI is up and reports: the next Restart from the phone resumes again
    routeHook(ctx as never, 'pr2', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-pr2', prompt: 'hi' })
    exited('pr2')
    expect(view('pr2')).toMatchObject({ restartable: true, relaunch: 'resume' })
    expect(view('pr2').resumeFailed).toBeUndefined()
  })

  it('a removed card forgets the resume it was owed', async () => {
    boardWith([card('pr3', 'claude', { status: 'ended', statusDetail: 'exited (1)', sessionId: 'sess-pr3' })])
    expect(phone.restart('pr3', view('pr3').promptAt ?? 0)).toEqual({ ok: true })
    await createApiHandlers(ctx as never, s as never).removeAgent('pr3')
    boardWith([card('pr3', 'claude', { sessionId: 'sess-other' })]) // another card under the same id
    await launch('pr3')
    expect(launched('pr3').resume).toBeUndefined()
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

describe("a restarted card's inbox", () => {
  const pipe = (n: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\LOCAL\\cc-msg-restarttest-${n}-${process.pid}` : join(tmpdir(), `cc-msg-restarttest-${n}-${process.pid}`))
  it('is accepted: the inbox of the process the Restart replaced is forgotten (a Restart reports no pty exit)', async () => {
    boardWith([card('in8', 'claude')], ['in8'])
    expect(registerInbox(s as never, 'in8', pipe('old'), undefined).ok).toBe(true)
    expect(registerInbox(s as never, 'in8', pipe('other'), undefined).ok).toBe(false) // one inbox per process
    await call(IPC.ptySpawn, { nodeId: 'in8', cwd: ROOT, cols: 80, rows: 24 })
    expect(registerInbox(s as never, 'in8', pipe('new'), undefined).ok).toBe(true)
  })
  it('a prompt still on its way to the old inbox when the card restarts does not mark the new process as gone', async () => {
    boardWith([card('in9', 'claude')], ['in9'])
    expect(registerInbox(s as never, 'in9', pipe('dead'), undefined).ok).toBe(true)
    expect(sendPrompt(ctx as never, s as never, 'in9', 'on its way')).toBe(true) // nothing listens: the answer will be 'gone'
    await call(IPC.ptySpawn, { nodeId: 'in9', cwd: ROOT, cols: 80, rows: 24 }) // restarted before the answer
    await new Promise((r) => setTimeout(r, 400))
    expect(board.nodes.get('in9')?.data.statusDetail ?? '').not.toMatch(/^failed:/)
    expect(ptys.write).not.toHaveBeenCalled() // and nothing typed into the shell that is still starting
    expect(registerInbox(s as never, 'in9', pipe('fresh'), undefined).ok).toBe(true)
  })
})

describe('a card whose CLI exited and left its shell open', () => {
  // real output of a PowerShell card (every stage is in shell-back.test.ts): Claude Code's TUI idle, then Claude Code
  // killed (its last frame, then the shell's bare prompt)
  const TUI_IDLE = "─────────────────────────────────────────\u001b[m  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← for agents\u001b[K\u001b[28;3H\u001b[?25h\u001b[m\u001b[?25l\u001b[38;2;153;153;153m\u001b[30;44H1 agent\u001b[K\u001b[28;3H\u001b[?25h\u001b[>0q\u001b[?u\u001b[m"
  const CLI_KILLED = "\u001b[?25l\u001b[2m\u001b[28;3HTry \"fix lint errors\"\u001b[22m\u001b[K\u001b[38;2;153;153;153m\u001b[30;39H · ← 1 agent\u001b[28;3H\u001b[?25h\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> "
  /** chunks of a second recorded session, by their numbers in it (all of them are in shell-back.test.ts) */
  const LIVE2: Record<number, string> = {
    /** Claude Code killed */
    24: "\u001b[m",
    /** the shell's prompt */
    25: "\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> ",
    /** mouse reports 346 ms later */
    26: "\u001b[?25l\u001b[91m\u001b[29;71H> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m1\u001b[m\r\n\u001b[17X\u001b[29;91H\u001b[?25h",
    27: "\u001b[?25l\u001b[93m\u001b[29;73H[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[?25h",
    /** Ctrl+C: a fresh bare prompt */
    34: "\u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> ",
    /** mouse reports 2.5 s later */
    35: "\u001b[?25l\u001b[91m\u001b[30;71H> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[\u001b[14C\u001b[?25h",
    36: "\u001b[?25l\u001b[m\r\n\u001b[93m\u001b[29;73H[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[m\r\n\u001b[29;97H\u001b[?25h",
    /** a resize: the dead frame repainted, prompt rows and all */
    37: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort \u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[38;2;153;153;153mft+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M   \u001b[m\r\n\u001b[K\u001b[29;97H\u001b[?25h",
    38: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort  \u001b[38;2;136;136;136m\r\n─────────────────────────────────────────────────────────────────────────────────────────────────── \u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55 \u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[38;2;153;153;153mft+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M    \u001b[m\r\n\u001b[K\u001b[29;97H\u001b[?25h",
    /** a live TUI's status row redrawn (no ready words in it) */
    50: "\u001b[?25l\u001b[38;2;153;153;153m\u001b[29;44H1 agent   \u001b[27;3H\u001b[?25h",
  }
  /**
   * A third recorded session's /exit, chunk by chunk (all of them are in shell-back.test.ts): the TUI's last frames, its
   * modes turned off, the CLI moving the cursor to column 1 itself, then the shell's prompt with no newline before it.
   */
  const EXIT_NO_NEWLINE = [
    "\u001b[?25l\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m\u001b[12;1H❯ \u001b[38;2;255;255;255m/exit                                                                                             \u001b[m\r\n\u001b[K\u001b[38;2;215;119;87m\r\n· Schlepping…\u001b[K\u001b[m\u001b[15;3H\u001b[K\u001b[38;2;136;136;136m\r\n────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[38;2;153;153;153m❯ \u001b[K\u001b[38;2;136;136;136m\r\n────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[38;2;255;193;7m\u001b[19;3H⏵⏵ auto mode on\u001b[63X\u001b[38;2;153;153;153m\u001b[63C◐ medium · /effort\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[17;3H\u001b[?25h",
    "\u001b[?25l\u001b[38;2;153;153;153m\u001b[19;18H (shift+tab to cycle) · esc to interrupt · ← 1 agent\u001b[17;3H\u001b[?25h",
    "\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l",
    "\u001b[>4m\u001b[?2031l\u001b[?2004l\u001b[?1016l",
    "\u001b[?25l\u001b[m\u001b[20;1H\u001b[?25h",
    "PS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> ",
  ]
  const FAILED = 'failed: Claude Code is no longer running in this card (only its shell is). Restart the card.'
  /** what the composer, voice and the Changes panel write (a bracketed paste; Enter follows 150 ms later) */
  const PASTE = '\u001b[200~fix the build\u001b[201~'
  const pipe = (n: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\LOCAL\\cc-msg-shelltest-${n}-${process.pid}` : join(tmpdir(), `cc-msg-shelltest-${n}-${process.pid}`))
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const typed = (): string => ptys.write.mock.calls.map((c) => String(c[1])).join('')
  const logged = (id: string): string[] => vi.mocked(log).mock.calls.map((c) => String(c[0])).filter((l) => l.includes(id))
  /** A Claude card with no inbox whose CLI ran and then exited, leaving PowerShell on its prompt. */
  function exitedCard(id: string): void {
    boardWith([card(id, 'claude', { status: 'idle', statusDetail: 'ready' })], [id])
    ptys.emit('data', id, TUI_IDLE)
    ptys.emit('data', id, CLI_KILLED)
  }
  /** A Claude card with no inbox and its TUI up, then recorded chunks at their recorded times (ms after the first). */
  function replay(id: string, chunks: Array<[ms: number, chunk: number]>): void {
    boardWith([card(id, 'claude', { status: 'idle', statusDetail: 'ready' })], [id])
    ptys.emit('data', id, TUI_IDLE)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const t0 = Date.now()
      for (const [ms, i] of chunks) {
        vi.setSystemTime(t0 + ms)
        ptys.emit('data', id, LIVE2[i])
      }
    } finally {
      vi.useRealTimers()
    }
  }
  /** A Claude card with its TUI up, read as its shell: a frame cut by a chunk boundary right after a row that looks like the prompt. */
  function misreadCard(id: string): void {
    boardWith([card(id, 'claude', { status: 'idle', statusDetail: 'ready' })], [id])
    ptys.emit('data', id, TUI_IDLE + '\u001b[12;3H\r\nPS C:\\work>')
    ptys.emit('data', id, '\u001b[30;44H1 agent\u001b[K\u001b[28;3H\u001b[?25h')
  }

  it('gets nothing typed into its shell and asks for a Restart; started again by hand, it takes prompts once it reports', async () => {
    exitedCard('sh1')
    expect(sendPrompt(ctx as never, s as never, 'sh1', '[watchdog] worker silent for 15 min')).toBe(false)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
    expect(board.nodes.get('sh1')?.data).toMatchObject({ status: 'needs-you', statusDetail: FAILED })
    expect(sendPrompt(ctx as never, s as never, 'sh1', 'again')).toBe(false)
    // the owner started Claude Code again by hand: its TUI draws before it can send a hook
    ptys.emit('data', 'sh1', TUI_IDLE)
    expect(sendPrompt(ctx as never, s as never, 'sh1', 'still marked')).toBe(false)
    // the owner's message from the composer gets through: its turn sends the hook that clears the mark
    call(IPC.ptyWrite, 'sh1', PASTE)
    expect(ptys.write).toHaveBeenCalledWith('sh1', PASTE)
    routeHook(ctx as never, 'sh1', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    expect(sendPrompt(ctx as never, s as never, 'sh1', 'next task')).toBe(true)
    await settle(200)
    expect(typed()).toContain('next task')
  })

  it('takes prompts again after a new launch', async () => {
    exitedCard('sh2')
    expect(sendPrompt(ctx as never, s as never, 'sh2', 'refused')).toBe(false)
    expect(await call(IPC.claudeLaunch, { nodeId: 'sh2', cwd: ROOT, shell: 'powershell', cols: 80, rows: 24, kind: 'claude', engine: 'claude', claude: {}, title: 'sh2' })).toEqual({ ok: true })
    ptys.emit('data', 'sh2', TUI_IDLE) // the TUI drew: ready
    expect(board.nodes.get('sh2')?.data.status).toBe('idle')
    expect(sendPrompt(ctx as never, s as never, 'sh2', 'after the restart')).toBe(true)
    await settle(200)
    expect(typed()).toContain('after the restart')
  })

  it('a launch forgets the prompt the replaced shell showed, before the new process prints anything', async () => {
    exitedCard('sh10')
    expect(sendPrompt(ctx as never, s as never, 'sh10', 'refused')).toBe(false)
    expect(await call(IPC.claudeLaunch, { nodeId: 'sh10', cwd: ROOT, shell: 'powershell', cols: 80, rows: 24, kind: 'claude', engine: 'claude', claude: {}, title: 'sh10' })).toEqual({ ok: true })
    sendPrompt(ctx as never, s as never, 'sh10', 'early') // a report that comes before any output of the new process
    ptys.emit('data', 'sh10', TUI_IDLE)
    expect(board.nodes.get('sh10')?.data).toMatchObject({ status: 'idle', statusDetail: 'ready' })
    expect(sendPrompt(ctx as never, s as never, 'sh10', 'after the launch')).toBe(true)
    await settle(200)
    expect(typed()).toContain('after the launch')
  })

  it('what it printed while starting does not count (the shell prompt, the launch line echoed)', async () => {
    boardWith([card('st1', 'claude', { engine: 'grok', status: 'starting', statusDetail: 'launching grok' })], ['st1'])
    ptys.emit('data', 'st1', LIVE2[25])
    ptys.emit('data', 'st1', 'grok --agent card.json\r\n')
    // a Grok card whose hooks did not load is made ready by four quiet seconds: no ready text, no hook
    board.setStatus('st1', { status: 'idle', statusDetail: 'ready (no hooks yet: status and lines may not work)' })
    expect(sendPrompt(ctx as never, s as never, 'st1', 'the task')).toBe(true)
    await settle(200)
    expect(typed()).toContain('the task')
  })

  it('mouse reports right after its prompt do not hide that its CLI exited', async () => {
    replay('sh7', [[0, 24], [24, 25], [370, 26], [386, 27]])
    expect(sendPrompt(ctx as never, s as never, 'sh7', 'report')).toBe(false)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
    expect(board.nodes.get('sh7')?.data.statusDetail).toBe(FAILED)
  })

  it('nor does a resize that repaints its dead frame with the prompt rows under it', async () => {
    replay('sh8', [[0, 34], [2498, 35], [2511, 36], [4006, 37], [4130, 38]])
    expect(sendPrompt(ctx as never, s as never, 'sh8', 'report')).toBe(false)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
    expect(board.nodes.get('sh8')?.data.statusDetail).toBe(FAILED)
  })

  it('nor does a normal exit that leaves the prompt with no newline before it, for a report or the composer', async () => {
    boardWith([card('ex1', 'claude', { status: 'idle', statusDetail: 'ready' })], ['ex1'])
    ptys.emit('data', 'ex1', TUI_IDLE)
    for (const chunk of EXIT_NO_NEWLINE) ptys.emit('data', 'ex1', chunk)
    const taken = sendPrompt(ctx as never, s as never, 'ex1', 'report')
    call(IPC.ptyWrite, 'ex1', PASTE)
    await settle(200)
    expect(taken).toBe(false)
    expect(ptys.write).not.toHaveBeenCalled()
    expect(board.nodes.get('ex1')?.data.statusDetail).toBe(FAILED)
  })

  it('a hook that lands after its CLI exited does not take the refusal back', async () => {
    exitedCard('sh9')
    routeHook(ctx as never, 'sh9', { hook_event_name: 'Stop', last_assistant_message: 'done' })
    expect(sendPrompt(ctx as never, s as never, 'sh9', 'report')).toBe(false)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
  })

  it("nor does Codex's notify, which Codex starts at the end of a turn and does not wait for", async () => {
    boardWith([card('cx1', 'claude', { engine: 'codex', status: 'working', statusDetail: 'prompt sent' })], ['cx1'])
    ptys.emit('data', 'cx1', LIVE2[24])
    ptys.emit('data', 'cx1', LIVE2[25])
    routeHook(ctx as never, 'cx1', { ...mapCodexNotify({ type: 'agent-turn-complete', 'thread-id': 't1', 'last-assistant-message': 'done' })! })
    expect(sendPrompt(ctx as never, s as never, 'cx1', 'next')).toBe(false)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
    expect(board.nodes.get('cx1')?.data.statusDetail).toBe('failed: codex is no longer running in this card (only its shell is). Restart the card.')
  })

  it('a SessionEnd after the prompt and mouse reports does not take the refusal back: the CLI was ending', async () => {
    replay('se1', [[0, 34], [2498, 35], [2511, 36]])
    routeHook(ctx as never, 'se1', { hook_event_name: 'SessionEnd' })
    expect(sendPrompt(ctx as never, s as never, 'se1', 'report')).toBe(false)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
  })

  it('a hook from a live TUI clears a wrong read of it', async () => {
    misreadCard('wr1')
    routeHook(ctx as never, 'wr1', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    expect(sendPrompt(ctx as never, s as never, 'wr1', 'go on')).toBe(true)
    await settle(200)
    expect(typed()).toContain('go on')
  })

  it('with its TUI still up and no inbox, a prompt is typed as before', async () => {
    boardWith([card('sh3', 'claude', { status: 'idle', statusDetail: 'ready' })], ['sh3'])
    ptys.emit('data', 'sh3', TUI_IDLE)
    expect(sendPrompt(ctx as never, s as never, 'sh3', 'go on')).toBe(true)
    await settle(200)
    expect(typed()).toContain('go on')
  })

  it('an inbox that fails without being gone does not fall back to typing into the shell', async () => {
    boardWith([card('sh4', 'claude', { status: 'idle', statusDetail: 'ready' })], ['sh4'])
    failingInboxes.add(pipe('sh4'))
    expect(registerInbox(s as never, 'sh4', pipe('sh4'), undefined).ok).toBe(true)
    ptys.emit('data', 'sh4', TUI_IDLE)
    ptys.emit('data', 'sh4', CLI_KILLED)
    expect(sendPrompt(ctx as never, s as never, 'sh4', 'report')).toBe(true)
    await settle(200)
    expect(ptys.write).not.toHaveBeenCalled()
    expect(board.nodes.get('sh4')?.data.statusDetail).toBe(FAILED)
  })

  it('the same failure with the TUI up still falls back to typing', async () => {
    boardWith([card('sh5', 'claude', { status: 'idle', statusDetail: 'ready' })], ['sh5'])
    failingInboxes.add(pipe('sh5'))
    expect(registerInbox(s as never, 'sh5', pipe('sh5'), undefined).ok).toBe(true)
    ptys.emit('data', 'sh5', TUI_IDLE)
    expect(sendPrompt(ctx as never, s as never, 'sh5', 'report')).toBe(true)
    await settle(300)
    expect(typed()).toContain('report')
  })

  it('a terminal card is a shell by design: never refused for showing its prompt', async () => {
    boardWith([card('sh6', 'terminal')], ['sh6'])
    ptys.emit('data', 'sh6', CLI_KILLED)
    expect(sendPrompt(ctx as never, s as never, 'sh6', 'dir')).toBe(true)
    await settle(200)
    expect(typed()).toContain('dir')
  })

  describe('text the app writes into its terminal (the composer, voice, the Changes panel, the chat view)', () => {
    it('is not written, the card asks for a Restart, and the Enter after the paste is dropped too', () => {
      exitedCard('pw1')
      call(IPC.ptyWrite, 'pw1', PASTE)
      expect(board.nodes.get('pw1')?.data).toMatchObject({ status: 'needs-you', statusDetail: FAILED })
      call(IPC.ptyWrite, 'pw1', '\r')
      expect(ptys.write).not.toHaveBeenCalled()
      expect(logged('pw1').filter((l) => l.includes('nothing typed'))).toHaveLength(1)
    })

    it('goes through to a card with its TUI up, and to a terminal card', () => {
      boardWith([card('pw2', 'claude', { status: 'idle', statusDetail: 'ready' }), card('pw3', 'terminal')], ['pw2', 'pw3'])
      ptys.emit('data', 'pw2', TUI_IDLE)
      ptys.emit('data', 'pw3', CLI_KILLED)
      call(IPC.ptyWrite, 'pw2', PASTE)
      call(IPC.ptyWrite, 'pw3', PASTE)
      expect(ptys.write.mock.calls).toEqual([['pw2', PASTE], ['pw3', PASTE]])
    })

    it("the owner's own keys in the card's terminal go through: they can start the CLI again by hand", () => {
      exitedCard('pw4')
      call(IPC.ptyType, 'pw4', 'claude\r')
      expect(ptys.write.mock.calls).toEqual([['pw4', 'claude\r']])
    })

    it('a newly registered inbox does not let it into the shell the terminal shows; the TUI drawn again does', () => {
      exitedCard('pw5')
      expect(registerInbox(s as never, 'pw5', pipe('pw5'), undefined).ok).toBe(true)
      call(IPC.ptyWrite, 'pw5', PASTE)
      expect(ptys.write).not.toHaveBeenCalled()
      ptys.emit('data', 'pw5', TUI_IDLE)
      call(IPC.ptyWrite, 'pw5', PASTE)
      expect(ptys.write.mock.calls).toEqual([['pw5', PASTE]])
    })

    it('goes through to Claude Code started again by hand whose ready text was missed and whose inbox is kept in reserve', () => {
      boardWith([card('rs1', 'claude', { status: 'idle', statusDetail: 'ready' })], ['rs1'])
      expect(registerInbox(s as never, 'rs1', pipe('rs1-dead'), undefined).ok).toBe(true)
      ptys.emit('data', 'rs1', TUI_IDLE)
      ptys.emit('data', 'rs1', CLI_KILLED)
      ptys.emit('data', 'rs1', LIVE2[26]) // mouse reports after the prompt
      ptys.emit('data', 'rs1', LIVE2[50]) // the new TUI's output, its ready words missed
      expect(registerInbox(s as never, 'rs1', pipe('rs1-new'), undefined)).toEqual({ ok: false, error: 'this card already has an inbox' })
      call(IPC.ptyWrite, 'rs1', PASTE)
      expect(ptys.write.mock.calls).toEqual([['rs1', PASTE]])
    })

    it('an inbox registering clears a wrong read of a live TUI', () => {
      misreadCard('wr2')
      expect(registerInbox(s as never, 'wr2', pipe('wr2'), undefined).ok).toBe(true)
      call(IPC.ptyWrite, 'wr2', PASTE)
      expect(ptys.write.mock.calls).toEqual([['wr2', PASTE]])
    })
  })
})
