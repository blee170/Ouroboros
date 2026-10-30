import { useEffect, useRef, useState } from 'react'
import type { OuroChannel, OuroSettingsView, OuroStatusView } from '@shared/ouro'

const STATE: Record<OuroStatusView['state'], string> = { off: 'Off', connecting: 'Connecting…', ready: 'Connected', retrying: 'Reconnecting', failed: 'Stopped' }

/**
 * Settings → Ouro: the owner talks to the board through Discord direct messages, which Android Auto reads aloud and
 * answers by voice. A bot token (stored encrypted), the owner's user ID (only its DMs are read) and two switches.
 */
export function OuroSettings() {
  const [status, setStatus] = useState<OuroStatusView | null>(null)
  const [token, setToken] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  /** the channel rows as typed: a half-typed row stays here while the saved list keeps only complete ones */
  const [rows, setRows] = useState<OuroChannel[] | null>(null)
  /** the status as last loaded: a save started from a blur must not carry an older render's channels */
  const latest = useRef<OuroStatusView | null>(null)
  latest.current = status
  useEffect(() => {
    let live = true
    const load = (): void => {
      window.ouroboros.ouro
        .status()
        .then((s) => {
          if (!live) return
          setStatus(s)
          setRows((r) => r ?? s.channels)
        })
        .catch((e: Error) => live && setNote({ ok: false, text: e.message }))
    }
    load()
    // the connection state changes on its own (connecting, reconnecting, a refused token)
    const t = setInterval(load, 3000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  if (!status) return note ? <div className="small error-text">Ouro: {note.text}</div> : null
  const configure = async (patch: Partial<OuroSettingsView>): Promise<void> => {
    const { enabled, ownerId, notify, approvals, channels } = { ...(latest.current ?? status), ...patch }
    setStatus(await window.ouroboros.ouro.configure({ enabled, ownerId, notify, approvals, channels }))
  }
  const editRow = (i: number, patch: Partial<OuroChannel>): void => setRows((r) => (r ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const saveRows = (next?: OuroChannel[]): Promise<void> => configure({ channels: next ?? rows ?? [] })
  /** whether a typed row is in the saved list (the same name without the #, and the same id) */
  const saved = (c: OuroChannel): boolean => {
    const name = c.name.trim().replace(/^#+/, '').trim().toLowerCase()
    return status.channels.some((s) => s.id === c.id.trim() && s.name.toLowerCase() === name)
  }
  const removeRow = (i: number): Promise<void> => {
    const next = (rows ?? []).filter((_, j) => j !== i)
    setRows(next)
    return saveRows(next)
  }
  const saveToken = async (): Promise<void> => {
    setStatus(await window.ouroboros.ouro.setToken(token))
    setToken('')
    setNote(null)
  }
  const test = async (): Promise<void> => {
    const r = await window.ouroboros.ouro.test()
    setNote(r.ok ? { ok: true, text: 'Sent: check your Discord direct messages.' } : { ok: false, text: r.error ?? 'not sent' })
  }
  const badId = status.ownerId !== '' && !/^\d{15,22}$/.test(status.ownerId)
  return (
    <section className="settings-section">
      <h4>Ouro (Discord)</h4>
      <label className="check">
        <input type="checkbox" checked={status.enabled} onChange={(e) => void configure({ enabled: e.target.checked })} /> Talk to the board through Discord direct messages
      </label>
      <div className="hint">
        For the car or busy hands: Android Auto reads a Discord DM aloud and takes a spoken reply. Say <em>상황 어때</em> / <em>status</em>, <em>다음</em>, <em>허가</em>, <em>보류</em> or a question's choice; anything else goes to the Conductor and its answer comes back. Ouro reads every approval or answer back and acts only on a spoken yes. Only direct messages from your user ID are read.
      </div>
      <label className="field">
        <span>Bot token</span>
        <div className="ctl">
          <input className="text" type="password" placeholder={status.hasToken ? '•••••• (saved)' : 'from the developer portal, Bot tab'} value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn" onClick={() => void saveToken()}>
            {token ? 'Save' : status.hasToken ? 'Clear' : 'Save'}
          </button>
        </div>
        <div className="hint">Stored encrypted and sent only to Discord.</div>
      </label>
      <label className="field">
        <span>Your user ID</span>
        <div className="ctl">
          <input className="text" placeholder="Discord → Settings → Advanced → Developer Mode, then right-click yourself → Copy User ID" defaultValue={status.ownerId} onBlur={(e) => void configure({ ownerId: e.target.value.trim() })} />
        </div>
        {badId && <div className="hint error-text">A user ID is 15 to 22 digits.</div>}
      </label>
      <label className="check">
        <input type="checkbox" checked={status.notify} onChange={(e) => void configure({ notify: e.target.checked })} /> Message me when something new waits on me (at most once a minute)
      </label>
      <label className="check">
        <input type="checkbox" checked={status.approvals} onChange={(e) => void configure({ approvals: e.target.checked })} /> Let me approve and answer by voice (off: Ouro reads them out and sends me to the PC)
      </label>
      <div className="field">
        <span>Channels cards may post to</span>
        <div className="ctl ouro-channels">
          {(rows ?? []).map((c, i) => (
            <div className="ouro-channel" key={i}>
              <div className="ouro-channel-row">
                <input className="text" placeholder="name, as cards will call it (no #)" value={c.name} onChange={(e) => editRow(i, { name: e.target.value })} onBlur={() => void saveRows()} />
                <input className="text" placeholder="channel ID (Developer Mode → right-click the channel → Copy Channel ID)" value={c.id} onChange={(e) => editRow(i, { id: e.target.value })} onBlur={() => void saveRows()} />
                <button className="btn small" onClick={() => void removeRow(i)} title="Remove this channel">
                  ✕
                </button>
              </div>
              {!saved(c) && <div className="hint error-text">Not saved yet: needs a name and a 15–22 digit ID that no other row uses.</div>}
            </div>
          ))}
          <button className="btn small" onClick={() => setRows([...(rows ?? []), { name: '', id: '' }])}>
            Add channel
          </button>
        </div>
        <div className="hint">
          Any agent card with board tools may post there without asking, as the bot (tool <code>post_discord</code>: "post the progress to #updates"). The bot needs View Channel and Send Messages in that channel. A row counts once it has a name and a 15–22 digit ID
          {status.channels.length ? ` (${status.channels.length} saved)` : ''}.
        </div>
      </div>
      <div className="field">
        <span>Status</span>
        <div className="ctl">
          <span className={status.state === 'failed' ? 'error-text' : undefined}>
            {STATE[status.state]}
            {status.state === 'ready' && status.username ? ` as ${status.username}` : ''}
            {status.detail && status.state !== 'ready' ? ` — ${status.detail}` : ''}
          </span>
          <button className="btn" disabled={status.state !== 'ready'} onClick={() => void test()} title="Sends you a direct message">
            Test
          </button>
        </div>
        {note && <div className={`hint${note.ok ? '' : ' error-text'}`}>{note.text}</div>}
      </div>
      <div className="hint">
        Setup: in the Discord developer portal make an application, turn on <b>Message Content Intent</b> on its Bot tab and copy the token here; invite the bot to a server you are in (OAuth2 → URL Generator → <code>bot</code>, Send Messages), so it can DM you.
      </div>
    </section>
  )
}
