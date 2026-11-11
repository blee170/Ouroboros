import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyManager } from '../src/main/pty-manager'

// A real ConPTY, a real shell and a real grandchild: the grandchild has no console of its own (detached), the
// way an MCP server started through uvx or node does, so closing the card's pseudo console alone never reached it.
const CHILD = [
  "const { spawn } = require('node:child_process')",
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true })",
  "require('node:fs').writeFileSync(process.argv[2], String(g.pid))",
  'setInterval(() => {}, 1000)'
].join('\n')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

const dirs: string[] = []
const pids: number[] = []

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

async function cardWithGrandchild(ptys: PtyManager, nodeId: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-tree-'))
  dirs.push(dir)
  const child = join(dir, 'child.js')
  const pidFile = join(dir, 'grandchild.pid')
  writeFileSync(child, CHILD)
  ptys.spawn({ nodeId, cwd: dir, shell: 'cmd.exe', cols: 80, rows: 24, initialCommand: `"${process.execPath}" "${child}" "${pidFile}"` })
  expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 15_000)).toBe(true)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  pids.push(pid)
  expect(alive(pid)).toBe(true)
  return pid
}

describe.skipIf(process.platform !== 'win32')('PtyManager process tree kill (Windows)', () => {
  it('kill ends the grandchild of the card', async () => {
    const ptys = new PtyManager()
    const pid = await cardWithGrandchild(ptys, 'tree-1')
    ptys.kill('tree-1')
    let late = 0
    ptys.on('data', () => late++)
    ptys.write('tree-1', 'echo after\r')
    expect(ptys.isAlive('tree-1')).toBe(false)
    expect(await until(() => !alive(pid), 10_000)).toBe(true)
    expect(late).toBe(0) // nothing from the dying process reaches the card
  })

  it('killAll (at quit) ends the grandchild synchronously', async () => {
    const ptys = new PtyManager()
    const pid = await cardWithGrandchild(ptys, 'tree-2')
    ptys.killAll()
    expect(ptys.isAlive('tree-2')).toBe(false)
    expect(alive(pid)).toBe(false)
  })

  it('killAll of some cards (a window closing) ends their grandchildren synchronously and leaves the others', async () => {
    const ptys = new PtyManager()
    const gone = await cardWithGrandchild(ptys, 'tree-3')
    const kept = await cardWithGrandchild(ptys, 'tree-4')
    ptys.killAll(['tree-3', 'nobody'])
    expect(ptys.isAlive('tree-3')).toBe(false)
    expect(alive(gone)).toBe(false)
    expect(ptys.isAlive('tree-4')).toBe(true)
    expect(alive(kept)).toBe(true)
    ptys.killAll()
    expect(alive(kept)).toBe(false)
  })

  it('kill of an unknown or already-exited card does not throw', () => {
    const ptys = new PtyManager()
    expect(() => ptys.kill('nobody')).not.toThrow()
    expect(() => ptys.killAll()).not.toThrow()
  })
})
