import { describe, expect, it } from 'vitest'
import { GAP, GRID, arrangeBoard, defaultSize, placeNew, type ArrangeInput, type Rect } from '@shared/layout'

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

describe('arrangeBoard', () => {
  const c = (id: string, kind: ArrangeInput['kind'], title = id, size = defaultSize(kind)): ArrangeInput => ({ id, kind, title, ...size })
  const noOverlap = (cards: ArrangeInput[], pos: Record<string, { x: number; y: number }>): void => {
    const rects = cards.map((k) => ({ ...pos[k.id], width: k.width, height: k.height }))
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(touches(rects[i], rects[j])).toBe(false)
  }

  it('puts the workers left of the Conductor they report to, and the briefs and notes beside the Conductor', () => {
    const cards = [c('k', 'conductor', 'Conductor', { width: 560, height: 820 }), c('w1', 'claude', 'Implementer'), c('w2', 'claude', 'Reviewer'), c('b', 'browser', '📄 Briefs'), c('n', 'note', 'Pipeline')]
    const pos = arrangeBoard(cards, [{ source: 'w1', target: 'k' }, { source: 'w2', target: 'k' }])
    expect(pos.w1.x).toBe(GRID.originX)
    expect(pos.w2.x).toBe(GRID.originX)
    expect(pos.w2.y).toBeGreaterThan(pos.w1.y) // a lane fills top to bottom
    expect(pos.k.x).toBeGreaterThan(pos.w1.x + 560)
    expect(pos.b.x).toBeGreaterThan(pos.k.x + 560) // briefs right next to the Conductor
    expect(pos.n.x).toBe(pos.b.x) // notes share the side lane, after the browser cards
    expect(pos.n.y).toBeGreaterThan(pos.b.y)
    noOverlap(cards, pos)
  })

  it('follows a chain of lines lane by lane and survives a loop', () => {
    const cards = [c('a', 'claude'), c('b', 'claude'), c('d', 'claude'), c('k', 'conductor')]
    const pos = arrangeBoard(cards, [{ source: 'a', target: 'b' }, { source: 'b', target: 'd' }, { source: 'd', target: 'k' }, { source: 'k', target: 'a' }])
    expect(pos.a.x).toBeLessThan(pos.b.x)
    expect(pos.b.x).toBeLessThan(pos.d.x)
    expect(pos.d.x).toBeLessThan(pos.k.x)
    noOverlap(cards, pos)
  })

  it('keeps a lineless Conductor to the right of the agents, and lays a fresh board out without lines', () => {
    const cards = [c('k', 'conductor'), c('w', 'claude'), c('t', 'terminal')]
    const pos = arrangeBoard(cards, [])
    expect(pos.k.x).toBeGreaterThan(pos.w.x)
    expect(pos.k.x).toBeGreaterThan(pos.t.x)
    noOverlap(cards, pos)
    expect(arrangeBoard([c('k', 'conductor')], []).k).toEqual(cell(0, 0))
  })

  it('fills a big lane as a small grid, never overlaps mixed sizes, and is deterministic', () => {
    const workers = Array.from({ length: 12 }, (_, i) => c(`w${i}`, 'claude', `Worker ${String(i).padStart(2, '0')}`, { width: 560, height: 300 + (i % 3) * 120 }))
    const cards = [...workers, c('k', 'conductor', 'Conductor', { width: 900, height: 700 }), c('b', 'browser', 'Briefs'), c('n', 'note', 'Pipeline', { width: 320, height: 200 })]
    const edges = workers.map((w) => ({ source: w.id, target: 'k' }))
    const pos = arrangeBoard(cards, edges)
    const xs = new Set(workers.map((w) => pos[w.id].x))
    expect(xs.size).toBe(3) // 12 workers → 3 columns × 4 rows
    expect(Math.max(...workers.map((w) => pos[w.id].x)) + 560).toBeLessThan(pos.k.x)
    noOverlap(cards, pos)
    expect(arrangeBoard([...cards].reverse(), [...edges].reverse())).toEqual(pos)
  })
})
