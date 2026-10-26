import { describe, expect, it } from 'vitest'
import { DiscordBot, type DiscordMessage } from '../src/main/discord'

const OWNER = '281821501458743298'

class FakeWs {
  static all: FakeWs[] = []
  sent: Record<string, unknown>[] = []
  closed?: number
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(public url: string) {
    FakeWs.all.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000): void {
    this.closed = code
    this.onclose?.({ code })
  }
  push(o: unknown): void {
    this.onmessage?.({ data: JSON.stringify(o) })
  }
}

function harness() {
  FakeWs.all = []
  const timers: { fn: () => void; ms: number; id: number }[] = []
  let next = 1
  const calls: { url: string; body: unknown; auth: string }[] = []
  let status = 200
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: String((init.headers as Record<string, string>).Authorization) })
    const s = status
    status = 200
    return new Response(JSON.stringify(url.endsWith('/users/@me/channels') ? { id: '999000111222333444' } : { retry_after: 0.01 }), { status: s })
  }) as unknown as typeof globalThis.fetch
  const bot = new DiscordBot('tok.en', OWNER, {
    WebSocket: FakeWs,
    fetch,
    setTimeout: (fn, ms) => {
      const id = next++
      timers.push({ fn, ms, id })
      return id
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i >= 0) timers.splice(i, 1)
    }
  })
  const fire = (): void => {
    const t = timers.shift()
    t?.fn()
  }
  return { bot, timers, calls, fire, setStatus: (s: number) => (status = s), ws: () => FakeWs.all[FakeWs.all.length - 1] }
}

describe('DiscordBot gateway', () => {
  it('identifies with the DM and content intents on hello, then heartbeats with the last sequence', () => {
    const h = harness()
    h.bot.start()
    const ws = h.ws()
    expect(ws.url).toContain('gateway.discord.gg')
    ws.push({ op: 10, d: { heartbeat_interval: 1000 } })
    expect(ws.sent[0]).toMatchObject({ op: 2, d: { token: 'tok.en', intents: (1 << 12) | (1 << 15) } })
    ws.push({ op: 0, s: 7, t: 'READY', d: { user: { username: 'Ouro' } } })
    expect(h.bot.state).toBe('ready')
    expect(h.bot.username).toBe('Ouro')
    h.fire()
    expect(ws.sent[1]).toEqual({ op: 1, d: 7 })
  })
  it('passes on only the owner\'s direct messages', () => {
    const h = harness()
    const got: DiscordMessage[] = []
    h.bot.on('message', (m: DiscordMessage) => got.push(m))
    h.bot.start()
    const ws = h.ws()
    ws.push({ op: 0, s: 1, t: 'MESSAGE_CREATE', d: { id: '1', channel_id: 'c', content: 'in a server', guild_id: 'g', author: { id: OWNER } } })
    ws.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '2', channel_id: 'c', content: 'stranger', author: { id: '123' } } })
    ws.push({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: { id: '3', channel_id: 'c', content: 'echo', author: { id: OWNER, bot: true } } })
    ws.push({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: { id: '4', channel_id: 'c', content: '상황 어때', author: { id: OWNER } } })
    expect(got).toEqual([{ id: '4', channelId: 'c', text: '상황 어때' }])
  })
  it('reconnects when a heartbeat goes unacknowledged, and after a plain close with backoff', () => {
    const h = harness()
    h.bot.start()
    const ws = h.ws()
    ws.push({ op: 10, d: { heartbeat_interval: 1000 } })
    h.fire() // first beat
    h.fire() // no ack since: zombie
    expect(ws.closed).toBe(4000)
    expect(h.bot.state).toBe('retrying')
    expect(h.timers[0].ms).toBe(2000)
    h.fire()
    expect(FakeWs.all.length).toBe(2)
    h.ws().close(1006)
    expect(h.timers[0].ms).toBe(4000)
  })
  it('stops for good on a bad token or a disallowed intent, with a plain reason', () => {
    const h = harness()
    h.bot.start()
    h.ws().close(4004)
    expect(h.bot.state).toBe('failed')
    expect(h.bot.detail).toContain('token')
    expect(h.bot.detail).not.toContain('tok.en')
    expect(h.timers.length).toBe(0)
    const h2 = harness()
    h2.bot.start()
    h2.ws().close(4014)
    expect(h2.bot.detail).toContain('Message Content Intent')
  })
  it('stop() closes without reconnecting', () => {
    const h = harness()
    h.bot.start()
    h.bot.stop()
    expect(h.bot.state).toBe('off')
    expect(h.timers.length).toBe(0)
    expect(FakeWs.all.length).toBe(1)
  })
})

describe('DiscordBot.send', () => {
  it('opens the DM once, splits long text and turns mentions off', async () => {
    const h = harness()
    await h.bot.send('a'.repeat(2000))
    expect(h.calls.map((c) => c.url.replace('https://discord.com/api/v10', ''))).toEqual(['/users/@me/channels', '/channels/999000111222333444/messages', '/channels/999000111222333444/messages'])
    expect(h.calls[0].body).toEqual({ recipient_id: OWNER })
    expect((h.calls[1].body as { content: string }).content.length).toBe(1900)
    expect(h.calls[1].body).toMatchObject({ allowed_mentions: { parse: [] } })
    expect(h.calls[0].auth).toBe('Bot tok.en')
    await h.bot.send('again')
    expect(h.calls.length).toBe(4)
  })
  it('waits once on a 429 and throws without the token or ids on other errors', async () => {
    const h = harness()
    await h.bot.send('x') // opens the DM
    h.setStatus(429)
    const p = h.bot.send('rate limited')
    await new Promise((r) => setImmediate(r))
    h.fire()
    await p
    expect(h.calls.length).toBe(4)
    h.setStatus(403)
    const err = await h.bot.send('nope').catch((e: Error) => e.message)
    expect(err).toBe('Discord POST /channels/…/messages → 403')
  })
})

describe('bug-hunt regressions (gateway)', () => {
  it('reconnects on a lost heartbeat even when the close never arrives', () => {
    const h = harness()
    h.bot.start()
    const ws = h.ws()
    ws.onclose = null // a dead link: the close is never delivered
    ws.push({ op: 10, d: { heartbeat_interval: 1000 } })
    h.fire()
    h.fire()
    expect(h.bot.state).toBe('retrying')
    h.fire()
    expect(FakeWs.all.length).toBe(2)
  })
})
