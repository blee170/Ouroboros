/**
 * Card placement on the canvas. Pure: no DOM, no React Flow, so the rules are unit-tested.
 *
 * New cards go into the first free cell of a 4-column grid (the grid the board has always used), checked
 * against the real rectangles of the cards already there — a cell is free only when nothing overlaps it,
 * so a card that was resized or dragged onto a cell keeps new cards out of it. ⊞ Arrange lays every card
 * out in lanes along the lines (see arrangeBoard).
 */
import type { NodeKind } from './types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** Grid the board has used since 0.1: 4 columns, 600 × 440 pitch, 80 px origin. */
export const GRID = { originX: 80, originY: 80, pitchX: 600, pitchY: 440, columns: 4 } as const

/** Space kept between a new card and its neighbours (and between rows/columns when arranging). */
export const GAP = 24

/** Default card sizes per kind (the renderer's own defaults). */
export function defaultSize(kind: NodeKind): Size {
  if (kind === 'note') return { width: 300, height: 220 }
  if (kind === 'browser') return { width: 640, height: 480 }
  if (kind === 'external') return { width: 300, height: 130 }
  return { width: 560, height: 400 }
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return a.x < b.x + b.width + margin && a.x + a.width + margin > b.x && a.y < b.y + b.height + margin && a.y + a.height + margin > b.y
}

/**
 * First grid cell (row-major, from the origin) where a card of `size` does not overlap any of `occupied`.
 * Rows are unbounded, so a full board grows downwards instead of stacking copies.
 */
export function placeNew(occupied: Rect[], size: Size): { x: number; y: number } {
  for (let row = 0; row < 1000; row++) {
    for (let col = 0; col < GRID.columns; col++) {
      const x = GRID.originX + col * GRID.pitchX
      const y = GRID.originY + row * GRID.pitchY
      const candidate: Rect = { x, y, ...size }
      if (!occupied.some((r) => overlaps(candidate, r, GAP))) return { x, y }
    }
  }
  return { x: GRID.originX, y: GRID.originY }
}

export interface ArrangeInput extends Size {
  id: string
  kind: NodeKind
  title: string
}

export interface ArrangeEdge {
  source: string
  target: string
}

const AGENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['claude', 'conductor', 'terminal', 'command'])
/** Space between lanes, wider than the space between cards so the lanes read as lanes. */
const LANE_GAP = GAP * 3

/**
 * Lay the board out along its lines. Lines run out of a card's right port into the next card's left port,
 * so cards are put in lanes from left to right by how far down the lines they sit: cards nobody feeds in the
 * first lane, the Conductor that receives the report lines to their right, and the notes and browser cards
 * (briefs) in a last lane beside it. A lineless Conductor still goes to the right of the agents. Each lane
 * is a small grid filled top to bottom (four per column, at most 3 columns); cards keep their sizes and
 * nothing overlaps.
 * Returns the new position per id.
 */
export function arrangeBoard(cards: ArrangeInput[], edges: ArrangeEdge[]): Record<string, { x: number; y: number }> {
  const byTitle = (a: ArrangeInput, b: ArrangeInput): number => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
  const agents = cards.filter((c) => AGENT_KINDS.has(c.kind))
  const kind = new Map(agents.map((c) => [c.id, c.kind]))
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    if (!kind.has(e.source) || !kind.has(e.target) || e.source === e.target) continue
    // a Conductor's own lines to its workers are dispatches back up the chain: the reports decide the lanes
    if (kind.get(e.source) === 'conductor' && kind.get(e.target) !== 'conductor') continue
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source])
  }
  // longest path from the sources; a line back up the chain (a loop) is ignored rather than followed forever
  const lane = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const known = lane.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let d = 0
    for (const s of incoming.get(id) ?? []) d = Math.max(d, depth(s) + 1)
    visiting.delete(id)
    lane.set(id, d)
    return d
  }
  for (const a of agents) depth(a.id)
  const deepestWorker = Math.max(-1, ...agents.filter((a) => a.kind !== 'conductor').map((a) => lane.get(a.id) ?? 0))
  for (const a of agents) if (a.kind === 'conductor' && !(incoming.get(a.id) ?? []).length && agents.length > 1) lane.set(a.id, Math.max(lane.get(a.id) ?? 0, deepestWorker + 1))

  const lanes: ArrangeInput[][] = []
  for (const a of agents) (lanes[lane.get(a.id) ?? 0] ??= []).push(a)
  const side = cards.filter((c) => c.kind === 'browser' || c.kind === 'note').sort((a, b) => Number(a.kind === 'note') - Number(b.kind === 'note') || byTitle(a, b))
  const blocks = [...lanes.filter((l) => l?.length).map((l) => l.sort(byTitle)), ...(side.length ? [side] : [])]

  const out: Record<string, { x: number; y: number }> = {}
  let x = GRID.originX
  for (const block of blocks) {
    // a lane fills top to bottom, four cards per column, up to three columns
    const cols = Math.min(3, Math.ceil(block.length / 4))
    const rows = Math.ceil(block.length / cols)
    const colWidth = new Array<number>(cols).fill(0)
    const rowHeight = new Array<number>(rows).fill(0)
    block.forEach((c, i) => {
      colWidth[Math.floor(i / rows)] = Math.max(colWidth[Math.floor(i / rows)], c.width)
      rowHeight[i % rows] = Math.max(rowHeight[i % rows], c.height)
    })
    block.forEach((c, i) => {
      const col = Math.floor(i / rows)
      const row = i % rows
      out[c.id] = {
        x: x + colWidth.slice(0, col).reduce((s, w) => s + w + GAP * 2, 0),
        y: GRID.originY + rowHeight.slice(0, row).reduce((s, h) => s + h + GAP * 2, 0)
      }
    })
    x += colWidth.reduce((s, w) => s + w, 0) + (cols - 1) * GAP * 2 + LANE_GAP
  }
  return out
}
