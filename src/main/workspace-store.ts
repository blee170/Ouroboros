import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, Workspace } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

export const WORKSPACE_FILE = '.ouroboros.json'

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
      const { status: _s, statusDetail: _d, lastAssistantMessage: _m, lastEventAt: _t, ptyAlive: _p, ...data } = n.data
      return { id: n.id, position: n.position, width: n.width, height: n.height, data }
    }),
    edges: ws.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: { ...e.data } }))
  }
}

export function loadWorkspace(projectRoot: string): Workspace | null {
  const file = join(projectRoot, WORKSPACE_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Workspace
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return null
    parsed.projectRoot = projectRoot
    parsed.edges = Array.isArray(parsed.edges) ? parsed.edges : []
    return parsed
  } catch {
    return null
  }
}

export function saveWorkspace(ws: Workspace): void {
  writeAtomic(join(ws.projectRoot, WORKSPACE_FILE), JSON.stringify(sanitizeWorkspace(ws), null, 2))
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
