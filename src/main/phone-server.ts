import http from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { ANSWER_KEYS, FailureLimiter, NOTIFY_EVENTS, PHONE_LIMITS, bindRefusal, type NotifyEvent, cleanDeviceName, pairingUrl, sourceAllowed, type PhoneDevice, type PhoneSettingsView } from '@shared/phone'
import { PHONE_CSS, PHONE_HTML, PHONE_JS, PHONE_MANIFEST } from './phone-page'
import { PHONE_ICON_PNG } from './phone-icon'

/** What the phone sees and may do; injected so the server runs without Electron in tests. */
export interface PhoneHandlers {
  board(): unknown
  prompt(cardId: string, text: string): { ok: boolean; error?: string }
  /** `promptAt` is the prompt the phone showed (the card's lastEventAt): a newer prompt is not answered blind */
  answer(cardId: string, key: string, promptAt: number): { ok: boolean; error?: string }
  resolveApproval(id: string, approve: boolean): { ok: boolean; error?: string }
  /** a card's question (ask_owner), answered from the phone; `device` is the paired phone's name */
  answerDecision(id: string, answer: unknown, note: unknown, device: string): { ok: boolean; error?: string }
  latestReport(): string | undefined
  /** an automation app on the phone reports an event (the car connected) */
  notify(event: NotifyEvent): { ok: boolean; error?: string; queued?: boolean }
  /** every action from the phone, for the log and the run's report */
  note(line: string): void
}

/** The PC's own addresses, refreshed every 30 s. */
let own: { at: number; set: Set<string> } = { at: 0, set: new Set() }
export function isOwnAddress(ip: string): boolean {
  if (Date.now() - own.at > 30_000) {
    const set = new Set<string>()
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) set.add(a.address)
    own = { at: Date.now(), set }
  }
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return own.set.has(v4) || v4 === '127.0.0.1' || ip === '::1'
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** Paired devices, kept as token hashes in the app's data folder. */
export class PhoneDevices {
  list: PhoneDevice[] = []
  constructor(
    private file: string,
    private log: (line: string) => void = () => {}
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      // a scope other than notify is dropped with the device: an unknown scope must not read as a full phone
      if (Array.isArray(raw)) this.list = raw.filter((d): d is PhoneDevice => Boolean(d) && typeof d.id === 'string' && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash) && (d.scope === undefined || d.scope === 'notify'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // set an unreadable file aside rather than overwrite it with the next pairing
        try {
          renameSync(file, `${file}.unreadable-${Date.now()}`)
        } catch {
          /* left in place */
        }
        log(`[phone] could not read ${file}: ${(e as Error).message}; set aside, no phone is paired`)
      }
    }
  }
  /** A new device for a fresh token; returns the token (shown to the phone once). */
  add(name: string, now = Date.now(), scope?: 'notify'): { device: PhoneDevice; token: string } {
    const token = randomBytes(24).toString('base64url')
    const device: PhoneDevice = { id: randomBytes(6).toString('hex'), name: cleanDeviceName(name), tokenHash: sha(token), createdAt: now, ...(scope ? { scope } : {}) }
    if (this.list.length >= PHONE_LIMITS.maxDevices) throw new Error(`${PHONE_LIMITS.maxDevices} phones are paired already; revoke one in Settings → Phone first`)
    const next = [...this.list, device]
    // the token is handed out only once it is on disk: otherwise the phone would be unpaired by the next restart
    this.write(next)
    this.list = next
    return { device, token }
  }
  /** The device a bearer token belongs to (constant-time over every device). */
  match(token: string): PhoneDevice | undefined {
    if (!token) return undefined
    const h = Buffer.from(sha(token), 'hex')
    let found: PhoneDevice | undefined
    for (const d of this.list) if (timingSafeEqual(h, Buffer.from(d.tokenHash, 'hex'))) found = d
    return found
  }
  seen(id: string, now = Date.now()): void {
    const d = this.list.find((x) => x.id === id)
    if (!d || (d.lastSeen && now - d.lastSeen < 60_000)) return
    d.lastSeen = now
    this.save()
  }
  revoke(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter((d) => d.id !== id)
    if (this.list.length === before) return false
    this.save()
    return true
  }
  private write(list: PhoneDevice[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(list, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }
  private save(): void {
    try {
      this.write(this.list)
    } catch (e) {
      this.log(`[phone] could not save devices: ${(e as Error).message}`)
    }
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        resolve(undefined)
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/** Why a request's key was refused, for the log; it never holds the header's value. */
export function authRefusal(header: string | undefined): string {
  if (!header) return 'no Authorization header (the header name must be just "Authorization")'
  if (!header.startsWith('Bearer ')) return 'the Authorization header does not start with "Bearer "'
  return 'unknown or revoked key'
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(body))
}

/**
 * The phone server: a second HTTP server, off unless the owner turns it on, on one interface the owner picked.
 * It serves the phone page and /m/api/*, nothing of the card API or the hooks.
 */
export class PhoneServer {
  private server: http.Server | null = null
  private pairing: { codeHash: string; expiresAt: number } | null = null
  private failures = new FailureLimiter()
  private view: PhoneSettingsView = { enabled: false, port: 0, allowLan: false }
  private boundPort = 0
  private generation = 0
  private retry: NodeJS.Timeout | undefined
  /** last answer per card: a double tap or a stale page must not type a second key into the card */
  private lastAnswer = new Map<string, number>()
  error: string | undefined

  constructor(
    readonly devices: PhoneDevices,
    private handlers: PhoneHandlers,
    private log: (line: string) => void = () => {},
    /** the network rules; tests swap in loopback */
    private policy: { sourceAllowed: typeof sourceAllowed; bindRefusal: typeof bindRefusal; isLocal: (ip: string) => boolean } = { sourceAllowed, bindRefusal, isLocal: isOwnAddress }
  ) {}

  get url(): string | undefined {
    return this.server && this.view.host ? `http://${this.view.host}:${this.boundPort}/m` : undefined
  }

  /** Stop and, when enabled, listen with these settings. Resolves with the error text, if any. */
  async apply(view: PhoneSettingsView): Promise<string | undefined> {
    const gen = ++this.generation
    this.stop()
    this.view = view
    this.error = undefined
    if (!view.enabled) return undefined
    const refusal = this.policy.bindRefusal(view.host, view.allowLan) ?? (this.policy.isLocal === isOwnAddress && view.host && !isOwnAddress(view.host) ? `${view.host} is not an address of this PC now` : undefined)
    if (refusal) return (this.error = refusal)
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        this.log(`[phone] ${(e as Error).message}`)
        if (!res.headersSent) json(res, 500, { error: 'internal error' })
      })
    })
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    const err = await new Promise<string | undefined>((resolve) => {
      server.once('error', (e) => resolve((e as Error).message))
      server.listen(view.port, view.host, () => resolve(undefined))
    })
    // a newer apply (the owner toggled again) won while this one was binding: this server is not wanted
    if (gen !== this.generation) {
      server.close()
      return this.error
    }
    if (err) {
      this.error = `could not listen on ${view.host}:${view.port}: ${err}`
      // the address is often missing at boot (Tailscale starts after the app): try again every minute while enabled
      this.retry = setTimeout(() => {
        if (gen === this.generation) void this.apply(view)
      }, 60_000)
      return this.error
    }
    server.on('error', (e) => this.log(`[phone] server error: ${(e as Error).message}`))
    // a request Node cannot parse (a header name with a space, as an automation app's "Header Authorization") never
    // reaches handle(): say so, then answer as Node would. A client that hung up is not news. It counts as a failed
    // attempt, so an address sending garbage is logged five times a minute at most.
    server.on('clientError', (e: NodeJS.ErrnoException, socket: Duplex) => {
      const ip = (socket as Socket).remoteAddress ?? '?'
      if (e.code !== 'ECONNRESET' && !this.failures.blocked(ip)) {
        this.failures.fail(ip)
        this.log(`[phone] refused a malformed request from ${ip}: ${e.code ?? 'parse error'}`)
      }
      const status = e.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : e.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request'
      if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
      else socket.destroy()
    })
    this.server = server
    this.boundPort = (server.address() as { port: number }).port
    this.log(`[phone] listening on ${this.url}`)
    return undefined
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.server?.close()
    this.server?.closeAllConnections?.()
    this.server = null
    this.pairing = null
  }

  /** A fresh one-use pairing code (the previous one stops working); the URL goes in the QR. */
  newPairing(now = Date.now()): { url: string; expiresAt: number } | { error: string } {
    if (!this.server || !this.view.host) return { error: this.error ?? 'the phone server is off' }
    const code = randomBytes(16).toString('base64url')
    this.pairing = { codeHash: sha(code), expiresAt: now + PHONE_LIMITS.pairTtlMs }
    return { url: pairingUrl(this.view.host, this.boundPort, code), expiresAt: this.pairing.expiresAt }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? ''
    // only the interface's own network reaches it (Tailscale, or the home LAN when the owner allowed it)
    if (!this.policy.sourceAllowed(ip, this.view.allowLan)) return void res.writeHead(403).end()
    // the PC itself is never a phone: a card on this machine reaching the Tailscale address comes from it
    if (this.policy.isLocal(ip)) return void res.writeHead(403).end()
    // DNS rebinding and other pages: the Host must be the address it listens on, an Origin must be its own
    const self = `${this.view.host}:${this.boundPort}`
    if (req.headers.host !== self) return void res.writeHead(421).end()
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${self}`) return void res.writeHead(403).end()
    const path = new URL(req.url ?? '/', `http://${self}`).pathname
    const method = req.method ?? 'GET'
    if (method === 'GET' && (path === '/m' || path === '/m/')) return this.asset(res, 'text/html; charset=utf-8', PHONE_HTML)
    if (method === 'GET' && path === '/m/app.js') return this.asset(res, 'text/javascript; charset=utf-8', PHONE_JS)
    if (method === 'GET' && path === '/m/app.css') return this.asset(res, 'text/css; charset=utf-8', PHONE_CSS)
    if (method === 'GET' && path === '/m/icon.png') return this.asset(res, 'image/png', PHONE_ICON_PNG)
    if (method === 'GET' && path === '/m/manifest.json') return this.asset(res, 'application/manifest+json', PHONE_MANIFEST)
    if (!path.startsWith('/m/api/')) return void res.writeHead(404).end()
    // a refused API call goes in main.log with why (never the key): an automation app's setup is otherwise blind
    const refuse = (status: number, error: string, why = error): void => {
      this.log(`[phone] refused ${method} ${path.slice(0, 80)} from ${ip}: ${status} ${why}`)
      json(res, status, { error })
    }
    // not logged: the failures that led here were, and a blocked address must not fill the log
    if (this.failures.blocked(ip)) return json(res, 429, { error: 'too many failed attempts; wait a minute' })
    const type = req.headers['content-type'] ?? ''
    // a failed attempt too: before any key is checked, so it must not log without limit
    if (method === 'POST' && !type.startsWith('application/json')) {
      this.failures.fail(ip)
      return refuse(415, 'application/json only', `content type ${type ? `"${type.slice(0, 60)}"` : 'missing'}, needs application/json`)
    }

    if (method === 'POST' && path === '/m/api/pair') {
      const body = (await readBody(req, 4096)) as { code?: unknown; name?: unknown } | undefined
      const p = this.pairing
      const ok = p && typeof body?.code === 'string' && Date.now() < p.expiresAt && timingSafeEqual(Buffer.from(sha(body.code), 'hex'), Buffer.from(p.codeHash, 'hex'))
      if (!ok) {
        this.failures.fail(ip)
        return refuse(401, 'this pairing code is wrong, used or expired; make a new one in Settings → Phone', 'pairing code wrong, used or expired')
      }
      this.pairing = null // one use
      let added: ReturnType<PhoneDevices['add']>
      try {
        added = this.devices.add(String(body?.name ?? ''))
      } catch (e) {
        return json(res, 500, { error: (e as Error).message })
      }
      const { device, token } = added
      this.handlers.note(`phone paired: ${device.name} (${ip})`)
      return json(res, 200, { token, device: { id: device.id, name: device.name } })
    }

    const auth = req.headers.authorization ?? ''
    const device = this.devices.match(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '')
    if (!device) {
      this.failures.fail(ip)
      return refuse(401, 'not paired', authRefusal(req.headers.authorization))
    }
    this.devices.seen(device.id)
    const from = `phone ${device.name}`

    // an automation app's key (MacroDroid) says that something happened, and nothing else
    if (method === 'POST' && path === '/m/api/notify') {
      const body = (await readBody(req, 1024)) as { event?: unknown } | undefined
      const event = (NOTIFY_EVENTS as readonly unknown[]).includes(body?.event) ? (body!.event as NotifyEvent) : undefined
      if (!event) return refuse(400, `event must be one of: ${NOTIFY_EVENTS.join(', ')}`, `the body has no known event (needs {"event":"car"}), key ${device.name}`)
      const r = this.handlers.notify(event)
      // a repeat inside the quiet time is not news: the log and the report get the first one
      if (!r.ok || r.queued !== false) this.handlers.note(`${device.scope === 'notify' ? `key ${device.name}` : from}: ${event}${r.ok ? '' : ` (${r.error})`}`)
      return json(res, r.ok ? 200 : 409, r)
    }
    if (device.scope === 'notify') return refuse(403, 'this key may only call /m/api/notify', `key ${device.name} may only call /m/api/notify`)

    if (method === 'GET' && path === '/m/api/board') return json(res, 200, this.handlers.board())
    if (method === 'GET' && path === '/m/api/report/latest') return json(res, 200, { markdown: this.handlers.latestReport() ?? '' })

    const card = /^\/m\/api\/cards\/([A-Za-z0-9_-]{1,64})\/(prompt|answer)$/.exec(path)
    if (method === 'POST' && card) {
      const body = (await readBody(req, PHONE_LIMITS.bodyBytes)) as { text?: unknown; key?: unknown } | undefined
      if (!body) return json(res, 400, { error: 'bad request' })
      if (card[2] === 'prompt') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text || text.length > PHONE_LIMITS.promptChars) return json(res, 400, { error: `a message of 1 to ${PHONE_LIMITS.promptChars} characters` })
        const r = this.handlers.prompt(card[1], text)
        if (r.ok) this.handlers.note(`${from} → ${card[1]}: ${text.slice(0, 200)}`)
        return json(res, r.ok ? 200 : 409, r)
      }
      const key = typeof body.key === 'string' && Object.hasOwn(ANSWER_KEYS, body.key) ? body.key : undefined
      if (!key) return json(res, 400, { error: 'key must be 1, 3 or esc' })
      const promptAt = typeof (body as { promptAt?: unknown }).promptAt === 'number' ? (body as { promptAt: number }).promptAt : NaN
      if (Date.now() - (this.lastAnswer.get(card[1]) ?? 0) < 2500) return json(res, 409, { ok: false, error: 'already answered; wait for the card to move on' })
      const r = this.handlers.answer(card[1], key, promptAt)
      if (r.ok) this.lastAnswer.set(card[1], Date.now())
      if (r.ok) this.handlers.note(`${from} answered ${card[1]}'s permission prompt with ${key}`)
      return json(res, r.ok ? 200 : 409, r)
    }

    const appr = /^\/m\/api\/approvals\/(\d{1,9}-A\d{1,9})$/.exec(path)
    if (method === 'POST' && appr) {
      const body = (await readBody(req, 1024)) as { approve?: unknown } | undefined
      if (typeof body?.approve !== 'boolean') return json(res, 400, { error: 'approve must be true or false' })
      const r = this.handlers.resolveApproval(appr[1], body.approve)
      if (r.ok) this.handlers.note(`${from} ${body.approve ? 'approved' : 'denied'} ${appr[1]}`)
      return json(res, r.ok ? 200 : 409, r)
    }
    const dec = /^\/m\/api\/decisions\/(\d{1,9}-D\d{1,9})$/.exec(path)
    if (method === 'POST' && dec) {
      const body = (await readBody(req, 4096)) as { answer?: unknown; note?: unknown } | undefined
      if (typeof body?.answer !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) return json(res, 400, { error: 'answer must be one of the offered answers' })
      const r = this.handlers.answerDecision(dec[1], body.answer, body.note, device.name)
      if (r.ok) this.handlers.note(`${from} answered ${dec[1]}: ${body.answer.slice(0, 80)}`)
      return json(res, r.ok ? 200 : 409, r)
    }
    return json(res, 404, { error: 'not found' })
  }

  private asset(res: http.ServerResponse, type: string, body: string | Buffer): void {
    res.writeHead(200, { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' }).end(body)
  }
}
