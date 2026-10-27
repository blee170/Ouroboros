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

/** One Grok Bot the owner set up (its own instructions, memory and routine), picked by name for each handoff. */
export interface GrokBot {
  id: string
  /** what the owner and the cards call it ("Personal", "CSB") */
  name: string
  /** one line a card reads to pick it ("email, vendor replies, calendar") */
  purpose?: string
  /** its routine's webhook */
  url?: string
  /** its routine's key (crsr_…), encrypted; main fills and reads it, the Settings list never sends it */
  keyEnc?: string
}
export const GROK_BOT_LIST = { max: 8, name: 40, purpose: 200 }
/** A bot as Settings shows it: no key, only whether one is saved. */
export type GrokBotView = Omit<GrokBot, 'keyEnc'> & { hasKey: boolean }

/** The owner's bots: the list, or the single bot of an older version (one URL and key) as its first entry. */
export function grokBots(st: { grokBots?: GrokBot[]; grokBotUrl?: string; grokBotKeyEnc?: string }): GrokBot[] {
  if (Array.isArray(st.grokBots)) return st.grokBots
  return st.grokBotUrl || st.grokBotKeyEnc ? [{ id: 'b1', name: 'Grok Bot', url: st.grokBotUrl, keyEnc: st.grokBotKeyEnc }] : []
}

/**
 * The list the owner saved in Settings (names, purposes, URLs; never keys), checked. A bot keeps its key by id;
 * a new row gets the next free id. Names are unique (any case) so a card can pick one by name.
 */
export function saveBots(prev: GrokBot[], input: unknown): { ok: true; bots: GrokBot[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'a list of bots is required' }
  if (input.length > GROK_BOT_LIST.max) return { ok: false, error: `at most ${GROK_BOT_LIST.max} bots` }
  const used = new Set(prev.map((b) => b.id))
  let n = 0
  const nextId = (): string => {
    do n++
    while (used.has(`b${n}`))
    used.add(`b${n}`)
    return `b${n}`
  }
  const out: GrokBot[] = []
  for (const raw of input as Record<string, unknown>[]) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
    if (!name) return { ok: false, error: 'every bot needs a name' }
    if (name.length > GROK_BOT_LIST.name) return { ok: false, error: `bot name "${name.slice(0, 20)}…" is over ${GROK_BOT_LIST.name} characters` }
    if (HIDDEN_CHARS.test(name)) return { ok: false, error: 'a bot name has invisible characters' }
    if (out.some((b) => b.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `two bots are called "${name}"` }
    const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim().replace(/\s+/g, ' ') : ''
    if (purpose.length > GROK_BOT_LIST.purpose) return { ok: false, error: `the purpose of "${name}" is over ${GROK_BOT_LIST.purpose} characters` }
    if (HIDDEN_CHARS.test(purpose)) return { ok: false, error: `the purpose of "${name}" has invisible characters` }
    const urlRaw = typeof raw.url === 'string' ? raw.url.trim() : ''
    const url = grokBotUrl(urlRaw)
    if (urlRaw && !url) return { ok: false, error: `the webhook of "${name}" is not a routine webhook (https://${GROK_BOT_HOST}/automations/webhook/…)` }
    const old = typeof raw.id === 'string' ? prev.find((b) => b.id === raw.id) : undefined
    if (old && out.some((b) => b.id === old.id)) return { ok: false, error: `bot ${old.id} is listed twice` }
    out.push({ id: old ? old.id : nextId(), name, ...(purpose ? { purpose } : {}), ...(url ? { url } : {}), ...(old?.keyEnc ? { keyEnc: old.keyEnc } : {}) })
  }
  return { ok: true, bots: out }
}

/** The bot a handoff goes to: by id or name (any case); with no name, the only bot there is. */
export function pickBot(bots: GrokBot[], want: unknown): { ok: true; bot: GrokBot } | { ok: false; error: string } {
  const w = typeof want === 'string' ? want.trim().toLowerCase() : ''
  if (!bots.length) return { ok: false, error: 'the owner has not set up a Grok Bot (Settings → Grok Bot)' }
  if (!w) {
    if (bots.length === 1) return { ok: true, bot: bots[0] }
    return { ok: false, error: `say which bot (bot: name). The owner's bots:\n${botMenu(bots)}` }
  }
  // a name first: a bot the owner called "b2" is that bot, not the one whose id is b2
  const bot = bots.find((b) => b.name.toLowerCase() === w) ?? bots.find((b) => b.id.toLowerCase() === w)
  return bot ? { ok: true, bot } : { ok: false, error: `no bot "${String(want).slice(0, 40)}". The owner's bots:\n${botMenu(bots)}` }
}

export function botViews(bots: GrokBot[]): GrokBotView[] {
  return bots.map(({ keyEnc, ...b }) => ({ ...b, hasKey: Boolean(keyEnc) }))
}

/**
 * The bot a handoff was asked for; one from an older version (no bot) goes to the first. It must still carry the name
 * the owner reviewed: an id freed by a removed bot can be given to a new one, and a renamed bot is not what Today showed.
 */
export function botOf(bots: GrokBot[], h: Pick<GrokHandoff, 'bot' | 'botName'>): GrokBot | undefined {
  if (!h.bot) return bots[0]
  const bot = bots.find((b) => b.id === h.bot)
  return bot && (h.botName === undefined || bot.name === h.botName) ? bot : undefined
}

/** One line per bot for a card: name, what it is for, and whether it can be sent to yet. */
export function botMenu(bots: GrokBot[]): string {
  return bots.map((b) => `- ${b.name}${b.purpose ? ` — ${b.purpose}` : ''}${b.url && b.keyEnc ? '' : ' (not set up yet: no webhook or key)'}`).join('\n')
}

export type GrokHandoffState = 'pending' | 'sent' | 'failed' | 'discarded'

export interface GrokHandoff {
  id: string
  /** the card that asked */
  card: string
  title: string
  /** the bot it goes to (id and its name when asked; a handoff from an older version has none: the first bot) */
  bot?: string
  botName?: string
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
export function newHandoff(input: { card: string; title: string; task: unknown; context?: unknown; bot?: GrokBot }, list: GrokHandoff[], id: string, now: number): { ok: true; handoff: GrokHandoff } | { ok: false; error: string } {
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  const context = typeof input.context === 'string' ? input.context.trim() : ''
  if (!task) return { ok: false, error: 'task required: what Grok Bot should do, in plain words' }
  if (task.length > GROK_BOT_LIMITS.task) return { ok: false, error: `task is ${task.length} characters; keep it under ${GROK_BOT_LIMITS.task} (put detail in context)` }
  if (context.length > GROK_BOT_LIMITS.context) return { ok: false, error: `context is ${context.length} characters; keep it under ${GROK_BOT_LIMITS.context}` }
  if (HIDDEN_CHARS.test(task) || HIDDEN_CHARS.test(context)) return { ok: false, error: 'task or context has invisible or direction-changing characters; send plain text' }
  const pending = list.filter((h) => h.state === 'pending')
  if (pending.length >= GROK_BOT_LIMITS.pending) return { ok: false, error: `${pending.length} handoffs already wait for the owner; wait until they decide` }
  if (pending.filter((h) => h.card === input.card).length >= GROK_BOT_LIMITS.pendingPerCard) return { ok: false, error: `${GROK_BOT_LIMITS.pendingPerCard} of your handoffs already wait for the owner; wait until they decide` }
  if (pending.some((h) => h.card === input.card && h.task === task && h.bot === input.bot?.id)) return { ok: false, error: 'the same handoff already waits for the owner' }
  return { ok: true, handoff: { id, card: input.card, title: input.title, ...(input.bot ? { bot: input.bot.id, botName: input.bot.name } : {}), task, context: context || undefined, createdAt: now, state: 'pending' } }
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
