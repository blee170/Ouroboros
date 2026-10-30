import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useBoard } from '@/store/board'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import { summarizeTasks } from '@shared/ledger'
import {
  BASE_RING,
  FRONT,
  ORBIT_TILT,
  SPARKLES_MAX,
  baseRing,
  cardTasks,
  circle,
  column,
  columnLength,
  contextFill,
  orbitLayout,
  orbitLinks,
  project,
  recency,
  scatter,
  shellArc,
  sparkleHeight,
  wheelZoom,
  type OrbitLink,
  type OrbitPoint,
  type OrbitView as View
} from '@shared/orbit'
import { Icon } from '@/lib/icons'

/** the faint dust round the cards, just outside the widest shell; decoration only */
const DUST = scatter(110)
const HOME = { rx: ORBIT_TILT, ry: 0, zoom: 1 }
/** the lines' light: neon cyan with a near-white core; state keeps its own colours */
const CYAN = '#2ee0ff'
const PALE = '#dffaff'
/** the halo passes of a neon line: width and alpha share, then the core */
const NEON = [
  [11, 0.09],
  [3.5, 0.3],
  [1.2, 1]
] as const
/** the task ring's colours by state (the status colours of the matching card states) */
const BASE_COLOR = { done: STATUS_COLOR.done, doing: STATUS_COLOR.working, blocked: STATUS_COLOR['needs-you'], todo: PALE }
/** how often the glow's recency is read again */
const TICK_MS = 15_000
const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
/** nearer marks are drawn stronger: 1 at the front, 0.3 at the back */
const fade = (z: number): number => 0.65 - 0.35 * Math.max(-1, Math.min(1, z))

/**
 * Orbit: the board as a constellation round its Conductor, over the canvas (which stays mounted underneath, so
 * every terminal keeps running). The Conductor is the glowing core, the cards it dispatched sit on shells round
 * it by tier (the nearest the most important), spread in height as well as round; lines from the core are
 * straight, lines between cards follow the shells; a light column rises from each card with its context use,
 * carrying a sparkle per task it still owns, and the thin ring round everything is the board's task progress.
 * The lines, columns and ring are painted on a canvas with additive light; the dots (and the lit lines) stay SVG
 * so they can be hovered, clicked and focused. Drag to turn, wheel to zoom, click a dot to select it (the
 * Inspector shows it), double-click to go to it. Esc or the button goes back.
 */
export function OrbitView({ onJump }: { onJump: (id: string) => void }) {
  const nodes = useBoard((s) => s.nodes)
  const edges = useBoard((s) => s.edges)
  const tasks = useBoard((s) => s.tasks)
  const usage = useBoard((s) => s.usage)
  const relayTokens = useBoard((s) => s.settings.relayTokens)
  const selected = useBoard((s) => s.selectedNodeId)
  const workingSince = useBoard((s) => s.workingSince)
  const select = useBoard((s) => s.select)
  const close = useBoard((s) => s.setOrbitOpen)
  const box = useRef<HTMLDivElement>(null)
  const paint = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [turn, setTurn] = useState(HOME)
  const [hover, setHover] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const spin = useRef(!reducedMotion())
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null)
  /** the last press turned the picture: its release is not a click on a dot */
  const dragged = useRef(false)

  const cards = useMemo(
    () =>
      nodes
        .filter((n) => n.data.kind !== 'note')
        .map((n) => ({ id: n.id, conductor: n.data.kind === 'conductor', parentId: n.data.parentId, role: n.data.role, title: n.data.title, status: n.data.status ?? 'idle', lastEventAt: n.data.lastEventAt })),
    [nodes]
  )
  // the layout reads only ids, parents and roles: a status change moves nothing
  const shape = useMemo(() => cards.map((c) => ({ id: c.id, conductor: c.conductor, parentId: c.parentId, role: c.role })), [cards])
  const pos = useMemo(() => orbitLayout(shape), [shape])
  const links = useMemo(() => orbitLinks(shape, edges), [shape, edges])
  // every line as points: straight from the core, along the shells between cards
  const arcs = useMemo(() => links.map((l) => ({ link: l, pts: shellArc(pos[l.from], pos[l.to]) })), [links, pos])
  // what each card carries: how close it is to its fresh start, and the tasks it still owns
  const info = useMemo(() => new Map(cards.map((c) => [c.id, { fill: contextFill(usage[c.id], relayTokens), ...cardTasks(tasks, c.id) }])), [cards, usage, relayTokens, tasks])
  // a column per card that has a context reading or owns tasks
  const columns = useMemo(
    () =>
      cards.flatMap((c) => {
        const x = info.get(c.id)!
        const sparkles = [...Array<'blocked'>(x.blocked).fill('blocked'), ...Array<'doing'>(x.doing).fill('doing')].slice(0, SPARKLES_MAX)
        const length = columnLength(x.fill, sparkles.length)
        if (!length) return []
        const [foot, tip] = column(pos[c.id], length)
        return [{ id: c.id, foot, tip, fill: x.fill, color: STATUS_COLOR[c.status], sparkles: sparkles.map((state, i) => ({ state, at: { x: foot.x, y: foot.y - sparkleHeight(i + 1), z: foot.z } })) }]
      }),
    [cards, pos, info]
  )
  const base = useMemo(() => baseRing(summarizeTasks(tasks)), [tasks])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  // a slow turn until the owner takes hold of the picture (never with reduced motion), about 30 frames a second:
  // the terminals share this thread
  useEffect(() => {
    let raf = 0
    let last = 0
    const step = (now: number): void => {
      if (spin.current && !drag.current && !hoverRef.current && now - last >= 33) {
        last = now
        setTurn((t) => ({ ...t, ry: t.ry + 0.005 }))
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])
  // a card removed under the pointer never sends pointer-leave
  useEffect(() => {
    if (hover && !cards.some((c) => c.id === hover)) setHover(null)
  }, [cards, hover])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc belongs to a dialog, the Jump palette or a text field first
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-backdrop')) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, [contenteditable="true"], .xterm')) return
      close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const view: View = { ...turn, w: size.w, h: size.h }
  const at = Object.fromEntries(cards.map((c) => [c.id, project(pos[c.id], view)]))
  const focus = hover ?? selected
  const lit = new Set(focus ? links.filter((l) => l.from === focus || l.to === focus).flatMap((l) => [l.from, l.to]) : [])
  // a handoff line glows while its target works on what it sent (the canvas's rule)
  const edgeById = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges])
  const statusOf = useMemo(() => new Map(cards.map((c) => [c.id, c.status])), [cards])
  const active = (l: OrbitLink): boolean => {
    if (l.kind !== 'handoff' || !l.edgeId) return false
    const e = edgeById.get(l.edgeId)
    const since = workingSince[l.to]
    return statusOf.get(l.to) === 'working' && since !== undefined && (e?.data?.lastFiredAt ?? 0) >= since - 10_000
  }
  const isLit = (l: OrbitLink): boolean => lit.has(l.from) && lit.has(l.to) && (l.from === focus || l.to === focus)
  // far side first, so nearer dots are drawn over farther ones
  const order = [...cards].sort((a, b) => at[b.id].z - at[a.id].z)

  // the painted layer, every render: light adds up, nearer marks stronger than farther ones
  useLayoutEffect(() => {
    const cv = paint.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
      cv.width = Math.round(size.w * dpr)
      cv.height = Math.round(size.h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, size.w, size.h)
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    /** traces a polyline and returns its mean depth */
    const trace = (pts: OrbitPoint[]): number => {
      ctx.beginPath()
      let z = 0
      pts.forEach((p, i) => {
        const q = project(p, view)
        z += q.z
        if (i === 0) ctx.moveTo(q.x, q.y)
        else ctx.lineTo(q.x, q.y)
      })
      return z / Math.max(1, pts.length)
    }
    /** a neon line: wide coloured halos that add up, and a thin near-white core */
    const glow = (pts: OrbitPoint[], color: string, alpha: number, dash?: number[], core = PALE): void => {
      const a = alpha * fade(trace(pts))
      ctx.setLineDash(dash ?? [])
      NEON.forEach(([w, k], i) => {
        ctx.strokeStyle = i === NEON.length - 1 ? core : color
        ctx.lineWidth = w
        ctx.globalAlpha = a * k
        ctx.stroke()
      })
    }
    // the core: the Conductor's light at the centre (a quiet glow when there is none)
    const centre = project({ x: 0, y: 0, z: 0 }, view)
    const edge = project({ x: 1, y: 0, z: 0 }, view)
    const radius = Math.hypot(edge.x - centre.x, edge.y - centre.y)
    const hasHub = cards.some((c) => c.conductor)
    const core = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius * 0.3)
    core.addColorStop(0, hasHub ? 'rgba(223,250,255,.9)' : 'rgba(46,224,255,.12)')
    core.addColorStop(0.2, hasHub ? 'rgba(46,224,255,.45)' : 'rgba(46,224,255,.06)')
    core.addColorStop(0.55, 'rgba(46,224,255,.08)')
    core.addColorStop(1, 'rgba(46,224,255,0)')
    ctx.globalAlpha = 1
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(centre.x, centre.y, radius * 0.3, 0, 2 * Math.PI)
    ctx.fill()
    // the dust
    ctx.fillStyle = PALE
    for (const p of DUST) {
      const q = project(p, view)
      ctx.globalAlpha = q.z < 0 ? 0.5 : 0.18
      ctx.fillRect(q.x - 0.6, q.y - 0.6, 1.2, 1.2)
    }
    // the task ring: the board's tasks as shares of a thin circle round everything (a faint circle without tasks)
    const ringPts = (from: number, to: number): OrbitPoint[] => circle(BASE_RING, Math.max(2, Math.ceil((Math.abs(to - from) / (2 * Math.PI)) * 64)), from, to)
    if (!base.length) glow(ringPts(0, 2 * Math.PI), CYAN, 0.12, [2, 6])
    for (const seg of base) glow(ringPts(seg.from - FRONT, seg.to - FRONT), BASE_COLOR[seg.state], seg.state === 'todo' ? 0.3 : 0.9, undefined, seg.state === 'todo' ? PALE : BASE_COLOR[seg.state])
    // the lines between cards; a lit one gets its halo here too (an SVG filter on forty lit paths is too slow at
    // thirty frames a second); the flowing one is drawn by the SVG on top
    for (const { link, pts } of arcs) {
      if (active(link)) continue
      const lit = isLit(link)
      glow(pts, lit ? '#5ad0ff' : CYAN, lit ? 1 : link.kind === 'handoff' ? 0.8 : 0.3, link.kind === 'parent' ? [3, 4] : undefined)
    }
    // the columns: context use as a beam of light rising from the card, a cap where it is past its fresh-start line
    for (const col of columns) {
      const f = project(col.foot, view)
      const t = project(col.tip, view)
      const beam = ctx.createLinearGradient(f.x, f.y, t.x, t.y)
      beam.addColorStop(0, col.color)
      beam.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(f.x, f.y)
      ctx.lineTo(t.x, t.y)
      for (const [w, k] of [[14, 0.08], [6, 0.18], [2, 1]] as const) {
        ctx.strokeStyle = w === 2 ? beam : col.color
        ctx.lineWidth = w
        ctx.globalAlpha = k * fade(f.z)
        ctx.stroke()
      }
      if (col.fill !== null && col.fill >= 1) {
        ctx.fillStyle = STATUS_COLOR.working
        ctx.globalAlpha = 0.95 * fade(t.z)
        ctx.fillRect(t.x - 4 * t.s, t.y - 1, 8 * t.s, 2)
      }
      for (const s of col.sparkles) {
        const q = project(s.at, view)
        ctx.fillStyle = s.state === 'blocked' ? STATUS_COLOR['needs-you'] : STATUS_COLOR.working
        ctx.globalAlpha = 0.3 * fade(q.z)
        ctx.beginPath()
        ctx.arc(q.x, q.y, 4.5 * q.s, 0, 2 * Math.PI)
        ctx.fill()
        ctx.globalAlpha = 0.95 * fade(q.z)
        ctx.beginPath()
        ctx.arc(q.x, q.y, 1.6, 0, 2 * Math.PI)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  })

  // the pointer is captured only once it moves: a plain click still reaches the dot under it
  const onPointerDown = (e: React.PointerEvent): void => {
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 }
    dragged.current = false
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    // a release over the control bar or outside the window never reaches the svg: a move with no button is one
    if (e.buttons === 0) {
      drag.current = null
      return
    }
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    d.moved += Math.abs(dx) + Math.abs(dy)
    if (d.moved > 6 && !dragged.current) {
      dragged.current = true
      spin.current = false
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    }
    setTurn((t) => ({ ...t, ry: t.ry + dx * 0.008, rx: Math.max(-1.2, Math.min(1.2, t.rx + dy * 0.008)) }))
  }
  const onPointerUp = (): void => {
    drag.current = null
  }
  const reset = (): void => {
    setTurn(HOME)
    spin.current = !reducedMotion()
  }
  const path = (pts: OrbitPoint[]): string =>
    pts
      .map((p, i) => {
        const q = project(p, view)
        return `${i ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`
      })
      .join(' ')
  const detail = (id: string): string => {
    const x = info.get(id)
    const open = (x?.doing ?? 0) + (x?.blocked ?? 0)
    const bits: string[] = []
    if (x && x.fill !== null) bits.push(`context ${Math.round(x.fill * 100)}% of its fresh-start line`)
    if (open) bits.push(`${open} open task${open === 1 ? '' : 's'}${open > SPARKLES_MAX ? ` (${SPARKLES_MAX} shown)` : ''}`)
    return bits.length ? ', ' + bits.join(', ') : ''
  }

  return (
    <div className="orbit-view" ref={box} onWheel={(e) => e.deltaY && setTurn((t) => ({ ...t, zoom: wheelZoom(t.zoom, e.deltaY) }))}>
      <canvas ref={paint} className="orbit-paint" style={{ width: size.w, height: size.h }} aria-hidden="true" />
      <svg width={size.w} height={size.h} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} role="group" aria-label={`Orbit view of ${cards.length} cards`}>
        <g className="orbit-lines">
          {arcs.map(({ link, pts }) => {
            const on = isLit(link)
            const live = active(link)
            if (!on && !live) return null
            const z = (at[link.from].z + at[link.to].z) / 2
            return <path key={`${link.from}-${link.to}`} d={path(pts)} className={`orbit-line ${link.kind}${on ? ' lit' : ''}${live ? ' active' : ''}`} opacity={fade(z)} />
          })}
        </g>
        <g className="orbit-dots">
          {order.map((c) => {
            const p = at[c.id]
            // stars, not discs: small at a glance, bigger as the owner zooms in
            const r = (c.conductor ? 4.5 : 2.8) * Math.max(0.7, Math.min(1.4, p.s)) * Math.min(3, 0.6 + turn.zoom * 0.4)
            const near = p.z < 0.15
            const named = c.id === hover || c.id === selected || (near && (turn.zoom >= 1.5 || c.conductor))
            return (
              <g
                key={c.id}
                className={`orbit-dot ${c.status}${c.conductor ? ' lead' : ''}${c.id === selected ? ' selected' : ''}`}
                transform={`translate(${p.x} ${p.y})`}
                opacity={Math.max(0.3, Math.min(1, 1.05 - p.z * 0.6))}
                onPointerEnter={() => setHover(c.id)}
                onPointerLeave={() => setHover((h) => (h === c.id ? null : h))}
                role="button"
                tabIndex={0}
                aria-label={`${c.title}, ${STATUS_LABEL[c.status]}${c.conductor ? ', Conductor' : ''}${detail(c.id)}. Enter selects, Shift+Enter goes to it`}
                onFocus={() => setHover(c.id)}
                onBlur={() => setHover((h) => (h === c.id ? null : h))}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (e.shiftKey) onJump(c.id)
                  else select(c.id, null)
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  // the picture holds still once a card is picked, so a second click lands on the same dot
                  spin.current = false
                  if (!dragged.current) select(c.id, null)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onJump(c.id)
                }}
              >
                <title>{`${c.title} · ${STATUS_LABEL[c.status]}${detail(c.id)}`}</title>
                <circle r={18} className="hit" />
                {/* the glow is brighter the more recently the card did anything */}
                <circle r={r * 2.2} className="glow" fill={STATUS_COLOR[c.status]} style={{ opacity: 0.12 + 0.4 * recency(c.lastEventAt, now) }} />
                <circle r={r} fill={STATUS_COLOR[c.status]} className="dot" />
                {named && (
                  <text x={r + 6} y={4} className="tag">
                    {c.title.length > 28 ? c.title.slice(0, 27) + '…' : c.title}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      {!cards.length && <div className="orbit-empty">No cards on the board yet.</div>}
      <div className="orbit-legend muted small">Core = Conductor · distance = dispatch tier (nearest first) · beam = context use (cap: past its fresh-start line) · sparkles = tasks it owns, up to {SPARKLES_MAX} (amber doing, orange blocked) · ring = the board's tasks</div>
      <div className="orbit-bar">
        <span className="muted small">Drag to turn · wheel to zoom · click a dot to select · double-click to go to it</span>
        <button className="btn" onClick={reset} title="Put the picture back and let it turn">
          Reset
        </button>
        <button className="btn" onClick={() => close(false)} title="Back to the canvas (Esc)">
          <Icon name="close" size={14} /> Canvas
        </button>
      </div>
    </div>
  )
}
