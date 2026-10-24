import { useEffect, useState } from 'react'
import { Icon } from '@/lib/icons'
import type { Checkpoint } from '@shared/protocol'

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Git snapshots of a card's folder: take one, restore one (undoable through its "before restore" snapshot), delete one. */
export function CheckpointsPanel({ cwd }: { cwd: string }) {
  const [items, setItems] = useState<Checkpoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => {
    try {
      const r = await window.ouroboros.checkpoints.list(cwd)
      setItems(r.ok ? r.checkpoints : null)
      setError(r.ok ? null : r.error)
    } catch (err) {
      setItems(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  if (!items) {
    // not a git repository: nothing to show; any other trouble (git missing, folder gone) must not hide silently
    if (!error || error === 'not a git repository') return null
    return (
      <div className="changes">
        <div className="muted small" style={{ overflowWrap: 'anywhere' }}>
          Checkpoints: {error}
        </div>
      </div>
    )
  }
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    try {
      const r = await fn()
      if (!r.ok) alert(r.error)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      await load()
    }
  }
  const snapshot = (): Promise<void> =>
    run(async () => {
      const r = await window.ouroboros.checkpoints.create(cwd, label.trim() || undefined)
      if (r.ok) setLabel('')
      return r
    })
  const restore = (c: Checkpoint): void => {
    if (!confirm(`Restore "${c.label}" (${when(c.createdAt)})?\n\nEvery file in this folder goes back to that snapshot (gitignored files stay). The current state is saved first as "before restore: ${c.label}", so this can be undone.`)) return
    const moveHead = c.headMoved && confirm('Commits were made since this snapshot.\n\nOK: also move the branch back to where it was then (the newer commits stay in the reflog and in the "before restore" snapshot). This acts on the whole repository: everything in it is unstaged, while only this folder\'s files are restored.\nCancel: keep the commits — the restore is then refused.')
    void run(() => window.ouroboros.checkpoints.restore(cwd, c.id, moveHead))
  }
  const remove = (c: Checkpoint): void => {
    if (!confirm(`Delete snapshot "${c.label}"?`)) return
    void run(() => window.ouroboros.checkpoints.delete(cwd, c.id))
  }
  return (
    <div className="changes">
      <div className="row between">
        <button className="link" onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={12} style={{ transform: open ? 'none' : 'rotate(-90deg)' }} /> Checkpoints · {items.length}
        </button>
        <button className="icon-btn" title="Refresh" aria-label="Refresh checkpoints" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {open && (
        <>
          <div className="row">
            <input
              className="text"
              placeholder="label, e.g. before implement"
              value={label}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void snapshot()
              }}
            />
            <button className="btn" disabled={busy} onClick={() => void snapshot()} title="Git snapshot of this folder (every non-gitignored file); changes nothing on disk">
              <Icon name="snapshot" size={14} /> Snapshot
            </button>
          </div>
          {items.length === 0 && <div className="muted small">No snapshots yet. Take one before a risky step; the Conductor does this on its own.</div>}
          {items.length > 0 && (
            <ul className="change-list">
              {items.map((c) => (
                <li key={c.id}>
                  <span className="change-file cp-row" title={`${c.id} · ${c.commit.slice(0, 7)}${c.branch ? ` on ${c.branch}` : ''}`}>
                    <span className="cp-label" title={c.label}>
                      {c.label}
                    </span>
                    <span className="muted small">
                      {when(c.createdAt)}
                      {c.headMoved ? ' · HEAD moved' : ''}
                    </span>
                  </span>
                  <button className="icon-btn" title="Restore this snapshot (undoable)" aria-label="Restore this snapshot" disabled={busy} onClick={() => restore(c)}>
                    <Icon name="restore" size={13} />
                  </button>
                  <button className="icon-btn" title="Delete this snapshot" aria-label="Delete this snapshot" disabled={busy} onClick={() => remove(c)}>
                    <Icon name="close" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
