import { EventEmitter } from 'node:events'
import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import type { PtySpawnOptions } from '@shared/protocol'

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
}

export interface PtyEvents {
  data: (nodeId: string, data: string) => void
  exit: (nodeId: string, code: number) => void
}

export class PtyManager extends EventEmitter {
  private entries = new Map<string, Entry>()

  spawn(opts: PtySpawnOptions & { env?: Record<string, string> }): void {
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
    const proc = pty.spawn(shell, shellArgs(kind), {
      name: 'xterm-256color',
      cols: Math.max(10, opts.cols | 0),
      rows: Math.max(3, opts.rows | 0),
      cwd,
      env,
      useConpty: true
    })
    const entry: Entry = { proc, nodeId: opts.nodeId }
    this.entries.set(opts.nodeId, entry)
    proc.onData((data) => this.emit('data', opts.nodeId, data))
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(opts.nodeId) === entry) this.entries.delete(opts.nodeId)
      this.emit('exit', opts.nodeId, exitCode)
    })
    if (opts.initialCommand) {
      // Give the shell a moment to print its prompt before typing.
      setTimeout(() => this.write(opts.nodeId, opts.initialCommand + '\r'), 400)
    }
  }

  write(nodeId: string, data: string): boolean {
    const e = this.entries.get(nodeId)
    if (!e) return false
    e.proc.write(data)
    return true
  }

  resize(nodeId: string, cols: number, rows: number): void {
    const e = this.entries.get(nodeId)
    if (!e) return
    try {
      e.proc.resize(Math.max(10, cols | 0), Math.max(3, rows | 0))
    } catch {
      /* resizing a dead pty throws; ignore */
    }
  }

  kill(nodeId: string): void {
    const e = this.entries.get(nodeId)
    if (!e) return
    this.entries.delete(nodeId)
    try {
      e.proc.kill()
    } catch {
      /* ignore */
    }
  }

  isAlive(nodeId: string): boolean {
    return this.entries.has(nodeId)
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }
}
