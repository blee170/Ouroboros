import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useBoard } from './store/board'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './panels/Toolbar'
import { Inspector } from './panels/Inspector'
import { Roster } from './panels/Roster'
import { Welcome } from './panels/Welcome'

export default function App() {
  const projectRoot = useBoard((s) => s.projectRoot)
  const rosterOpen = useBoard((s) => s.rosterOpen)
  const inspectorOpen = useBoard((s) => s.inspectorOpen)

  useEffect(() => {
    const name = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    document.title = name ? `${name} — Ouroboros` : 'Ouroboros'
  }, [projectRoot])

  useEffect(() => {
    const b = useBoard.getState()
    void b.init().then(() => window.ouroboros.app.info()).then((info) => {
      if (info.initialProject && !useBoard.getState().projectRoot) void useBoard.getState().openProject(info.initialProject)
    })
    const api = window.ouroboros
    const offs = [
      api.board.onAgentStatus((p) => useBoard.getState().applyStatus(p)),
      api.board.onHandoffFired((p) => useBoard.getState().applyHandoffFired(p)),
      api.board.onExternalSession((p) => useBoard.getState().applyExternal(p)),
      api.board.onSetNote((p) => useBoard.getState().updateNodeData(p.nodeId, { note: p.note })),
      api.board.onAddEdge((e) => useBoard.getState().addEdgeFromMain(e)),
      api.board.onRemoveNode((id) => void useBoard.getState().removeNode(id)),
      api.board.onRemoveEdge((id) => useBoard.getState().removeEdge(id)),
      api.board.onAddNode((n) => {
        useBoard.getState().addNode(n.data.kind, { ...n.data, id: n.id, position: n.position })
      }),
      api.pty.onExit((id) => {
        const s = useBoard.getState()
        if (s.nodes.some((n) => n.id === id)) s.applyStatus({ nodeId: id, status: 'ended', statusDetail: 'process exited', at: Date.now() })
      })
    ]
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        useBoard.getState().persist()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <div className="main">
          {projectRoot ? <Canvas /> : <Welcome />}
          {projectRoot && (rosterOpen || inspectorOpen) && (
            <aside className="side">
              {rosterOpen && <Roster />}
              {inspectorOpen && <Inspector />}
            </aside>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  )
}
