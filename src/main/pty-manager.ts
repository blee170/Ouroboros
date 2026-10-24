import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import type { PtySpawnOptions } from '@shared/protocol'
import { log } from './diagnostics'

/**
 * Windows: prefer the ConPTY bundled with node-pty over the one shipped in the OS. The in-box
 * ConPTY of older Windows 10 builds has known crashes on resize/close; the bundled DLL needs
 * Windows 10 2004+ (build 19041).
 */
function useBundledConpty(): boolean {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return build >= 19041
}

export type ShellKind = 'powershell' | 'cmd' | 'posix'

export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.OUROBOROS_SHELL || 'powershell.exe'
  }
  return process.env.OUROBOROS_SHELL || process.env.SHELL || '/bin/bash'
}

export function shellKind(shell: string): ShellKind {
  const s = shell.toLowerCase()
  if (s.includes('pwsh') || s.includes('powershell')) return 'powershell'
  if (s.endsWith('cmd.exe') || s === 'cmd') return 'cmd'
  return 'posix'
}

function shellArgs(kind: ShellKind): string[] {
  if (kind === 'powershell') return ['-NoLogo']
  return []
}

interface Entry {
  proc: pty.IPty
  nodeId: string
  cols: number
  rows: number
  exited: boolean
}

export interface PtyEvents {
  data: (nodeId: string, data: string) => void
  exit: (nodeId: string, code: number) => void
}

export class PtyManager extends EventEmitter {
  private entries = new Map<string, Entry>()

  spawn(opts: PtySpawnOptions & { env?: Record<string, string>; omitEnv?: string[] }): void {
    this.kill(opts.nodeId)
    const shell = opts.shell || defaultShell()
    const kind = shellKind(shell)
    const cwd = existsSync(opts.cwd) ? opts.cwd : process.cwd()
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      OUROBOROS_NODE_ID: opts.nodeId,
      ...(opts.env ?? {})
    }
    for (const k of opts.omitEnv ?? []) delete env[k]
    const cols = Math.max(10, opts.cols | 0)
    const rows = Math.max(3, opts.rows | 0)
    log(`pty spawn ${opts.nodeId} shell=${shell} ${cols}x${rows} cwd=${cwd}`)
    const proc = pty.spawn(shell, shellArgs(kind), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConpty: true,
      useConptyDll: useBundledConpty()
    })
    const entry: Entry = { proc, nodeId: opts.nodeId, cols, rows, exited: false }
    this.entries.set(opts.nodeId, entry)
    proc.onData((data) => this.emit('data', opts.nodeId, data))
    proc.onExit(({ exitCode }) => {
      entry.exited = true
      log(`pty exit ${opts.nodeId} code=${exitCode}`)
      // a restart replaces the entry before the killed process reports its exit: that exit is not the card's
      if (this.entries.get(opts.nodeId) !== entry) return
      this.entries.delete(opts.nodeId)
      this.emit('exit', opts.nodeId, exitCode)
    })
    if (opts.initialCommand) {
      // Give the shell a moment to print its prompt before typing.
      setTimeout(() => this.write(opts.nodeId, opts.initialCommand + '\r'), 400)
    }
  }

  write(nodeId: string, data: string): boolean {
    const e = this.entries.get(nodeId)
    if (!e || e.exited) return false
    try {
      e.proc.write(data)
      return true
    } catch (err) {
      log(`pty write failed ${nodeId}: ${String((err as Error).message ?? err)}`)
      return false
    }
  }

  resize(nodeId: string, cols: number, rows: number): void {
    const e = this.entries.get(nodeId)
    if (!e || e.exited) return
    const c = Math.max(10, cols | 0)
    const r = Math.max(3, rows | 0)
    if (c === e.cols && r === e.rows) return // nothing changed: never poke ConPTY for nothing
    e.cols = c
    e.rows = r
    try {
      e.proc.resize(c, r)
    } catch (err) {
      log(`pty resize failed ${nodeId}: ${String((err as Error).message ?? err)}`)
    }
  }

  kill(nodeId: string): void {
    const e = this.entries.get(nodeId)
    if (!e) return
    this.entries.delete(nodeId)
    if (e.exited) return // already gone: closing a dead ConPTY twice is what crashes
    log(`pty kill ${nodeId}`)
    try {
      e.proc.kill()
    } catch (err) {
      log(`pty kill failed ${nodeId}: ${String((err as Error).message ?? err)}`)
    }
  }

  isAlive(nodeId: string): boolean {
    return this.entries.has(nodeId)
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }
}
