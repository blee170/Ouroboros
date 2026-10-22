import { useEffect, useState } from 'react'
import type { Checkpoint } from '@shared/protocol'

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Git snapshots of a card's folder: take one, restore one (undoable through its "before restore" snapshot), delete one. */
export function CheckpointsPanel({ cwd }: { cwd: string }) {
  const [items, setItems] = useState<Checkpoint[] | null>(null)
  const [label, setLabel] = useState('')
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => {
    try {
      const r = await window.ouroboros.checkpoints.list(cwd)
      setItems(r.ok ? r.checkpoints : null)
    } catch {
      setItems(null)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  if (!items) return null // not a git repository
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    try {
      const r = await fn()
      if (!r.ok) alert(r.error)
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
    const moveHead = c.headMoved && confirm('Commits were made since this snapshot.\n\nOK: also move the branch back to where it was then (the newer commits stay in the reflog and in the "before restore" snapshot).\nCancel: keep the commits — the restore is then refused.')
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
          {open ? '▾' : '▸'} Checkpoints · {items.length}
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void load()}>
          ↻
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
              ⛁ Snapshot
            </button>
          </div>
          {items.length === 0 && <div className="muted small">No snapshots yet. Take one before a risky step; the Conductor does this on its own.</div>}
          {items.length > 0 && (
            <ul className="change-list">
              {items.map((c) => (
                <li key={c.id}>
                  <span className="change-file cp-row" title={`${c.id} · ${c.commit.slice(0, 7)}${c.branch ? ` on ${c.branch}` : ''}`}>
                    <span className="cp-label">{c.label}</span>
                    <span className="muted small">
                      {when(c.createdAt)}
                      {c.headMoved ? ' · HEAD moved' : ''}
                    </span>
                  </span>
                  <button className="icon-btn" title="Restore this snapshot (undoable)" disabled={busy} onClick={() => restore(c)}>
                    ⟲
                  </button>
                  <button className="icon-btn" title="Delete this snapshot" disabled={busy} onClick={() => remove(c)}>
                    ✕
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
