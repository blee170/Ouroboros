/**
 * The POST to a Grok Bot routine's webhook. No Electron here: the key and the fetch are passed in, so every
 * answer (200 with a run, 400 routine off, 401 wrong key, other statuses, network) runs under vitest.
 * Nothing here throws or logs the key.
 */
import { grokBotUrl, scrubKey } from '@shared/grokbot'

const TIMEOUT_MS = 15_000

export type GrokSendResult = { ok: true; runUuid?: string } | { ok: false; error: string; status?: number }

export async function sendToGrokBot(o: { url: string; key: string; payload: Record<string, unknown>; fetch?: typeof fetch }): Promise<GrokSendResult> {
  const url = grokBotUrl(o.url)
  if (!url) return { ok: false, error: 'the webhook URL is not a Grok Bot routine webhook (https://api2.cursor.sh/automations/webhook/…)' }
  if (!o.key) return { ok: false, error: 'no Grok Bot key saved' }
  const f = o.fetch ?? fetch
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(o.payload),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    let json: Record<string, unknown> = {}
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      /* not JSON: the status is the answer */
    }
    const msg = typeof json.message === 'string' ? json.message : typeof json.error === 'string' ? json.error : ''
    // a run started only when Grok Bot says so; the error bodies differ in shape
    if (res.status === 200 && json.success === true) return { ok: true, runUuid: typeof json.runUuid === 'string' ? json.runUuid.slice(0, 80) : undefined }
    if (res.status === 401) return { ok: false, status: 401, error: 'Grok Bot refused the key (401): copy the routine\'s key again into Settings → Grok Bot' }
    if (res.status === 400) return { ok: false, status: 400, error: `Grok Bot did not start a run (400): is the routine's Active switch on?${msg ? ` (${scrubKey(msg, o.key).slice(0, 160)})` : ''}` }
    return { ok: false, status: res.status, error: `Grok Bot ${res.status}${msg ? `: ${scrubKey(msg, o.key).slice(0, 200)}` : ': no run started'}` }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Grok Bot unreachable: ${scrubKey(m, o.key).slice(0, 200)}` }
  }
}
