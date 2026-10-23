/**
 * Card placement on the canvas. Pure: no DOM, no React Flow, so the rules are unit-tested.
 *
 * New cards go into the first free cell of a 4-column grid (the grid the board has always used), checked
 * against the real rectangles of the cards already there — a cell is free only when nothing overlaps it,
 * so a card that was resized or dragged onto a cell keeps new cards out of it. ⊞ Arrange re-flows every
 * card into neat rows: conductors first, then agent cards by title, then notes, then browsers.
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

const KIND_ORDER: Record<NodeKind, number> = { conductor: 0, claude: 1, terminal: 1, command: 1, note: 2, browser: 3, external: 4 }

/**
 * Re-flow cards into rows: conductors, then agent cards by title, then notes, then browsers.
 * Cards keep their sizes; a row wraps when it would pass the grid's width, and each row is as tall as its
 * tallest card, so nothing overlaps whatever sizes the cards have. Returns the new position per id.
 */
export function arrangeGrid(cards: ArrangeInput[]): Record<string, { x: number; y: number }> {
  const sorted = [...cards].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  const maxWidth = GRID.columns * (defaultSize('claude').width + GAP * 2) // four default cards per row
  const out: Record<string, { x: number; y: number }> = {}
  let x = GRID.originX
  let y = GRID.originY
  let rowHeight = 0
  for (const c of sorted) {
    if (x > GRID.originX && x + c.width > GRID.originX + maxWidth) {
      x = GRID.originX
      y += rowHeight + GAP * 2
      rowHeight = 0
    }
    out[c.id] = { x, y }
    x += c.width + GAP * 2
    rowHeight = Math.max(rowHeight, c.height)
  }
  return out
}
