import { describe, expect, it, vi } from 'vitest'
import { createServer, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: class {}, Notification: class {}, clipboard: {}, dialog: {}, globalShortcut: {}, powerSaveBlocker: {}, ClipboardItem: class {}, shell: {}, safeStorage: {}, nativeImage: {}, Menu: {}, screen: {} }))
vi.mock('../src/main/diagnostics', async (importOriginal) => ({ ...(await importOriginal<object>()), log: vi.fn() }))

const { registerInbox, sendPrompt } = await import('../src/main/ipc')
const { deliverInbox } = await import('../src/main/claude-inbox')
const { Board } = await import('../src/main/board')

// a real pipe name Claude Code could have made: registerInbox checks the shape
const pipe = (id: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\LOCAL\\cc-msg-gonetest-${id}-${process.pid}` : join(tmpdir(), `cc-msg-gonetest-${id}-${process.pid}`))

const setup = (id: string) => {
  const board = new Board()
  board.sync({ projectRoot: 'C:/p', nodes: [{ id, data: { kind: 'claude', title: 'Chief', status: 'idle', statusDetail: 'ready' } }], edges: [] } as never)
  const written: string[] = []
  const ctx = { ptys: { isAlive: () => true, write: (_id: string, data: string) => void written.push(data) } } as never
  const s = { board, autonomy: { on: false }, win: { isDestroyed: () => true } } as never
  return { board, ctx, s, written }
}
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('deliverInbox', () => {
  it("says 'gone' when nothing listens on the inbox, 'ok' when something does", async () => {
    const path = pipe('d')
    expect(await deliverInbox({ socket: path }, 'x')).toBe('gone')
    const server = createServer((c) => c.resume())
    await new Promise<void>((r) => server.listen(path, r))
    expect(await deliverInbox({ socket: path }, 'x')).toBe('ok')
    await new Promise<void>((r) => server.close(() => r()))
  })
})

describe('a prompt for a card whose Claude Code has exited', () => {
  it('is not typed into the shell: the card asks for a Restart, and later prompts are refused', async () => {
    const { board, ctx, s, written } = setup('g1')
    // the inbox was registered while Claude Code ran; nothing listens on it now, but the shell (the PTY) is alive
    expect(registerInbox(s, 'g1', pipe('g1'), undefined).ok).toBe(true)
    expect(sendPrompt(ctx, s, 'g1', 'You have 1 new board message(s) from the owner')).toBe(true)
    await settle(400)
    expect(written).toEqual([])
    expect(board.nodes.get('g1')?.data).toMatchObject({ status: 'needs-you' })
    expect(board.nodes.get('g1')?.data.statusDetail).toMatch(/^failed: Claude Code is no longer running/)
    // the next one is refused at once (the sender keeps it: board mail stays undelivered, the relay stops)
    expect(sendPrompt(ctx, s, 'g1', '[handoff note]')).toBe(false)
    await settle(300)
    expect(written).toEqual([])
  })

  it('is delivered again once the card registers a new inbox (a restart)', async () => {
    const { ctx, s, written } = setup('g2')
    expect(registerInbox(s, 'g2', pipe('g2'), undefined).ok).toBe(true)
    sendPrompt(ctx, s, 'g2', 'first')
    await settle(400)
    expect(sendPrompt(ctx, s, 'g2', 'refused')).toBe(false)
    let got = ''
    const path = pipe('g2b')
    const server = createServer((c) => c.on('data', (d) => (got += d)))
    await new Promise<void>((r) => server.listen(path, r))
    expect(registerInbox(s, 'g2', path, undefined).ok).toBe(true)
    expect(sendPrompt(ctx, s, 'g2', 'after restart')).toBe(true)
    await settle(300)
    expect(got).toContain('after restart')
    expect(written).toEqual([])
    await new Promise<void>((r) => server.close(() => r()))
  })
})

describe('deliverInbox error codes', () => {
  const failing = (code: string) => (): Socket => {
    const c = Object.assign(new EventEmitter(), { end: () => undefined, destroy: () => undefined })
    setTimeout(() => c.emit('error', Object.assign(new Error(code), { code })), 0)
    return c as unknown as Socket
  }
  it("only a missing or refusing inbox is 'gone': an error that says nothing about the listener is 'failed'", async () => {
    expect(await deliverInbox({ socket: 'x' }, 't', failing('ENOENT'))).toBe('gone')
    expect(await deliverInbox({ socket: 'x' }, 't', failing('ECONNREFUSED'))).toBe('gone')
    expect(await deliverInbox({ socket: 'x' }, 't', failing('EACCES'))).toBe('failed')
    expect(await deliverInbox({ socket: 'x' }, 't', failing('EMFILE'))).toBe('failed')
  })
})
