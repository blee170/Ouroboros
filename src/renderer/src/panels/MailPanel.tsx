import { useState } from 'react'
import { useBoard } from '@/store/board'
import { OWNER, type Mail } from '@shared/mail'

function when(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One card's board mail (to and from it, last week, not yet acknowledged) and a box to message it as the owner. */
export function MailPanel({ nodeId }: { nodeId: string }) {
  const mail = useBoard((s) => s.mail)
  const nodes = useBoard((s) => s.nodes)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const titleOf = (id: string): string => (id === OWNER ? 'You' : (nodes.find((n) => n.id === id)?.data.title ?? id))
  const thread = mail.filter((m) => m.to === nodeId || m.from === nodeId).sort((a, b) => a.createdAt - b.createdAt).slice(-30)
  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    const r = await window.ouroboros.mail.send(nodeId, body)
    setBusy(false)
    if (r.ok) {
      setText('')
      setError(null)
    } else setError(r.error ?? 'not sent')
  }
  const state = (m: Mail): string => (m.ackedAt ? 'handled' : m.deliveredAt ? 'read' : 'queued')
  return (
    <div className="mail-panel">
      {thread.length === 0 ? (
        <div className="muted small">No messages. Cards message each other with send_message; you can write to this card below.</div>
      ) : (
        <ul className="mail-list">
          {thread.map((m) => (
            <li key={m.id} className={`mail-item${m.to === nodeId && !m.ackedAt ? ' unread' : ''}`}>
              <div className="mail-head small">
                <span className="mono">{m.id}</span>
                <span>
                  {titleOf(m.from)} → {titleOf(m.to)}
                </span>
                {m.kind !== 'note' && <span className="mail-kind">{m.kind}</span>}
                <span className="spacer" />
                <span className="muted">
                  {state(m)} · {when(m.createdAt)}
                </span>
              </div>
              <div className="mail-body">{m.body}</div>
            </li>
          ))}
        </ul>
      )}
      <textarea className="text" rows={2} placeholder="Message this card (it gets it before it ends its turn, or now if it is idle)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
      }} />
      <div className="row">
        {error && <span className="small error-text">{error}</span>}
        <span className="spacer" />
        <button className="btn small" disabled={busy || !text.trim()} onClick={() => void send()} title="Ctrl+Enter">
          Send
        </button>
      </div>
    </div>
  )
}
