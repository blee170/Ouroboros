import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, type EdgeTypes, type NodeTypes, type OnSelectionChangeParams } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { AgentNode } from './nodes/AgentNode'
import { NoteNode } from './nodes/NoteNode'
import { ExternalNode } from './nodes/ExternalNode'
import { BrowserNode } from './nodes/BrowserNode'
import { HandoffEdge } from './edges/HandoffEdge'
import { STATUS_COLOR } from '@shared/status'
import type { NodeKind } from '@shared/types'
import { rosterOrder } from '@/lib/rosterOrder'
import { setDragShield } from '@/lib/dragShield'

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
  const add = (kind: NodeKind, engine?: 'claude' | 'codex' | 'gemini'): void => {
    if (menu) addNode(kind, { position: menu.flow, engine })
    setMenu(null)
  }
  const defaultViewport = useMemo(() => viewport ?? { x: 0, y: 0, zoom: 0.8 }, [viewport])
  const [find, setFind] = useState<string | null>(null)

  // Ctrl+1…9 jump to the n-th agent card (roster order), Ctrl+F finds a card by title.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      // never steal keys from a terminal, text field or editable note
      const t = e.target as HTMLElement | null
      if (t && (t.closest('input, textarea, [contenteditable="true"], .xterm, webview') || t.isContentEditable)) return
      if (e.key === 'f') {
        e.preventDefault()
        setFind('')
        return
      }
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9) return
      const target = rosterOrder(useBoard.getState().nodes)[n - 1]
      if (!target) return
      e.preventDefault()
      void rf.fitView({ nodes: [{ id: target.id }], duration: 300, padding: 0.3 })
      select(target.id, null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf, select])
  const runFind = (q: string): void => {
    const needle = q.trim().toLowerCase()
    const hit = needle ? useBoard.getState().nodes.find((x) => String(x.data.title ?? '').toLowerCase().includes(needle)) : undefined
    if (hit) {
      void rf.fitView({ nodes: [{ id: hit.id }], duration: 300, padding: 0.3 })
      select(hit.id, null)
    }
    setFind(null)
  }

  return (
    <div className="canvas-wrap" onClick={() => menu && setMenu(null)}>
      {find !== null && (
        <input
          className="find-box"
          autoFocus
          placeholder="Find card by title… (Enter)"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runFind(find)
            if (e.key === 'Escape') setFind(null)
          }}
          onBlur={() => setFind(null)}
        />
      )}
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <marker id="handoff-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
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
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2a2f3d" />
        <MiniMap pannable zoomable nodeColor={(n) => STATUS_COLOR[(n.data as { status?: keyof typeof STATUS_COLOR }).status ?? 'idle']} maskColor="rgba(15,17,23,0.7)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {menu && (
        <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 290) }}>
          <button onClick={() => add('claude', 'claude')}>✦ Claude agent</button>
          <button onClick={() => add('claude', 'codex')}>◎ Codex agent</button>
          <button onClick={() => add('claude', 'gemini')}>✧ Gemini agent</button>
          <button onClick={() => add('conductor')}>🎼 Conductor</button>
          <button onClick={() => add('terminal')}>▣ Terminal</button>
          <button onClick={() => add('browser')}>🌐 Browser</button>
          <button onClick={() => add('command')}>⚡ Command card</button>
          <button onClick={() => add('note')}>📝 Note</button>
        </div>
      )}
    </div>
  )
}
