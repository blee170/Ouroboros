import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/ledger'
import { OWNER_ACTION_LIMITS, ownerNeed } from '@shared/owner-action'

const HEAD = { approve: 'Needs your OK', do: 'Only you can do this', unknown: 'Needs your decision' } as const

/**
 * A blocked task that waits on the owner, written for someone who does not code: the request, the steps, the text to
 * copy and how to check it, with one button per answer. Approve sends the card back to work; Done marks the task done
 * and passes what the owner pasted back to the card. Shown in the Tasks tab and in Today.
 */
export function OwnerActionBox({ task, cardTitle }: { task: Task; cardTitle?: string }) {
  const need = ownerNeed(task)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null)
  const sending = useRef(false)
  // a card changed the task: what was typed was an answer to something else
  useEffect(() => setText(''), [task.updatedAt])
  if (!need) return null
  const doIt = need.kind === 'do'
  const send = async (choice: 'approve' | 'hold' | 'did'): Promise<void> => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const r = await window.ouroboros.tasks.owner(task.id, choice, text.trim() || undefined, task.updatedAt)
      setMsg(r.ok ? (r.warning ? { error: true, text: r.warning } : null) : { error: true, text: r.error ?? 'failed' })
      if (r.ok) setText('')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  const copy = async (i: number, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(i)
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500)
    } catch {
      setMsg({ error: true, text: 'Could not copy: select the text and press Ctrl+C.' })
    }
  }
  return (
    <div className={`owner-action k-${need.kind}`}>
      <div className="owner-action-head">
        {HEAD[need.kind]}
        {cardTitle && <span className="muted"> · asked by {cardTitle}</span>}
      </div>
      <div className="owner-action-ask">{need.ask}</div>
      {need.steps.length > 0 && (
        <>
          <div className="owner-action-label">{doIt ? 'What to do' : 'What happens once you approve'}</div>
          <ol className="owner-action-steps">
            {need.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {need.copy.map((c, i) => (
        <div key={i} className="owner-action-copy">
          <div className="row">
            <span className="owner-action-label">
              {c.label} <span className="muted">· {c.text.split('\n').length} lines</span>
            </span>
            <span className="spacer" />
            <button className="btn small" onClick={() => void copy(i, c.text)}>
              {copied === i ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>{c.text}</pre>
        </div>
      ))}
      {need.check && (
        <div className="owner-action-check">
          <span className="owner-action-label">How to check it worked</span> {need.check}
        </div>
      )}
      <textarea
        className="text owner-action-note"
        rows={2}
        maxLength={doIt ? OWNER_ACTION_LIMITS.pasteChars : OWNER_ACTION_LIMITS.noteChars}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={doIt ? 'Paste what you saw (optional): the card checks it' : need.kind === 'unknown' ? 'Note, or what you saw if you did it (optional)' : 'Note for the card (optional)'}
        aria-label={`Note for ${task.id}`}
      />
      <div className="row owner-action-buttons">
        <button className="btn small" disabled={busy} onClick={() => void send('hold')} title="Keep it blocked and tell the card not to do it">
          Not now
        </button>
        <span className="spacer" />
        {need.kind !== 'approve' && (
          <button className={`btn small${doIt ? ' primary' : ''}`} disabled={busy} onClick={() => void send('did')} title="You did it yourself: the task is marked done and the card is told, with what you pasted">
            {doIt ? 'Done, I did it' : 'I did it myself'}
          </button>
        )}
        {need.kind !== 'do' && (
          <button className="btn small primary" disabled={busy} onClick={() => void send('approve')} title="The card is told to go ahead now">
            Approve
          </button>
        )}
      </div>
      {msg && <div className={msg.error ? 'task-error' : 'muted small'}>{msg.text}</div>}
    </div>
  )
}
