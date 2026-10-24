import { useEffect, useState } from 'react'
import type { AgentEngine } from '@shared/types'
import { agoText, resetsIn, type EngineUsage, type UsageWindow } from '@shared/usage'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'
import { ENGINE_ICON } from '@/lib/cardKinds'

const ENGINE_NAME: Record<AgentEngine, string> = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' }

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** "Tue 14:30" for a reset more than a day away, "14:30" otherwise. */
const when = (t: number, now: number): string => (t - now > 24 * 3_600_000 ? `${new Date(t).toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(t)}` : hhmm(t))
const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function Bar({ w, now }: { w: UsageWindow; now: number }) {
  const pct = Math.round(w.usedPct)
  return (
    <div className={`usage-row${pct >= 90 ? ' hot' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={w.label}>
      <span className="usage-label">{w.label}</span>
      <span className="usage-track">
        <span className="usage-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="usage-pct">{pct}%</span>
      <span className="usage-reset">{w.resetsAt ? `${resetsIn(w.resetsAt, now)} · ${when(w.resetsAt, now)}` : ''}</span>
    </div>
  )
}

/** Where the numbers came from, in words: the card, the endpoint, the file; and how old they are. */
function sourceText(u: EngineUsage, cardTitle: (id: string) => string | undefined, now: number): string {
  const age = agoText(u.source.at, now)
  switch (u.source.kind) {
    case 'statusline':
      return `From Claude Code's status line in "${(u.source.detail && cardTitle(u.source.detail)) ?? 'a card'}", ${age}. Exact: the same numbers as /usage.`
    case 'oauth':
      return `From claude.ai (the endpoint /usage reads), ${age}. Asked at most every 5 min while no card is running.`
    case 'rollout':
      return `From the last Codex request on this machine, ${u.source.at ? `${age} (${hhmm(u.source.at)})` : 'time unknown'}. Exact as of that request.`
    case 'sessions':
      return 'Summed from the Gemini session files on this machine. Exact for this PC; other devices are not counted.'
    default:
      return ''
  }
}

function EngineSection({ u, now, cardTitle }: { u: EngineUsage; now: number; cardTitle: (id: string) => string | undefined }) {
  const I = ENGINE_ICON[u.engine]
  const stateWord =
    u.state === 'ok' ? (u.plan ? u.plan : 'signed in') : u.state === 'not-installed' ? 'not installed' : u.state === 'not-signed-in' ? 'not signed in' : u.state === 'api-key' ? 'API key' : u.state === 'unavailable' ? 'unavailable' : 'no data yet'
  return (
    <section className={`usage-engine ${u.state}`}>
      <h4>
        <I className="ico" size={14} aria-hidden="true" /> {ENGINE_NAME[u.engine]}
        <span className="usage-state">{stateWord}</span>
      </h4>
      {u.windows.length > 0 && (
        <div className="usage-bars">
          {u.windows.map((w) => (
            <Bar key={w.id} w={w} now={now} />
          ))}
        </div>
      )}
      {(u.tokens || typeof u.costUsd === 'number') && (
        <div className="usage-tokens">
          {u.tokens && (
            <span>
              {u.tokens.label}: <b>{fmtTokens(u.tokens.total)}</b>
              {u.tokens.today !== undefined && u.tokens.today !== u.tokens.total ? ` (today ${fmtTokens(u.tokens.today)})` : ''}
            </span>
          )}
          {typeof u.costUsd === 'number' && (
            <span title="Sum of the running cards' session cost as Claude Code estimates it at API list price; a subscription does not pay this">
              Cards' session cost: <b>${u.costUsd.toFixed(2)}</b> (list-price estimate)
            </span>
          )}
        </div>
      )}
      {u.message && <div className="hint">{u.message}</div>}
      {u.source.kind !== 'none' && <div className="usage-source">{sourceText(u, cardTitle, now)}</div>}
    </section>
  )
}

/**
 * Usage: per engine, the account's rate-limit windows (Claude's 5-hour and weekly bars, per-model buckets; Codex's
 * 5-hour and weekly limits), when each resets, and the token totals a CLI records. Every number says where it came
 * from and how old it is. Refreshes on open and every 60 s while open.
 */
export function UsageDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose)
  const snap = useBoard((s) => s.accountUsage)
  const setAccountUsage = useBoard((s) => s.setAccountUsage)
  const nodes = useBoard((s) => s.nodes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // the button forces a read (the Claude endpoint at most once a minute); the timer only re-reads files and caches,
  // so an open dialog never polls claude.ai faster than the 5-minute interval
  const read = (force: boolean): void => {
    setBusy(true)
    setError('')
    void (force ? window.ouroboros.usage.refresh() : window.ouroboros.usage.get())
      .then((s) => {
        setAccountUsage(s)
        setNow(Date.now())
      })
      .catch((err: Error) => setError(`Could not read usage: ${err?.message ?? String(err)}`))
      .finally(() => setBusy(false))
  }
  const refresh = (): void => read(true)
  useEffect(() => {
    refresh()
    const t = setInterval(() => read(false), 60_000)
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      clearInterval(t)
      clearInterval(tick)
    }
  }, [])
  const cardTitle = (id: string): string | undefined => nodes.find((n) => n.id === id)?.data.title
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal usage-dialog" role="dialog" aria-label="Usage">
        <h3>
          <Icon name="usage" size={16} /> Usage
          <span className="spacer" />
          <button className="icon-btn" title="Read again now" aria-label="Refresh usage" onClick={refresh} disabled={busy}>
            <Icon name="refresh" size={14} className={busy ? 'spin' : undefined} />
          </button>
          <button className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </h3>
        <div className="hint">
          What each plan has used of its limits and when they reset. Claude's numbers come from Claude Code itself (its status line while a card runs, else the endpoint its /usage reads); Codex's from its last request; Gemini records tokens only.
        </div>
        {error && <div className="hint usage-error">{error}</div>}
        {!snap && !error && <div className="muted small">Reading…</div>}
        {snap?.engines.map((u) => (
          <EngineSection key={u.engine} u={u} now={now} cardTitle={cardTitle} />
        ))}
        {snap && <div className="usage-source">Read {agoText(snap.at, now)}. Plans publish percentages, not token caps; a bar at 100% means the CLI waits until the reset.</div>}
      </div>
    </div>
  )
}
