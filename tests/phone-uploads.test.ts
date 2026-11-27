import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PHONE_FILES_NOTE, PHONE_LIMITS, cleanUploadName, withPhoneFiles } from '../src/shared/phone'
import { PhoneDevices, PhoneServer, type PhoneHandlers } from '../src/main/phone-server'
import { PhoneUploads } from '../src/main/phone-uploads'

/** Every file under a folder, as paths relative to it. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
}

describe('a file name from the phone', () => {
  it.each([
    ['..\\..\\x.ps1', 'x.ps1'],
    ['a/b/c.png', 'c.png'],
    ['CON.txt', '_CON.txt'],
    ['nul', '_nul'],
    ['com1.tar.gz', '_com1.tar.gz'],
    ['a:b.jpg', 'ab.jpg'],
    ['회의 메모 (1).jpg', '회의 메모 (1).jpg'],
    ['a'.repeat(300) + '.png', 'a'.repeat(76) + '.png'],
    ['README', 'README'],
    ['photo.jpg.', 'photo.jpg'],
    ['photo .JPG  ', 'photo.jpg'],
    ['.env', 'file.env'],
    ['...', 'file'],
    ['', 'file'],
    ['<>:"|?*', 'file'],
    ['\u202Egnp.exe', 'gnp.exe'],
    ['line\nbreak\t.txt', 'linebreak.txt'],
    ["$(rm -rf ~) `x` it's [1].png", '(rm -rf ~) x its 1.png'],
    // an extension longer than 8 is no extension: the whole name is the base
    ['notes.verylongext', 'notes.verylongext']
  ])('%j becomes %j', (raw, clean) => {
    expect(cleanUploadName(raw)).toBe(clean)
  })

  it('is a base name of at most about 80 characters for anything', () => {
    for (const raw of [undefined, 42, null, { name: 'x' }]) expect(cleanUploadName(raw)).toBe('file')
    expect(cleanUploadName('가'.repeat(200) + '.pdf')).toHaveLength(80)
    expect(cleanUploadName('x'.repeat(200))).toHaveLength(80)
  })
})

describe('the prompt a message with files becomes', () => {
  it('puts each path on its own line under one fixed line, after the text', () => {
    expect(withPhoneFiles('look at this', ['C:\\u\\a.png', 'C:\\u\\b c.pdf'])).toBe(`look at this\n\n${PHONE_FILES_NOTE}\nC:\\u\\a.png\nC:\\u\\b c.pdf`)
    expect(withPhoneFiles('', ['C:\\u\\a.png'])).toBe(`${PHONE_FILES_NOTE}\nC:\\u\\a.png`)
    expect(withPhoneFiles('just text', [])).toBe('just text')
    expect(PHONE_FILES_NOTE).toMatch(/phone/)
    expect(PHONE_FILES_NOTE).toMatch(/this PC/)
  })
})

describe('the uploads folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-uploads-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const body = (s: string): Readable => Readable.from([Buffer.from(s)])

  it('sweeps by the clock: unsent files after 30 minutes, every file after 7 days, an earlier run left over by its age on disk', async () => {
    let clock = Date.now()
    const u = new PhoneUploads(dir, { now: () => clock })
    // an earlier run's files: one past the keep time, one still young
    mkdirSync(join(dir, '2020-01-01'), { recursive: true })
    const old = join(dir, '2020-01-01', 'old-1234abcd.txt')
    const young = join(dir, '2020-01-01', 'young-1234abcd.txt')
    writeFileSync(old, 'old')
    writeFileSync(young, 'young')
    const longAgo = (clock - PHONE_LIMITS.uploadKeepMs - 60_000) / 1000
    utimesSync(old, longAgo, longAgo)

    const kept = await u.save('d1', 'kept.txt', body('kept'))
    const unsent = await u.save('d1', 'unsent.txt', body('unsent'))
    if ('error' in kept || 'error' in unsent) throw new Error('not saved')
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    const att = u.attach('d1', [kept.id])
    if ('gone' in att) throw new Error('gone')
    u.sent([kept.id])
    const unsentPath = filesIn(dir).find((f) => f.includes('unsent-'))!
    expect(unsentPath).toBeTruthy()

    clock += PHONE_LIMITS.uploadUnsentMs - 1000
    expect(u.attach('d1', [unsent.id])).toHaveProperty('files')
    clock += 2000
    expect(u.attach('d1', [unsent.id])).toEqual({ gone: [unsent.id] })
    expect(existsSync(join(dir, unsentPath))).toBe(false)
    expect(existsSync(att.files[0].path)).toBe(true) // sent: the card may read it later

    clock += PHONE_LIMITS.uploadKeepMs
    expect(u.attach('d1', ['nothing'])).toEqual({ gone: ['nothing'] })
    expect(existsSync(att.files[0].path)).toBe(false)
    expect(existsSync(young)).toBe(false)
    expect(filesIn(dir)).toEqual([])
  })

  it('caps the files one phone has waiting, and frees a slot when one is removed', async () => {
    const u = new PhoneUploads(join(dir, 'cap'))
    const ids: string[] = []
    for (let i = 0; i < PHONE_LIMITS.uploadsPending; i++) {
      const r = await u.save('d1', `f${i}.txt`, body(String(i)))
      if ('error' in r) throw new Error(r.error)
      ids.push(r.id)
    }
    expect(await u.save('d1', 'one-more.txt', body('x'))).toMatchObject({ status: 429 })
    expect(await u.save('d2', 'other-phone.txt', body('x'))).toHaveProperty('id')
    expect(u.discard('d2', ids[0])).toBe(false) // another phone's
    expect(u.discard('d1', ids[0])).toBe(true)
    expect(u.attach('d1', [ids[0]])).toEqual({ gone: [ids[0]] })
    expect(await u.save('d1', 'one-more.txt', body('x'))).toHaveProperty('id')
  })
})

describe('uploads over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-phone-up-'))
  const prompts: Array<{ id: string; text: string; files: Array<{ path: string; name: string }> }> = []
  const notes: string[] = []
  const handlers: PhoneHandlers = {
    board: () => ({ cards: [] }),
    // the "busy" card refuses, as a card the run does not allow
    prompt: (id, text, files) => (id === 'busy' ? { ok: false, error: 'not delivered' } : (prompts.push({ id, text, files }), { ok: true })),
    answer: () => ({ ok: true }),
    resolveApproval: () => ({ ok: true }),
    answerDecision: () => ({ ok: true }),
    task: () => undefined,
    answerTask: () => ({ ok: true }),
    latestReport: () => undefined,
    notify: () => ({ ok: true, queued: true }),
    note: (l) => notes.push(l)
  }
  const loopback = { sourceAllowed: (ip: string | undefined) => ip === '127.0.0.1' || ip === '::ffff:127.0.0.1', bindRefusal: () => undefined, isLocal: () => false }

  /** A server of its own (a failed attempt counts against the address per server), with a phone and a notify key paired. */
  async function start(name: string, opts: { maxBytes?: number; requestMs?: number } = {}) {
    const upDir = join(dir, name, 'uploads')
    const devices = new PhoneDevices(join(dir, name, 'devices.json'))
    const uploads = new PhoneUploads(upDir, { maxBytes: opts.maxBytes })
    const server = new PhoneServer(devices, handlers, () => {}, loopback, { uploads, requestMs: opts.requestMs })
    expect(await server.apply({ enabled: true, host: '127.0.0.1', port: 0, allowLan: false })).toBeUndefined()
    const port = Number(new URL(server.url!).port)
    return { server, port, upDir, phone: devices.add('Pixel').token, other: devices.add('Galaxy').token, key: devices.add('MacroDroid', Date.now(), 'notify').token }
  }
  const servers: PhoneServer[] = []
  afterAll(() => {
    for (const s of servers) s.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  type Reply = { status: number; body: Record<string, unknown> }
  /** One request; `body` a Buffer is sent as is (chunked when `chunked`), anything else as JSON. */
  function call(port: number, path: string, o: { method?: string; token?: string; type?: string; body?: unknown; name?: string; headers?: Record<string, string>; chunked?: boolean } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const raw = Buffer.isBuffer(o.body) ? o.body : o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body))
      const headers: Record<string, string> = { 'content-type': o.type ?? (Buffer.isBuffer(o.body) ? 'application/octet-stream' : 'application/json'), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.name !== undefined ? { 'x-file-name': encodeURIComponent(o.name) } : {}), ...o.headers }
      if (raw && !o.chunked) headers['content-length'] = String(raw.length)
      const req = http.request({ host: '127.0.0.1', port, path, method: o.method ?? (raw ? 'POST' : 'GET'), headers }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let body: Record<string, unknown> = {}
          try {
            body = JSON.parse(text)
          } catch {
            /* empty */
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      })
      req.on('error', reject)
      if (raw && o.chunked) for (let i = 0; i < raw.length; i += 16 * 1024) req.write(raw.subarray(i, i + 16 * 1024))
      req.end(raw && !o.chunked ? raw : undefined)
    })
  }
  const upload = (port: number, token: string, name: string, data: Buffer): Promise<Reply> => call(port, '/m/api/uploads', { token, name, body: data })

  let t: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    t = await start('main')
    servers.push(t.server)
  })

  it('saves the bytes sent, under a clean name, and gives the card their paths', async () => {
    const photo = randomBytes(300 * 1024)
    const up = await upload(t.port, t.phone, '회의 사진.JPG', photo)
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ name: '회의 사진.jpg', bytes: photo.length })
    const pdf = await upload(t.port, t.phone, '..\\report.pdf', Buffer.from('%PDF-1.4'))
    const r = await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'look', files: [up.body.id, pdf.body.id] } })
    expect(r.status).toBe(200)
    const got = prompts.at(-1)!
    expect(got).toMatchObject({ id: 'c1', text: 'look' })
    expect(got.files.map((f) => f.name)).toEqual(['회의 사진.jpg', 'report.pdf'])
    expect(readFileSync(got.files[0].path).equals(photo)).toBe(true)
    expect(readFileSync(got.files[1].path, 'utf8')).toBe('%PDF-1.4')
    // <dir>/<yyyy-mm-dd>/<clean base>-<short id>.<ext>
    expect(relative(t.upDir, got.files[0].path)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]회의 사진-[0-9a-f]{8}\.jpg$/)
    expect(notes.at(-1)).toMatch(/Pixel → c1: look .*회의 사진\.jpg, report\.pdf/)
  })

  it('takes a message of files alone, and refuses one with neither text nor files', async () => {
    const up = await upload(t.port, t.phone, 'a.png', Buffer.from('png'))
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: '  ', files: [up.body.id] } })).status).toBe(200)
    expect(prompts.at(-1)).toMatchObject({ text: '', files: [{ name: 'a.png' }] })
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: ' ', files: [] } })).status).toBe(400)
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: 'a.png' } })).status).toBe(400)
  })

  it('refuses an unknown, another phone\'s or an already sent attachment, saying which', async () => {
    const mine = await upload(t.port, t.phone, 'mine.txt', Buffer.from('1'))
    const theirs = await upload(t.port, t.other, 'theirs.txt', Buffer.from('2'))
    const before = prompts.length
    for (const id of ['0123456789abcdef', theirs.body.id]) {
      const r = await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: [mine.body.id, id] } })
      expect(r.status).toBe(400)
      expect(r.body.gone).toEqual([id])
      expect(String(r.body.error)).toMatch(/attach it again/)
    }
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: [mine.body.id] } })).status).toBe(200)
    const again = await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: [mine.body.id] } })
    expect(again.status).toBe(400)
    expect(again.body.gone).toEqual([mine.body.id])
    expect(prompts.length).toBe(before + 1)
  })

  it('refuses more than six files in one message, and keeps them attachable', async () => {
    const ids: unknown[] = []
    for (let i = 0; i < 7; i++) ids.push((await upload(t.port, t.phone, `p${i}.jpg`, Buffer.from(String(i)))).body.id)
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: ids } })).status).toBe(400)
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: ids.slice(0, 6) } })).status).toBe(200)
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: ids.slice(6) } })).status).toBe(200)
  })

  it('leaves the files attachable when the card refuses the message, so a retry works', async () => {
    const up = await upload(t.port, t.phone, 'retry.txt', Buffer.from('r'))
    expect((await call(t.port, '/m/api/cards/busy/prompt', { token: t.phone, body: { text: 'x', files: [up.body.id] } })).status).toBe(409)
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: [up.body.id] } })).status).toBe(200)
  })

  it('removes an attachment the phone will not send, only for that phone', async () => {
    const up = await upload(t.port, t.phone, 'gone.txt', Buffer.from('g'))
    expect((await call(t.port, `/m/api/uploads/${up.body.id}`, { method: 'DELETE', token: t.other })).status).toBe(404)
    expect((await call(t.port, `/m/api/uploads/${up.body.id}`, { method: 'DELETE', token: t.phone })).status).toBe(200)
    expect(filesIn(t.upDir).some((f) => f.includes('gone-'))).toBe(false)
    expect((await call(t.port, '/m/api/cards/c1/prompt', { token: t.phone, body: { text: 'x', files: [up.body.id] } })).status).toBe(400)
  })

  it('checks the key before reading a byte: no key 401, a notify key 403, nothing on disk', async () => {
    const s = await start('auth')
    servers.push(s.server)
    expect((await upload(s.port, '', 'a.txt', Buffer.alloc(4096))).status).toBe(401)
    expect((await upload(s.port, 'not-a-key', 'a.txt', Buffer.alloc(4096))).status).toBe(401)
    expect((await upload(s.port, s.key, 'a.txt', Buffer.alloc(4096))).status).toBe(403)
    expect(filesIn(s.upDir)).toEqual([])
  })

  it('refuses a file over the limit by its declared length at once, before any of it arrives', async () => {
    const s = await start('declared')
    servers.push(s.server)
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/m/api/uploads', method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${s.phone}`, 'x-file-name': 'big.mp4', 'content-length': String(PHONE_LIMITS.uploadBytes + 1) } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
        req.destroy()
      })
      req.on('error', (e) => reject(e))
      req.flushHeaders() // and no body at all
    })
    expect(status).toBe(413)
    expect(filesIn(s.upDir)).toEqual([])
  })

  it('cuts off a file that runs over the limit while it streams (no truthful length), leaving no part of it', async () => {
    const s = await start('streamed', { maxBytes: 64 * 1024 })
    servers.push(s.server)
    const r = await call(s.port, '/m/api/uploads', { token: s.phone, name: 'big.bin', body: Buffer.alloc(64 * 1024 + 1), chunked: true })
    expect(r.status).toBe(413)
    expect(filesIn(s.upDir)).toEqual([])
    // exactly the limit is fine
    expect((await call(s.port, '/m/api/uploads', { token: s.phone, name: 'ok.bin', body: Buffer.alloc(64 * 1024), chunked: true })).status).toBe(200)
  })

  it('keeps the JSON-only rule for every other POST, and wants raw bytes for an upload', async () => {
    const s = await start('types')
    servers.push(s.server)
    for (const path of ['/m/api/cards/c1/prompt', '/m/api/notify', '/m/api/pair']) expect((await call(s.port, path, { token: s.phone, body: Buffer.from('{}'), type: 'application/octet-stream' })).status).toBe(415)
    expect((await call(s.port, '/m/api/cards/c1/answer', { token: s.phone, body: { key: '1' }, type: 'text/plain' })).status).toBe(415)
    expect((await call(s.port, '/m/api/uploads', { token: s.phone, name: 'a.txt', body: { a: 1 }, type: 'application/json' })).status).toBe(415)
    expect(filesIn(s.upDir)).toEqual([])
  })

  it('still cuts off a slow JSON body, while a slow upload may take its time', async () => {
    const s = await start('slow', { requestMs: 400 })
    servers.push(s.server)
    const before = prompts.length
    const started = Date.now()
    // a body that never finishes: the connection is closed, the card gets nothing
    const closed = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(s.port, '127.0.0.1', () => sock.write(`POST /m/api/cards/c1/prompt HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${s.phone}\r\nContent-Length: 100\r\n\r\n{"text":"`))
      let out = ''
      sock.on('data', (c) => (out += c))
      sock.on('close', () => resolve(out))
      sock.on('error', reject)
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(closed).not.toMatch(/^HTTP\/1.1 200/)
    expect(prompts.length).toBe(before)
    // an upload trickling in for longer than that bound still lands
    const slow = await new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/m/api/uploads', method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${s.phone}`, 'x-file-name': 'slow.txt' } }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      let n = 0
      const tick = setInterval(() => {
        req.write('x')
        if (++n === 6) {
          clearInterval(tick)
          req.end()
        }
      }, 200)
    })
    expect(slow.status).toBe(200)
    expect(slow.body).toMatchObject({ name: 'slow.txt', bytes: 6 })
  })
})
