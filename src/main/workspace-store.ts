import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { LedgerData } from '@shared/ledger'

export const WORKSPACE_FILE = '.ouroboros.json'

type BoardWritten = (projectRoot: string, text: string, fromDisk: boolean) => void
let boardWritten: BoardWritten | undefined
/** Called with every board file the app writes (BoardTrust records it); `fromDisk` when its cards were re-read from the file. */
export function onBoardWritten(fn: BoardWritten | undefined): void {
  boardWritten = fn
}

function writeBoard(projectRoot: string, text: string, fromDisk: boolean): void {
  writeAtomic(join(projectRoot, WORKSPACE_FILE), text)
  boardWritten?.(projectRoot, text, fromDisk)
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** Strip runtime-only fields before persisting. */
export function sanitizeWorkspace(ws: Workspace): Workspace {
  return {
    version: 1,
    projectRoot: ws.projectRoot,
    viewport: ws.viewport,
    nodes: ws.nodes.map((n) => {
      const { status: _s, statusDetail: _d, lastAssistantMessage: _m, lastEventAt: _t, lastStopAt: _st, endedAt: _e, ptyAlive: _p, ...data } = n.data
      return { id: n.id, position: n.position, width: n.width, height: n.height, data }
    }),
    edges: ws.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: { ...e.data } })),
    ...(ws.tasks ? { tasks: ws.tasks, nextTaskId: ws.nextTaskId } : {})
  }
}

/**
 * Write the task ledger into the board file, keeping everything else in it. The renderer's own save goes
 * through saveWorkspace with the ledger injected by main, so the two writers never disagree about tasks.
 * A board file that cannot be parsed is left alone (loadWorkspace copies it aside on the next open).
 */
export function saveLedger(projectRoot: string, ledger: LedgerData): void {
  const file = join(projectRoot, WORKSPACE_FILE)
  let ws: Workspace = { version: 1, projectRoot, nodes: [], edges: [] }
  if (existsSync(file)) {
    try {
      ws = JSON.parse(readFileSync(file, 'utf8')) as Workspace
    } catch (err) {
      console.error(`[workspace] ${file} could not be read, ledger not written (${err instanceof Error ? err.message : String(err)})`)
      return
    }
  }
  // the cards come from the file as found: the trust record must not take them as the app's own
  writeBoard(projectRoot, JSON.stringify({ ...ws, tasks: ledger.tasks, nextTaskId: ledger.nextTaskId }, null, 2), true)
}

export function loadWorkspace(projectRoot: string): Workspace | null {
  return readWorkspace(projectRoot)?.workspace ?? null
}

/** The board and the exact text it was parsed from (the trust check hashes the same bytes it parsed). */
export function readWorkspace(projectRoot: string): { workspace: Workspace; text: string } | null {
  const file = join(projectRoot, WORKSPACE_FILE)
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as Workspace
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) throw new Error(`unsupported board file (version ${String(parsed.version)})`)
    parsed.projectRoot = projectRoot
    parsed.edges = Array.isArray(parsed.edges) ? parsed.edges : []
    return { workspace: parsed, text }
  } catch (err) {
    // an unreadable board (conflict markers, a hand edit, a newer format) would be overwritten by the empty
    // board the window starts with: keep a copy next to it first
    const copy = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      copyFileSync(file, copy)
    } catch {
      /* nothing more to do */
    }
    console.error(`[workspace] ${file} could not be read (${err instanceof Error ? err.message : String(err)}); copied to ${copy}`)
    return null
  }
}

export function saveWorkspace(ws: Workspace): void {
  writeBoard(ws.projectRoot, JSON.stringify(sanitizeWorkspace(ws), null, 2), false)
}

export class UserStore {
  constructor(private userData: string) {}

  private file(name: string): string {
    return join(this.userData, name)
  }

  getSettings(): AppSettings {
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(this.file('settings.json'), 'utf8')) as Partial<AppSettings>) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.getSettings(), ...patch }
    writeAtomic(this.file('settings.json'), JSON.stringify(next, null, 2))
    return next
  }

  getRecent(): string[] {
    try {
      const list = JSON.parse(readFileSync(this.file('recent.json'), 'utf8')) as string[]
      return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
    } catch {
      return []
    }
  }

  pushRecent(projectRoot: string): string[] {
    const list = [projectRoot, ...this.getRecent().filter((p) => p !== projectRoot)].slice(0, 10)
    writeAtomic(this.file('recent.json'), JSON.stringify(list, null, 2))
    return list
  }
}
