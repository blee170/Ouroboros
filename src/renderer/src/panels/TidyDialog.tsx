import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'
import { SLEEP_MAX_MINUTES, SLEEP_MIN_MINUTES, sleepMinutes } from '@shared/sleep'

export function TidyDialog({ onClose }: { onClose: () => void }) {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const [minutes, setMinutes] = useState(30)
  const [includeOwn, setIncludeOwn] = useState(false)
  const [cands, setCands] = useState<Array<{ id: string; title: string; reason: string }>>([])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [slept, setSlept] = useState<string | null>(null)
  const retire = settings.retireMinutes ?? 5
  useEscape(onClose)

  const sleepFinished = async (): Promise<void> => {
    const r = await window.ouroboros.board.sleepFinished()
    setSlept(r.slept ? `${r.slept} card(s) put to sleep.` : 'No card to put to sleep: only finished Claude cards with a conversation sleep (not Conductors, pinned, working, waiting or wired-to-working cards).')
    void refresh()
  }

  const refresh = async (m = minutes, own = includeOwn): Promise<void> => {
    setBusy(true)
    const c = await window.ouroboros.tidy.candidates(m, own)
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
      <div className="modal" role="dialog" aria-labelledby="tidy-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="tidy-title">
          <Icon name="broom" /> Tidy cards
        </h3>
        <div className="hint">Cards dispatched by a Conductor or team whose job is over: process exited, report delivered, or idle with no report line (your own cards: exited or idle) for more than</div>
        <div className="row">
          <input className="text" style={{ width: 70, flex: 'none' }} type="number" min={1} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) | 0))} aria-label="Idle minutes" />
          <span className="small">min</span>
          <label className="check" style={{ margin: '0 0 0 8px' }}>
            <input
              type="checkbox"
              checked={includeOwn}
              onChange={(e) => {
                setIncludeOwn(e.target.checked)
                void refresh(minutes, e.target.checked)
              }}
            />
            include cards I made myself
          </label>
          <span className="spacer" />
          <button className="btn small" disabled={busy} onClick={() => void refresh()}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        </div>
        <ul className="tidy-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {cands.map((c) => (
            <li key={c.id} className="tidy-row">
              <input type="checkbox" checked={Boolean(checked[c.id])} onChange={(e) => setChecked({ ...checked, [c.id]: e.target.checked })} aria-label={`Close ${c.title}`} />
              <div className="tidy-main">
                <span className="title">{c.title}</span>
                <span className="muted small">{c.reason}</span>
              </div>
            </li>
          ))}
          {!busy && cands.length === 0 && <li className="muted small">Nothing to tidy. Conductors, pinned, working and waiting cards are never listed{includeOwn ? '' : '; your own cards only when asked'}.</li>}
        </ul>
        <label className="field">
          <span>Auto-retire</span>
          <div className="ctl">
            <input className="text" style={{ width: 80, flex: 'none' }} type="number" min={0} max={1440} defaultValue={retire} onBlur={(e) => void setSettings({ retireMinutes: Math.min(1440, Math.max(0, Number(e.target.value) | 0)) })} />
            <span className="small">min</span>
          </div>
          <div className="hint">After a dispatched card's report reached the card that made it (0 = never). Cards you made are never auto-closed.</div>
        </label>
        <label className="field">
          <span>Sleep finished cards</span>
          <div className="ctl">
            <input
              className="text"
              style={{ width: 80, flex: 'none' }}
              type="number"
              min={0}
              max={SLEEP_MAX_MINUTES}
              defaultValue={sleepMinutes(settings.sleepMinutes) || ''}
              placeholder="off"
              onBlur={(e) => void setSettings({ sleepMinutes: sleepMinutes(e.target.value) })}
              aria-label="Sleep finished cards after minutes"
            />
            <span className="small">min</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => void sleepFinished()}>
              <Icon name="moon" size={13} /> Sleep finished cards now
            </button>
          </div>
          <div className="hint">
            Your own Claude cards done or idle this long are put to sleep: the process stops, the card and its conversation stay, and it wakes on the same conversation when you press Wake or send it a prompt. Empty or 0 = off; at least {SLEEP_MIN_MINUTES} min. Never removes a card.
          </div>
          {slept && <div className="hint">{slept}</div>}
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
