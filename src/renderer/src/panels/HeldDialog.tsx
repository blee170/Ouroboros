import { useState } from 'react'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import type { HeldChange } from '@shared/board-trust'

// shown in full: a harmless start could hide what follows it
const show = (v: string | null): string => (v === null ? '(unset)' : v)

function ChangeRow({ c }: { c: HeldChange }) {
  return (
    <li className="held-change">
      <code>{c.field}</code>
      <span className="muted small">{show(c.before)}</span>
      <span aria-hidden>→</span>
      <span className="small">{show(c.after)}</span>
    </li>
  )
}

/**
 * Cards whose launch fields (permission mode, board tools, startup command, MCP servers, …) were changed in
 * `.ouroboros.json` by something other than this app — another card can write that file. Main refuses to launch
 * them until the owner trusts the change or reverts it.
 */
export function HeldDialog() {
  const held = useBoard((s) => s.held)
  const resolveHeld = useBoard((s) => s.resolveHeld)
  const [busy, setBusy] = useState(false)
  if (!held.length) return null
  const decide = async (ids: string[], revert: boolean): Promise<void> => {
    setBusy(true)
    try {
      await resolveHeld(ids, revert)
    } finally {
      setBusy(false)
    }
  }
  const all = held.map((h) => h.nodeId)
  return (
    <div className="modal-backdrop">
      <div className="modal wide-ish" role="dialog" aria-labelledby="held-title">
        <h3 id="held-title">
          <Icon name="stop" /> Board file changed outside Ouroboros
        </h3>
        <div className="hint">
          Since Ouroboros last saved <code>.ouroboros.json</code>, something else changed what these cards run or may do. A card can write that file, so
          they are not started until you look. <b>Revert</b> puts back what Ouroboros saved (a card it never saved is removed); <b>Trust</b> keeps the change.
        </div>
        <ul className="held-list">
          {held.map((h) => (
            <li key={h.nodeId} className="held-card">
              <div className="row">
                <span className="title">{h.title}</span>
                {h.added && <span className="muted small">new card</span>}
                <span className="spacer" />
                <button className="btn small" disabled={busy} onClick={() => void decide([h.nodeId], true)}>
                  <Icon name="revert" size={13} /> Revert
                </button>
                <button className="btn small" disabled={busy} onClick={() => void decide([h.nodeId], false)}>
                  Trust
                </button>
              </div>
              <ul className="held-changes">
                {h.changes.map((c) => (
                  <ChangeRow key={c.field} c={c} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="row right">
          <button className="btn" disabled={busy} onClick={() => void decide(all, false)}>
            Trust all
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void decide(all, true)}>
            Revert all
          </button>
        </div>
      </div>
    </div>
  )
}
