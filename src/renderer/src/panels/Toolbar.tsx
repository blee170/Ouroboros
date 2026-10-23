import { useEffect, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { UpdateStatus } from '@shared/protocol'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { CARD_KINDS, ENGINE_GLYPH, ENGINE_LABEL } from '@/lib/cardKinds'
import { SettingsDialog } from './SettingsDialog'
import { BoardBuilder } from './BoardBuilder'
import { TidyDialog } from './TidyDialog'
import { AutonomyDialog } from './AutonomyDialog'

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * One row: project · the two cards you add every minute (+ Claude, + Terminal) and a menu for the rest · the
 * board's state (never pushed off) · board actions · panels · settings. Secondary buttons drop their label at
 * 1480px, every button at 1180px and the brand at 1040px, instead of wrapping the bar.
 */
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
  // the confirmation lives on the icon too, since the label is hidden at the default window width
  const justSaved = Boolean(savedAt && Date.now() - savedAt < 4000)
  const rosterOpen = useBoard((s) => s.rosterOpen)
  const inspectorOpen = useBoard((s) => s.inspectorOpen)
  const toggleRoster = useBoard((s) => s.toggleRoster)
  const toggleInspector = useBoard((s) => s.toggleInspector)
  const select = useBoard((s) => s.select)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [tidyOpen, setTidyOpen] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const autonomy = useBoard((s) => s.autonomy)
  // the menu is fixed-positioned under its button: the bar clips its own overflow, so a child dropdown would be cut off
  const [moreOpen, setMoreOpen] = useState<{ left: number; top: number } | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const openMore = (): void => {
    const r = moreRef.current?.getBoundingClientRect()
    setMoreOpen(moreOpen || !r ? null : { left: r.left, top: r.bottom + 4 })
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
    // capture phase: the canvas (d3-zoom) and card headers (d3-drag) stop mousedown from bubbling
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [moreOpen])
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
  const defaultEngine = useBoard((s) => s.settings.defaultEngine) ?? 'claude'
  const nodes = useBoard((s) => s.nodes)
  const counts = {
    working: nodes.filter((n) => n.data.status === 'working' || n.data.status === 'starting').length,
    needs: nodes.filter((n) => n.data.status === 'needs-you').length,
    idle: nodes.filter((n) => n.data.status === 'idle' || n.data.status === 'done').length,
    ended: nodes.filter((n) => n.data.status === 'ended').length
  }
  const arrange = useBoard((s) => s.arrange)
  const undoArrange = useBoard((s) => s.undoArrange)
  const canUndoArrange = useBoard((s) => Boolean(s.arrangeUndo))
  const rf = useReactFlow()
  const arrangeAndFit = (): void => {
    arrange()
    setTimeout(() => void rf.fitView({ duration: 400, padding: 0.08 }), 50)
  }
  // the state strip is the product signal: a click on "need you" jumps to the first such card, the others open the Roster
  const jumpToNode = (id: string | undefined): void => {
    if (id && nodes.some((n) => n.id === id)) {
      void rf.fitView({ nodes: [{ id }], duration: 300, padding: 0.3 })
      select(id, null)
    } else if (!rosterOpen) toggleRoster()
  }
  const jumpTo = (...statuses: string[]): void => jumpToNode(nodes.find((n) => statuses.includes(n.data.status ?? ''))?.id)

  // A window holds one project: picking another folder while one is open opens it in a new window.
  const pick = async (): Promise<void> => {
    const root = await window.ouroboros.workspace.openProject()
    if (!root) return
    if (projectRoot) await window.ouroboros.window.open(root)
    else await openProject(root)
  }

  return (
    <div className="toolbar">
      <div className="tb-group">
        <span className="brand">◎ Ouroboros</span>
        <button className="btn project-btn" onClick={() => void pick()} title={projectRoot ? `${projectRoot}\nPick another folder to open it in a new window` : 'Open a project folder'}>
          <Icon name="folder" />
          <span className="tb-label">{projectRoot ? basename(projectRoot) : 'Open project'}</span>
        </button>
        <button className="btn" title="New window (another project side by side)" onClick={() => void window.ouroboros.window.open()}>
          <Icon name="window" />
        </button>
      </div>
      <span className="sep" />
      <div className="tb-group">
        <button className="btn" disabled={!projectRoot} onClick={() => addNode('claude', { engine: defaultEngine })} title={`New ${ENGINE_LABEL[defaultEngine]} agent card (default engine, set in Settings)`}>
          <Icon name="plus" />
          <span className="glyph">{ENGINE_GLYPH[defaultEngine]}</span>
          <span className="tb-label">{ENGINE_LABEL[defaultEngine]}</span>
        </button>
        <button className="btn" disabled={!projectRoot} onClick={() => addNode('terminal')} title="New terminal card">
          <Icon name="plus" />
          <span className="glyph">▣</span>
          <span className="tb-label">Terminal</span>
        </button>
        <div className="menu-anchor" ref={moreRef}>
          <button className={`btn${moreOpen ? ' active' : ''}`} disabled={!projectRoot} onClick={openMore} title="Every kind of card (also on the canvas: right-click)" aria-expanded={Boolean(moreOpen)}>
            <Icon name="plus" />
            <span className="tb-label">More</span>
            <Icon name="chevron" size={14} />
          </button>
          {moreOpen && (
            <div className="menu" style={{ position: 'fixed', left: moreOpen.left, top: moreOpen.top }}>
              {CARD_KINDS.map((k) => (
                <button key={k.label} title={k.hint} onClick={() => (setMoreOpen(null), addNode(k.kind, { engine: k.engine, ...k.data }))}>
                  <span className="glyph">{k.glyph}</span>
                  {k.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn collapsible" disabled={!projectRoot} onClick={() => setBuilderOpen(true)} title="Build a board from your folders and Claude Code history">
          <Icon name="sparkles" />
          <span className="tb-label">Build board</span>
        </button>
      </div>
      <div className="tb-group grow">
        <div className="status-strip" title="The board right now. Click a number to go there.">
          <button className={counts.working ? '' : 'zero'} onClick={() => jumpTo('working', 'starting')} title="Cards working now">
            <span className="dot" style={{ background: 'var(--info)' }} />
            <span className="n">{counts.working}</span> <span className="w">working</span>
          </button>
          <button className={counts.needs ? '' : 'zero'} onClick={() => jumpTo('needs-you')} title="Cards waiting for you: click to jump to the first">
            <span className="dot" style={{ background: 'var(--warn)' }} />
            <span className="n">{counts.needs}</span> <span className="w">need you</span>
          </button>
          <button className={counts.idle ? '' : 'zero'} onClick={() => jumpTo('done', 'idle')} title="Cards that finished or sit idle">
            <span className="dot" style={{ background: 'var(--ok)' }} />
            <span className="n">{counts.idle}</span> <span className="w">idle</span>
          </button>
          <button className={`ended${counts.ended ? '' : ' zero'}`} onClick={() => jumpTo('ended')} title="Cards whose process ended">
            <span className="dot" style={{ background: 'var(--muted)' }} />
            <span className="n">{counts.ended}</span> <span className="w">ended</span>
          </button>
        </div>
      </div>
      <div className="tb-group">
        {autonomy.on ? (
          <div className="auto-pill" title={`Autonomous mode until ${hhmm(autonomy.until ?? 0)} · ${autonomy.dispatches}/${autonomy.maxDispatches} new cards · ${autonomy.parked.length} waiting on you${autonomy.parked.length ? ': ' + autonomy.parked.map((p) => p.title).join(', ') : ''}`}>
            <Icon name="moon" size={14} />
            <span>until {hhmm(autonomy.until ?? 0)}</span>
            {autonomy.parked.length > 0 && (
              <button className="parked" onClick={() => jumpToNode(autonomy.parked[0].id)} title="Cards parked for you: jump to the first">
                {autonomy.parked.length} parked
              </button>
            )}
            <button className="icon-btn" onClick={() => void window.ouroboros.autonomy.stop()} title="Stop the autonomous run now (the report lands on the canvas)" aria-label="Stop autonomous mode">
              <Icon name="stop" size={12} />
            </button>
          </div>
        ) : (
          <button className="btn collapsible" disabled={!projectRoot} onClick={() => setAutoOpen(true)} title="Autonomous mode: keep the board working while you are away, with rails and a morning report">
            <Icon name="moon" />
            <span className="tb-label">Autonomous</span>
          </button>
        )}
        <button className={`btn collapsible${justSaved ? ' saved' : ''}`} onClick={persist} disabled={!projectRoot} title={savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()} · also auto-saved after every change` : 'Save .ouroboros.json now (changes are auto-saved too)'}>
          <Icon name={justSaved ? 'check' : 'save'} />
          <span className="tb-label">{justSaved ? 'Saved' : 'Save'}</span>
        </button>
        <button className="btn collapsible" disabled={!projectRoot} title="Close cards whose job is over" onClick={() => setTidyOpen(true)}>
          <Icon name="broom" />
          <span className="tb-label">Tidy</span>
        </button>
        {canUndoArrange ? (
          <button className="btn collapsible" title="Put the cards back where they were before Arrange" onClick={undoArrange}>
            <Icon name="undo" />
            <span className="tb-label">Undo arrange</span>
          </button>
        ) : (
          <button className="btn collapsible" disabled={!projectRoot || !nodes.some((n) => n.data.kind !== 'external')} title="Lay the cards out along the lines: workers on the left, the Conductor they report to on the right, briefs and notes beside it" onClick={arrangeAndFit}>
            <Icon name="grid" />
            <span className="tb-label">Arrange</span>
          </button>
        )}
      </div>
      <span className="sep" />
      <div className="tb-group">
        <button className={`btn${rosterOpen ? ' active' : ''}`} onClick={toggleRoster} title="Roster: every card, and a prompt box that sends to the checked ones" aria-pressed={rosterOpen}>
          Roster
        </button>
        <button className={`btn${inspectorOpen ? ' active' : ''}`} onClick={toggleInspector} title="Inspector: the selected card or line" aria-pressed={inspectorOpen}>
          Inspector
        </button>
        {(upd?.state === 'available' || upd?.state === 'ready' || upd?.state === 'downloading') && (
          <button className="btn update-badge" title={upd.state === 'ready' ? 'Restart to install' : 'Open settings to update'} onClick={() => (upd.state === 'ready' ? void window.ouroboros.update.install() : setSettingsOpen(true))}>
            ⬆ {upd.state === 'ready' ? `Restart for v${upd.version}` : upd.state === 'downloading' ? `${upd.percent ?? 0}%` : `v${upd.version} available`}
          </button>
        )}
        <button className="btn" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" />
        </button>
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {builderOpen && <BoardBuilder onClose={() => setBuilderOpen(false)} />}
      {tidyOpen && <TidyDialog onClose={() => setTidyOpen(false)} />}
      {autoOpen && <AutonomyDialog onClose={() => setAutoOpen(false)} />}
    </div>
  )
}
