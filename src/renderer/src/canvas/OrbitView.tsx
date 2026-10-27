import { useEffect, useMemo, useRef, useState } from 'react'
import { useBoard } from '@/store/board'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import { orbitLayout, orbitLinks, project, sphere, wheelZoom, type OrbitView as View } from '@shared/orbit'
import { Icon } from '@/lib/icons'

/** the faint points that give the globe its surface; decoration only */
const DUST = sphere(110)
const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Orbit: the board as a turning globe over the canvas (which stays mounted underneath, so every terminal keeps
 * running). A card is a dot in its state's colour, the Conductor the larger one facing you; lines are the handoff
 * lines and dispatch links. Drag to turn, wheel to zoom, click a dot to select it (the Inspector shows it),
 * double-click to go to it on the canvas. Esc or the button goes back.
 */
export function OrbitView({ onJump }: { onJump: (id: string) => void }) {
  const nodes = useBoard((s) => s.nodes)
  const edges = useBoard((s) => s.edges)
  const selected = useBoard((s) => s.selectedNodeId)
  const workingSince = useBoard((s) => s.workingSince)
  const select = useBoard((s) => s.select)
  const close = useBoard((s) => s.setOrbitOpen)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [turn, setTurn] = useState({ rx: -0.35, ry: 0, zoom: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const spin = useRef(!reducedMotion())
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null)
  /** the last press turned the globe: its release is not a click on a dot */
  const dragged = useRef(false)

  const cards = useMemo(
    () => nodes.filter((n) => n.data.kind !== 'note').map((n) => ({ id: n.id, conductor: n.data.kind === 'conductor', parentId: n.data.parentId, title: n.data.title, status: n.data.status ?? 'idle' })),
    [nodes]
  )
  const pos = useMemo(() => orbitLayout(cards), [cards])
  const links = useMemo(() => orbitLinks(cards, edges), [cards, edges])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  // a slow turn until the owner takes hold of the globe (never with reduced motion), about 30 frames a second:
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
  const lit = new Set(selected || hover ? links.filter((l) => l.from === (hover ?? selected) || l.to === (hover ?? selected)).flatMap((l) => [l.from, l.to]) : [])
  // a handoff line glows while its target works on what it sent (the canvas's rule)
  const edgeById = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges])
  const statusOf = useMemo(() => new Map(cards.map((c) => [c.id, c.status])), [cards])
  const active = (l: (typeof links)[number]): boolean => {
    if (l.kind !== 'handoff' || !l.edgeId) return false
    const e = edgeById.get(l.edgeId)
    const since = workingSince[l.to]
    return statusOf.get(l.to) === 'working' && since !== undefined && (e?.data?.lastFiredAt ?? 0) >= since - 10_000
  }
  // far side first, so nearer dots are drawn over farther ones
  const order = [...cards].sort((a, b) => at[b.id].z - at[a.id].z)

  // the pointer is captured only once it moves: a plain click still reaches the dot under it
  const onPointerDown = (e: React.PointerEvent): void => {
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 }
    dragged.current = false
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
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
    setTurn({ rx: -0.35, ry: 0, zoom: 1 })
    spin.current = !reducedMotion()
  }

  return (
    <div className="orbit-view" ref={box} onWheel={(e) => e.deltaY && setTurn((t) => ({ ...t, zoom: wheelZoom(t.zoom, e.deltaY) }))}>
      <svg width={size.w} height={size.h} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} role="group" aria-label={`Orbit view of ${cards.length} cards`}>
        <g className="orbit-dust">
          {DUST.map((p, i) => {
            const q = project(p, view)
            return <circle key={i} cx={q.x} cy={q.y} r={q.z < 0 ? 1.1 : 0.7} opacity={q.z < 0 ? 0.35 : 0.12} />
          })}
        </g>
        <g className="orbit-lines">
          {links.map((l) => {
            const a = at[l.from]
            const b = at[l.to]
            const on = lit.has(l.from) && lit.has(l.to) && (l.from === (hover ?? selected) || l.to === (hover ?? selected))
            return (
              <line
                key={`${l.from}-${l.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`orbit-line ${l.kind}${on ? ' lit' : ''}${active(l) ? ' active' : ''}`}
                opacity={Math.max(0.25, Math.min(1, 1 - (a.z + b.z) * 0.35))}
              />
            )
          })}
        </g>
        <g className="orbit-dots">
          {order.map((c) => {
            const p = at[c.id]
            const r = (c.conductor ? 10 : 7) * Math.max(0.7, Math.min(1.4, p.s)) * Math.min(1.8, 0.8 + turn.zoom * 0.25)
            const near = p.z < 0.15
            const named = c.id === hover || c.id === selected || (near && (cards.length <= 12 || turn.zoom >= 1.5 || c.conductor))
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
                aria-label={`${c.title}, ${STATUS_LABEL[c.status]}${c.conductor ? ', Conductor' : ''}. Enter selects, Shift+Enter goes to it`}
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
                  // the globe holds still once a card is picked, so a second click lands on the same dot
                  spin.current = false
                  if (!dragged.current) select(c.id, null)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onJump(c.id)
                }}
              >
                <title>{`${c.title} · ${STATUS_LABEL[c.status]}`}</title>
                <circle r={18} className="hit" />
                <circle r={r * 2} className="glow" fill={STATUS_COLOR[c.status]} />
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
      <div className="orbit-bar">
        <span className="muted small">Drag to turn · wheel to zoom · click a dot to select · double-click to go to it</span>
        <button className="btn" onClick={reset} title="Put the globe back and let it turn">
          Reset
        </button>
        <button className="btn" onClick={() => close(false)} title="Back to the canvas (Esc)">
          <Icon name="close" size={14} /> Canvas
        </button>
      </div>
    </div>
  )
}
