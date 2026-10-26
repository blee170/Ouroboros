import { useEffect, useState } from 'react'
import type { OuroSettingsView, OuroStatusView } from '@shared/ouro'

const STATE: Record<OuroStatusView['state'], string> = { off: 'Off', connecting: 'Connecting…', ready: 'Connected', retrying: 'Reconnecting', failed: 'Stopped' }

/**
 * Settings → Ouro: the owner talks to the board through Discord direct messages, which Android Auto reads aloud and
 * answers by voice. A bot token (stored encrypted), the owner's user ID (only its DMs are read) and two switches.
 */
export function OuroSettings() {
  const [status, setStatus] = useState<OuroStatusView | null>(null)
  const [token, setToken] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => {
      window.ouroboros.ouro
        .status()
        .then((s) => live && setStatus(s))
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
    const { enabled, ownerId, notify, approvals } = { ...status, ...patch }
    setStatus(await window.ouroboros.ouro.configure({ enabled, ownerId, notify, approvals }))
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
