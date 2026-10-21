import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import { toPastePayload } from '@shared/handoff'

export function Roster() {
  const allNodes = useBoard((s) => s.nodes)
  const nodes = useMemo(() => allNodes.filter((n) => n.data.kind !== 'note' && n.data.kind !== 'browser'), [allNodes])
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
    for (const n of targets) {
      window.ouroboros.pty.write(n.id, toPastePayload(text))
      setTimeout(() => window.ouroboros.pty.write(n.id, '\r'), 150)
    }
    setText('')
  }

  return (
    <div className="panel roster">
      <h3>Roster</h3>
      {nodes.length === 0 && <div className="muted small">No agents yet.</div>}
      <ul className="roster-list">
        {nodes.map((n) => {
          const st = n.data.status ?? 'starting'
          return (
            <li key={n.id} className={`roster-item status-${st}`}>
              <input type="checkbox" disabled={n.data.kind === 'external'} checked={Boolean(checked[n.id])} onChange={(e) => setChecked({ ...checked, [n.id]: e.target.checked })} />
              <button className="roster-main" onClick={() => focus(n.id)}>
                <span className="status-dot" style={{ background: STATUS_COLOR[st] }} />
                <span className="title">{n.data.title}</span>
                <span className="muted small">{STATUS_LABEL[st]}{n.data.statusDetail ? ` · ${n.data.statusDetail}` : ''}</span>
                {n.data.lastAssistantMessage && <span className="small clamp">{n.data.lastAssistantMessage}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="block">
        <div className="muted small">Broadcast to {targets.length} selected</div>
        <textarea rows={3} value={text} placeholder="Type a prompt for all checked agents…" onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={!targets.length || !text.trim()} onClick={broadcast}>
          Send to {targets.length}
        </button>
      </div>
    </div>
  )
}
