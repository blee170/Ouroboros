import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HookServer, type ApiHandlers } from '../src/main/hook-server'
import type { HookEvent } from '../src/shared/types'

const hooks: Array<[string, HookEvent]> = []
const external: HookEvent[] = []
const selves: Array<string | undefined> = []
const api = { listAgents: () => [] } as unknown as ApiHandlers
const logged: string[] = []
const server = new HookServer({
  log: (l) => logged.push(l),
  onHook: (id, e) => {
    hooks.push([id, e])
  },
  onExternalHook: (e) => external.push(e),
  resolveApi: (self) => (selves.push(self), api),
  externalToken: 'ext-token'
})

/** A raw request, so Host and Origin can be set the way a browser page or a rebinding attack would. */
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path, method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', ...opts.headers } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(opts.method === 'GET' ? undefined : (opts.body ?? JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'hi' })))
  })
}

beforeAll(async () => {
  await server.start(0)
})
afterAll(() => server.stop())

describe('HookServer auth', () => {
  it('derives stable per-card tokens, different between cards and between hooks and the API', () => {
    expect(server.hookToken('a')).toBe(server.hookToken('a'))
    expect(server.hookToken('a')).not.toBe(server.hookToken('b'))
    expect(server.hookToken('a')).not.toBe(server.apiToken('a'))
    expect(server.hookToken('a')).toMatch(/^[0-9a-f]{64}$/)
  })

  it("takes a card's hook only with that card's token", async () => {
    hooks.length = 0
    expect(await call('/hook/a')).toBe(401)
    expect(await call('/hook/a', { headers: { 'x-ouroboros-token': server.hookToken('b') } })).toBe(401)
    expect(await call('/hook/a', { headers: { 'x-ouroboros-token': server.token } })).toBe(401) // not even the master token
    expect(hooks).toEqual([])
    expect(await call('/hook/a', { headers: { 'x-ouroboros-token': server.hookToken('a') } })).toBe(200)
    expect(hooks.map(([id]) => id)).toEqual(['a'])
    // the refusal is in the log, once per route and status however often the card retries
    expect(logged.filter((l) => l.includes('/hook/a: 401'))).toHaveLength(1)
  })

  it('takes the global hook only with the external token', async () => {
    external.length = 0
    expect(await call('/hook/external')).toBe(401)
    expect(await call('/hook/external', { headers: { 'x-ouroboros-token': server.hookToken('external') } })).toBe(401)
    expect(await call('/hook/external', { headers: { 'x-ouroboros-token': 'ext-token' } })).toBe(200)
    expect(external).toHaveLength(1)
  })

  it('refuses browser pages, other host names and non-JSON posts', async () => {
    const ok = { 'x-ouroboros-token': server.hookToken('a') }
    expect(await call('/hook/a', { headers: { ...ok, origin: 'https://evil.example' } })).toBe(403)
    expect(await call('/hook/a', { headers: { ...ok, origin: 'null' } })).toBe(403)
    expect(await call('/hook/a', { headers: { ...ok, host: `evil.example:${server.port}` } })).toBe(403) // DNS rebinding
    expect(await call('/hook/a', { headers: { ...ok, host: `localhost:${server.port}` } })).toBe(200)
    expect(await call('/hook/a', { headers: { ...ok, 'content-type': 'text/plain' } })).toBe(415) // a no-cors fetch
    expect(await call('/hook/a/statusline', { headers: { 'content-type': 'text/plain' } })).toBe(415)
    expect(await call('/hook/a/statusline', { body: '{}' })).toBe(204) // guarded, no token
    expect(await call('/api/agents', { method: 'GET', headers: { 'x-ouroboros-token': server.token, origin: 'https://evil.example' } })).toBe(403)
  })

  it('makes an API caller the card its token belongs to, and nobody else', async () => {
    selves.length = 0
    const get = (headers: Record<string, string>): Promise<number> => call('/api/agents', { method: 'GET', headers, body: '' })
    expect(await get({})).toBe(401)
    expect(await get({ 'x-ouroboros-token': server.apiToken('a') })).toBe(401) // a card token must name its card
    expect(await get({ 'x-ouroboros-token': server.apiToken('a'), 'x-ouroboros-self': 'b' })).toBe(401) // A posing as B
    expect(await call('/api/agents?self=b', { method: 'GET', headers: { 'x-ouroboros-token': server.apiToken('a') }, body: '' })).toBe(401)
    expect(await get({ 'x-ouroboros-token': server.hookToken('a'), 'x-ouroboros-self': 'a' })).toBe(401) // every card has a hook token; only board-tools cards an API token
    expect(selves).toEqual([])
    expect(await get({ 'x-ouroboros-token': server.apiToken('a'), 'x-ouroboros-self': 'a' })).toBe(200)
    expect(await get({ 'x-ouroboros-token': server.token })).toBe(200) // master: main process and tests, unscoped
    expect(await get({ 'x-ouroboros-token': server.token, 'x-ouroboros-self': 'b' })).toBe(200)
    expect(selves).toEqual(['a', undefined, 'b'])
  })
})

describe('post_discord route', () => {
  it('posts only as a named card, passing the channel and text through', async () => {
    const posts: Array<[string, unknown]> = []
    ;(api as { discordPost?: ApiHandlers['discordPost'] }).discordPost = async (self, input) => {
      posts.push([self, input])
      return typeof input.channel === 'string' && input.channel ? { ok: true, channel: input.channel } : { ok: false, error: 'no allowed channel' }
    }
    const body = JSON.stringify({ channel: 'updates', text: 'done' })
    expect(await call('/api/discord', { headers: { 'x-ouroboros-token': server.token }, body })).toBe(403)
    expect(await call('/api/discord', { headers: { 'x-ouroboros-token': server.apiToken('c1'), 'x-ouroboros-self': 'c1' }, body })).toBe(200)
    expect(await call('/api/discord', { headers: { 'x-ouroboros-token': server.apiToken('c1'), 'x-ouroboros-self': 'c1' }, body: '{}' })).toBe(400)
    expect(await call('/api/discord', { headers: { 'x-ouroboros-token': server.hookToken('c1'), 'x-ouroboros-self': 'c1' }, body })).toBe(401)
    expect(posts).toEqual([
      ['c1', { channel: 'updates', text: 'done' }],
      ['c1', {}]
    ])
  })
})
