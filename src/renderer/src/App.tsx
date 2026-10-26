import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useBoard } from './store/board'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './panels/Toolbar'
import { Inspector } from './panels/Inspector'
import { HeldDialog } from './panels/HeldDialog'
import { TasksPanel } from './panels/TasksPanel'
import { TodayPanel, needsCount } from './panels/TodayPanel'
import { Sidebar } from './panels/Sidebar'
import { StatusBar } from './panels/StatusBar'
import { Welcome } from './panels/Welcome'
import { Icon } from './lib/icons'
import { speak } from './lib/speak'

export default function App() {
  const projectRoot = useBoard((s) => s.projectRoot)
  const rosterOpen = useBoard((s) => s.rosterOpen)
  const inspectorOpen = useBoard((s) => s.inspectorOpen)
  const toggleInspector = useBoard((s) => s.toggleInspector)
  const rpanelTab = useBoard((s) => s.rpanelTab)
  const showRpanel = useBoard((s) => s.showRpanel)
  const openTasks = useBoard((s) => s.tasks.filter((t) => t.state === 'blocked' || t.state === 'doing' || t.state === 'todo').length)
  const needs = useBoard(needsCount)

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
    void api.autonomy.state().then((p) => p && useBoard.getState().setAutonomy(p))
    // one quiet update check shortly after start, on the Welcome screen too; the result waits in the store
    const updateTimer = setTimeout(() => void api.update.check(), 8000)
    // the plan-usage chip: read once at start and every 15 min (the Claude endpoint is asked at most every 5 min);
    // a card's status line pushes fresher numbers in between
    const readUsage = (): void => void api.usage.get().then((s) => useBoard.getState().setAccountUsage(s)).catch(() => undefined)
    const usageTimer0 = setTimeout(readUsage, 3000)
    const usageTimer = setInterval(readUsage, 15 * 60_000)
    const offs = [
      api.usage.onChange((s) => useBoard.getState().setAccountUsage(s)),
      api.update.onStatus((p) => useBoard.getState().setUpdateStatus(p)),
      api.autonomy.onChange((p) => useBoard.getState().setAutonomy(p)),
      api.tasks.onChange((t) => useBoard.getState().setTasks(t)),
      api.mail.onChange((m) => useBoard.getState().setMail(m)),
      api.gate.onChange((a) => useBoard.getState().setApprovals(a)),
      api.decisions.onChange((d) => useBoard.getState().setDecisions(d)),
      api.grokBot.onChange((h) => useBoard.getState().setGrokHandoffs(h)),
      api.board.onAgentStatus((p) => useBoard.getState().applyStatus(p)),
      api.board.onActivity((p) => useBoard.getState().applyActivity(p)),
      api.board.onHandoffFired((p) => useBoard.getState().applyHandoffFired(p)),
      api.board.onExternalSession((p) => useBoard.getState().applyExternal(p)),
      api.board.onAnnounce((p) => void speak(p)),
      api.board.onSetNote((p) => useBoard.getState().updateNodeData(p.nodeId, { note: p.note })),
      api.board.onUpdateNode((p) => {
        const s = useBoard.getState()
        s.updateNodeData(p.nodeId, p.data)
        if (p.restart) void s.restartNode(p.nodeId)
      }),
      api.board.onAddEdge((e) => useBoard.getState().addEdgeFromMain(e)),
      api.board.onRemoveNode((id) => void useBoard.getState().removeNode(id)),
      api.board.onRemoveEdge((id) => useBoard.getState().removeEdge(id)),
      api.board.onAddNode((n) => {
        // main stores Claude as `undefined`; without the explicit value the renderer would apply the default
        // engine (Codex / Gemini) to a card the Conductor asked for as Claude. Main-initiated cards do not
        // steal the selection from whatever the owner is editing.
        const agent = n.data.kind === 'claude' || n.data.kind === 'conductor'
        useBoard.getState().addNode(n.data.kind, { ...n.data, id: n.id, position: n.position, near: n.near, engine: agent ? (n.data.engine ?? 'claude') : undefined, select: false })
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
    // coming back to the window counts as looking at the selected card: its unread mark goes
    const onFocus = (): void => {
      const s = useBoard.getState()
      if (s.selectedNodeId) s.markViewed(s.selectedNodeId)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('focus', onFocus)
    return () => {
      offs.forEach((off) => off())
      clearTimeout(updateTimer)
      clearTimeout(usageTimer0)
      clearInterval(usageTimer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <div className="main">
          {projectRoot && rosterOpen && <Sidebar />}
          {projectRoot ? <Canvas /> : <Welcome />}
          {projectRoot && inspectorOpen && (
            <aside className="rpanel">
              <div className="rpanel-header">
                <h2>
                  <button className={`rtab${rpanelTab === 'inspector' ? ' on' : ''}`} onClick={() => showRpanel('inspector')} aria-pressed={rpanelTab === 'inspector'}>
                    Inspector
                  </button>
                  <button className={`rtab${rpanelTab === 'tasks' ? ' on' : ''}`} onClick={() => showRpanel('tasks')} aria-pressed={rpanelTab === 'tasks'} title="The task ledger: what the Conductor planned, who is on it, what is blocked">
                    Tasks{openTasks > 0 && <span className="rtab-n">{openTasks}</span>}
                  </button>
                  <button className={`rtab${rpanelTab === 'today' ? ' on' : ''}`} onClick={() => showRpanel('today')} aria-pressed={rpanelTab === 'today'} title="What waits on you, ranked, and what happened today">
                    Today{needs > 0 && <span className="rtab-n needs">{needs}</span>}
                  </button>
                </h2>
                <button className="ghost" onClick={toggleInspector} title="Close the panel" aria-label="Close panel">
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="rpanel-body">{rpanelTab === 'tasks' ? <TasksPanel /> : rpanelTab === 'today' ? <TodayPanel /> : <Inspector />}</div>
            </aside>
          )}
        </div>
        {projectRoot && <StatusBar />}
        {projectRoot && <HeldDialog />}
      </div>
    </ReactFlowProvider>
  )
}
