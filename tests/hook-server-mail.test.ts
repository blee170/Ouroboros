import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HookServer, type ApiHandlers } from '../src/main/hook-server'

const sent: Array<[unknown, string]> = []
const api = {
  mailSend: (input: unknown, from: string) => (sent.push([input, from]), { ok: true, id: 'M1', to: 'chief' }),
  mailInbox: (self: string) => ({ count: 1, text: `inbox of ${self}` }),
  mailAck: (id: string) => (id === 'M1' ? { ok: true } : { ok: false, error: 'no message' }),
  registerInbox: (self: string, socket: unknown) => (inboxes.push([self, socket]), { ok: true }),
  askOwner: async (self: string, input: { question?: unknown }) => (typeof input.question === 'string' ? { ok: true, id: 'D1', answered: false, text: `pending D1 for ${self}` } : { ok: false, error: 'question required' }),
  listAgents: () => []
} as unknown as ApiHandlers
const inboxes: Array<[string, unknown]> = []
const server = new HookServer({
  onHook: (id, e) => (e.hook_event_name === 'Stop' && id === 'w1' ? { decision: 'block', reason: 'mail' } : undefined),
  onExternalHook: () => undefined,
  resolveApi: () => api
})

function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path, method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', ...opts.headers } }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }))
    })
    req.on('error', reject)
    req.end(opts.method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}))
  })
}

beforeAll(async () => {
  await server.start(0)
})
afterAll(() => server.stop())

describe('mail routes', () => {
  it('take a card mail token, API token or the master token, always as a named card', async () => {
    const as = (id: string, token: string) => ({ 'x-ouroboros-self': id, 'x-ouroboros-token': token })
    expect((await call('/api/mail', { body: { to: 'chief', body: 'hi' } })).status).toBe(401)
    expect((await call('/api/mail', { headers: as('w1', server.mailToken('w2')), body: { to: 'chief', body: 'hi' } })).status).toBe(401)
    expect((await call('/api/mail', { headers: { 'x-ouroboros-token': server.token }, body: { to: 'chief', body: 'hi' } })).status).toBe(401) // master, but no card named
    expect((await call('/api/mail', { headers: as('w1', server.hookToken('w1')), body: { to: 'chief', body: 'hi' } })).status).toBe(401) // a hook token is no mail credential
    sent.length = 0
    const ok = await call('/api/mail', { headers: as('w1', server.mailToken('w1')), body: { to: 'chief', body: 'hi', kind: 'status' } })
    expect(ok).toMatchObject({ status: 200, body: { ok: true, id: 'M1' } })
    expect(sent).toEqual([[{ to: 'chief', body: 'hi', kind: 'status', reply_to: undefined }, 'w1']])
    expect((await call('/api/mail', { headers: as('c1', server.apiToken('c1')), body: { to: 'w1', body: 'x' } })).status).toBe(200)
    expect((await call('/api/mail', { headers: as('w1', server.mailToken('w1')), body: { to: 'chief' } })).status).toBe(400)
    expect(await call('/api/mail?unread=1', { method: 'GET', headers: as('w1', server.mailToken('w1')) })).toMatchObject({ status: 200, body: { text: 'inbox of w1' } })
    expect((await call('/api/mail/M1/ack', { headers: as('w1', server.mailToken('w1')) })).status).toBe(200)
    expect((await call('/api/mail/M9/ack', { headers: as('w1', server.mailToken('w1')) })).status).toBe(404)
  })

  it('asks the owner as the card its token says', async () => {
    const as = (id: string, token: string) => ({ 'x-ouroboros-self': id, 'x-ouroboros-token': token })
    expect((await call('/api/mail/ask', { headers: as('w1', server.mailToken('w2')), body: { question: 'q' } })).status).toBe(401)
    expect(await call('/api/mail/ask', { headers: as('w1', server.mailToken('w1')), body: { question: 'Ship it?' } })).toMatchObject({ status: 200, body: { id: 'D1', text: 'pending D1 for w1' } })
    expect((await call('/api/mail/ask', { headers: as('w1', server.mailToken('w1')), body: {} })).status).toBe(400)
  })

  it("registers the caller's own inbox, as the card its token says", async () => {
    expect((await call('/api/mail/inbox', { headers: { 'x-ouroboros-self': 'w1', 'x-ouroboros-token': server.mailToken('w2') }, body: { socket: 'x' } })).status).toBe(401)
    expect((await call('/api/mail/inbox', { headers: { 'x-ouroboros-self': 'w1', 'x-ouroboros-token': server.mailToken('w1') }, body: { socket: 'p', token: 't' } })).status).toBe(200)
    expect(inboxes).toEqual([['w1', 'p']])
  })

  it('a mail token reaches nothing else on the API', async () => {
    const h = { 'x-ouroboros-self': 'w1', 'x-ouroboros-token': server.mailToken('w1') }
    expect((await call('/api/agents', { method: 'GET', headers: h })).status).toBe(401)
    expect((await call('/api/tasks', { method: 'GET', headers: h })).status).toBe(401)
  })
})

describe('hook replies', () => {
  it("return main's reply for Stop and {} for other cards and events", async () => {
    const tok = (id: string) => ({ 'x-ouroboros-token': server.hookToken(id) })
    expect(await call('/hook/w1', { headers: tok('w1'), body: { hook_event_name: 'Stop' } })).toMatchObject({ status: 200, body: { decision: 'block', reason: 'mail' } })
    expect(await call('/hook/w2', { headers: tok('w2'), body: { hook_event_name: 'Stop' } })).toEqual({ status: 200, body: {} })
    expect(await call('/hook/w1', { headers: tok('w1'), body: { hook_event_name: 'PreToolUse' } })).toEqual({ status: 200, body: {} })
  })
})
