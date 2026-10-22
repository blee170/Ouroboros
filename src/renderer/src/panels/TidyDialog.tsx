import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'

export function TidyDialog({ onClose }: { onClose: () => void }) {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const [minutes, setMinutes] = useState(30)
  const [cands, setCands] = useState<Array<{ id: string; title: string; reason: string }>>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const refresh = async (m = minutes): Promise<void> => {
    setBusy(true)
    const c = await window.ouroboros.tidy.candidates(m)
    setCands(c)
    setChecked(Object.fromEntries(c.map((x) => [x.id, true])))
    setBusy(false)
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = async (): Promise<void> => {
    const ids = cands.filter((c) => checked[c.id]).map((c) => c.id)
    if (!ids.length) return
    await window.ouroboros.tidy.apply(ids)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🧹 Tidy cards</h3>
        <div className="row">
          <span className="small">Close cards that exited, or finished/idle for more than</span>
          <input className="text" style={{ width: 70 }} type="number" min={1} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) | 0))} />
          <span className="small">min</span>
          <button className="btn small" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <ul className="roster-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {cands.map((c) => (
            <li key={c.id} className="roster-item">
              <input type="checkbox" checked={Boolean(checked[c.id])} onChange={(e) => setChecked({ ...checked, [c.id]: e.target.checked })} />
              <div className="roster-main" style={{ cursor: 'default' }}>
                <span className="status-dot" style={{ background: '#525252' }} />
                <span className="title">{c.title}</span>
                <span className="muted small">{c.reason}</span>
              </div>
            </li>
          ))}
          {!busy && cands.length === 0 && <li className="muted small">Nothing to tidy. Conductors, working and waiting cards are never listed.</li>}
        </ul>
        <label className="row">
          <input
            type="checkbox"
            checked={(settings.autoTidyMinutes ?? 0) > 0}
            onChange={(e) => void setSettings({ autoTidyMinutes: e.target.checked ? minutes : 0 })}
          />
          Auto-tidy every minute using this threshold {settings.autoTidyMinutes ? `(currently ${settings.autoTidyMinutes} min)` : ''}
        </label>
        <div className="row right">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={!cands.some((c) => checked[c.id])} onClick={() => void apply()}>
            Close {cands.filter((c) => checked[c.id]).length} card(s)
          </button>
        </div>
      </div>
    </div>
  )
}
