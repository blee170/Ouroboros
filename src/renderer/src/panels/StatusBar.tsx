import { useEffect, useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { AgentStatus } from '@shared/types'
import { summarizeTasks } from '@shared/ledger'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { StateGlyph } from '@/lib/StateGlyph'
import { rosterOrder } from '@/lib/rosterOrder'
import { hottestWindow, resetsIn } from '@shared/usage'

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The status bar, 24px. Left: the board's state as counts (a click jumps to the first such card). Right: the
 * autonomous run while one is on, an update when there is one, and when the board was last saved.
 */
export function StatusBar() {
  const nodes = useBoard((s) => s.nodes)
  const select = useBoard((s) => s.select)
  const rosterOpen = useBoard((s) => s.rosterOpen)
  const toggleRoster = useBoard((s) => s.toggleRoster)
  const autonomy = useBoard((s) => s.autonomy)
  const persist = useBoard((s) => s.persist)
  const savedAt = useBoard((s) => s.savedAt)
  const saveError = useBoard((s) => s.saveError)
  const rf = useReactFlow()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => tick((x) => x + 1), 4200) // "Saved" settles back into the time after a moment
    return () => clearTimeout(t)
  }, [savedAt])
  const justSaved = Boolean(savedAt && Date.now() - savedAt < 4000)
  const upd = useBoard((s) => s.updateStatus)
  const usage = useBoard((s) => s.usage)
  const tasks = useBoard((s) => s.tasks)
  const showRpanel = useBoard((s) => s.showRpanel)
  const taskCounts = useMemo(() => summarizeTasks(tasks), [tasks])

  // the same cards in the same order as the sidebar: a card with no status yet counts as starting, and
  // "the first" card of a state is the first row there
  const agents = useMemo(() => rosterOrder(nodes), [nodes])
  // Claude cards past 70% of their context window, hottest first: the one thing about usage worth a chip
  const hot = useMemo(
    () =>
      nodes
        .filter((n) => usage[n.id] && usage[n.id].contextTokens / usage[n.id].contextWindow >= 0.7)
        .map((n) => ({ id: n.id, title: n.data.title, pct: Math.round((usage[n.id].contextTokens / usage[n.id].contextWindow) * 100) }))
        .sort((a, b) => b.pct - a.pct),
    [nodes, usage]
  )
  // the account's plan windows, one chip: "Claude 5h 42% · 7d 61%" (the Claude plan, else Codex); orange from 90%
  const accountUsage = useBoard((s) => s.accountUsage)
  const setUsageOpen = useBoard((s) => s.setUsageOpen)
  const planChip = useMemo(() => {
    const u = accountUsage?.engines.find((e) => e.windows.length) ?? undefined
    if (!u) return null
    const five = u.windows.find((w) => w.id === 'five_hour')
    const week = u.windows.find((w) => w.id === 'seven_day')
    const shown = [five && { short: '5h', w: five }, week && { short: '7d', w: week }].filter(Boolean) as Array<{ short: string; w: (typeof u.windows)[number] }>
    const lead = shown.length ? shown : [{ short: '', w: hottestWindow(u.windows)! }]
    const name = u.engine === 'claude' ? 'Claude' : u.engine === 'codex' ? 'Codex' : 'Gemini'
    const now = Date.now()
    return {
      text: `${name} ${lead.map((x) => `${x.short ? x.short + ' ' : ''}${Math.round(x.w.usedPct)}%`).join(' · ')}`,
      hot: lead.some((x) => x.w.usedPct >= 90),
      title: `${name} plan usage: ${u.windows.map((w) => `${w.label} ${Math.round(w.usedPct)}%${w.resetsAt ? ` (${resetsIn(w.resetsAt, now)})` : ''}`).join(', ')}. Click for every engine.`
    }
  }, [accountUsage])
  const count = (...statuses: string[]): number => agents.filter((n) => statuses.includes(n.data.status ?? 'starting')).length
  const groups: Array<{ status: AgentStatus; statuses: string[]; label: string; hint: string }> = [
    { status: 'working', statuses: ['working', 'starting'], label: 'working', hint: 'Cards working now' },
    { status: 'needs-you', statuses: ['needs-you'], label: 'need you', hint: 'Cards waiting for you: click to jump to the first' },
    { status: 'done', statuses: ['done'], label: 'ready', hint: 'Cards that finished a turn: read the reply, then the diff' },
    { status: 'idle', statuses: ['idle'], label: 'idle', hint: 'Cards waiting for a prompt' }
  ]
  const ended = count('ended')
  // a click jumps to the first card in that state; with none, it opens the sidebar
  const jumpToNode = (id: string | undefined): void => {
    if (id && nodes.some((n) => n.id === id)) {
      void rf.fitView({ nodes: [{ id }], duration: 300, padding: 0.3 })
      select(id, null)
    } else if (!rosterOpen) toggleRoster()
  }
  const jumpTo = (statuses: string[]): void => jumpToNode(agents.find((n) => statuses.includes(n.data.status ?? 'starting'))?.id)
  // an update was found: show it until it is installed; a failed download keeps the version it was found with
  const failed = upd?.state === 'error' && Boolean(upd.version)
  const updating = upd?.state === 'available' || upd?.state === 'ready' || upd?.state === 'downloading' || failed

  return (
    <div className="statusbar">
      {groups.map((g) => {
        const n = count(...g.statuses)
        return (
          <button key={g.status} className={`ghost${n ? '' : ' zero'}`} onClick={() => jumpTo(g.statuses)} title={g.hint}>
            <StateGlyph status={g.status} size={11} title={g.label} decorative />
            <span className="n">{n}</span> {g.label}
          </button>
        )
      })}
      {ended > 0 && (
        <button className="ghost" onClick={() => jumpTo(['ended'])} title="Cards whose process ended (Tidy closes them)">
          <StateGlyph status="ended" size={11} title="ended" decorative />
          <span className="n">{ended}</span> ended
        </button>
      )}
      <span className="spacer" />
      {(taskCounts.doing > 0 || taskCounts.blocked > 0 || taskCounts.todo > 0) && (
        <button className={`ghost${taskCounts.blocked ? ' ctx-chip' : ''}`} onClick={() => showRpanel('tasks')} title={`Task ledger: ${taskCounts.todo} to do, ${taskCounts.doing} doing, ${taskCounts.blocked} blocked, ${taskCounts.done} done. Click to open the Tasks tab.`}>
          <Icon name="tasks" size={12} />
          <span className="n">{taskCounts.doing}</span> doing
          {taskCounts.blocked > 0 && (
            <>
              {' · '}
              <span className="n">{taskCounts.blocked}</span> need you
            </>
          )}
        </button>
      )}
      {planChip && (
        <button className={`ghost plan-chip${planChip.hot ? ' hot' : ''}`} onClick={() => setUsageOpen(true)} title={planChip.title}>
          <Icon name="usage" size={12} />
          {planChip.text}
        </button>
      )}
      {hot.length > 0 && (
        <button className="ghost ctx-chip" onClick={() => jumpToNode(hot[0].id)} title={`Context nearly full: ${hot.map((h) => `${h.title} ${h.pct}%`).join(', ')}. Ask the card to /compact, or start a fresh card. Click to jump to the fullest.`}>
          <Icon name="gauge" size={12} />
          <span className="n">{hot.length}</span> near context limit
        </button>
      )}
      {autonomy.on && (
        <div className="auto-pill" title={`Autonomous mode until ${hhmm(autonomy.until ?? 0)} · ${autonomy.dispatches}/${autonomy.maxDispatches} new cards · ${autonomy.parked.length} waiting on you${autonomy.parked.length ? ': ' + autonomy.parked.map((p) => p.title).join(', ') : ''}`}>
          <Icon name="moon" size={12} />
          <span>until {hhmm(autonomy.until ?? 0)}</span>
          {autonomy.parked.length > 0 && (
            <button className="parked" onClick={() => jumpToNode(autonomy.parked[0].id)} title="Cards parked for you: jump to the first">
              {autonomy.parked.length} parked
            </button>
          )}
          <button className="icon-btn" onClick={() => void window.ouroboros.autonomy.stop()} title="Stop the autonomous run now (the report lands on the canvas)" aria-label="Stop autonomous mode">
            <Icon name="stop" size={11} />
          </button>
        </div>
      )}
      {updating && upd && (
        <button
          className={`ghost update-badge${failed ? ' failed' : ''}`}
          title={failed ? `${upd.message ?? 'The download failed'} · click to try again` : upd.state === 'ready' ? 'Restart to install the update' : upd.state === 'downloading' ? 'Downloading the update' : 'Download the update'}
          disabled={upd.state === 'downloading'}
          onClick={() => (upd.state === 'ready' ? void window.ouroboros.update.install() : void window.ouroboros.update.download())}
        >
          <Icon name="up" size={12} />
          {failed ? `v${upd.version} failed` : upd.state === 'ready' ? `Restart for v${upd.version}` : upd.state === 'downloading' ? `${upd.percent ?? 0}%` : `v${upd.version} available`}
        </button>
      )}
      {saveError ? (
        <button className="ghost save-failed" onClick={persist} title={`${saveError}\nClick to save again`}>
          <Icon name="save" size={12} />
          Save failed
        </button>
      ) : (
        <button className="ghost" onClick={persist} title={savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()} · also auto-saved after every change (Ctrl+S)` : 'Save .ouroboros.json now (changes are auto-saved too)'}>
          <Icon name={justSaved ? 'check' : 'save'} size={12} />
          {justSaved ? 'Saved' : savedAt ? `Saved ${hhmm(savedAt)}` : 'Save'}
        </button>
      )}
    </div>
  )
}
