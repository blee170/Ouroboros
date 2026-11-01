import { useMemo, useState } from 'react'
import { useBoard } from '@/store/board'
import { ROUTINE_LIMITS, scheduleText, type Routine, type RoutineInput, type RoutineSchedule } from '@shared/routines'

const AGENT_KINDS = new Set(['claude', 'conductor', 'command'])
const EMPTY: RoutineInput = { name: '', prompt: '', cardId: '', schedule: 'manual', at: '09:00', everyHours: 1, enabled: true }

const when = (t: number): string => {
  const d = new Date(t)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * The Routines tab: saved prompts for one card each, run with ▶ or on a schedule (every day or every weekday at a
 * time, or every n hours) while the app is running. Main keeps them per project in the app's data folder.
 */
export function RoutinesPanel() {
  const routines = useBoard((s) => s.routines)
  const nodes = useBoard((s) => s.nodes)
  const cards = useMemo(() => nodes.filter((n) => AGENT_KINDS.has(n.data.kind)).map((n) => ({ id: n.id, title: n.data.title })), [nodes])
  const [form, setForm] = useState<RoutineInput | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const api = window.ouroboros.routines
  const startNew = (): void => {
    const conductor = nodes.find((n) => n.data.kind === 'conductor')
    setForm({ ...EMPTY, cardId: conductor?.id ?? cards[0]?.id ?? '' })
    setError('')
  }
  const save = async (): Promise<void> => {
    if (!form) return
    setBusy(true)
    try {
      const card = cards.find((c) => c.id === form.cardId)
      const r = await api.save({ ...form, cardTitle: card?.title ?? form.cardTitle })
      if (r.ok) setForm(null)
      setError(r.ok ? '' : r.error)
    } finally {
      setBusy(false)
    }
  }
  const run = async (r: Routine): Promise<void> => {
    const res = await api.run(r.id)
    setError(res.ok ? '' : `${r.name}: ${res.error}`)
  }
  const toggle = async (r: Routine): Promise<void> => {
    const res = await api.save({ ...r, enabled: !r.enabled })
    setError(res.ok ? '' : res.error)
  }
  const remove = async (r: Routine): Promise<void> => {
    if (!window.confirm(`Delete the routine "${r.name}"?`)) return
    await api.remove(r.id)
  }
  const cardName = (r: Routine): string => cards.find((c) => c.id === r.cardId)?.title ?? (r.cardTitle ? `${r.cardTitle} (not on the board)` : 'card gone')

  return (
    <div className="panel routines">
      <p className="muted small">A saved prompt for one card, sent with ▶ or on a schedule. Schedules run only while Ouroboros is open; a time missed while it was closed is shown as missed, not run late.</p>
      {error && <div className="task-error">{error}</div>}
      {!form && (
        <div className="row">
          <button className="btn small" onClick={startNew} disabled={cards.length === 0} title={cards.length === 0 ? 'Add an agent card first' : undefined}>
            New routine
          </button>
        </div>
      )}
      {form && (
        <div className="task-details routine-form">
          <label>
            <span>Name</span>
            <input className="text" value={form.name ?? ''} maxLength={ROUTINE_LIMITS.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Morning briefing" />
          </label>
          <label>
            <span>Card</span>
            <select value={form.cardId ?? ''} onChange={(e) => setForm({ ...form, cardId: e.target.value })}>
              {!cards.some((c) => c.id === form.cardId) && <option value={form.cardId ?? ''}>{form.cardTitle ? `${form.cardTitle} (not on the board)` : 'pick a card'}</option>}
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Prompt</span>
            <textarea className="text" rows={5} value={form.prompt ?? ''} maxLength={ROUTINE_LIMITS.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Read my calendar and inbox and brief me on today: meetings, mail that needs an answer, the three things to do first." />
          </label>
          <label>
            <span>When</span>
            <select value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value as RoutineSchedule })}>
              <option value="manual">Button only</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays (Mon–Fri)</option>
              <option value="hourly">Every n hours</option>
            </select>
          </label>
          {(form.schedule === 'daily' || form.schedule === 'weekdays') && (
            <label>
              <span>At (this PC's time)</span>
              <input className="text" type="time" value={form.at ?? ''} onChange={(e) => setForm({ ...form, at: e.target.value })} />
            </label>
          )}
          {form.schedule === 'hourly' && (
            <label>
              <span>Every (hours, 1–{ROUTINE_LIMITS.maxHours})</span>
              <input className="text" type="number" min={1} max={ROUTINE_LIMITS.maxHours} step={1} value={form.everyHours ?? 1} onChange={(e) => setForm({ ...form, everyHours: Number(e.target.value) })} />
            </label>
          )}
          <div className="row right">
            <button className="btn small quiet" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="btn small primary" onClick={() => void save()} disabled={busy || !form.name?.trim() || !form.prompt?.trim() || !form.cardId}>
              Save
            </button>
          </div>
        </div>
      )}
      <section className="task-group">
        <h4>Routines{routines.length > 0 && ` · ${routines.length}`}</h4>
        {routines.length === 0 && !form && <p className="muted small">None yet. A routine with no schedule is a button: the prompt you type every day, one click away.</p>}
        <ul className="task-list">
          {routines.map((r) => (
            <li key={r.id} className="task-row routine-row">
              <div className="task-line">
                <button className="btn small" onClick={() => void run(r)} title={`Send the prompt to ${cardName(r)} now`} aria-label={`Run ${r.name} now`}>
                  ▶
                </button>
                <span className="task-title" title={r.prompt}>
                  {r.name}
                </span>
                <button className="btn small quiet" onClick={() => setForm({ ...r, enabled: undefined })}>
                  Edit
                </button>
                <button className="btn small quiet danger" onClick={() => void remove(r)} aria-label={`Delete ${r.name}`}>
                  ✕
                </button>
              </div>
              <div className="task-meta">
                <span>→ {cardName(r)}</span>
                <span>
                  {scheduleText(r)}
                  {r.nextAt !== undefined && ` · next ${when(r.nextAt)}`}
                </span>
                {r.schedule !== 'manual' && (
                  <label className="routine-on">
                    <input type="checkbox" checked={r.enabled} onChange={() => void toggle(r)} /> on
                  </label>
                )}
                {r.lastRun && <span className={r.lastRun.ok ? '' : 'task-reason warn'}>{`last ${when(r.lastRun.at)}: ${r.lastRun.text}`}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
