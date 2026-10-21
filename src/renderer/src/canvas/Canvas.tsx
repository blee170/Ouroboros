import { useCallback, useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, type EdgeTypes, type NodeTypes, type OnSelectionChangeParams } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { AgentNode } from './nodes/AgentNode'
import { NoteNode } from './nodes/NoteNode'
import { ExternalNode } from './nodes/ExternalNode'
import { HandoffEdge } from './edges/HandoffEdge'
import { STATUS_COLOR } from '@shared/status'
import type { NodeKind } from '@shared/types'

const nodeTypes: NodeTypes = { agent: AgentNode, note: NoteNode, external: ExternalNode }
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
  const add = (kind: NodeKind): void => {
    if (menu) addNode(kind, { position: menu.flow })
    setMenu(null)
  }
  const defaultViewport = useMemo(() => viewport ?? { x: 0, y: 0, zoom: 0.8 }, [viewport])

  return (
    <div className="canvas-wrap" onClick={() => menu && setMenu(null)}>
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
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => add('claude')}>✦ Claude agent</button>
          <button onClick={() => add('conductor')}>🎼 Conductor</button>
          <button onClick={() => add('terminal')}>▣ Terminal</button>
          <button onClick={() => add('note')}>📝 Note</button>
        </div>
      )}
    </div>
  )
}
