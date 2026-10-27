import { describe, expect, it } from 'vitest'
import { ORBIT_LIFT, orbitLayout, orbitLinks, project, sphere, wheelZoom } from '@shared/orbit'

describe('orbit', () => {
  it('spreads points on the unit sphere', () => {
    for (const n of [1, 2, 7, 40]) {
      const pts = sphere(n)
      expect(pts).toHaveLength(n)
      for (const p of pts) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 6)
    }
  })
  it('puts every card on the globe once, the Conductor facing the viewer', () => {
    const cards = [{ id: 'a' }, { id: 'c', conductor: true }, { id: 'b' }, { id: 'd' }]
    const pos = orbitLayout(cards)
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(Math.min(...Object.values(pos).map((p) => p.z))).toBe(pos.c.z)
    expect(new Set(Object.values(pos).map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(4)
    expect(orbitLayout([])).toEqual({})
  })
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
  it('projects the front of the globe to the centre, nearer points bigger', () => {
    const v = { rx: 0, ry: 0, zoom: 1, w: 800, h: 600 }
    const front = project({ x: 0, y: 0, z: -1 }, v)
    const back = project({ x: 0, y: 0, z: 1 }, v)
    expect(front.x).toBeCloseTo(400)
    expect(front.y).toBeCloseTo(300 - ORBIT_LIFT)
    expect(front.s).toBeGreaterThan(back.s)
    // a quarter turn brings the right side to the front
    expect(project({ x: 1, y: 0, z: 0 }, { ...v, ry: Math.PI / 2 }).z).toBeCloseTo(1)
    expect(project({ x: 1, y: 0, z: 0 }, { ...v, zoom: 2 }).x - 400).toBeCloseTo((project({ x: 1, y: 0, z: 0 }, v).x - 400) * 2)
  })
  it('zooms by wheel steps within a range', () => {
    expect(wheelZoom(1, 100)).toBeCloseTo(0.9)
    expect(wheelZoom(1, -100)).toBeCloseTo(1 / 0.9)
    expect(wheelZoom(0.5, 100)).toBe(0.5)
    expect(wheelZoom(4, -100)).toBe(4)
  })
})
