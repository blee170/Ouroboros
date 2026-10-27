import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: {}, BrowserWindow: class {}, Notification: class {}, clipboard: {}, dialog: {}, globalShortcut: {}, powerSaveBlocker: {}, ClipboardItem: class {}, shell: {}, safeStorage: {}, nativeImage: {}, Menu: {}, screen: {} }))

const { registerInbox } = await import('../src/main/ipc')
const { Board } = await import('../src/main/board')

const sessionWith = (id: string, status: string | undefined, statusDetail?: string) => {
  const board = new Board()
  board.sync({ projectRoot: 'C:/p', nodes: [{ id, data: { kind: 'claude', title: 'Worker', status, statusDetail } }], edges: [] } as never)
  return { board } as never
}
const socket = (id: string): string => (process.platform === 'win32' ? `\\\\.\\pipe\\LOCAL\\cc-msg-testpipe-${id}` : `/tmp/cc-msg-testpipe-${id}`)

describe('registerInbox', () => {
  it("makes a card still starting ready: its board server registering means Claude Code is up", () => {
    const s = sessionWith('a1', 'starting', 'launching claude')
    const r = registerInbox(s, 'a1', socket('a1'), undefined)
    expect(r.ok, r.error).toBe(true)
    expect((s as { board: InstanceType<typeof Board> }).board.nodes.get('a1')?.data).toMatchObject({ status: 'idle', statusDetail: 'ready' })
  })
  it('leaves a card that is already past starting as it is', () => {
    const s = sessionWith('a2', 'working', 'tool: Bash')
    expect(registerInbox(s, 'a2', socket('a2'), undefined).ok).toBe(true)
    expect((s as { board: InstanceType<typeof Board> }).board.nodes.get('a2')?.data).toMatchObject({ status: 'working', statusDetail: 'tool: Bash' })
  })
})
