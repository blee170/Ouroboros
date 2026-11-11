/**
 * A window whose page loads again while main still runs its cards (its renderer died and main reloaded it, or the
 * tray's Reload window): the page takes the board from main and reattaches to the running cards. Launching them, as a
 * plain open does, would replace every process. Pure, so the rules are unit-tested.
 */
import { defaultSize, placeNew, type Rect } from './layout'
import type { NodeData, Workspace, WorkspaceEdge, WorkspaceNode } from './types'

/** Automatic reloads of one window after its renderer died: at most RELOAD_LIMIT in RELOAD_WINDOW_MS. */
export const RELOAD_LIMIT = 3
export const RELOAD_WINDOW_MS = 5 * 60_000

/** A page that dies again as soon as it loads would be reloaded forever: past the limit the window is left down. */
export class ReloadGuard {
  private times: number[] = []

  /** May the window be reloaded now? A reload that may is counted. */
  allow(now: number): boolean {
    this.times = this.times.filter((t) => now - t < RELOAD_WINDOW_MS)
    if (this.times.length >= RELOAD_LIMIT) return false
    this.times.push(now)
    return true
  }
}

/** A card as main's Board holds it (`pos` is its centre, as the renderer last synced it). */
export interface LiveNode {
  id: string
  data: NodeData
  pos?: { x: number; y: number }
}

/**
 * What a reloaded window opens with: main's cards and lines (main has every card, the ones the Conductor made after
 * the last save included, and their runtime state), laid out where the board file has them. A card the file does not
 * have yet goes where the renderer last had it, else into the first free grid cell. `live`: the cards whose process
 * is running, to reattach to (an asleep card has none). The viewport is the file's.
 */
export function reattachWorkspace(projectRoot: string, nodes: Iterable<LiveNode>, edges: WorkspaceEdge[], alive: (id: string) => boolean, file: Workspace | null): { workspace: Workspace; live: string[] } {
  const saved = new Map((file?.nodes ?? []).map((n) => [n.id, n]))
  const out: (WorkspaceNode & { placed: boolean })[] = []
  const live: string[] = []
  for (const n of nodes) {
    const running = alive(n.id) && !n.data.asleep
    if (running) live.push(n.id)
    // a running card's state is main's (a card with no event yet is up, as Board.snapshot says)
    const data: NodeData = running ? { ...n.data, status: n.data.status ?? 'idle' } : { ...n.data }
    const f = saved.get(n.id)
    const size = defaultSize(n.data.kind)
    if (f) out.push({ id: n.id, position: { ...f.position }, width: f.width, height: f.height, data, placed: true })
    else if (n.pos) out.push({ id: n.id, position: { x: Math.round(n.pos.x - size.width / 2), y: Math.round(n.pos.y - size.height / 2) }, ...size, data, placed: true })
    else out.push({ id: n.id, position: { x: 0, y: 0 }, ...size, data, placed: false })
  }
  const rect = (n: WorkspaceNode): Rect => ({ ...n.position, width: n.width ?? defaultSize(n.data.kind).width, height: n.height ?? defaultSize(n.data.kind).height })
  const occupied = out.filter((n) => n.placed).map(rect)
  for (const n of out) {
    if (n.placed) continue
    n.position = placeNew(occupied, defaultSize(n.data.kind))
    occupied.push(rect(n))
  }
  return {
    workspace: {
      version: 1,
      projectRoot,
      viewport: file?.viewport,
      nodes: out.map(({ placed: _p, ...n }) => n),
      edges: edges.map((e) => ({ ...e, data: { ...e.data } }))
    },
    live
  }
}

/**
 * A terminal's keystroke forwarder that a repaint can silence. A replayed output buffer holds the queries the CLI and
 * ConPTY sent at their start (ConPTY's own DA1 `ESC [ c`, cursor position, DECRQM, colour queries): xterm answers each
 * again while it parses the replay, and forwarded, those answers would be typed into the running process. xterm calls
 * a write's callback once that data is parsed (in order), so live output written after it is answered as usual.
 * Keys typed while the replay is parsed are dropped with them.
 */
export function replayInput(send: (data: string) => void): {
  input(data: string): void
  replay(term: { write(data: string, parsed: () => void): void }, data: string, done: () => void): void
} {
  let replaying = false
  return {
    input: (data) => {
      if (!replaying) send(data)
    },
    replay: (term, data, done) => {
      replaying = true
      term.write(data, () => {
        replaying = false
        done()
      })
    }
  }
}

/**
 * A card's launch effect: the first launch of a card main still runs attaches to that process (its terminal is
 * repainted, nothing is killed or started); an asleep card waits for its wake; anything else spawns, as on a plain open.
 */
export function launchMode(o: { first: boolean; live: boolean; asleep: boolean }): 'attach' | 'spawn' | 'wait' {
  if (o.first && o.live) return 'attach'
  if (o.asleep) return 'wait'
  return 'spawn'
}
