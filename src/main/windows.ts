/**
 * Registry of open windows. One window = one project (workspace) with its own Board.
 * Pure (no Electron) so it can be unit tested; the main process stores the BrowserWindow
 * inside the session object it registers.
 */
export interface SessionLike {
  /** webContents id of the window */
  id: number
  projectRoot: string
  hasNode(nodeId: string): boolean
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

export class SessionRegistry<S extends SessionLike> {
  private sessions = new Map<number, S>()
  /** focus history, most recent last */
  private order: number[] = []
  /** nodes bound to a window before its board has echoed them (pty spawn, api create) */
  private nodeOwner = new Map<string, number>()

  add(s: S): void {
    this.sessions.set(s.id, s)
    this.order.push(s.id)
  }

  remove(id: number): S | undefined {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    this.order = this.order.filter((x) => x !== id)
    for (const [n, owner] of this.nodeOwner) if (owner === id) this.nodeOwner.delete(n)
    return s
  }

  get(id: number | undefined): S | undefined {
    return id === undefined ? undefined : this.sessions.get(id)
  }

  /** Mark a window as the most recently used one. */
  touch(id: number): void {
    if (!this.sessions.has(id)) return
    this.order = this.order.filter((x) => x !== id)
    this.order.push(id)
  }

  all(): S[] {
    return [...this.sessions.values()]
  }

  get size(): number {
    return this.sessions.size
  }

  /** The most recently focused window (falls back to the oldest one). Target of unscoped API calls. */
  current(): S | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const s = this.sessions.get(this.order[i])
      if (s) return s
    }
    return undefined
  }

  bindNode(nodeId: string, sessionId: number): void {
    this.nodeOwner.set(nodeId, sessionId)
  }

  unbindNode(nodeId: string): void {
    this.nodeOwner.delete(nodeId)
  }

  /** The window whose board owns the card. */
  forNode(nodeId: string): S | undefined {
    const bound = this.sessions.get(this.nodeOwner.get(nodeId) ?? -1)
    if (bound) return bound
    for (const s of this.sessions.values()) if (s.hasNode(nodeId)) return s
    return undefined
  }

  forProject(root: string): S | undefined {
    if (!root) return undefined
    for (const s of this.sessions.values()) if (s.projectRoot && samePath(s.projectRoot, root)) return s
    return undefined
  }

  /**
   * The window whose project folder contains `cwd` (deepest match). The app's own worktrees,
   * `<project>-worktrees/<slug>` next to the project (see worktree.ts), count as the project.
   */
  forCwd(cwd: string): S | undefined {
    const c = normalizePath(cwd)
    let best: S | undefined
    let bestLen = -1
    for (const s of this.sessions.values()) {
      if (!s.projectRoot) continue
      const r = normalizePath(s.projectRoot)
      if ((c === r || c.startsWith(r + '/') || c.startsWith(r + '-worktrees/')) && r.length > bestLen) {
        best = s
        bestLen = r.length
      }
    }
    return best
  }

  /**
   * Where a session we did not launch belongs: only the window whose project contains its cwd, never a
   * fallback. `evict` is the window that showed it before and must drop it (the cwd no longer matches,
   * or a better window opened).
   */
  forExternal(cwd: string, knownId?: number): { target?: S; evict?: S } {
    const target = cwd ? this.forCwd(cwd) : undefined
    const known = this.get(knownId)
    return { target, evict: known && known !== target ? known : undefined }
  }
}
