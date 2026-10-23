import { useState } from 'react'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'
import { DEFAULT_AUTONOMY, IDLE_END_MINUTES, relaunchAction } from '@shared/autonomy'

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "HH:MM" today, or tomorrow when that time has passed. */
function atClock(hhmmText: string, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmmText)
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= now + 60_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * Preflight sheet for Autonomous mode: when the run ends, the caps, and exactly what the toggle does to
 * the cards that are live right now, so the owner knows what the board will look like before leaving.
 */
export function AutonomyDialog({ onClose }: { onClose: () => void }) {
  const nodes = useBoard((s) => s.nodes)
  const autonomy = useBoard((s) => s.autonomy)
  const [until, setUntil] = useState(() => hhmm(Date.now() + 8 * 3_600_000))
  const [maxDispatches, setMaxDispatches] = useState(DEFAULT_AUTONOMY.maxDispatches)
  const [stallMinutes, setStallMinutes] = useState(DEFAULT_AUTONOMY.stallMinutes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(onClose)

  const live = nodes.filter((n) => n.data.kind !== 'note' && n.data.kind !== 'browser' && n.data.kind !== 'external')
  const plan = live.map((n) => ({ n, action: relaunchAction({ kind: n.data.kind, engine: n.data.engine, ptyAlive: n.data.status !== undefined && n.data.status !== 'ended', status: n.data.status ?? 'idle' }) }))
  const relaunch = plan.filter((p) => p.action === 'relaunch')
  const close = plan.filter((p) => p.action === 'close')
  const conductor = relaunch.some((p) => p.n.data.kind === 'conductor')
  const endAt = atClock(until)

  const start = async (): Promise<void> => {
    if (!endAt) {
      setError('End time must be HH:MM')
      return
    }
    setBusy(true)
    const r = await window.ouroboros.autonomy.start({ until: endAt, maxDispatches, maxRetriesPerTitle: DEFAULT_AUTONOMY.maxRetriesPerTitle, stallMinutes })
    setBusy(false)
    if (r?.on) onClose()
    else setError('The run did not start (is the end time in the future?)')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal auto-dialog" role="dialog" aria-labelledby="auto-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="auto-title">
          <Icon name="moon" /> Autonomous mode
        </h3>
        <div className="hint">The board keeps working while you are away. The app holds the rails: nobody answers for you, nothing leaves this machine, and you come back to a report.</div>
        <div className="settings-section">
          <h4>Run</h4>
          <label className="field">
            <span>Ends at</span>
            <div className="ctl">
              <input className="text" style={{ width: 90, flex: 'none' }} value={until} onChange={(e) => setUntil(e.target.value)} placeholder="HH:MM" aria-label="End time" />
              {[4, 8].map((h) => (
                <button key={h} className="btn small" onClick={() => setUntil(hhmm(Date.now() + h * 3_600_000))}>
                  +{h} h
                </button>
              ))}
              <button className="btn small" onClick={() => setUntil('10:00')}>
                10:00
              </button>
              <span className="hint">{endAt ? `${hhmm(endAt)}${endAt - Date.now() > 20 * 3_600_000 ? ' (tomorrow)' : ''}` : '—'}</span>
            </div>
          </label>
          <label className="field">
            <span>New cards</span>
            <div className="ctl">
              <input className="text" style={{ width: 70, flex: 'none' }} type="number" min={0} max={500} value={maxDispatches} onChange={(e) => setMaxDispatches(Math.max(0, Number(e.target.value) | 0))} aria-label="Dispatch cap" />
              <span className="hint">create_agent calls for the whole run; a role may be re-made {DEFAULT_AUTONOMY.maxRetriesPerTitle} times</span>
            </div>
          </label>
          <label className="field">
            <span>Stall after</span>
            <div className="ctl">
              <input className="text" style={{ width: 70, flex: 'none' }} type="number" min={0} max={240} value={stallMinutes} onChange={(e) => setStallMinutes(Math.max(0, Number(e.target.value) | 0))} aria-label="Stall minutes" />
              <span className="hint">min of silence: nudged once, parked after another {stallMinutes || '…'} min (0 = off)</span>
            </div>
          </label>
        </div>
        <div className="settings-section">
          <h4>What happens now</h4>
          <ul className="auto-plan">
            {relaunch.map(({ n }) => (
              <li key={n.id}>
                <span className="dot" style={{ background: 'var(--accent)' }} /> <b>{n.data.title}</b> restarts in auto mode with the deny rules ({n.data.sessionId ? 'same conversation' : '--continue'})
                {n.data.kind === 'conductor' ? '; it gets the autonomous-mode brief' : ''}
              </li>
            ))}
            {close.map(({ n }) => (
              <li key={n.id}>
                <span className="dot" style={{ background: 'var(--warn)' }} /> <b>{n.data.title}</b> is closed ({n.data.engine} cards have no auto-mode rails)
              </li>
            ))}
            {relaunch.length + close.length === 0 && <li className="muted">No live agent card. The rails still apply to every card started during the run.</li>}
            {!conductor && relaunch.length > 0 && <li className="muted">No live Conductor: nothing dispatches new work; the cards above just keep their rails.</li>}
          </ul>
        </div>
        <div className="settings-section">
          <h4>Rails</h4>
          <ul className="auto-plan">
            <li>A card that asks a question, needs a permission or hits an error is <b>parked</b>: never answered for you, listed first in the report. The run ends early once nothing has worked for {IDLE_END_MINUTES} min.</li>
            <li>Every card launched during the run is denied: git push, merge, reset --hard, branch -D, clean; gh pr merge / workflow run / release; vercel, wrangler deploy, supabase db push, prisma migrate deploy; rm -rf /, ~; editing .ouroboros.json or Claude settings.</li>
            <li>The PC stays awake. Stop any time with ■ in the toolbar. The report (waiting on you · every card's branch, diff and last reply · denials · stalls · timeline) lands on the canvas as a note and in the app's data folder.</li>
          </ul>
        </div>
        {autonomy.ended && (
          <div className="hint">
            Last run ended {hhmm(autonomy.ended.at)}: {autonomy.ended.reason} · <code>{autonomy.ended.reportPath}</code>
          </div>
        )}
        {error && <div className="hint" style={{ color: 'var(--warn)' }}>{error}</div>}
        <div className="row right">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !endAt} onClick={() => void start()}>
            <Icon name="moon" size={14} /> Start until {endAt ? hhmm(endAt) : '—'}
          </button>
        </div>
      </div>
    </div>
  )
}
