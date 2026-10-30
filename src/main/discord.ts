/**
 * A Discord bot that only talks to its owner in direct messages. No Electron and no dependencies: Node's global
 * WebSocket and fetch, both passed in so the gateway (hello, heartbeat, identify, reconnect, fatal close codes)
 * and the REST calls run under vitest against a fake. Nothing here logs or returns the token.
 */
import { EventEmitter } from 'node:events'
import type { OuroBotState } from '@shared/ouro'

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
const API = 'https://discord.com/api/v10'
// DIRECT_MESSAGES (1<<12) and MESSAGE_CONTENT (1<<15): the content intent must be switched on in the developer portal
const INTENTS = (1 << 12) | (1 << 15)
const CHUNK = 1900
const FATAL: Record<number, string> = {
  4004: 'Discord refused the bot token (4004): copy it again from the developer portal (Bot → Reset Token)',
  4013: 'Discord refused the intents (4013)',
  4014: 'Message Content Intent is off (4014): switch it on in the developer portal, Bot tab'
}

export interface DiscordMessage {
  id: string
  channelId: string
  text: string
}

interface WsLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number): void
}

export interface DiscordDeps {
  WebSocket?: new (url: string) => WsLike
  fetch?: typeof fetch
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
}

export type DiscordState = OuroBotState

/**
 * Events: 'ready' (bot username), 'message' (DiscordMessage from the owner's DM), 'state' (DiscordState, detail).
 * A fatal close (bad token, intent off) stops it for good; anything else reconnects, waiting 2 s up to 60 s.
 */
export class DiscordBot extends EventEmitter {
  state: DiscordState = 'off'
  detail = ''
  username = ''
  private ws?: WsLike
  private beat?: unknown
  private retry?: unknown
  private seq: number | null = null
  private acked = true
  private backoff = 2000
  private dmChannel?: string
  private stopped = true
  private readonly d: Required<DiscordDeps>

  constructor(
    private readonly token: string,
    private readonly ownerId: string,
    deps: DiscordDeps = {}
  ) {
    super()
    this.d = {
      WebSocket: deps.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike),
      fetch: deps.fetch ?? fetch,
      setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = undefined
    try {
      ws?.close(1000)
    } catch {
      /* already closed */
    }
    this.setState('off', '')
  }

  /** Sends to the owner's DM, split into Discord-sized pieces. Throws a message without the token on failure. */
  async send(text: string): Promise<void> {
    const body = text.trim()
    if (!body) return
    if (!this.dmChannel) {
      const dm = (await this.api('POST', '/users/@me/channels', { recipient_id: this.ownerId })) as { id?: string }
      if (!dm?.id) throw new Error('Discord did not open a DM channel')
      this.dmChannel = dm.id
    }
    await this.post(this.dmChannel, body)
  }

  /**
   * Posts to a channel the bot can write in (a server channel the owner allows, or the DM), split into Discord-sized
   * parts without cutting an emoji in two; no mention resolves, and quiet hides link previews too. A failure after
   * the first part says how many went out, so the caller does not post the whole thing again.
   */
  async post(channelId: string, text: string, quiet = false): Promise<void> {
    const body = text.trim()
    if (!body) return
    const parts: string[] = []
    for (let i = 0; i < body.length; ) {
      let end = Math.min(i + CHUNK, body.length)
      const c = body.charCodeAt(end)
      if (end < body.length && c >= 0xdc00 && c <= 0xdfff) end--
      parts.push(body.slice(i, end))
      i = end
    }
    for (let k = 0; k < parts.length; k++) {
      try {
        await this.api('POST', `/channels/${channelId}/messages`, { content: parts[k], allowed_mentions: { parse: [] }, ...(quiet ? { flags: 4 } : {}) })
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        throw new Error(k ? `${m}; ${k} of ${parts.length} parts were posted` : m)
      }
    }
  }

  private async api(method: string, path: string, body?: unknown, again = true): Promise<unknown> {
    const res = await this.d.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
    if (res.status === 429 && again) {
      let wait = 1
      try {
        wait = Number(((await res.json()) as { retry_after?: number }).retry_after) || 1
      } catch {
        /* no body: wait a second */
      }
      await new Promise<void>((r) => this.d.setTimeout(r, Math.min(wait, 10) * 1000))
      return this.api(method, path, body, false)
    }
    if (!res.ok) throw new Error(`Discord ${method} ${path.replace(/\d{15,}/g, '…')} → ${res.status}`)
    return res.status === 204 ? undefined : res.json()
  }

  private setState(s: DiscordState, detail: string): void {
    this.state = s
    this.detail = detail
    this.emit('state', s, detail)
  }

  private clearTimers(): void {
    if (this.beat !== undefined) this.d.clearTimeout(this.beat)
    if (this.retry !== undefined) this.d.clearTimeout(this.retry)
    this.beat = this.retry = undefined
  }

  private connect(): void {
    this.clearTimers()
    this.setState('connecting', '')
    let ws: WsLike
    try {
      ws = new this.d.WebSocket(GATEWAY)
    } catch (err) {
      this.scheduleRetry(err instanceof Error ? err.message : String(err))
      return
    }
    this.ws = ws
    this.seq = null
    this.acked = true
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      let msg: { op?: number; s?: number | null; t?: string; d?: Record<string, unknown> }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (typeof msg.s === 'number') this.seq = msg.s
      this.onGateway(ws, msg)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.clearTimers()
      if (this.stopped) return
      const fatal = FATAL[ev.code]
      if (fatal) {
        this.stopped = true
        this.setState('failed', fatal)
        return
      }
      this.scheduleRetry(`disconnected (${ev.code})`)
    }
    ws.onerror = () => {
      /* onclose follows and decides */
    }
  }

  private onGateway(ws: WsLike, msg: { op?: number; t?: string; d?: Record<string, unknown> }): void {
    const send = (o: unknown): void => {
      try {
        ws.send(JSON.stringify(o))
      } catch {
        /* the close handler reconnects */
      }
    }
    switch (msg.op) {
      case 10: {
        const every = Number(msg.d?.heartbeat_interval) || 41_250
        const tick = (): void => {
          // no ack since the last beat: the connection is a zombie, so start over
          if (!this.acked) {
            // a dead link may never deliver the close: drop it and reconnect without waiting for onclose
            this.ws = undefined
            this.clearTimers()
            try {
              ws.close(4000)
            } catch {
              /* already gone */
            }
            return this.scheduleRetry('heartbeat lost')
          }
          this.acked = false
          send({ op: 1, d: this.seq })
          this.beat = this.d.setTimeout(tick, every)
        }
        this.beat = this.d.setTimeout(tick, Math.floor(every * Math.random()))
        send({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'ouroboros', device: 'ouroboros' } } })
        return
      }
      case 11:
        this.acked = true
        return
      case 1:
        send({ op: 1, d: this.seq })
        return
      case 7:
      case 9:
        ws.close(4000)
        return
      case 0:
        if (msg.t === 'READY') {
          this.backoff = 2000
          this.username = String((msg.d?.user as { username?: string } | undefined)?.username ?? '')
          this.setState('ready', this.username)
          this.emit('ready', this.username)
        } else if (msg.t === 'MESSAGE_CREATE') {
          const d = msg.d ?? {}
          const author = (d.author ?? {}) as { id?: string; bot?: boolean }
          // the owner's direct messages only: a server channel has a guild_id, and bots (Ouro itself) are skipped
          if (d.guild_id || author.bot || author.id !== this.ownerId) return
          const channelId = String(d.channel_id ?? '')
          if (channelId) this.dmChannel = channelId
          this.emit('message', { id: String(d.id ?? ''), channelId, text: String(d.content ?? '') } satisfies DiscordMessage)
        }
    }
  }

  private scheduleRetry(why: string): void {
    if (this.stopped) return
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, 60_000)
    this.setState('retrying', `${why}; trying again in ${Math.round(wait / 1000)} s`)
    this.retry = this.d.setTimeout(() => this.connect(), wait)
  }
}
