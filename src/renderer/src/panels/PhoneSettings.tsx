import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import { DEFAULT_PHONE_PORT, type PhoneStatus } from '@shared/phone'

type Iface = { name: string; address: string; kind: 'tailscale' | 'lan' | 'other' }

/** A QR for the pairing link, drawn as an SVG data URL (no network). */
function Qr({ text }: { text: string }) {
  const src = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return `data:image/svg+xml;utf8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}`
  }, [text])
  return <img className="phone-qr" src={src} alt="Pairing QR code" />
}

/**
 * Settings → Phone: the phone companion's server (off by default), the interface it listens on, pairing by QR and
 * the paired devices. Tailscale is the intended network; the home LAN is plain HTTP and says so.
 */
export function PhoneSettings() {
  const [status, setStatus] = useState<PhoneStatus | null>(null)
  const [ifaces, setIfaces] = useState<Iface[]>([])
  const [pair, setPair] = useState<{ url: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** a MacroDroid key just made: shown here once, never again */
  const [notifyKey, setNotifyKey] = useState<{ key: string; url: string } | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    window.ouroboros.phone
      .status()
      .then((s) => {
        setStatus(s)
        setError(s.error ?? null)
      })
      .catch((e: Error) => setError(e.message))
    window.ouroboros.phone
      .interfaces()
      .then(setIfaces)
      .catch(() => setIfaces([]))
  }, [])
  useEffect(() => {
    if (!pair) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pair])
  if (!status) return error ? <div className="small error-text">Phone: {error}</div> : null
  const configure = async (patch: Partial<PhoneStatus>): Promise<void> => {
    const next = { enabled: status.enabled, host: status.host, port: status.port || DEFAULT_PHONE_PORT, allowLan: status.allowLan, ...patch }
    if (next.enabled && !next.host) next.host = ifaces.find((i) => i.kind === 'tailscale')?.address
    setPair(null)
    const s = await window.ouroboros.phone.configure({ enabled: next.enabled, host: next.host, port: next.port, allowLan: next.allowLan })
    setStatus(s)
    setError(s.error ?? null)
  }
  const makePair = async (): Promise<void> => {
    const r = await window.ouroboros.phone.pair()
    if ('error' in r) setError(r.error)
    else {
      setError(null)
      setPair(r)
      setNow(Date.now())
    }
  }
  const makeKey = async (): Promise<void> => {
    const r = await window.ouroboros.phone.notifyKey().catch((e: Error) => ({ ok: false as const, error: e.message }))
    if (!r.ok) return setError(r.error)
    setError(null)
    setNotifyKey({ key: r.key, url: r.url })
    setStatus(await window.ouroboros.phone.status())
  }
  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0
  const chosen = ifaces.find((i) => i.address === status.host)
  return (
    <section className="settings-section">
      <h4>Phone</h4>
      <label className="check">
        <input type="checkbox" checked={status.enabled} onChange={(e) => void configure({ enabled: e.target.checked })} /> Let a paired phone see the board, message cards, answer permission prompts and approve merges
      </label>
      <div className="hint">
        Off by default. The phone page shows card names, their status and the last reply of each card. Meant for <b>Tailscale</b> (install it on the PC and the phone, same account): the server listens only on the address you pick, never on every interface, and refuses anyone outside that network. Windows asks once to let Ouroboros through the firewall; allow it for private networks.
      </div>
      <label className="field">
        <span>Listen on</span>
        <div className="ctl">
          <select className="text" value={status.host ?? ''} onChange={(e) => void configure({ host: e.target.value || undefined })}>
            <option value="">Pick an address…</option>
            {status.host && !ifaces.some((i) => i.address === status.host) && <option value={status.host}>{status.host} (not on this PC now)</option>}
            {ifaces.map((i) => (
              <option key={i.address} value={i.address} disabled={i.kind === 'other'}>
                {i.address} · {i.name} {i.kind === 'tailscale' ? '(Tailscale)' : i.kind === 'lan' ? '(home network)' : '(not allowed)'}
              </option>
            ))}
          </select>
          <input className="text port" type="number" min={1024} max={65535} defaultValue={status.port || DEFAULT_PHONE_PORT} onBlur={(e) => {
              const port = Number(e.target.value) || DEFAULT_PHONE_PORT
              if (port !== status.port) void configure({ port })
            }} />
        </div>
      </label>
      {ifaces.every((i) => i.kind !== 'tailscale') && <div className="hint">No Tailscale address on this PC. Install Tailscale for the intended setup.</div>}
      <label className="check">
        <input type="checkbox" checked={status.allowLan} onChange={(e) => void configure({ allowLan: e.target.checked })} /> Home network (no TLS)
      </label>
      {(status.allowLan || chosen?.kind === 'lan') && <div className="hint warn-text">Plain HTTP on your home network: anyone on the same Wi-Fi can see the traffic, including the device token. Use only on a network you trust; Tailscale encrypts it.</div>}
      {status.url && (
        <div className="row">
          <span className="small muted">
            Listening at <code>{status.url}</code>
          </span>
          <span className="spacer" />
          <button className="btn small" onClick={() => void makePair()}>
            Pair a phone
          </button>
        </div>
      )}
      {pair && left > 0 && (
        <div className="phone-pair">
          <Qr text={pair.url} />
          <div className="small">
            Scan with the phone's camera. The code works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
            <br />
            <code className="muted">{pair.url.replace(/#pair=.*/, '#pair=…')}</code>
          </div>
        </div>
      )}
      {status.url && (
        <div className="row">
          <span className="small muted">Car alerts: when the phone joins the car, Ouro sends a ready message on Discord, so you can reply by voice.</span>
          <span className="spacer" />
          <button className="btn small" onClick={() => void makeKey()} title="A key that can only say the car connected">
            Make a MacroDroid key
          </button>
        </div>
      )}
      {notifyKey && (
        <div className="phone-key small">
          <div>
            Shown once; copy it into MacroDroid now. It can only report the car, nothing else. Making a new key ends this one; Revoke below removes it.
          </div>
          <ol>
            <li>
              MacroDroid → new macro → Trigger: <b>Bluetooth event</b> → Connected → your car.
            </li>
            <li>
              Action: <b>HTTP request</b> → POST → URL <code>{notifyKey.url}</code>{' '}
              <button className="btn small" onClick={() => void navigator.clipboard.writeText(notifyKey.url)}>
                Copy
              </button>
            </li>
            <li>
              Add a header. Name: <code>Authorization</code>{' '}
              <button className="btn small" onClick={() => void navigator.clipboard.writeText('Authorization')}>
                Copy
              </button>{' '}
              (just this word, not "Header Authorization")
            </li>
            <li>
              Value: <code>Bearer {notifyKey.key.slice(0, 6)}…</code>{' '}
              <button className="btn small" onClick={() => void navigator.clipboard.writeText(`Bearer ${notifyKey.key}`)}>
                Copy
              </button>{' '}
              (starts with "Bearer" and a space)
            </li>
            <li>
              Body (content type <code>application/json</code>): <code>{'{"event":"car"}'}</code>
            </li>
          </ol>
          <div className="muted">
            Ouro waits 75 seconds before it writes, so Discord's mobile notification delay (set it to 1 minute) has passed. Tailscale must be on on the phone. A car that reconnects is greeted again (Android Auto shows only messages that arrive during the current connection), unless it reconnects within 2 minutes of the last greeting. If nothing arrives, the app log (main.log) says why each refused request was refused.
          </div>
        </div>
      )}
      {error && <div className="small error-text">{error}</div>}
      {status.devices.length > 0 && (
        <div className="phone-devices">
          {status.devices.map((d) => (
            <div key={d.id} className="row">
              <span>{d.name}</span>
              <span className="small muted">{d.scope === 'notify' ? 'car-alert key, made' : 'paired'} {new Date(d.createdAt).toLocaleDateString()}{d.lastSeen ? ` · seen ${new Date(d.lastSeen).toLocaleString()}` : ''}</span>
              <span className="spacer" />
              <button className="btn small danger" onClick={() => void window.ouroboros.phone.revoke(d.id).then(setStatus)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
