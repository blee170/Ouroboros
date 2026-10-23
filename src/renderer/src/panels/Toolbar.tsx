import { useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { UpdateStatus } from '@shared/protocol'
import { useBoard } from '@/store/board'
import { SettingsDialog } from './SettingsDialog'
import { BoardBuilder } from './BoardBuilder'
import { TidyDialog } from './TidyDialog'

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function Toolbar() {
  const projectRoot = useBoard((s) => s.projectRoot)
  const addNode = useBoard((s) => s.addNode)
  const openProject = useBoard((s) => s.openProject)
  const persist = useBoard((s) => s.persist)
  const savedAt = useBoard((s) => s.savedAt)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => tick((x) => x + 1), 4200) // flip "Saved ✓" back to "Save"
    return () => clearTimeout(t)
  }, [savedAt])
  const toggleRoster = useBoard((s) => s.toggleRoster)
  const toggleInspector = useBoard((s) => s.toggleInspector)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [tidyOpen, setTidyOpen] = useState(false)
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    const off = window.ouroboros.update.onStatus(setUpd)
    // one quiet check shortly after start
    const t = setTimeout(() => void window.ouroboros.update.check(), 8000)
    return () => {
      off()
      clearTimeout(t)
    }
  }, [])
  const defaultEngine = useBoard((s) => s.settings.defaultEngine)
  const engineLabel = defaultEngine === 'codex' ? '◎ Codex' : defaultEngine === 'gemini' ? '✧ Gemini' : '✦ Claude'
  const nodes = useBoard((s) => s.nodes)
  const needs = nodes.filter((n) => n.data.status === 'needs-you').length
  const working = nodes.filter((n) => n.data.status === 'working').length
  const arrange = useBoard((s) => s.arrange)
  const undoArrange = useBoard((s) => s.undoArrange)
  const canUndoArrange = useBoard((s) => Boolean(s.arrangeUndo))
  const rf = useReactFlow()
  const arrangeAndFit = (): void => {
    arrange()
    setTimeout(() => void rf.fitView({ duration: 400, padding: 0.08 }), 50)
  }

  // A window holds one project: picking another folder while one is open opens it in a new window.
  const pick = async (): Promise<void> => {
    const root = await window.ouroboros.workspace.openProject()
    if (!root) return
    if (projectRoot) await window.ouroboros.window.open(root)
    else await openProject(root)
  }

  return (
    <div className="toolbar">
      <span className="brand">◎ Ouroboros</span>
      <button className="btn" onClick={() => void pick()} title={projectRoot ? `${projectRoot} — pick another folder to open it in a new window` : 'Open a project folder'}>
        📁 {projectRoot ? basename(projectRoot) : 'Open project'}
      </button>
      <button className="btn" title="New window (another project side by side)" onClick={() => void window.ouroboros.window.open()}>
        ⧉
      </button>
      <span className="sep" />
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('claude')} title={`New agent card (${engineLabel}); right-click the canvas for a specific engine`}>
        + {engineLabel}
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('conductor')}>
        + Conductor
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('terminal')}>
        + Terminal
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('browser')}>
        + Browser
      </button>
      <button className="btn" disabled={!projectRoot} title="A card that runs Aside's browser agent for every prompt it receives (needs the Aside app + CLI)" onClick={() => addNode('command', { title: '🅰 Aside', commandTemplate: 'aside exec {{prompt}}' })}>
        + Aside
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => addNode('note')}>
        + Note
      </button>
      <button className="btn" disabled={!projectRoot} onClick={() => setBuilderOpen(true)} title="Generate a board from your folders and Claude Code history">
        ✨ Build board
      </button>
      <span className="spacer" />
      <span className="stat">
        <span className="dot" style={{ background: '#3b82f6' }} /> {working} working
      </span>
      <span className="stat">
        <span className="dot" style={{ background: '#f59e0b' }} /> {needs} need you
      </span>
      <span className="sep" />
      <button className="btn" onClick={persist} disabled={!projectRoot} title={savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()} — also auto-saved after every change` : 'Saves .ouroboros.json now (changes are auto-saved too)'}>
        💾 {savedAt && Date.now() - savedAt < 4000 ? 'Saved ✓' : 'Save'}
      </button>
      <button className="btn" disabled={!projectRoot} title="Close finished or idle cards" onClick={() => setTidyOpen(true)}>
        🧹 Tidy
      </button>
      {canUndoArrange ? (
        <button className="btn" title="Put the cards back where they were before Arrange" onClick={undoArrange}>
          ↶ Undo arrange
        </button>
      ) : (
        <button className="btn" disabled={!projectRoot || !nodes.some((n) => n.data.kind !== 'external')} title="Line the cards up in rows: conductors, then agents by title, then notes, then browsers" onClick={arrangeAndFit}>
          ⊞ Arrange
        </button>
      )}
      <button className="btn" onClick={toggleRoster}>
        Roster
      </button>
      <button className="btn" onClick={toggleInspector}>
        Inspector
      </button>
      {(upd?.state === 'available' || upd?.state === 'ready' || upd?.state === 'downloading') && (
        <button className="btn update-badge" title={upd.state === 'ready' ? 'Restart to install' : 'Open settings to update'} onClick={() => (upd.state === 'ready' ? void window.ouroboros.update.install() : setSettingsOpen(true))}>
          ⬆ {upd.state === 'ready' ? `Restart for v${upd.version}` : upd.state === 'downloading' ? `${upd.percent ?? 0}%` : `v${upd.version} available`}
        </button>
      )}
      <button className="btn" title="Settings" onClick={() => setSettingsOpen(true)}>
        ⚙
      </button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {builderOpen && <BoardBuilder onClose={() => setBuilderOpen(false)} />}
      {tidyOpen && <TidyDialog onClose={() => setTidyOpen(false)} />}
    </div>
  )
}
