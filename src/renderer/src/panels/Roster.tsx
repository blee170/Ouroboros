import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import { typePrompt } from '@/lib/typePrompt'
import { ROSTER_GROUPS, rosterOrder } from '@/lib/rosterOrder'

export function Roster() {
  const allNodes = useBoard((s) => s.nodes)
  const nodes = useMemo(() => rosterOrder(allNodes), [allNodes])
  const ordered = nodes
  const select = useBoard((s) => s.select)
  const rf = useReactFlow()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [text, setText] = useState('')

  const focus = (id: string): void => {
    const n = rf.getNode(id)
    if (n) void rf.fitView({ nodes: [{ id }], duration: 400, padding: 0.3 })
    select(id, null)
  }
  const targets = nodes.filter((n) => checked[n.id] && n.data.kind !== 'external')
  const broadcast = (): void => {
    if (!text.trim() || !targets.length) return
    for (const n of targets) typePrompt(n.id, text)
    setText('')
  }

  return (
    <div className="panel roster">
      <h3>Roster</h3>
      {nodes.length === 0 && <div className="muted small">No agents yet.</div>}
      <ul className="roster-list">
        {ROSTER_GROUPS.map((g) => {
          const members = nodes.filter((n) => g.statuses.includes(n.data.status ?? 'starting'))
          if (!members.length) return null
          return [
            <li key={`h-${g.label}`} className="roster-group">
              <span>{g.label}</span>
              <span className="muted small">{members.length}</span>
              <button className="link small" title="Check all in this group" onClick={() => setChecked({ ...checked, ...Object.fromEntries(members.filter((m) => m.data.kind !== 'external').map((m) => [m.id, true])) })}>
                select
              </button>
            </li>,
            ...members.map((n) => {
          const st = n.data.status ?? 'starting'
          return (
            <li key={n.id} className={`roster-item status-${st}`}>
              <input type="checkbox" disabled={n.data.kind === 'external'} checked={Boolean(checked[n.id])} onChange={(e) => setChecked({ ...checked, [n.id]: e.target.checked })} />
              <button className="roster-main" onClick={() => focus(n.id)}>
                <span className="status-dot" style={{ background: STATUS_COLOR[st] }} />
                <span className="title">{n.data.title}</span>
                {ordered.indexOf(n) < 9 && <kbd className="hotkey">Ctrl+{ordered.indexOf(n) + 1}</kbd>}
                <span className="muted small">{STATUS_LABEL[st]}{n.data.statusDetail ? ` · ${n.data.statusDetail}` : ''}</span>
                {n.data.lastAssistantMessage && <span className="small clamp">{n.data.lastAssistantMessage}</span>}
              </button>
            </li>
          )
            })
          ]
        })}
      </ul>
      <div className="block">
        <div className="muted small">Send to {targets.length} checked card{targets.length === 1 ? '' : 's'} (Ctrl+1…9 focuses cards, Ctrl+F finds one by title)</div>
        <textarea rows={3} value={text} placeholder="Type a prompt for all checked agents…" onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={!targets.length || !text.trim()} onClick={broadcast}>
          Send to {targets.length}
        </button>
      </div>
    </div>
  )
}
