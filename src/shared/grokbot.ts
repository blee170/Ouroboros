/**
 * Handing a task to Grok Bot (xAI + Cursor's cloud teammate) through one of its routines' webhook. A card asks
 * (`handoff_to_grok_bot`), the owner sends or discards each one: the text leaves this machine, so it is never sent
 * without them. Pure: main keeps the list and does the POST.
 */

/** The only host a webhook may point at: the key goes in its Authorization header. */
export const GROK_BOT_HOST = 'api2.cursor.sh'
export const GROK_BOT_LIMITS = { task: 4000, context: 12000, pending: 10, pendingPerCard: 3 }

/**
 * Characters that can hide or reorder what the owner reads before Send: bidi controls, zero-width characters,
 * and control characters other than tab and newline. A handoff with any of them is refused.
 */
const HIDDEN_CHARS = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]')

export type GrokHandoffState = 'pending' | 'sent' | 'failed' | 'discarded'

export interface GrokHandoff {
  id: string
  /** the card that asked */
  card: string
  title: string
  task: string
  context?: string
  createdAt: number
  state: GrokHandoffState
  decidedAt?: number
  /** Grok Bot's id for the run it started */
  runUuid?: string
  error?: string
}

/** The routine's webhook URL as typed, or undefined unless it is `https://api2.cursor.sh/automations/webhook/<id>`. */
export function grokBotUrl(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' || u.hostname !== GROK_BOT_HOST || u.port || u.username || u.password || u.search || u.hash) return undefined
  return /^\/automations\/webhook\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname) ? `https://${GROK_BOT_HOST}${u.pathname}` : undefined
}

/** A new handoff from a card, or why it is refused. */
export function newHandoff(input: { card: string; title: string; task: unknown; context?: unknown }, list: GrokHandoff[], id: string, now: number): { ok: true; handoff: GrokHandoff } | { ok: false; error: string } {
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  const context = typeof input.context === 'string' ? input.context.trim() : ''
  if (!task) return { ok: false, error: 'task required: what Grok Bot should do, in plain words' }
  if (task.length > GROK_BOT_LIMITS.task) return { ok: false, error: `task is ${task.length} characters; keep it under ${GROK_BOT_LIMITS.task} (put detail in context)` }
  if (context.length > GROK_BOT_LIMITS.context) return { ok: false, error: `context is ${context.length} characters; keep it under ${GROK_BOT_LIMITS.context}` }
  if (HIDDEN_CHARS.test(task) || HIDDEN_CHARS.test(context)) return { ok: false, error: 'task or context has invisible or direction-changing characters; send plain text' }
  const pending = list.filter((h) => h.state === 'pending')
  if (pending.length >= GROK_BOT_LIMITS.pending) return { ok: false, error: `${pending.length} handoffs already wait for the owner; wait until they decide` }
  if (pending.filter((h) => h.card === input.card).length >= GROK_BOT_LIMITS.pendingPerCard) return { ok: false, error: `${GROK_BOT_LIMITS.pendingPerCard} of your handoffs already wait for the owner; wait until they decide` }
  if (pending.some((h) => h.card === input.card && h.task === task)) return { ok: false, error: 'the same handoff already waits for the owner' }
  return { ok: true, handoff: { id, card: input.card, title: input.title, task, context: context || undefined, createdAt: now, state: 'pending' } }
}

/** The JSON body Grok Bot's routine receives with its instruction. */
export function handoffPayload(h: GrokHandoff, project: string, now: number): Record<string, unknown> {
  return {
    source: 'ouroboros',
    kind: 'handoff',
    task: h.task,
    ...(h.context ? { context: h.context } : {}),
    from: h.title,
    project,
    handoffId: h.id,
    sentAt: new Date(now).toISOString()
  }
}

/** Keys and tokens never reach a log, a toast or a card: Cursor keys (crsr_…) and anything after "Bearer". */
export function scrubKey(s: string, key?: string): string {
  let out = s.replace(/\bcrsr_[A-Za-z0-9_-]+/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]')
  if (key) out = out.split(key).join('[key]')
  return out
}
