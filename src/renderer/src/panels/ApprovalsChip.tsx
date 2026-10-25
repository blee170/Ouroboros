import { useState } from 'react'
import { useBoard } from '@/store/board'

/**
 * What cards asked the owner to allow during an autonomous run (the action gate's "ask", today `gh pr merge`):
 * a status-bar chip while any wait, opening a list with Approve / Deny. An approval is good once, for that card and
 * that exact command, for 30 minutes; the card is told by board mail either way.
 */
export function ApprovalsChip() {
  const approvals = useBoard((s) => s.approvals)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = approvals.filter((a) => a.state === 'pending')
  if (pending.length === 0) return null
  const resolve = async (id: string, approve: boolean): Promise<void> => {
    const r = await window.ouroboros.gate.resolve(id, approve)
    setError(r.ok ? (r.warning ?? null) : (r.error ?? 'failed'))
  }
  return (
    <div className="approvals">
      <button className="ghost approvals-chip" onClick={() => setOpen(!open)} title="Cards ask you to allow something only you may decide">
        {pending.length} approval{pending.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="approvals-pop" role="dialog" aria-label="Approvals">
          {pending.map((a) => (
            <div key={a.id} className="approval">
              <div className="small">
                <b>{a.title}</b> <span className="muted">{a.id} · {new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <code className="approval-cmd">{a.command}</code>
              {a.cwd && <div className="muted small mono">{a.cwd}</div>}
              <div className="row">
                <span className="spacer" />
                <button className="btn small" onClick={() => void resolve(a.id, false)}>
                  Deny
                </button>
                <button className="btn small primary" onClick={() => void resolve(a.id, true)} title="Allow this exact command once, for this card, within 30 minutes">
                  Approve once
                </button>
              </div>
            </div>
          ))}
          {error && <div className="small error-text">{error}</div>}
        </div>
      )}
    </div>
  )
}
