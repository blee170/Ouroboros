import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FailureLimiter, bindRefusal, cleanDeviceName, isPrivateLan, isTailscale, pairingUrl, sourceAllowed } from '../src/shared/phone'
import { PhoneDevices, PhoneServer, type PhoneHandlers } from '../src/main/phone-server'

describe('network rules', () => {
  it('knows Tailscale and home-network addresses', () => {
    expect(isTailscale('100.64.0.1')).toBe(true)
    expect(isTailscale('100.127.255.254')).toBe(true)
    expect(isTailscale('100.128.0.1')).toBe(false)
    expect(isTailscale('::ffff:100.100.1.2')).toBe(true)
    expect(isPrivateLan('192.168.0.10')).toBe(true)
    expect(isPrivateLan('172.31.1.1')).toBe(true)
    expect(isPrivateLan('172.32.1.1')).toBe(false)
    expect(isPrivateLan('8.8.8.8')).toBe(false)
    expect(sourceAllowed('100.70.1.1', false)).toBe(true)
    expect(sourceAllowed('192.168.0.5', false)).toBe(false)
    expect(sourceAllowed('192.168.0.5', true)).toBe(true)
    expect(sourceAllowed('127.0.0.1', true)).toBe(false)
    expect(sourceAllowed('fe80::1', true)).toBe(false)
    expect(isTailscale('100.064.0.1')).toBe(false) // leading zero: octal to some resolvers
  })
  it('never binds every interface, and a LAN address only when allowed', () => {
    expect(bindRefusal('0.0.0.0', true)).toMatch(/every interface/)
    expect(bindRefusal('::', true)).toMatch(/every interface/)
    expect(bindRefusal(undefined, true)).toMatch(/pick/)
    expect(bindRefusal('100.80.0.1', false)).toBeUndefined()
    expect(bindRefusal('192.168.1.2', false)).toMatch(/home network/)
    expect(bindRefusal('192.168.1.2', true)).toBeUndefined()
    expect(bindRefusal('203.0.113.4', true)).toMatch(/neither/)
  })
  it('limits failures per address per minute', () => {
    const f = new FailureLimiter(2)
    f.fail('a', 0)
    f.fail('a', 1)
    expect(f.blocked('a', 2)).toBe(true)
    expect(f.blocked('b', 2)).toBe(false)
    expect(f.blocked('a', 60_002)).toBe(false)
  })
  it('puts the code in the fragment and cleans device names', () => {
    expect(pairingUrl('100.1.2.3', 47900, 'a/b')).toBe('http://100.1.2.3:47900/m#pair=a%2Fb')
    expect(cleanDeviceName('Pixel <script>\n9')).toBe('Pixel script9')
    expect(cleanDeviceName('')).toBe('Phone')
    expect(cleanDeviceName('김의 폰')).toBe('김의 폰')
  })
})

describe('the phone server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-phone-'))
  const notes: string[] = []
  const prompts: Array<[string, string]> = []
  const answers: Array<[string, string]> = []
  const handlers: PhoneHandlers = {
    board: () => ({ project: 'p', autonomous: false, cards: [{ id: 'c1', title: 'Chief' }], approvals: [] }),
    prompt: (id, text) => (prompts.push([id, text]), { ok: true }),
    answer: (id, key) => (answers.push([id, key]), { ok: true }),
    resolveApproval: (id) => (id === '1-A1' ? { ok: true } : { ok: false, error: 'no approval' }),
    answerDecision: (id, answer, _note, device) => (id === '1-D1' && answer === 'Approve' && device ? { ok: true } : { ok: false, error: 'no such question' }),
    latestReport: () => '# report',
    note: (l) => notes.push(l)
  }
  const devices = new PhoneDevices(join(dir, 'devices.json'))
  const server = new PhoneServer(devices, handlers, () => {}, { sourceAllowed: (ip) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1', bindRefusal: () => undefined, isLocal: () => false })
  let base = ''
  const call = (path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders; text: string }> =>
    new Promise((resolve, reject) => {
      const u = new URL(base + path)
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers } }, (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse(raw)
          } catch {
            /* html */
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers, text: raw })
        })
      })
      req.on('error', reject)
      req.end(opts.body ? JSON.stringify(opts.body) : undefined)
    })
  beforeAll(async () => {
    expect(await server.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })).toBeUndefined()
    base = server.url!.replace(/\/m$/, '')
  })
  afterAll(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves the page with a strict CSP and no inline script', async () => {
    const r = await call('/m')
    expect(r.status).toBe(200)
    expect(r.headers['content-security-policy']).toContain("default-src 'self'")
    expect(r.text).toContain('<script src="/m/app.js">')
    expect(r.text).not.toMatch(/<script>/)
    expect((await call('/m/app.js')).text).not.toContain('innerHTML')
  })

  it('pairs once with a fresh code, then takes only the device token', async () => {
    expect((await call('/m/api/board')).status).toBe(401)
    const p = server.newPairing()
    if ('error' in p) throw new Error(p.error)
    const code = decodeURIComponent(p.url.split('#pair=')[1])
    const paired = await call('/m/api/pair', { body: { code, name: 'Pixel' } })
    expect(paired.status).toBe(200)
    const token = String(paired.body.token)
    expect(readFileSync(join(dir, 'devices.json'), 'utf8')).not.toContain(token)
    expect((await call('/m/api/pair', { body: { code, name: 'again' } })).status).toBe(401) // one use
    expect((await call('/m/api/board', { token })).body).toMatchObject({ project: 'p' })
    expect((await call('/m/api/report/latest', { token })).body).toEqual({ markdown: '# report' })
    // prompts, answers, approvals
    expect((await call('/m/api/cards/c1/prompt', { token, body: { text: ' hi ' } })).status).toBe(200)
    expect(prompts).toEqual([['c1', 'hi']])
    expect((await call('/m/api/cards/c1/prompt', { token, body: { text: 'x'.repeat(16 * 1024 + 1) } })).status).toBe(400)
    expect((await call('/m/api/cards/c1/answer', { token, body: { key: 'esc' } })).status).toBe(200)
    expect((await call('/m/api/cards/c1/answer', { token, body: { key: 'esc' } })).status).toBe(409) // a double tap
    expect((await call('/m/api/cards/c1/answer', { token, body: { key: 'y' } })).status).toBe(400)
    expect((await call('/m/api/cards/c1/answer', { token, body: { key: '2' } })).status).toBe(400) // no lasting allow from the phone
    expect((await call('/m/api/cards/../answer', { token, body: { key: '1' } })).status).toBe(404)
    expect(answers).toEqual([['c1', 'esc']])
    expect((await call('/m/api/approvals/1-A1', { token, body: { approve: true } })).status).toBe(200)
    expect((await call('/m/api/approvals/1-A2', { token, body: { approve: true } })).status).toBe(409)
    expect(notes.some((n) => n.includes('approved 1-A1'))).toBe(true)
    expect((await call('/m/api/decisions/1-D1', { token, body: { answer: 'Approve', note: 'go' } })).status).toBe(200)
    expect((await call('/m/api/decisions/1-D1', { token, body: { answer: 7 } })).status).toBe(400)
    expect((await call('/m/api/decisions/1-D2', { token, body: { answer: 'Approve' } })).status).toBe(409)
    expect((await call('/m/api/decisions/D1', { token, body: { answer: 'Approve' } })).status).toBe(404)
    expect(notes.some((n) => n.includes('answered 1-D1: Approve'))).toBe(true)
    // revoked: refused
    devices.revoke(devices.list[0].id)
    expect((await call('/m/api/board', { token })).status).toBe(401)
  })

  it('refuses a foreign Host or Origin, non-JSON posts, and the card API', async () => {
    expect((await call('/m', { headers: { host: 'evil.example:80' } })).status).toBe(421)
    expect((await call('/m/api/board', { headers: { origin: 'http://evil.example' } })).status).toBe(403)
    expect((await call('/m/api/pair', { body: { code: 'x' }, headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await call('/api/agents')).status).toBe(404)
    expect((await call('/hook/w1')).status).toBe(404)
  })

  it('locks out an address after repeated failures', async () => {
    const fresh = new PhoneServer(new PhoneDevices(join(dir, 'd2.json')), handlers, () => {}, { sourceAllowed: () => true, bindRefusal: () => undefined, isLocal: () => false })
    await fresh.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })
    const save = base
    base = fresh.url!.replace(/\/m$/, '')
    for (let i = 0; i < 5; i++) expect((await call('/m/api/board', { token: 'nope' })).status).toBe(401)
    expect((await call('/m/api/board', { token: 'nope' })).status).toBe(429)
    fresh.stop()
    base = save
  })

  it('refuses the PC itself as a phone (a card reaching its own address)', async () => {
    const s = new PhoneServer(new PhoneDevices(join(dir, 'd4.json')), handlers, () => {}, { sourceAllowed: () => true, bindRefusal: () => undefined, isLocal: () => true })
    await s.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })
    const save = base
    base = s.url!.slice(0, -2)
    expect((await call('/m')).status).toBe(403)
    s.stop()
    base = save
  })

  it('stays off when disabled and refuses to listen everywhere', async () => {
    const s = new PhoneServer(new PhoneDevices(join(dir, 'd3.json')), handlers)
    expect(await s.apply({ enabled: false, port: 0, allowLan: false })).toBeUndefined()
    expect(s.url).toBeUndefined()
    expect(await s.apply({ enabled: true, host: '0.0.0.0', port: 0, allowLan: true })).toMatch(/every interface/)
    expect(s.newPairing()).toHaveProperty('error')
  })
})
