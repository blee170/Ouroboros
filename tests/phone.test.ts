import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FailureLimiter, bindRefusal, cleanDeviceName, isPrivateLan, isTailscale, pairingUrl, phoneRestart, phoneSend, sourceAllowed } from '../src/shared/phone'
import { PhoneDevices, PhoneServer, authRefusal, type PhoneHandlers } from '../src/main/phone-server'
import net from 'node:net'

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

describe('what a message from the phone does to a card', () => {
  const up = { alive: true, launchFailed: false }
  it.each([
    ['an idle card', { status: 'idle', ...up }],
    ['a working card', { status: 'working', ...up }],
    ['a finished card', { status: 'done', statusDetail: 'finished', ...up }],
    // Claude Code is alive at its prompt after a StopFailure: a message starts a new turn
    ['a card whose turn failed', { status: 'needs-you', statusDetail: 'failed: API Error: Request rejected (429)', ...up }]
  ])('sends to %s', (_name, card) => {
    expect(phoneSend(card)).toEqual({ how: 'send' })
  })

  it('wakes an asleep card, which has no process', () => {
    expect(phoneSend({ status: 'ended', statusDetail: 'asleep', asleep: true, alive: false, launchFailed: false })).toEqual({ how: 'wake' })
  })

  it.each([
    ['an ended card', { status: 'ended', alive: false, launchFailed: false }],
    ['a card whose CLI never started', { status: 'needs-you', statusDetail: 'failed: claude is not installed or not on PATH.', alive: true, launchFailed: true }],
    // the same "failed:" words, but text typed there would run in a shell
    ['a card where only its shell runs', { status: 'needs-you', statusDetail: 'failed: Claude Code is no longer running in this card (only its shell is). Restart the card.', alive: true, launchFailed: true }],
    ['a failed turn whose process is gone', { status: 'needs-you', statusDetail: 'failed: API Error', alive: false, launchFailed: false }],
    // /exit: SessionEnd ends the CLI, its shell stays alive (an inbox push would come back gone and drop the message)
    ['a card whose CLI ended inside its shell', { status: 'ended', statusDetail: 'session ended', alive: true, launchFailed: false }]
  ])('refuses %s: it needs a Restart', (_name, card) => {
    const r = phoneSend(card)
    expect(r).not.toHaveProperty('how')
    expect((r as { refusal: string }).refusal).toMatch(/not running/)
    expect((r as { refusal: string }).refusal).toMatch(/Restart/)
    // the phone restarts it now: no walk to the PC
    expect((r as { refusal: string }).refusal).not.toMatch(/PC/)
  })

  it.each([
    ['a permission prompt', { status: 'needs-you', statusDetail: 'permission: Bash', alive: true, launchFailed: false }],
    ['the folder-trust question', { status: 'needs-you', statusDetail: 'trust this folder?', alive: true, launchFailed: false }],
    ['a needs-you with no detail', { status: 'needs-you', alive: true, launchFailed: false }]
  ])('refuses %s: answer it first', (_name, card) => {
    const r = phoneSend(card)
    expect(r).not.toHaveProperty('how')
    expect((r as { refusal: string }).refusal).toMatch(/answer/)
  })

  it('leaves an asleep card asleep when it cannot wake, and says why', () => {
    const asleep = { status: 'ended', statusDetail: 'asleep', asleep: true, alive: false, launchFailed: false }
    const capped = phoneSend({ ...asleep, leadFull: true })
    expect(capped).not.toHaveProperty('how')
    expect((capped as { refusal: string }).refusal).toMatch(/lead/)
    // the run's own words, as sendPrompt would refuse it
    expect(phoneSend({ ...asleep, runRefusal: 'Autonomous mode: not this card' })).toEqual({ refusal: 'Autonomous mode: not this card' })
  })

  it('says why the PC did not start a card, instead of "not running"', () => {
    const held = 'held: the board file was changed outside Ouroboros.'
    expect(phoneSend({ status: 'starting', statusDetail: 'waking', alive: false, launchFailed: false, launchRefused: held })).toEqual({ refusal: `The PC did not start it: ${held}` })
  })
})

describe('what a Restart from the phone does to a card', () => {
  const down = { waking: false, restarting: false, alive: false, launchFailed: false }
  it.each([
    ['a card whose CLI never came up', { status: 'needs-you', statusDetail: 'failed: claude is not installed or not on PATH.', ...down, alive: true, launchFailed: true }],
    ['a card where only its shell runs', { status: 'needs-you', statusDetail: 'failed: Claude Code is no longer running in this card (only its shell is). Restart the card.', ...down, alive: true, launchFailed: true }],
    ['a card whose process exited', { status: 'ended', statusDetail: 'exited (0)', ...down }],
    ['a failed turn whose process is gone', { status: 'needs-you', statusDetail: 'failed: API Error', ...down }],
    ['a card whose CLI ended inside its shell', { status: 'ended', statusDetail: 'session ended', ...down, alive: true }],
    // a refused launch leaves main's status as it was (starting, for a woken card), with no process
    ['a card whose launch the PC refused', { status: 'starting', statusDetail: 'waking', ...down, launchRefused: 'held: the board file was changed outside Ouroboros.' }]
  ])('restarts %s', (_name, card) => {
    expect(phoneRestart(card)).toHaveProperty('how')
  })

  it.each([
    ['a working card', { status: 'working', ...down, alive: true }, /running/],
    ['a card at its prompt', { status: 'idle', ...down, alive: true }, /running/],
    ['a card whose turn failed (Claude Code is at its prompt)', { status: 'needs-you', statusDetail: 'failed: API Error (429)', ...down, alive: true }, /running/],
    ['a card on a permission prompt', { status: 'needs-you', statusDetail: 'permission: Bash', ...down, alive: true }, /running/],
    ['an asleep card', { status: 'ended', statusDetail: 'asleep', asleep: true, ...down }, /asleep/],
    ['a waking card', { status: 'starting', statusDetail: 'waking', ...down, waking: true, restarting: true }, /waking/],
    ['a starting card', { status: 'starting', statusDetail: 'launching claude', ...down, alive: true }, /starting/],
    ['a card its page has not launched yet', { status: 'starting', ...down }, /starting/],
    ['a card restarting already', { status: 'needs-you', statusDetail: 'failed: x', ...down, launchFailed: true, restarting: true }, /already/]
  ])('refuses %s', (_name, card, why) => {
    const r = phoneRestart(card)
    expect(r).not.toHaveProperty('how')
    expect((r as { refusal: string }).refusal).toMatch(why)
  })

  it('relaunches as the PC does: the conversation resumes only when the launch options carry a session', () => {
    const gone = { status: 'ended', ...down }
    expect(phoneRestart({ ...gone, claude: { resume: 'sess-1' } })).toEqual({ how: 'resume' })
    expect(phoneRestart({ ...gone, claude: { continue: true } })).toEqual({ how: 'continue' })
    expect(phoneRestart({ ...gone, claude: {} })).toEqual({ how: 'new' })
    expect(phoneRestart(gone)).toEqual({ how: 'new' })
    // the session the app knows wins: a card that was launched plain keeps its conversation too
    expect(phoneRestart({ ...gone, sessionId: 'sess-9' })).toEqual({ how: 'resume' })
    expect(phoneRestart({ ...gone, sessionId: 'sess-9', claude: { continue: true } })).toEqual({ how: 'resume' })
  })

  it('after a resume from the phone that did not come up, relaunches as the card’s own options say, and says so', () => {
    const tried = { status: 'ended', ...down, sessionId: 'sess-9', resumeTried: true }
    expect(phoneRestart({ ...tried, claude: { continue: true } })).toEqual({ how: 'continue', resumeFailed: true })
    expect(phoneRestart({ ...tried, claude: { resume: 'sess-own' } })).toEqual({ how: 'resume', resumeFailed: true })
    expect(phoneRestart(tried)).toEqual({ how: 'new', resumeFailed: true })
  })
})

describe('the phone server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-phone-'))
  const notes: string[] = []
  const prompts: Array<[string, string]> = []
  const answers: Array<[string, string]> = []
  const events: string[] = []
  const taskAnswers: unknown[][] = []
  const restarted = new Set<string>()
  const handlers: PhoneHandlers = {
    board: () => ({ project: 'p', autonomous: false, cards: [{ id: 'c1', title: 'Chief' }], approvals: [] }),
    prompt: (id, text) => (prompts.push([id, text]), { ok: true }),
    answer: (id, key) => (answers.push([id, key]), { ok: true }),
    resolveApproval: (id) => (id === '1-A1' ? { ok: true } : { ok: false, error: 'no approval' }),
    answerDecision: (id, answer, _note, device) => (id === '1-D1' && answer === 'Approve' && device ? { ok: true } : { ok: false, error: 'no such question' }),
    task: (id) => (id === '1-T1' ? { id, kind: 'do', ask: 'Run the migration', steps: ['Open the dashboard'], updatedAt: 5 } : undefined),
    // as the app answers: the answer is to the task as the phone read it (updatedAt 5)
    answerTask: (id, choice, text, shownAt) => (
      taskAnswers.push([id, choice, text, shownAt]),
      id !== '1-T1' ? { ok: false, error: `${id.slice(2)} is not waiting on you` } : shownAt !== 5 ? { ok: false, error: 'T1 changed since you read it. Read it again before you answer.' } : choice === 'hold' ? { ok: true, warning: 'Saved, but the card was not told: no route' } : { ok: true }
    ),
    // as the app restarts: from the screen the phone showed (lastEventAt 5), a card that is not running, once
    restart: (id, promptAt) =>
      promptAt !== 5 ? { ok: false, error: 'the card has moved on since this screen was loaded; look again' } : id === 'run' ? { ok: false, error: 'It is running: only a card whose CLI stopped is restarted from the phone.' } : restarted.has(id) ? { ok: false, error: 'It is restarting already.' } : (restarted.add(id), { ok: true }),
    latestReport: () => '# report',
    notify: (e) => (events.push(e), { ok: true, queued: true }),
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
    const js = (await call('/m/app.js')).text
    expect(js).not.toContain('innerHTML')
    expect(() => new Function(js)).not.toThrow() // the template string still makes valid script
  })

  it('gives an automation key the notify route and nothing else', async () => {
    const { token, device } = devices.add('MacroDroid', Date.now(), 'notify')
    expect(device.scope).toBe('notify')
    const r = await call('/m/api/notify', { token, body: { event: 'car' } })
    expect(r.status).toBe(200)
    expect(events).toEqual(['car'])
    expect((await call('/m/api/notify', { token, body: { event: 'boom' } })).status).toBe(400)
    expect((await call('/m/api/board', { token })).status).toBe(403)
    expect((await call('/m/api/cards/c1/prompt', { token, body: { text: 'hi' } })).status).toBe(403)
    expect(notes.some((n) => n.includes('key MacroDroid: car'))).toBe(true)
    // an unknown scope on disk is not read as a full phone
    const f2 = join(dir, 'scoped.json')
    writeFileSync(f2, JSON.stringify([{ id: 'a', name: 'x', tokenHash: 'a'.repeat(64), createdAt: 1, scope: 'admin' }, { id: 'b', name: 'y', tokenHash: 'b'.repeat(64), createdAt: 1, scope: 'notify' }]))
    expect(new PhoneDevices(f2).list.map((d) => d.id)).toEqual(['b'])
    // revoked like a phone (no 401 calls here: they would count against this address for the next test)
    devices.revoke(device.id)
    expect(devices.match(token)).toBeUndefined()
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

  it('opens and answers a task that waits on the owner, and never logs what was pasted', async () => {
    // its own server: the refusals below count against this address
    const s = new PhoneServer(new PhoneDevices(join(dir, 'd5.json')), handlers, () => {}, { sourceAllowed: () => true, bindRefusal: () => undefined, isLocal: () => false })
    await s.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })
    const save = base
    base = s.url!.replace(/\/m$/, '')
    try {
      const { token } = s.devices.add('Pixel')
      const key = s.devices.add('MacroDroid', Date.now(), 'notify').token
      expect((await call('/m/api/tasks/1-T1')).status).toBe(401)
      expect((await call('/m/api/tasks/1-T1', { token: key })).status).toBe(403)
      expect((await call('/m/api/tasks/1-T1', { token: key, body: { choice: 'hold', shownAt: 5 } })).status).toBe(403)
      // the long parts the board leaves out come with the task, when the owner opens it
      const open = await call('/m/api/tasks/1-T1', { token })
      expect(open.status).toBe(200)
      expect(open.body).toMatchObject({ id: '1-T1', steps: ['Open the dashboard'], updatedAt: 5 })
      expect((await call('/m/api/tasks/1-T9', { token })).status).toBe(404)
      expect((await call('/m/api/tasks/T1', { token })).status).toBe(404)
      // refused before the app sees it
      expect((await call('/m/api/tasks/1-T1', { token, body: { choice: 'yes', shownAt: 5 } })).status).toBe(400)
      expect((await call('/m/api/tasks/1-T1', { token, body: { choice: 'did', text: 7, shownAt: 5 } })).status).toBe(400)
      expect((await call('/m/api/tasks/1-T1', { token, body: { choice: 'did' } })).status).toBe(400)
      expect(taskAnswers).toEqual([])
      // the app's own refusals and its warning reach the phone as they are
      expect(await call('/m/api/tasks/1-T1', { token, body: { choice: 'did', text: 'x', shownAt: 4 } })).toMatchObject({ status: 409, body: { error: 'T1 changed since you read it. Read it again before you answer.' } })
      expect(await call('/m/api/tasks/1-T9', { token, body: { choice: 'hold', shownAt: 5 } })).toMatchObject({ status: 409, body: { error: 'T9 is not waiting on you' } })
      expect(await call('/m/api/tasks/1-T1', { token, body: { choice: 'hold', shownAt: 5 } })).toMatchObject({ status: 200, body: { ok: true, warning: 'Saved, but the card was not told: no route' } })
      expect((await call('/m/api/tasks/1-T1', { token, body: { choice: 'did', text: 'SECRET-PASTE 42 rows', shownAt: 5 } })).status).toBe(200)
      expect(taskAnswers.at(-1)).toEqual(['1-T1', 'did', 'SECRET-PASTE 42 rows', 5])
      // the log and the run's report name the phone, the answer and the task, never the pasted text
      expect(notes.filter((n) => n.includes('task'))).toEqual(['phone Pixel answered task 1-T1: hold', 'phone Pixel answered task 1-T1: did'])
      expect(notes.join('\n')).not.toContain('SECRET-PASTE')
    } finally {
      s.stop()
      base = save
    }
  })

  it('restarts a card once, from the screen the phone showed', async () => {
    const s = new PhoneServer(new PhoneDevices(join(dir, 'd6.json')), handlers, () => {}, { sourceAllowed: () => true, bindRefusal: () => undefined, isLocal: () => false })
    await s.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })
    const save = base
    base = s.url!.replace(/\/m$/, '')
    try {
      const { token } = s.devices.add('Pixel')
      const key = s.devices.add('MacroDroid', Date.now(), 'notify').token
      expect((await call('/m/api/cards/c9/restart', { body: { promptAt: 5 } })).status).toBe(401)
      expect((await call('/m/api/cards/c9/restart', { token: key, body: { promptAt: 5 } })).status).toBe(403)
      expect(await call('/m/api/cards/c9/restart', { token, body: { promptAt: 4 } })).toMatchObject({ status: 409, body: { error: 'the card has moved on since this screen was loaded; look again' } })
      expect((await call('/m/api/cards/c9/restart', { token, body: {} })).status).toBe(409) // no screen, no restart
      expect(await call('/m/api/cards/run/restart', { token, body: { promptAt: 5 } })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/running/) } })
      expect(await call('/m/api/cards/c9/restart', { token, body: { promptAt: 5 } })).toMatchObject({ status: 200, body: { ok: true } })
      // a double tap reaches the app, which has a restart under way already
      expect(await call('/m/api/cards/c9/restart', { token, body: { promptAt: 5 } })).toMatchObject({ status: 409, body: { error: 'It is restarting already.' } })
      expect(notes.filter((n) => n.includes('restart'))).toEqual(['phone Pixel restarted c9'])
    } finally {
      s.stop()
      base = save
    }
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

describe('refused requests are logged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-phone-log-'))
  const lines: string[] = []
  const handlers = { notify: () => ({ ok: true, queued: true }), note: () => {} } as unknown as PhoneHandlers
  const devices = new PhoneDevices(join(dir, 'devices.json'))
  const server = new PhoneServer(devices, handlers, (l) => lines.push(l), { sourceAllowed: () => true, bindRefusal: () => undefined, isLocal: () => false })
  let port = 0
  const send = (raw: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(raw))
      let out = ''
      s.on('data', (c) => (out += c))
      s.on('close', () => resolve(out))
      s.on('error', reject)
    })
  const post = (headers: string, body = '{"event":"car"}'): Promise<string> =>
    send(`POST /m/api/notify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n${headers}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
  beforeAll(async () => {
    expect(await server.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })).toBeUndefined()
    port = Number(new URL(server.url!).port)
  })
  afterAll(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('says why a key was refused, without the key', () => {
    expect(authRefusal(undefined)).toMatch(/no Authorization header/)
    expect(authRefusal('secret-without-bearer')).toMatch(/does not start with "Bearer "/)
    expect(authRefusal('secret-without-bearer')).not.toContain('secret')
    expect(authRefusal('Bearer abc123')).toBe('unknown or revoked key')
  })

  it('logs a missing header, an unknown key, a bad body and a header name with a space', async () => {
    const { token } = devices.add('MacroDroid', Date.now(), 'notify')
    expect(await post('')).toMatch(/^HTTP\/1.1 401/)
    expect(await post('Authorization: Bearer nope-not-a-key\r\n')).toMatch(/^HTTP\/1.1 401/)
    expect(await post(`Authorization: Bearer ${token}\r\n`, '{"event":"boat"}')).toMatch(/^HTTP\/1.1 400/)
    expect(await post(`Header Authorization: Bearer ${token}\r\n`)).toMatch(/^HTTP\/1.1 400/)
    expect(lines.some((l) => /refused POST \/m\/api\/notify .*401 no Authorization header/.test(l))).toBe(true)
    expect(lines.some((l) => /401 unknown or revoked key/.test(l))).toBe(true)
    expect(lines.some((l) => /400 the body has no known event .*key MacroDroid/.test(l))).toBe(true)
    expect(lines.some((l) => /refused a malformed request from .*HPE_INVALID_HEADER_TOKEN/.test(l))).toBe(true)
    expect(lines.join('\n')).not.toContain(token)
    expect(lines.join('\n')).not.toContain('nope-not-a-key')
  })
})
