import { describe, expect, it } from 'vitest'
import {
  BASE_RING,
  COLUMN_MIN,
  CORE,
  FRONT,
  MAX_TIER,
  ORBIT_INNER,
  ORBIT_LIFT,
  ORBIT_OUTER,
  SHELL_SPREAD,
  baseRing,
  cardTasks,
  circle,
  column,
  columnLength,
  contextFill,
  onShell,
  orbitLayout,
  orbitLinks,
  orbitTiers,
  project,
  recency,
  scatter,
  shellArc,
  sparkleHeight,
  tierRadius,
  wheelZoom
} from '@shared/orbit'
import type { Task } from '@shared/ledger'

const len = (p: { x: number; y: number; z: number }): number => Math.hypot(p.x, p.y, p.z)
const task = (id: string, state: Task['state'], owner?: string): Task => ({ id, title: id, state, owner, deps: [], createdBy: 'owner', createdAt: 0, updatedAt: 0 })

describe('orbit tiers', () => {
  it('counts hops from the Conductor; roots, missing parents, cycles and a second Conductor start at 1', () => {
    const cards = [
      { id: 'c', conductor: true },
      { id: 'lead', parentId: 'c' },
      { id: 'w', parentId: 'lead' },
      { id: 'solo' },
      { id: 'orphan', parentId: 'gone' },
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
      { id: 'c2', conductor: true, parentId: 'c' },
      { id: 'under-c2', parentId: 'c2' },
      { id: 'self', parentId: 'self' }
    ]
    const { hub, depth } = orbitTiers(cards)
    expect(hub).toBe('c')
    expect(depth).toEqual({ c: 0, lead: 1, w: 2, solo: 1, orphan: 1, x: 1, y: 2, c2: 1, 'under-c2': 2, self: 1 })
  })
  it('caps a long chain at MAX_TIER', () => {
    const cards = [{ id: 'c', conductor: true }]
    for (let i = 1; i <= 10; i++) cards.push({ id: `n${i}`, parentId: i === 1 ? 'c' : `n${i - 1}` } as never)
    expect(orbitTiers(cards).depth.n10).toBe(MAX_TIER)
    expect(orbitTiers([]).hub).toBeUndefined()
  })
  it('spaces the shells evenly from the inner one to the outer one', () => {
    expect(tierRadius(1, 1)).toBeCloseTo(ORBIT_INNER)
    expect(tierRadius(1, 3)).toBeCloseTo(ORBIT_INNER)
    expect(tierRadius(2, 3)).toBeCloseTo((ORBIT_INNER + ORBIT_OUTER) / 2)
    expect(tierRadius(3, 3)).toBeCloseTo(ORBIT_OUTER)
    expect(tierRadius(9, 3)).toBeCloseTo(ORBIT_OUTER) // never further out
    expect(tierRadius(1, 0)).toBeCloseTo(ORBIT_INNER)
    expect(ORBIT_OUTER).toBeLessThan(1)
  })
})

describe('orbit layout', () => {
  it('puts the Conductor at the core and every other card on its tier shell, once each', () => {
    const cards = [{ id: 'a', parentId: 'c' }, { id: 'c', conductor: true }, { id: 'b', parentId: 'c' }, { id: 'd', parentId: 'a' }]
    const pos = orbitLayout(cards)
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(pos.c).toEqual(CORE)
    expect(new Set(Object.values(pos).map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`)).size).toBe(4)
    // tier 1 on the inner shell, tier 2 on the outer
    expect(len(pos.a)).toBeCloseTo(ORBIT_INNER)
    expect(len(pos.b)).toBeCloseTo(ORBIT_INNER)
    expect(len(pos.d)).toBeCloseTo(ORBIT_OUTER)
    expect(orbitLayout([])).toEqual({})
  })
  it('spreads a shell in height: the first card high, the last low, a lone card level', () => {
    const cards = [{ id: 'c', conductor: true }, ...['p', 'q', 'r', 's'].map((id) => ({ id, parentId: 'c' }))]
    const pos = orbitLayout(cards)
    expect(pos.p.y).toBeLessThan(pos.q.y)
    expect(pos.q.y).toBeLessThan(pos.r.y)
    expect(pos.r.y).toBeLessThan(pos.s.y)
    expect(pos.p.y).toBeCloseTo(-pos.s.y)
    expect(Math.abs(pos.p.y)).toBeLessThanOrEqual(ORBIT_INNER * SHELL_SPREAD + 1e-9)
    const one = orbitLayout([{ id: 'w' }])
    expect(one.w.y).toBe(0)
    expect(one.w.z).toBeCloseTo(-ORBIT_INNER) // in front
    expect(orbitLayout([{ id: 'c', conductor: true }])).toEqual({ c: CORE })
    expect(onShell(2, FRONT, 1)).toEqual({ x: expect.closeTo(0, 9), y: -2 * SHELL_SPREAD, z: expect.closeTo(-2 * Math.sqrt(1 - SHELL_SPREAD ** 2), 9) })
    expect(len(onShell(0.7, 1, 5))).toBeCloseTo(0.7) // h is clamped, the point stays on the shell
  })
  it('keeps a lead and its workers together on a shell, same roles side by side, in a stable order', () => {
    const cards = [
      { id: 'c', conductor: true },
      { id: 'l1', parentId: 'c' },
      { id: 'l2', parentId: 'c' },
      { id: 'w2a', parentId: 'l2', role: 'engineering-backend' },
      { id: 'w1a', parentId: 'l1', role: 'marketing-copy' },
      { id: 'w2b', parentId: 'l2', role: 'engineering-frontend' },
      { id: 'w1b', parentId: 'l1', role: 'engineering-backend' }
    ]
    const pos = orbitLayout(cards)
    const angle = (id: string): number => Math.atan2(pos[id].z, pos[id].x)
    const apart = (p: string, q: string): number => Math.abs(((angle(p) - angle(q) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
    // two leads: l1 faces the viewer with the front half of the circle, l2 has the back half
    expect(angle('l1')).toBeCloseTo(FRONT)
    expect(apart('l1', 'l2')).toBeCloseTo(Math.PI)
    // each lead's workers sit in its half, roles sorted, so a team is one direction out from the core
    for (const w of ['w1a', 'w1b']) expect(apart(w, 'l1')).toBeLessThan(Math.PI / 2)
    for (const w of ['w2a', 'w2b']) expect(apart(w, 'l2')).toBeLessThan(Math.PI / 2)
    expect(((angle('w1a') - angle('w1b') + 3 * Math.PI) % (2 * Math.PI)) - Math.PI).toBeGreaterThan(0) // engineering before marketing, round the same way
    // nothing moves when a status changes (the layout only reads ids, parents and roles)
    expect(orbitLayout(cards.map((c) => ({ ...c })))).toEqual(pos)
    // on the first shell too, where every card is its own root: same roles side by side
    const flat = orbitLayout([
      { id: 'c', conductor: true },
      { id: 'a', parentId: 'c', role: 'engineering-backend' },
      { id: 'b', parentId: 'c', role: 'marketing-copy' },
      { id: 'd', parentId: 'c', role: 'engineering-backend' },
      { id: 'e', parentId: 'c', role: 'marketing-copy' }
    ])
    const flatAngle = (id: string): number => Math.atan2(flat[id].z, flat[id].x)
    const flatApart = (p: string, q: string): number => Math.abs(((flatAngle(p) - flatAngle(q) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
    expect(flatApart('a', 'd')).toBeCloseTo(Math.PI / 2)
    expect(flatApart('b', 'e')).toBeCloseTo(Math.PI / 2)
    expect(flatApart('a', 'b')).toBeCloseTo(Math.PI)
  })
})

describe('orbit links', () => {
  it('joins cards by handoff lines and dispatch links, once each; with neither, every card to the Conductor', () => {
    const cards = [{ id: 'c', conductor: true }, { id: 'w1', parentId: 'c' }, { id: 'w2' }]
    expect(orbitLinks(cards, [{ id: 'e1', source: 'w1', target: 'w2' }, { id: 'e2', source: 'w2', target: 'w1' }, { id: 'e3', source: 'w1', target: 'gone' }])).toEqual([
      { from: 'w1', to: 'w2', kind: 'handoff', edgeId: 'e1' },
      { from: 'c', to: 'w1', kind: 'parent' }
    ])
    expect(orbitLinks([{ id: 'c', conductor: true }, { id: 'x' }, { id: 'y' }], [])).toEqual([
      { from: 'c', to: 'x', kind: 'hub' },
      { from: 'c', to: 'y', kind: 'hub' }
    ])
    expect(orbitLinks([{ id: 'x' }, { id: 'y' }], [])).toEqual([])
  })
})

describe('orbit lines and ring', () => {
  const a = onShell(ORBIT_INNER, FRONT, 0.5)
  const b = onShell(ORBIT_OUTER, FRONT + Math.PI / 2, -0.5)
  it('runs straight from the core, and follows the shells between two cards', () => {
    const spoke = shellArc(CORE, a, 4)
    expect(spoke).toHaveLength(5)
    expect(spoke[0]).toEqual(CORE)
    expect(spoke[4]).toEqual(a)
    expect(spoke[2].y).toBeCloseTo(a.y / 2)
    expect(spoke[2].z).toBeCloseTo(a.z / 2)
    const arc = shellArc(a, b, 8)
    expect(arc).toHaveLength(9)
    expect(arc[0]).toEqual(a)
    expect(arc[8].x).toBeCloseTo(b.x)
    expect(arc[8].z).toBeCloseTo(b.z)
    // the radius slides from a's to b's, so the middle sits between the shells, not on the chord
    expect(len(arc[4])).toBeCloseTo((ORBIT_INNER + ORBIT_OUTER) / 2)
    expect(len(arc[4])).toBeGreaterThan(len({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }))
    // two cards on one shell: the arc stays on it
    const c = onShell(ORBIT_INNER, FRONT + 1, 0.5)
    for (const p of shellArc(a, c, 6)) expect(len(p)).toBeCloseTo(ORBIT_INNER)
    expect(shellArc(a, a, 2)).toEqual([a, a, a])
    // opposite ends (two leads under the Conductor): round the shell, never through the core
    const opp = shellArc(a, { x: -a.x, y: -a.y, z: -a.z }, 4)
    expect(opp[0]).toEqual(a)
    expect(opp[4]).toEqual({ x: -a.x, y: -a.y, z: -a.z })
    for (const p of opp) expect(len(p)).toBeCloseTo(ORBIT_INNER)
    // and between shells the radius still slides
    const far = shellArc(a, { x: -2 * a.x, y: -2 * a.y, z: -2 * a.z }, 4)
    expect(len(far[2])).toBeCloseTo(1.5 * ORBIT_INNER)
  })
  it('draws circles and arcs of them in the plane through the core', () => {
    const quarter = circle(2, 4, 0, Math.PI / 2)
    expect(quarter).toHaveLength(5)
    expect(quarter[0]).toEqual(onShell(2, FRONT))
    expect(quarter[4].x).toBeCloseTo(2)
    for (const p of circle(1, 12)) {
      expect(p.y).toBe(0)
      expect(len(p)).toBeCloseTo(1)
    }
    expect(BASE_RING).toBeGreaterThan(ORBIT_OUTER)
  })
  it('scatters the dust over the whole sphere, the same every time', () => {
    const pts = scatter(40)
    expect(pts).toHaveLength(40)
    for (const p of pts) expect(len(p)).toBeCloseTo(1, 6)
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(-0.9)
    expect(Math.max(...pts.map((p) => p.y))).toBeGreaterThan(0.9)
    expect(scatter(40)).toEqual(pts)
    expect(scatter(1)).toEqual([{ x: 1, y: 0, z: 0 }])
  })
})

describe('orbit columns, tasks and task ring', () => {
  it('reads context fill against the fresh-start line', () => {
    expect(contextFill(undefined, undefined)).toBeNull()
    expect(contextFill({ contextTokens: 125_000, contextWindow: 200_000 }, undefined)).toBeCloseTo(125_000 / 120_000) // 60% of the window caps the 250k default
    expect(contextFill({ contextTokens: 100_000, contextWindow: 1_000_000 }, 200_000)).toBeCloseTo(0.5)
    expect(contextFill({ contextTokens: 100_000, contextWindow: 1_000_000 }, 10)).toBeCloseTo(0.4) // a bad setting falls back to the default
    expect(contextFill({ contextTokens: NaN, contextWindow: 200_000 }, undefined)).toBeNull()
    expect(contextFill({ contextTokens: 0, contextWindow: 0 }, undefined)).toBe(0)
  })
  it('sizes a column by fill, never shorter than its sparkles', () => {
    expect(columnLength(null, 0)).toBe(0)
    expect(columnLength(0, 0)).toBeCloseTo(0.06)
    expect(columnLength(2, 0)).toBeCloseTo(0.36)
    expect(columnLength(null, 3)).toBeCloseTo(0.21)
    expect(columnLength(0.1, 6)).toBeCloseTo(0.36)
    expect(columnLength(null, 40)).toBeCloseTo(0.36)
    expect(sparkleHeight(1)).toBeGreaterThan(COLUMN_MIN / 2)
    expect(sparkleHeight(6)).toBeLessThan(columnLength(null, 6))
    const [foot, tip] = column({ x: 0.3, y: 0, z: -0.9 }, 0.2)
    expect(foot).toEqual({ x: 0.3, y: 0, z: -0.9 })
    expect(tip).toEqual({ x: 0.3, y: -0.2, z: -0.9 })
  })
  it('counts the doing and blocked tasks a card owns', () => {
    const tasks = [task('T1', 'doing', 'a'), task('T2', 'blocked', 'a'), task('T3', 'doing', 'b'), task('T4', 'done'), task('T5', 'todo')]
    expect(cardTasks(tasks, 'a')).toEqual({ doing: 1, blocked: 1 })
    expect(cardTasks(tasks, 'zz')).toEqual({ doing: 0, blocked: 0 })
  })
  it('splits the task ring by state, round from the front, dropped tasks left out', () => {
    expect(baseRing({ todo: 0, doing: 0, blocked: 0, done: 0, dropped: 3 })).toEqual([])
    const segs = baseRing({ todo: 1, doing: 1, blocked: 0, done: 2, dropped: 5 })
    expect(segs.map((s) => s.state)).toEqual(['done', 'doing', 'todo'])
    expect(segs[0].from).toBeCloseTo(FRONT)
    expect(segs[0].to - segs[0].from).toBeCloseTo(Math.PI)
    expect(segs[2].to).toBeCloseTo(FRONT + 2 * Math.PI)
  })
  it('fades recency over half an hour', () => {
    expect(recency(undefined, 1000)).toBe(0)
    expect(recency(1000, 1000)).toBe(1)
    expect(recency(1000, 1000 + 15 * 60_000)).toBeCloseTo(0.5)
    expect(recency(1000, 1000 + 60 * 60_000)).toBe(0)
    expect(recency(0, 1000)).toBe(0)
    expect(recency(5000, 1000)).toBe(1)
  })
})

describe('orbit view', () => {
  it('projects the front to the centre, nearer points bigger', () => {
    const v = { rx: 0, ry: 0, zoom: 1, w: 800, h: 600 }
    const front = project({ x: 0, y: 0, z: -1 }, v)
    const back = project({ x: 0, y: 0, z: 1 }, v)
    expect(front.x).toBeCloseTo(400)
    expect(front.y).toBeCloseTo(300 - ORBIT_LIFT)
    expect(front.s).toBeGreaterThan(back.s)
    // a quarter turn brings the right side to the front
    expect(project({ x: 1, y: 0, z: 0 }, { ...v, ry: Math.PI / 2 }).z).toBeCloseTo(1)
    expect(project({ x: 1, y: 0, z: 0 }, { ...v, zoom: 2 }).x - 400).toBeCloseTo((project({ x: 1, y: 0, z: 0 }, v).x - 400) * 2)
    // up is up: a point above the plane lands above the centre
    expect(project({ x: 0, y: -1, z: 0 }, v).y).toBeLessThan(300 - ORBIT_LIFT)
    // the task ring fits a narrow box
    const narrow = { ...v, w: 400, h: 900 }
    expect(project({ x: BASE_RING, y: 0, z: 0 }, narrow).x).toBeLessThan(400)
    expect(project({ x: 0, y: 0, z: -1 }, { ...v, w: 1, h: 1 }).s).toBeGreaterThan(0) // never NaN for a tiny box
  })
  it('zooms by wheel steps within a range', () => {
    expect(wheelZoom(1, 100)).toBeCloseTo(0.9)
    expect(wheelZoom(1, -100)).toBeCloseTo(1 / 0.9)
    expect(wheelZoom(0.5, 100)).toBe(0.5)
    expect(wheelZoom(4, -100)).toBe(4)
  })
})
