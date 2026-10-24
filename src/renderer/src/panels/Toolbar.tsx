import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { CARD_KINDS, ENGINE_LABEL } from '@/lib/cardKinds'
import { SettingsDialog } from './SettingsDialog'
import { BoardBuilder } from './BoardBuilder'
import { TidyDialog } from './TidyDialog'
import { AutonomyDialog } from './AutonomyDialog'
import { HelpDialog } from './HelpDialog'

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * The title bar, 36px: the sidebar toggle, the wordmark and the project on the left; on the right one "New card"
 * (the button adds the default agent, its arrow lists every kind), the board actions as ghost icons, help,
 * settings and the right panel toggle. The board's state lives in the status bar, the cards in the sidebar.
 */
export function Toolbar() {
  const projectRoot = useBoard((s) => s.projectRoot)
  const addNode = useBoard((s) => s.addNode)
  const openProject = useBoard((s) => s.openProject)
  const rosterOpen = useBoard((s) => s.rosterOpen)
  const inspectorOpen = useBoard((s) => s.inspectorOpen)
  const toggleRoster = useBoard((s) => s.toggleRoster)
  const toggleInspector = useBoard((s) => s.toggleInspector)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [tidyOpen, setTidyOpen] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState<false | 'help' | 'first-run'>(false)
  const autonomyOn = useBoard((s) => s.autonomy.on)
  // the first-run guide: once, the first time a project is open with the saved settings in hand (the defaults
  // alone would show it to everyone on every start before their settings arrived)
  const tourSeen = useBoard((s) => s.settings.tourSeen)
  const settingsLoaded = useBoard((s) => s.settingsLoaded)
  const setSettings = useBoard((s) => s.setSettings)
  useEffect(() => {
    if (!projectRoot || !settingsLoaded || tourSeen) return
    setHelpOpen('first-run')
    void setSettings({ tourSeen: true })
  }, [projectRoot, settingsLoaded, tourSeen, setSettings])
  // the kinds menu is fixed-positioned under its button: a child dropdown would be clipped by the bar
  const [moreOpen, setMoreOpen] = useState<{ left: number; top: number } | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const openMore = (): void => {
    const r = moreRef.current?.getBoundingClientRect()
    setMoreOpen(moreOpen || !r ? null : { left: Math.max(8, r.right - 220), top: r.bottom + 6 })
  }
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMoreOpen(null)
    }
    const onResize = (): void => setMoreOpen(null) // its fixed coordinates go stale
    // capture phase: the canvas (d3-zoom) and card headers (d3-drag) stop mousedown from bubbling; a click
    // inside a browser card's webview never reaches this window at all, but it does take the focus (blur)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [moreOpen])
  const defaultEngine = useBoard((s) => s.settings.defaultEngine) ?? 'claude'
  const hasCards = useBoard((s) => s.nodes.some((n) => n.data.kind !== 'external'))
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
    <div className="titlebar">
      <div className="tb-group">
        <button className={`ghost${rosterOpen ? ' on' : ''}`} disabled={!projectRoot} onClick={toggleRoster} title="Sidebar: every card by state, and a prompt box for the checked ones" aria-label="Toggle sidebar" aria-pressed={rosterOpen}>
          <Icon name="panelLeft" />
        </button>
        <span className="wordmark">Ouroboros</span>
        <button className="ghost project" onClick={() => void pick()} title={projectRoot ? `${projectRoot}\nPick another folder to open it in a new window` : 'Open a project folder'}>
          <Icon name="folder" size={14} />
          <span className="tb-label">{projectRoot ? basename(projectRoot) : 'Open project'}</span>
        </button>
        <button className="ghost" title="New window (another project side by side)" aria-label="New window" onClick={() => void window.ouroboros.window.open()}>
          <Icon name="window" size={14} />
        </button>
      </div>
      <div className="tb-group grow" />
      <div className="tb-group">
        <div className="menu-anchor split" ref={moreRef}>
          <button className="new-card" disabled={!projectRoot} onClick={() => addNode('claude', { engine: defaultEngine })} title={`New ${ENGINE_LABEL[defaultEngine]} agent card (the default engine, set in Settings)`}>
            <Icon name="plus" size={14} />
            New card
          </button>
          <button className={`new-card-more${moreOpen ? ' on' : ''}`} disabled={!projectRoot} onClick={openMore} title="Every kind of card (also on the canvas: right-click)" aria-label="Choose a kind of card" aria-expanded={Boolean(moreOpen)}>
            <Icon name="chevron" size={13} />
          </button>
          {/* a plain popover of buttons (Tab moves through them, Escape closes), not an ARIA menu with arrow keys */}
          {moreOpen && (
            <div className="menu" style={{ position: 'fixed', left: moreOpen.left, top: moreOpen.top }}>
              {CARD_KINDS.map((k) => (
                <button key={k.label} title={k.hint} onClick={() => (setMoreOpen(null), addNode(k.kind, { engine: k.engine, ...k.data }))}>
                  <span className="glyph">
                    <k.icon size={14} aria-hidden="true" />
                  </span>
                  {k.label}
                  {k.kind === 'claude' && k.engine === defaultEngine && <kbd>default</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="sep" />
        <button className="ghost" disabled={!projectRoot} onClick={() => setBuilderOpen(true)} title="Build a board from your folders and Claude Code history" aria-label="Build board">
          <Icon name="sparkles" />
        </button>
        <button className="ghost" disabled={!projectRoot} title="Tidy: close cards whose job is over" aria-label="Tidy" onClick={() => setTidyOpen(true)}>
          <Icon name="broom" />
        </button>
        {canUndoArrange ? (
          <button className="ghost on" title="Undo arrange: put the cards back where they were" aria-label="Undo arrange" onClick={undoArrange}>
            <Icon name="undo" />
          </button>
        ) : (
          <button className="ghost" disabled={!projectRoot || !hasCards} title="Arrange: lay the cards out along the lines, workers left, the Conductor they report to right" aria-label="Arrange" onClick={arrangeAndFit}>
            <Icon name="grid" />
          </button>
        )}
        {!autonomyOn && (
          <button className="ghost" disabled={!projectRoot} onClick={() => setAutoOpen(true)} title="Autonomous mode: keep the board working while you are away, with rails and a morning report" aria-label="Autonomous mode">
            <Icon name="moon" />
          </button>
        )}
        <span className="sep" />
        <button className="ghost" title="Help: your first hour, shortcuts, the tutorial" aria-label="Help" onClick={() => setHelpOpen('help')}>
          <Icon name="help" />
        </button>
        <button className="ghost" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" />
        </button>
        <button className={`ghost${inspectorOpen ? ' on' : ''}`} disabled={!projectRoot} onClick={toggleInspector} title="Inspector: the selected card or line" aria-label="Toggle inspector" aria-pressed={inspectorOpen}>
          <Icon name="panel" />
        </button>
      </div>
      {helpOpen && <HelpDialog firstRun={helpOpen === 'first-run'} onClose={() => setHelpOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {builderOpen && <BoardBuilder onClose={() => setBuilderOpen(false)} />}
      {tidyOpen && <TidyDialog onClose={() => setTidyOpen(false)} />}
      {autoOpen && <AutonomyDialog onClose={() => setAutoOpen(false)} />}
    </div>
  )
}
