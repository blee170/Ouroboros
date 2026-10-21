import { useState } from 'react'
import { useBoard } from '@/store/board'
import { SettingsDialog } from './SettingsDialog'

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function Toolbar() {
  const projectRoot = useBoard((s) => s.projectRoot)
  const addNode = useBoard((s) => s.addNode)
  const openProject = useBoard((s) => s.openProject)
  const persist = useBoard((s) => s.persist)
  const toggleRoster = useBoard((s) => s.toggleRoster)
  const toggleInspector = useBoard((s) => s.toggleInspector)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const nodes = useBoard((s) => s.nodes)
  const needs = nodes.filter((n) => n.data.status === 'needs-you').length
  const working = nodes.filter((n) => n.data.status === 'working').length

  const pick = async (): Promise<void> => {
    const root = await window.ouroboros.workspace.openProject()
    if (root) await openProject(root)
  }

  return (
    <div className="toolbar">
      <span className="brand">◎ Ouroboros</span>
      <button className="btn" onClick={() => void pick()} title={projectRoot}>
        📁 {projectRoot ? basename(projectRoot) : 'Open project'}
      </button>
      <span className="sep" />
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('claude')}>
        + Claude
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('conductor')}>
        + Conductor
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('terminal')}>
        + Terminal
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('note')}>
        + Note
      </button>
      <span className="spacer" />
      <span className="stat">
        <span className="dot" style={{ background: '#3b82f6' }} /> {working} working
      </span>
      <span className="stat">
        <span className="dot" style={{ background: '#f59e0b' }} /> {needs} need you
      </span>
      <span className="sep" />
      <button className="btn" onClick={persist} disabled={!projectRoot}>
        💾 Save
      </button>
      <button className="btn" onClick={toggleRoster}>
        Roster
      </button>
      <button className="btn" onClick={toggleInspector}>
        Inspector
      </button>
      <button className="btn" onClick={() => setSettingsOpen(true)}>
        ⚙
      </button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
