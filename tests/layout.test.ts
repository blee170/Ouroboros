import { describe, expect, it } from 'vitest'
import { GAP, GRID, arrangeGrid, defaultSize, placeNew, type ArrangeInput, type Rect } from '@shared/layout'

const cell = (col: number, row: number): { x: number; y: number } => ({ x: GRID.originX + col * GRID.pitchX, y: GRID.originY + row * GRID.pitchY })
const card = (col: number, row: number, size = defaultSize('claude')): Rect => ({ ...cell(col, row), ...size })
const touches = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

describe('placeNew', () => {
  it('fills the grid row-major and skips occupied cells', () => {
    expect(placeNew([], defaultSize('claude'))).toEqual(cell(0, 0))
    expect(placeNew([card(0, 0)], defaultSize('claude'))).toEqual(cell(1, 0))
    expect(placeNew([card(0, 0), card(1, 0), card(2, 0), card(3, 0)], defaultSize('claude'))).toEqual(cell(0, 1))
  })

  it('reuses a cell freed by a closed card instead of counting cards', () => {
    // three cards, the middle one gone: the count-based formula would land on cell 3 and leave cell 1 empty
    expect(placeNew([card(0, 0), card(2, 0)], defaultSize('claude'))).toEqual(cell(1, 0))
  })

  it('treats a cell as taken when a resized or dragged card reaches into it', () => {
    const wide: Rect = { ...cell(0, 0), width: 1100, height: 400 } // spans cells 0 and 1
    expect(placeNew([wide], defaultSize('claude'))).toEqual(cell(2, 0))
    const dragged: Rect = { x: cell(1, 0).x - 100, y: cell(0, 0).y + 300, width: 560, height: 400 } // sits across rows 0 and 1
    const p = placeNew([dragged], defaultSize('claude'))
    expect(touches({ ...p, ...defaultSize('claude') }, dragged)).toBe(false)
  })

  it('keeps a gap: a card ending right at the next cell still blocks it', () => {
    const almost: Rect = { ...cell(0, 0), width: GRID.pitchX - GAP / 2, height: 400 }
    expect(placeNew([almost], defaultSize('claude'))).toEqual(cell(2, 0))
  })

  it('never overlaps whatever is on the board (random boards)', () => {
    let seed = 7
    const rnd = (): number => ((seed = (seed * 48271) % 2147483647) / 2147483647)
    for (let round = 0; round < 50; round++) {
      const occupied: Rect[] = []
      for (let i = 0; i < 12; i++) occupied.push({ x: Math.floor(rnd() * 2400), y: Math.floor(rnd() * 1600), width: 300 + Math.floor(rnd() * 700), height: 150 + Math.floor(rnd() * 500) })
      const size = { width: 300 + Math.floor(rnd() * 400), height: 200 + Math.floor(rnd() * 300) }
      const p = placeNew(occupied, size)
      for (const r of occupied) expect(touches({ ...p, ...size }, r)).toBe(false)
    }
  })
})

describe('arrangeGrid', () => {
  const c = (id: string, kind: ArrangeInput['kind'], title: string, size = defaultSize(kind)): ArrangeInput => ({ id, kind, title, ...size })

  it('orders conductors, then agents by title, then notes, then browsers, in rows from the origin', () => {
    const pos = arrangeGrid([c('n', 'note', 'Pipeline'), c('b', 'claude', 'Bravo'), c('w', 'browser', 'Briefs'), c('a', 'claude', 'Alpha'), c('k', 'conductor', 'Conductor'), c('t', 'terminal', 'Shell')])
    expect(pos.k).toEqual(cell(0, 0))
    expect(pos.a.x).toBeGreaterThan(pos.k.x)
    expect(pos.b.x).toBeGreaterThan(pos.a.x)
    expect(pos.t.x).toBeGreaterThan(pos.b.x)
    expect(pos.a.y).toBe(pos.k.y)
    // the fifth card wraps to a second row, which starts below the tallest card of the first
    expect(pos.n.y).toBeGreaterThanOrEqual(pos.k.y + 400 + GAP)
    expect(pos.n.x).toBe(GRID.originX)
    expect(pos.w.x).toBeGreaterThan(pos.n.x)
  })

  it('never overlaps cards of mixed sizes and is deterministic', () => {
    const cards = [c('1', 'claude', 'A', { width: 900, height: 700 }), c('2', 'claude', 'B'), c('3', 'claude', 'C', { width: 320, height: 200 }), c('4', 'note', 'N'), c('5', 'browser', 'W'), c('6', 'conductor', 'K', { width: 560, height: 820 }), c('7', 'command', 'Z')]
    const pos = arrangeGrid(cards)
    const rects = cards.map((k) => ({ ...pos[k.id], width: k.width, height: k.height }))
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(touches(rects[i], rects[j])).toBe(false)
    expect(arrangeGrid([...cards].reverse())).toEqual(pos)
  })
})
