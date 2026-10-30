/**
 * Orbit: the board as a constellation round its Conductor (the desktop's Orbit view). The Conductor is the core;
 * every card it dispatched sits on a shell round it by its tier (how many hops from the Conductor), the nearest
 * shell the most important, and spread over its shell in a slow helix so no two sit at one height. Lines from
 * the core are straight; lines between cards follow the shells as arcs. From each card a vertical column rises
 * with its context use; the sparkles on it are the tasks it still owns; the thin ring round everything is the
 * board's task progress. Pure: where things sit and where a point lands on screen for a turn and a zoom. The
 * view draws it.
 */
import { relaySettings, relayThreshold } from './relay'
import type { Task, TaskCounts } from './ledger'

export interface OrbitPoint {
  x: number
  y: number
  z: number
}

export interface OrbitCard {
  id: string
  conductor?: boolean
  parentId?: string
  /** specialist role id (agency ids start with their division): same-role cards sit side by side on a shell */
  role?: string
}

export interface OrbitLink {
  from: string
  to: string
  /** a handoff line on the canvas, a card and the one that dispatched it, or (a board with neither) a card and the Conductor */
  kind: 'handoff' | 'parent' | 'hub'
  /** the handoff line's id (to light it while its target works on what it sent) */
  edgeId?: string
}

/** the Conductor's place */
export const CORE: OrbitPoint = { x: 0, y: 0, z: 0 }
/** the shells: tier 1 nearest the core, the deepest tier the widest */
export const ORBIT_INNER = 0.42
export const ORBIT_OUTER = 0.9
/** how far up and down a shell its cards spread (1 would reach the poles) */
export const SHELL_SPREAD = 0.72
/** the angle round the core that faces the viewer at ry = 0 (z = -1); screen y is down, so up is y < 0 */
export const FRONT = -Math.PI / 2
/** the default tilt: the viewer looks down a little */
export const ORBIT_TILT = 0.4
/** a dispatch chain deeper than this shares the outer shell */
export const MAX_TIER = 6

/**
 * Every card's tier: the (first) Conductor 0, a card it dispatched 1, that card's workers 2, and so on. A card with
 * no parent on the board, a second Conductor, or a card in a parent cycle is a root of its own at tier 1.
 */
export function orbitTiers(cards: OrbitCard[]): { hub?: string; depth: Record<string, number> } {
  const hub = cards.find((c) => c.conductor)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const depth: Record<string, number> = {}
  const tierOf = (c: OrbitCard, seen: Set<string>): number => {
    if (c.id in depth) return depth[c.id]
    let d = 1
    if (c === hub) d = 0
    else if (!c.conductor && c.parentId && c.parentId !== c.id && !seen.has(c.id)) {
      const parent = byId.get(c.parentId)
      if (parent) {
        seen.add(c.id)
        d = Math.min(MAX_TIER, tierOf(parent, seen) + 1)
        // a parent cycle settled this card as a root while its chain was being followed
        if (c.id in depth) return depth[c.id]
      }
    }
    depth[c.id] = d
    return d
  }
  for (const c of cards) tierOf(c, new Set())
  return { hub: hub?.id, depth }
}

/** The radius of tier d's shell when the deepest tier is D: evenly from the inner shell out to the outer one. */
export function tierRadius(d: number, deepest: number): number {
  const D = Math.max(1, deepest)
  return ORBIT_INNER + ((ORBIT_OUTER - ORBIT_INNER) * (Math.max(1, Math.min(d, D)) - 1)) / Math.max(1, D - 1)
}

/** A point on the shell of radius r at angle theta round the core (FRONT faces the viewer), h its height from -1 (low) to 1 (high). */
export function onShell(r: number, theta: number, h = 0): OrbitPoint {
  const up = Math.max(-1, Math.min(1, h)) * SHELL_SPREAD
  const flat = Math.sqrt(Math.max(0, 1 - up * up))
  return { x: Math.cos(theta) * flat * r, y: -up * r || 0, z: Math.sin(theta) * flat * r }
}

/**
 * The shell members by tier, each shell in its settled order (a lead's workers together, same roles side by side),
 * and every card's root: the tier-1 card it hangs under (itself at tier 1).
 */
function shellMembers(cards: OrbitCard[]): { depth: Record<string, number>; shells: Map<number, OrbitCard[]>; hub?: string; root: Map<string, string> } {
  const { hub, depth } = orbitTiers(cards)
  const index = new Map(cards.map((c, i) => [c.id, i]))
  const byId = new Map(cards.map((c) => [c.id, c]))
  const root = new Map<string, string>()
  for (const c of cards) {
    let cur = c
    const seen = new Set<string>()
    while (depth[cur.id] > 1 && cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.parentId)!
    }
    root.set(c.id, cur.id)
  }
  const shells = new Map<number, OrbitCard[]>()
  for (const c of cards) {
    if (c.id === hub) continue
    const d = depth[c.id]
    if (!shells.has(d)) shells.set(d, [])
    shells.get(d)!.push(c)
  }
  for (const members of shells.values()) {
    // a root is its own root: the first key ties for the whole first shell, so roles decide there too
    const key = (c: OrbitCard): [number, string, number] => {
      const r = root.get(c.id) ?? c.id
      return [r === c.id ? -1 : (index.get(r) ?? 0), c.role ?? '~', index.get(c.id) ?? 0]
    }
    members.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0) || ka[2] - kb[2]
    })
  }
  return { depth, shells, hub, root }
}

/**
 * Every card's place: the Conductor at the core; each tier-1 card owns a wedge of the circle (the first facing the
 * viewer) and everything under it sits in that wedge on the deeper shells, so a team reads as one direction out
 * from the core. Round each shell the cards step lower one by one (a helix), so the picture has height as well
 * as width.
 */
export function orbitLayout(cards: OrbitCard[]): Record<string, OrbitPoint> {
  const pos: Record<string, OrbitPoint> = {}
  const { shells, hub, root } = shellMembers(cards)
  if (hub) pos[hub] = { ...CORE }
  const deepest = Math.max(1, ...shells.keys())
  const roots = shells.get(1) ?? []
  const width = (2 * Math.PI) / Math.max(1, roots.length)
  const wedge = new Map(roots.map((c, i) => [c.id, FRONT + width * i - width / 2]))
  for (const [d, members] of shells) {
    const r = tierRadius(d, deepest)
    const n = members.length
    // the cards of one wedge on this shell, in order
    const inWedge = new Map<string, OrbitCard[]>()
    for (const c of members) {
      const w = root.get(c.id) ?? c.id
      if (!inWedge.has(w)) inWedge.set(w, [])
      inWedge.get(w)!.push(c)
    }
    members.forEach((c, i) => {
      const w = root.get(c.id) ?? c.id
      const group = inWedge.get(w)!
      const start = wedge.get(w) ?? FRONT - width / 2
      const theta = start + (width * (group.indexOf(c) + 0.5)) / group.length
      pos[c.id] = onShell(r, theta, n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n)
    })
  }
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

/**
 * The line from a to b as segments + 1 points: straight when either end is the core, otherwise an arc that follows
 * the shells (the direction turns along the great circle while the radius slides from a's to b's).
 */
export function shellArc(a: OrbitPoint, b: OrbitPoint, segments = 8): OrbitPoint[] {
  const ra = Math.hypot(a.x, a.y, a.z)
  const rb = Math.hypot(b.x, b.y, b.z)
  const out: OrbitPoint[] = []
  const straight = (): OrbitPoint[] => {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      out.push(i === segments ? { ...b } : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
    }
    return out
  }
  if (ra < 1e-9 || rb < 1e-9) return straight()
  const ua = { x: a.x / ra, y: a.y / ra, z: a.z / ra }
  const ub = { x: b.x / rb, y: b.y / rb, z: b.z / rb }
  const dot = Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y + ua.z * ub.z))
  const omega = Math.acos(dot)
  const s = Math.sin(omega)
  // the same direction: the straight line
  if (s < 1e-6 && dot > 0) return straight()
  // opposite directions (every great circle fits, so the straight line would run through the core): go round over
  // a direction perpendicular to a, towards the pole when a is not at one
  const opposite = s < 1e-6
  let vb = ub
  if (opposite) {
    const seed = Math.abs(ua.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
    const d = seed.x * ua.x + seed.y * ua.y + seed.z * ua.z
    const p = { x: seed.x - d * ua.x, y: seed.y - d * ua.y, z: seed.z - d * ua.z }
    const pl = Math.hypot(p.x, p.y, p.z)
    vb = { x: p.x / pl, y: p.y / pl, z: p.z / pl }
  }
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const ka = opposite ? Math.cos(t * Math.PI) : Math.sin((1 - t) * omega) / s
    const kb = opposite ? Math.sin(t * Math.PI) : Math.sin(t * omega) / s
    const r = ra + (rb - ra) * t
    // the ends are the cards themselves, not a rounding of them
    out.push(i === 0 ? { ...a } : i === segments ? { ...b } : { x: (ka * ua.x + kb * vb.x) * r, y: (ka * ua.y + kb * vb.y) * r, z: (ka * ua.z + kb * vb.z) * r })
  }
  return out
}

/** A circle (or the arc of one from angle `from` to `to`, measured from the front) in the plane through the core. */
export function circle(r: number, n = 48, from = 0, to = 2 * Math.PI): OrbitPoint[] {
  const out: OrbitPoint[] = []
  for (let i = 0; i <= n; i++) out.push(onShell(r, FRONT + from + ((to - from) * i) / n))
  return out
}

/** n points spread evenly over the unit sphere (a Fibonacci lattice): the faint dust that hints at the space round the cards. */
export function scatter(n: number): OrbitPoint[] {
  const out: OrbitPoint[] = []
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const t = i * 2.399963
    out.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r })
  }
  return out
}

/** The height of a card's context column (unit units): empty at COLUMN_MIN, at its fresh-start line at COLUMN_MIN + COLUMN_MAX. */
export const COLUMN_MIN = 0.06
export const COLUMN_MAX = 0.3
/** each owned task on the column is one sparkle this far above the last */
export const SPARKLE_STEP = 0.05
export const SPARKLES_MAX = 6

/**
 * How close a card is to its fresh start: context tokens over the relay threshold (the setting, capped at 60% of
 * the window), so 1 is the line and more is past it. Null without a usage reading.
 */
export function contextFill(usage: { contextTokens: number; contextWindow: number } | undefined, relayTokens: number | undefined): number | null {
  if (!usage || !Number.isFinite(usage.contextTokens) || usage.contextTokens < 0) return null
  const threshold = relayThreshold(relaySettings({ relayTokens }).tokens, usage.contextWindow)
  return threshold > 0 ? usage.contextTokens / threshold : null
}

/** The column's height: its context fill, but never shorter than its sparkles need; 0 with neither. */
export function columnLength(fill: number | null, sparkles: number): number {
  const k = Math.min(SPARKLES_MAX, Math.max(0, sparkles))
  const byFill = fill === null ? 0 : COLUMN_MIN + COLUMN_MAX * Math.min(1, fill)
  const bySparkles = k > 0 ? COLUMN_MIN + SPARKLE_STEP * k : 0
  return Math.max(byFill, bySparkles)
}

/** Where the k-th sparkle (1-based) sits above the column's foot. */
export function sparkleHeight(k: number): number {
  return COLUMN_MIN / 2 + SPARKLE_STEP * k
}

/** A column standing straight up from its foot. */
export function column(foot: OrbitPoint, length: number): [OrbitPoint, OrbitPoint] {
  return [{ ...foot }, { x: foot.x, y: foot.y - length, z: foot.z }]
}

/** The tasks a card still owns (done and dropped tasks keep no owner, so only these two states can be counted per card). */
export function cardTasks(tasks: Task[], id: string): { doing: number; blocked: number } {
  let doing = 0
  let blocked = 0
  for (const t of tasks) {
    if (t.owner !== id) continue
    if (t.state === 'doing') doing++
    else if (t.state === 'blocked') blocked++
  }
  return { doing, blocked }
}

/** the task ring: a thin circle round everything, in the plane through the core */
export const BASE_RING = 1.12

export interface BaseSegment {
  state: 'done' | 'doing' | 'blocked' | 'todo'
  from: number
  to: number
}

/** The task ring as shares of the board's tasks, round from the front: done, then doing, blocked, todo (dropped tasks are not work). */
export function baseRing(counts: TaskCounts): BaseSegment[] {
  const states: BaseSegment['state'][] = ['done', 'doing', 'blocked', 'todo']
  const total = states.reduce((n, s) => n + Math.max(0, counts[s] || 0), 0)
  if (!total) return []
  const out: BaseSegment[] = []
  let at = FRONT
  for (const state of states) {
    const n = Math.max(0, counts[state] || 0)
    if (!n) continue
    const to = at + (2 * Math.PI * n) / total
    out.push({ state, from: at, to })
    at = to
  }
  return out
}

/** a card's glow fades over this long after its last event */
export const RECENCY_MS = 30 * 60_000

/** How recent a card's last event is: 1 just now, 0 after RECENCY_MS or with no event. */
export function recency(lastEventAt: number | undefined, now: number): number {
  if (!lastEventAt || !Number.isFinite(lastEventAt)) return 0
  return Math.max(0, Math.min(1, 1 - (now - lastEventAt) / RECENCY_MS))
}

/** The view: turned rx (tilt, radians) then ry (spin), zoomed, centred in a w×h box a little above the middle (the controls sit at the bottom). */
export interface OrbitView {
  rx: number
  ry: number
  zoom: number
  w: number
  h: number
}

/** how far above the middle the picture sits (px): room for the legend and the controls below */
export const ORBIT_LIFT = 12

/** Where a point lands on screen; s is its perspective scale, z its depth (negative = towards the viewer). */
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
  // the task ring (BASE_RING) fits the width; the legend and the controls take the bottom
  const scale = Math.max(40, Math.min(v.h / 2 - 90, v.w / 2.6)) * v.zoom
  return { x: v.w / 2 + x1 * scale * persp, y: v.h / 2 - ORBIT_LIFT + y2 * scale * persp, s: persp, z: z2 }
}

/** The zoom after one wheel step (deltaY > 0 zooms out), kept in a range where the picture stays usable. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return Math.max(0.5, Math.min(4, zoom * (deltaY > 0 ? 0.9 : 1 / 0.9)))
}
