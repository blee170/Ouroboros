import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, type EdgeTypes, type NodeTypes, type OnSelectionChangeParams } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { AgentNode } from './nodes/AgentNode'
import { NoteNode } from './nodes/NoteNode'
import { ExternalNode } from './nodes/ExternalNode'
import { BrowserNode } from './nodes/BrowserNode'
import { HandoffEdge } from './edges/HandoffEdge'
import { STATUS_COLOR } from '@shared/status'
import { nextAttention } from '@shared/attention'
import { CARD_KINDS, type CardKindItem } from '@/lib/cardKinds'
import { setDragShield } from '@/lib/dragShield'
import { JumpPalette } from '@/panels/JumpPalette'
import { OrbitView } from './OrbitView'

const nodeTypes: NodeTypes = { agent: AgentNode, note: NoteNode, external: ExternalNode, browser: BrowserNode }
const edgeTypes: EdgeTypes = { handoff: HandoffEdge }

interface Menu {
  x: number
  y: number
  flow: { x: number; y: number }
}

export function Canvas() {
  const nodes = useBoard((s) => s.nodes)
  const edges = useBoard((s) => s.edges)
  const onNodesChange = useBoard((s) => s.onNodesChange)
  const onEdgesChange = useBoard((s) => s.onEdgesChange)
  const onConnect = useBoard((s) => s.onConnect)
  const select = useBoard((s) => s.select)
  const addNode = useBoard((s) => s.addNode)
  const setViewport = useBoard((s) => s.setViewport)
  const viewport = useBoard((s) => s.viewport)
  const orbitOpen = useBoard((s) => s.orbitOpen)
  const setOrbitOpen = useBoard((s) => s.setOrbitOpen)
  const rf = useReactFlow()
  const [menu, setMenu] = useState<Menu | null>(null)

  const onSelectionChange = useCallback(
    (p: OnSelectionChangeParams) => select(p.nodes[0]?.id ?? null, p.nodes.length ? null : (p.edges[0]?.id ?? null)),
    [select]
  )
  const onContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setMenu({ x: e.clientX, y: e.clientY, flow })
    },
    [rf]
  )
  const add = (k: CardKindItem): void => {
    if (menu) addNode(k.kind, { position: menu.flow, engine: k.engine, ...k.data })
    setMenu(null)
  }
  const defaultViewport = useMemo(() => viewport ?? { x: 0, y: 0, zoom: 0.8 }, [viewport])
  const [palette, setPalette] = useState(false)
  const jumpTo = useCallback(
    (id: string): void => {
      void rf.fitView({ nodes: [{ id }], duration: 300, padding: 0.3 })
      select(id, null)
    },
    [rf, select]
  )

  // from the globe: back to the canvas, then to the card
  const jumpFromOrbit = useCallback(
    (id: string): void => {
      setOrbitOpen(false)
      requestAnimationFrame(() => jumpTo(id))
    },
    [jumpTo, setOrbitOpen]
  )

  // Ctrl+1…9 jump to the n-th card (the sidebar's settled order), Ctrl+J (or Ctrl+F) opens Jump to…, Ctrl+Shift+O the Orbit view,
  // Ctrl+Shift+N goes to the next card that needs you (then to an unread finished turn).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      // never steal keys from a terminal, text field or editable note
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input, textarea, [contenteditable="true"], .xterm, webview') || t.isContentEditable)) return
      const key = e.key.toLowerCase()
      if (key === 'j' || key === 'f') {
        e.preventDefault()
        setPalette(true)
        return
      }
      const s = useBoard.getState()
      if (key === 'o' && e.shiftKey) {
        e.preventDefault()
        if (s.orbitOpen || s.nodes.some((n) => n.data.kind !== 'note')) s.setOrbitOpen(!s.orbitOpen)
        return
      }
      if (key === 'n' && e.shiftKey) {
        e.preventDefault()
        const live = new Map(s.nodes.map((n) => [n.id, n.data.status]))
        const next = nextAttention(
          s.settledRoster.map((r) => ({ id: r.id, status: live.get(r.id) ?? 'starting' })),
          s.attention.unread,
          s.selectedNodeId
        )
        if (next) jumpTo(next)
        return
      }
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9) return
      const target = s.settledRoster[n - 1]
      if (!target) return
      e.preventDefault()
      jumpTo(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jumpTo])

  return (
    <div className="canvas-wrap" onClick={() => menu && setMenu(null)}>
      {palette && <JumpPalette onPick={jumpTo} onClose={() => setPalette(false)} />}
      {orbitOpen && <OrbitView onJump={jumpFromOrbit} />}
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <marker id="handoff-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
          </marker>
        </defs>
      </svg>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onPaneContextMenu={onContextMenu}
        onMoveEnd={(_e, v) => setViewport(v)}
        onNodeDragStart={() => setDragShield(true)}
        onNodeDragStop={() => setDragShield(false)}
        onConnectStart={() => setDragShield(true)}
        onConnectEnd={() => setDragShield(false)}
        defaultViewport={defaultViewport}
        minZoom={0.15}
        maxZoom={2}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,0.08)" />
        <MiniMap pannable zoomable nodeColor={(n) => STATUS_COLOR[(n.data as { status?: keyof typeof STATUS_COLOR }).status ?? 'idle']} maskColor="rgba(10,10,10,0.75)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {menu && (
        <div className="context-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 330) }}>
          {CARD_KINDS.map((k) => (
            <button key={k.label} role="menuitem" title={k.hint} onClick={() => add(k)}>
              <span className="glyph">
                <k.icon size={14} aria-hidden="true" />
              </span>
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
