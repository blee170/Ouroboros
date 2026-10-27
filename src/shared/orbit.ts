/**
 * Orbit: the board as a turning globe, every card a dot on it and its lines drawn across it (the phone page's Orbit
 * view, on the desktop). Pure: where each card sits, which lines join them, and where a point lands on screen for a
 * turn and a zoom. The view draws it.
 */

export interface OrbitPoint {
  x: number
  y: number
  z: number
}

export interface OrbitCard {
  id: string
  conductor?: boolean
  parentId?: string
}

export interface OrbitLink {
  from: string
  to: string
  /** a handoff line on the canvas, a card and the one that dispatched it, or (a board with neither) a card and the Conductor */
  kind: 'handoff' | 'parent' | 'hub'
  /** the handoff line's id (to light it while its target works on what it sent) */
  edgeId?: string
}

/** Evenly spread points on a unit sphere (a Fibonacci lattice). */
export function sphere(n: number): OrbitPoint[] {
  const out: OrbitPoint[] = []
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const t = i * 2.399963
    out.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r })
  }
  return out
}

/** Every card's place on the globe, in board order; the (first) Conductor faces the viewer. */
export function orbitLayout(cards: OrbitCard[]): Record<string, OrbitPoint> {
  const pos: Record<string, OrbitPoint> = {}
  const pts = sphere(cards.length)
  const hub = cards.find((c) => c.conductor)
  if (hub && pts.length) {
    let front = 0
    pts.forEach((p, i) => {
      if (p.z < pts[front].z) front = i
    })
    pos[hub.id] = pts.splice(front, 1)[0]
  }
  let i = 0
  for (const c of cards) if (c !== hub) pos[c.id] = pts[i++]
  return pos
}

/** The lines between cards on the board: handoff lines and dispatch (parent) links; with neither, every card to the Conductor. */
export function orbitLinks(cards: OrbitCard[], edges: Array<{ id: string; source: string; target: string }>): OrbitLink[] {
  const ids = new Set(cards.map((c) => c.id))
  const out: OrbitLink[] = []
  const seen = new Set<string>()
  const add = (l: OrbitLink): void => {
    const key = [l.from, l.to].sort().join('\0')
    if (l.from === l.to || !ids.has(l.from) || !ids.has(l.to) || seen.has(key)) return
    seen.add(key)
    out.push(l)
  }
  for (const e of edges) add({ from: e.source, to: e.target, kind: 'handoff', edgeId: e.id })
  for (const c of cards) if (c.parentId) add({ from: c.parentId, to: c.id, kind: 'parent' })
  if (!out.length) {
    const hub = cards.find((c) => c.conductor)
    if (hub) for (const c of cards) if (c !== hub) add({ from: hub.id, to: c.id, kind: 'hub' })
  }
  return out
}

/** The view: turned rx (tilt, radians) then ry (spin), zoomed, centred in a w×h box a little above the middle (the controls sit at the bottom). */
export interface OrbitView {
  rx: number
  ry: number
  zoom: number
  w: number
  h: number
}

/** how far above the middle the globe sits (px) */
export const ORBIT_LIFT = 24

/** Where a globe point lands on screen; s is its perspective scale, z its depth (negative = towards the viewer). */
export function project(p: OrbitPoint, v: OrbitView): { x: number; y: number; s: number; z: number } {
  const cy = Math.cos(v.ry)
  const sy = Math.sin(v.ry)
  const x1 = p.x * cy - p.z * sy
  const z1 = p.x * sy + p.z * cy
  const cx = Math.cos(v.rx)
  const sx = Math.sin(v.rx)
  const y2 = p.y * cx - z1 * sx
  const z2 = p.y * sx + z1 * cx
  const persp = 3.2 / (3.2 + z2)
  const scale = Math.max(40, Math.min(v.w, v.h) / 2 - 90) * v.zoom
  return { x: v.w / 2 + x1 * scale * persp, y: v.h / 2 - ORBIT_LIFT + y2 * scale * persp, s: persp, z: z2 }
}

/** The zoom after one wheel step (deltaY > 0 zooms out), kept in a range where the globe stays usable. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return Math.max(0.5, Math.min(4, zoom * (deltaY > 0 ? 0.9 : 1 / 0.9)))
}
