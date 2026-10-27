import { useEffect, useState } from 'react'
import type { GrokReplyStatus } from '@shared/protocol'

/**
 * Settings → Grok Bot → Replies: the way back from Grok Bot. A server on 127.0.0.1 that Tailscale Funnel forwards
 * to; the routine posts its result there with the reply key and the handoff's correlation id, and the asking card
 * gets it as board mail. The key is shown once, with the steps to paste into the routine.
 */
export function GrokReplySettings() {
  const [st, setSt] = useState<GrokReplyStatus | null>(null)
  const [url, setUrl] = useState('')
  const [issue, setIssue] = useState('')
  const [made, setMade] = useState<{ key: string; instructions: string } | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const reload = async (): Promise<void> => {
    try {
      const s = await window.ouroboros.grokReply.status()
      setSt(s)
      setUrl(s.publicUrl || s.suggestedUrl || '')
      setIssue(s.githubIssue)
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    }
  }
  useEffect(() => void reload(), [])
  if (!st) return note ? <div className="small error-text">Grok Bot replies: {note.text}</div> : null

  const configure = async (input: { enabled?: boolean; publicUrl?: string; githubIssue?: string }): Promise<void> => {
    const r = await window.ouroboros.grokReply.configure(input).catch((e: Error) => ({ ok: false, error: e.message }))
    setNote(r.ok ? null : { ok: false, text: r.error ?? 'not saved' })
    await reload()
  }
  const makeKey = async (): Promise<void> => {
    // the address goes into the steps: save what is typed first
    if (url.trim() !== st.publicUrl) await configure({ publicUrl: url })
    const r = await window.ouroboros.grokReply.makeKey()
    setMade({ key: r.key, instructions: r.instructions })
    await reload()
  }
  const revoke = async (): Promise<void> => {
    await window.ouroboros.grokReply.revoke()
    setMade(null)
    setNote({ ok: true, text: 'Key revoked: Grok Bot can no longer reply until you make a new one.' })
    await reload()
  }
  const mailState = !st.githubIssue
    ? 'not set'
    : st.mailReady
      ? `reading it every 30 s${st.mailError ? ` (last read failed: ${st.mailError})` : st.mailCheckedAt ? `, last at ${new Date(st.mailCheckedAt).toLocaleTimeString()}` : ''}`
      : `not used${st.mailError ? `: ${st.mailError}` : ''}`
  const state = !st.enabled ? 'off' : st.listening ? `listening on 127.0.0.1:${st.port}` : `not listening${st.error ? `: ${st.error}` : ''}`

  return (
    <>
      <h4 className="sub">Replies from Grok Bot</h4>
      <label className="check">
        <input type="checkbox" checked={st.enabled} onChange={(e) => void configure({ enabled: e.target.checked })} /> Let Grok Bot reply to the card that handed it work
      </label>
      <div className="hint">
        A small server on this PC ({state}). Tailscale Funnel carries the routine's reply to it from the internet; nothing else on it is reachable. Turn Funnel on once in a terminal:{' '}
        <code>tailscale funnel --bg --https=8443 http://127.0.0.1:{st.port}</code>
      </div>
      <label className="field">
        <span>Public address</span>
        <div className="ctl">
          <input className="text" placeholder="https://<this PC>.ts.net:8443/grok/reply" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() !== st.publicUrl && void configure({ publicUrl: url })} />
        </div>
      </label>
      <label className="field">
        <span>Reply key</span>
        <div className="ctl">
          <span className="small muted">{st.hasKey ? `made ${st.keyMadeAt ? new Date(st.keyMadeAt).toLocaleString() : ''}` : 'none yet'}</span>
          <button className="btn" onClick={() => void makeKey()}>
            {st.hasKey ? 'Make a new key' : 'Make a key'}
          </button>
          {st.hasKey && (
            <button className="btn" onClick={() => void revoke()}>
              Revoke
            </button>
          )}
        </div>
      </label>
      {made && (
        <div className="phone-key small">
          <div>Shown once. In Grok Bot, save it as the secret OUROBOROS_REPLY_KEY, then add the steps below to the routine. Making a new key ends this one.</div>
          <div>
            <code>{made.key.slice(0, 9)}…</code>{' '}
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(made.key)}>
              Copy key
            </button>{' '}
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(made.instructions)}>
              Copy the steps for the routine
            </button>
          </div>
          <pre className="muted">{made.instructions}</pre>
        </div>
      )}
      <label className="field">
        <span>Or a GitHub issue</span>
        <div className="ctl">
          <input className="text" placeholder="https://github.com/<you>/<private repo>/issues/1" value={issue} onChange={(e) => setIssue(e.target.value)} />
          <button className="btn" onClick={() => void configure({ githubIssue: issue })}>
            {issue.trim() ? 'Check and use' : 'Turn off'}
          </button>
        </div>
      </label>
      <div className="hint">
        For a routine whose network cannot reach the Funnel address: it comments its result on this issue, and Ouroboros reads it with your gh sign-in ({mailState}), mails it to the card, and deletes the comment. The repository must be private. No key: a reply must name a correlation_id this app sent.
        {st.mailInstructions && (
          <>
            {' '}
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(st.mailInstructions ?? '')}>
              Copy the steps for the routine
            </button>
          </>
        )}
      </div>
      {note && <div className={`small${note.ok ? '' : ' error-text'}`}>{note.text}</div>}
      <div className="hint">
        Every handoff sent while either way is on carries a random correlation_id; a reply must name one (and, through Funnel, have the key) to reach a card, and a card that is gone hands it to the Conductor. A reply that comes while the project is closed waits until it opens. Grok Bot's words arrive marked as its words, never as your approval.
      </div>
    </>
  )
}
