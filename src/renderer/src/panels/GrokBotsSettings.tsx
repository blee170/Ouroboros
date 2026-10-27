import { useEffect, useState } from 'react'
import { GROK_BOT_LIMITS, GROK_BOT_LIST, type GrokBotView } from '@shared/grokbot'

/**
 * Settings → Grok Bot: the owner's bots, one per purpose (a personal one for email and calendar, a business one for
 * research). Each has a name and a one-line purpose the Conductor reads to pick it, and its own routine's webhook and
 * key. Names, purposes and webhooks are saved as a list when a field loses focus; a key is saved on its own button
 * and never comes back to this page (settings.get leaves the bots out).
 */
export function GrokBotsSettings() {
  const [rows, setRows] = useState<GrokBotView[] | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    void window.ouroboros.grokBot
      .bots()
      .then(setRows)
      .catch((e: Error) => setNote({ ok: false, text: e.message }))
  }, [])
  if (!rows) return note ? <div className="small error-text">Grok Bot: {note.text}</div> : null

  // a refused or failed save puts the saved list back, so the page never shows unsaved text as saved
  const reload = (): void => void window.ouroboros.grokBot.bots().then(setRows, () => undefined)
  const commit = async (next: GrokBotView[], done?: string): Promise<void> => {
    try {
      const r = await window.ouroboros.grokBot.save(next.map(({ id, name, purpose, url, autoSend }) => ({ id, name, purpose, url, autoSend })))
      if (!r.ok) {
        setNote({ ok: false, text: `${r.error} (not saved; the saved list is shown again)` })
        return reload()
      }
      setRows(r.bots)
      setNote(done ? { ok: true, text: done } : null)
    } catch (e) {
      setNote({ ok: false, text: `not saved: ${(e as Error).message}` })
      reload()
    }
  }
  const edit = (id: string, patch: Partial<GrokBotView>): void => setRows((prev) => prev && prev.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  const add = (): void => {
    let n = rows.length + 1
    while (rows.some((b) => b.name.toLowerCase() === `bot ${n}`)) n++
    // saved at once, so the new bot has an id its key can be stored under
    void commit([...rows, { id: '', name: `Bot ${n}`, hasKey: false }])
  }
  const remove = (id: string): void => {
    setRemoving(null)
    void commit(rows.filter((b) => b.id !== id), 'Bot removed, with its key.')
  }
  const saveKey = async (b: GrokBotView): Promise<void> => {
    let r: Awaited<ReturnType<typeof window.ouroboros.grokBot.setKey>>
    try {
      r = await window.ouroboros.grokBot.setKey(b.id, keys[b.id] ?? '')
    } catch (e) {
      return setNote({ ok: false, text: `${b.name}: key not saved: ${(e as Error).message}` })
    }
    if (!r.ok) return setNote({ ok: false, text: r.error ?? 'not saved' })
    setKeys((prev) => ({ ...prev, [b.id]: '' }))
    setRows((prev) => prev && prev.map((x) => (x.id === b.id ? { ...x, hasKey: r.hasKey } : x)))
    setNote({ ok: true, text: r.hasKey ? `${b.name}: key saved (encrypted).` : `${b.name}: key cleared.` })
  }
  const test = async (b: GrokBotView): Promise<void> => {
    setNote({ ok: true, text: `Asking ${b.name}…` })
    const r = await window.ouroboros.grokBot.test(b.id).catch((e: Error) => ({ ok: false as const, error: e.message }))
    setNote(r.ok ? { ok: true, text: `${b.name}: the routine started a test run${r.runUuid ? ` (${r.runUuid})` : ''}.` } : { ok: false, text: `${b.name}: ${r.error}` })
  }

  return (
    <>
      {rows.map((b) => (
        <div key={b.id} className="grok-bot">
          <label className="field">
            <span>Name</span>
            <div className="ctl">
              <input className="text" maxLength={GROK_BOT_LIST.name} value={b.name} onChange={(e) => edit(b.id, { name: e.target.value })} onBlur={() => void commit(rows)} />
              {removing === b.id ? (
                <>
                  <button className="btn danger" onClick={() => remove(b.id)}>
                    Remove {b.name}
                  </button>
                  <button className="btn" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setRemoving(b.id)} title="Remove this bot and its saved key">
                  Remove
                </button>
              )}
            </div>
          </label>
          <label className="field">
            <span>Purpose</span>
            <div className="ctl">
              <input className="text" maxLength={GROK_BOT_LIST.purpose} placeholder="e.g. my email, vendor replies, calendar" value={b.purpose ?? ''} onChange={(e) => edit(b.id, { purpose: e.target.value })} onBlur={() => void commit(rows)} />
            </div>
          </label>
          <label className="field">
            <span>Webhook URL</span>
            <div className="ctl">
              <input className="text" placeholder="https://api2.cursor.sh/automations/webhook/…" value={b.url ?? ''} onChange={(e) => edit(b.id, { url: e.target.value })} onBlur={() => void commit(rows)} />
            </div>
          </label>
          <label className="field">
            <span>Key</span>
            <div className="ctl">
              <input className="text" type="password" placeholder={b.hasKey ? '•••••• (saved)' : 'crsr_…'} value={keys[b.id] ?? ''} onChange={(e) => setKeys((prev) => ({ ...prev, [b.id]: e.target.value }))} />
              <button className="btn" onClick={() => void saveKey(b)}>
                {keys[b.id] ? 'Save' : b.hasKey ? 'Clear' : 'Save'}
              </button>
              <button className="btn" onClick={() => void test(b)} title="Starts one run of this bot's routine with a test body">
                Test
              </button>
            </div>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={b.autoSend === true}
              onChange={(e) => void commit(rows.map((x) => (x.id === b.id ? { ...x, autoSend: e.target.checked } : x)))}
            />{' '}
            Send without asking me
          </label>
          {b.autoSend && (
            <div className="hint">
              A card's handoff to {b.name} leaves at once, and you get a notification for each one. Not sent without you: more than {GROK_BOT_LIMITS.autoPerDay} in 24 hours, or a task that looks like it holds a key, token or password. Leave this off for a bot that can send mail, pay or delete.
            </div>
          )}
        </div>
      ))}
      {rows.length < GROK_BOT_LIST.max && (
        <div className="field">
          <button className="btn" onClick={add}>
            {rows.length ? 'Add another bot' : 'Add a bot'}
          </button>
        </div>
      )}
      {note && <div className={`small${note.ok ? '' : ' error-text'}`}>{note.text}</div>}
      <div className="hint">Keys are stored encrypted and sent only to api2.cursor.sh. Test starts one run of that bot's routine with a body that says it is a test.</div>
    </>
  )
}
