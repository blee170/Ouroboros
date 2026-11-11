import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { CALL_LIMITS, CALL_LLMS, CALL_PATHS, DEFAULT_VOICE_ID, type OuroCallSettingsView, type OuroCallStatusView } from '@shared/ouro-call'

type Secret = 'twilio' | 'elevenlabs' | 'webhook'

/**
 * Settings → Ouro → Phone calls: Ouro phones the owner when something waits and nothing was heard back. Twilio places
 * the call, an ElevenLabs agent talks it through in Korean. The phone number is the only one ever dialled.
 */
export function OuroCallSettings() {
  const [status, setStatus] = useState<OuroCallStatusView | null>(null)
  const [secrets, setSecrets] = useState<Record<Secret, string>>({ twilio: '', elevenlabs: '', webhook: '' })
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [agentNote, setAgentNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null)
  /** the status as last loaded: a save started from a blur must not carry an older render's values */
  const latest = useRef<OuroCallStatusView | null>(null)
  latest.current = status
  useEffect(() => {
    let live = true
    const load = (): void => {
      window.ouroboros.ouroCall
        .status()
        .then((s) => live && setStatus(s))
        .catch((e: Error) => live && setNote({ ok: false, text: e.message }))
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  if (!status) return note ? <div className="small error-text">Phone calls: {note.text}</div> : null

  const configure = async (patch: Partial<OuroCallSettingsView>): Promise<void> => {
    try {
      setStatus(await window.ouroboros.ouroCall.configure(patch))
      setNote(null)
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    }
  }
  const saveSecret = async (kind: Secret): Promise<void> => {
    try {
      // typed text saves; an empty box clears the saved secret
      setStatus(await window.ouroboros.ouroCall.setSecret(kind, secrets[kind]))
      setSecrets((s) => ({ ...s, [kind]: '' }))
      setNote(null)
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    }
  }
  const provision = async (): Promise<void> => {
    setAgentNote(null)
    const r = await window.ouroboros.ouroCall.provision().catch((e: Error) => ({ ok: false, error: e.message }))
    setAgentNote(r.ok ? { ok: true, text: 'Agent is ready.' } : { ok: false, text: r.error ?? 'not provisioned' })
    setStatus(await window.ouroboros.ouroCall.status().catch(() => latest.current))
  }
  const test = async (): Promise<void> => {
    setTestNote(null)
    const r = await window.ouroboros.ouroCall.test().catch((e: Error) => ({ ok: false, error: e.message, warning: undefined as string | undefined }))
    setTestNote(r.ok ? { ok: true, text: r.warning ?? 'Calling you now.' } : { ok: false, text: r.error ?? 'not placed' })
    setStatus(await window.ouroboros.ouroCall.status().catch(() => latest.current))
  }
  const secretField = (kind: Secret, label: string, has: boolean, placeholder: string, hint: string): JSX.Element => (
    <label className="field">
      <span>{label}</span>
      <div className="ctl">
        <input className="text" type="password" placeholder={has ? '•••••• (saved)' : placeholder} value={secrets[kind]} onChange={(e) => setSecrets((s) => ({ ...s, [kind]: e.target.value }))} />
        <button className="btn" onClick={() => void saveSecret(kind)}>
          {secrets[kind] ? 'Save' : has ? 'Clear' : 'Save'}
        </button>
      </div>
      <div className="hint">{hint}</div>
    </label>
  )
  const text = (field: 'ownerPhone' | 'fromNumber' | 'twilioSid' | 'ownerName' | 'voiceId' | 'publicBase' | 'replyText', label: string, placeholder: string, hint?: ReactNode): JSX.Element => (
    <label className="field">
      <span>{label}</span>
      <div className="ctl">
        <input
          className="text"
          key={status[field]}
          placeholder={placeholder}
          defaultValue={status[field]}
          onBlur={(e) => e.target.value.trim() !== status[field] && void configure({ [field]: e.target.value.trim() })}
        />
      </div>
      {hint && <div className="hint">{hint}</div>}
    </label>
  )
  const num = (field: 'waitMinutes' | 'maxPerDay' | 'maxMinutes', label: string, lim: { min: number; max: number }): JSX.Element => (
    <label className="field">
      <span>{label}</span>
      <div className="ctl">
        <input className="text" type="number" min={lim.min} max={lim.max} key={status[field]} defaultValue={status[field]} onBlur={(e) => Number(e.target.value) !== status[field] && void configure({ [field]: Number(e.target.value) })} />
      </div>
    </label>
  )
  const time = (field: 'quietFrom' | 'quietTo'): JSX.Element => (
    <input className="text" type="time" key={status[field]} defaultValue={status[field]} onBlur={(e) => e.target.value && e.target.value !== status[field] && void configure({ [field]: e.target.value })} />
  )
  const base = status.baseUrl
  const state = status.serverListening ? 'listening' : `not listening${status.serverError ? `: ${status.serverError}` : ''}`
  return (
    <>
      <h4 className="sub">Phone calls</h4>
      <label className="check">
        <input type="checkbox" checked={status.enabled} onChange={(e) => void configure({ enabled: e.target.checked })} /> Call me when something waits and I have not reacted
      </label>
      <div className="hint">
        Ouro tells you on Discord first. After the wait with no reaction (no Discord message from you, nobody typing at this PC) it phones you from the Twilio number, and an ElevenLabs agent (Claude) talks it through in Korean: the situation, numbered choices, a read-back, then it acts under the same rules as the Discord dialogue. Nothing irreversible is done by voice alone. Calls are skipped in quiet hours and capped per day.
      </div>
      {text('ownerPhone', 'Your phone number', '+61412345678', 'E.164. The only number Ouro ever dials; it cannot be changed over the network.')}
      {text('fromNumber', 'Twilio number', '+61…', 'E.164, the number the call comes from.')}
      {text('twilioSid', 'Twilio account SID', 'AC…')}
      {secretField('twilio', 'Twilio auth token', status.hasTwilioToken, 'from the Twilio console', 'Stored encrypted and sent only to Twilio.')}
      {secretField('elevenlabs', 'ElevenLabs API key', status.hasElevenKey, 'from ElevenLabs', "The same key as Settings → Voice input's ElevenLabs engine.")}
      {secretField('webhook', 'ElevenLabs webhook secret', status.hasWebhookSecret, 'from ElevenLabs', 'From the ElevenLabs Agents settings → Post-call webhooks, where the URL below goes.')}
      {text('ownerName', 'How I am addressed', '사장님')}
      {num('waitMinutes', 'Wait before calling (minutes)', CALL_LIMITS.waitMinutes)}
      <div className="field">
        <span>Quiet hours</span>
        <div className="ctl">
          {time('quietFrom')}
          <span className="small muted">to</span>
          {time('quietTo')}
        </div>
        <div className="hint">No calls between them (same value = none).</div>
      </div>
      {num('maxPerDay', 'Calls a day', CALL_LIMITS.maxPerDay)}
      {num('maxMinutes', 'Minutes per call', CALL_LIMITS.maxMinutes)}
      <label className="field">
        <span>Model</span>
        <div className="ctl">
          <select className="text" value={status.llm} onChange={(e) => void configure({ llm: e.target.value })}>
            {CALL_LLMS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </label>
      {text('voiceId', 'Voice ID', DEFAULT_VOICE_ID)}
      {text(
        'publicBase',
        'Public address',
        'https://<this PC>.ts.net:8443',
        <>
          {base ? `Using ${base}` : 'Not known yet: turn Tailscale Funnel on (see Grok Bot → Replies) or type it'}. Server: <span className={status.serverError ? 'error-text' : undefined}>{state}</span>.
        </>
      )}
      {text('replyText', 'Reply text', '', 'What Ouro posts when you say "reply" to a mention.')}
      <div className="field" style={{ alignItems: 'start' }}>
        <span>Webhook URLs</span>
        <div className="ctl" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="small">
            Twilio → your number → Voice → A call comes in (POST): <code>{`${base}${CALL_PATHS.inbound}`}</code>
          </div>
          <div className="small muted">Ring the Twilio number from your phone and hang up: Ouro rejects the call unanswered and calls you back with the board. Anyone else is only rejected.</div>
          <div className="small">
            ElevenLabs → Agents settings → Post-call webhooks: <code>{`${base}${CALL_PATHS.post}`}</code>
          </div>
        </div>
      </div>
      <div className="field">
        <span>Agent</span>
        <div className="ctl">
          <span className="small muted">{status.agentId ? 'provisioned' : 'not made yet'}</span>
          <button className="btn" onClick={() => void provision()}>
            {status.agentId ? 'Update agent' : 'Provision'}
          </button>
        </div>
        {agentNote && <div className={`hint${agentNote.ok ? '' : ' error-text'}`}>{agentNote.text}</div>}
      </div>
      <div className="field">
        <span>Status</span>
        <div className="ctl">
          <span className={status.missing.length ? 'error-text' : undefined}>{status.missing.length ? `Not ready: ${status.missing.join(', ')}` : 'Ready'}</span>
          <button className="btn" disabled={status.missing.length > 0 || !status.enabled} onClick={() => void test()} title="Rings your phone with a test line">
            Test call
          </button>
        </div>
        <div className="small muted">
          {status.todayCalls} of {status.maxPerDay} today{status.active ? ', a call is under way' : ''}
          {status.last ? `. Last: ${status.last.outcome}, ${new Date(status.last.at).toLocaleString()}${status.last.summary ? `: ${status.last.summary}` : ''}` : ''}
        </div>
        {testNote && <div className={`hint${testNote.ok ? '' : ' error-text'}`}>{testNote.text}</div>}
        {note && <div className="hint error-text">{note.text}</div>}
      </div>
      <div className="hint">
        Setup: make a Twilio account (a trial can only call your own verified number and plays a notice first; an Australian local number is about $3 a month and needs ID and address proof) and paste the number's voice URL above into Twilio. Make an ElevenLabs account (agent minutes: Free 15, Starter 75 a month, $0.08 a minute after, Claude on top), then press Provision, paste the post-call webhook URL into ElevenLabs and copy its secret here. Keep Tailscale Funnel on (<code>tailscale funnel status</code>). Save the Twilio number as a contact named 우로 so the car announces it. A call to an Australian mobile costs about $0.075 a minute from Twilio plus the ElevenLabs minute.
      </div>
    </>
  )
}
