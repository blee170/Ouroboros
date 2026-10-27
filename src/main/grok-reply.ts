/**
 * The Grok Bot reply server and its store. The server listens on 127.0.0.1 only (Tailscale Funnel forwards the
 * public https address to it) and answers one route, POST /grok/reply, with the reply key. The store keeps the
 * key's hash and the sent handoffs' correlation ids in userData, so a reply still finds its card after a restart.
 */
import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { addRecord, parseReply, REPLY_LIMITS, REPLY_PATH, type ParsedReply, type ReplyRecord, type WaitingReply } from '@shared/grokreply'
import { samePath } from './windows'

const waitingOk = (w: unknown): w is WaitingReply => !!w && typeof w === 'object' && ((w as WaitingReply).kind === 'result' || (w as WaitingReply).kind === 'question') && typeof (w as WaitingReply).text === 'string' && (w as WaitingReply).text.length <= REPLY_LIMITS.text

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

interface StoreData {
  keyHash?: string
  keyMadeAt?: number
  records: ReplyRecord[]
}

export class ReplyStore {
  private data: StoreData = { records: [] }

  constructor(
    private file: string,
    private log: (line: string) => void = () => {}
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreData>
      this.data = {
        keyHash: typeof raw.keyHash === 'string' && /^[0-9a-f]{64}$/.test(raw.keyHash) ? raw.keyHash : undefined,
        keyMadeAt: typeof raw.keyMadeAt === 'number' ? raw.keyMadeAt : undefined,
        records: Array.isArray(raw.records)
          ? raw.records
              .filter((r): r is ReplyRecord => !!r && typeof r.correlationId === 'string' && typeof r.projectRoot === 'string' && typeof r.card === 'string' && typeof r.sentAt === 'number')
              .map((r) => ({ ...r, replies: Number(r.replies) || 0, waiting: Array.isArray(r.waiting) ? r.waiting.filter(waitingOk) : undefined }))
          : []
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // keep the unreadable file for a look; a new key must be made, and replies to older handoffs are refused
        try {
          renameSync(file, `${file}.unreadable-${Date.now()}`)
        } catch {
          /* left in place: the next save overwrites it */
        }
        log(`[grok-reply] could not read ${file}: ${(e as Error).message}; started empty`)
      }
    }
  }

  get hasKey(): boolean {
    return Boolean(this.data.keyHash)
  }
  get keyMadeAt(): number | undefined {
    return this.data.keyMadeAt
  }

  /** A new reply key (the old one stops working). Only its hash is kept; the key is shown once. */
  makeKey(now = Date.now()): string {
    const key = `ouro_${randomBytes(24).toString('base64url')}`
    this.data = { ...this.data, keyHash: sha(key), keyMadeAt: now }
    this.save()
    return key
  }

  revokeKey(): void {
    this.data = { ...this.data, keyHash: undefined, keyMadeAt: undefined }
    this.save()
  }

  /** Constant-time check of a presented key. */
  keyMatches(key: string): boolean {
    if (!this.data.keyHash || !key) return false
    return timingSafeEqual(Buffer.from(sha(key), 'hex'), Buffer.from(this.data.keyHash, 'hex'))
  }

  /** A sent handoff, remembered under a fresh correlation id (returned). */
  remember(rec: Omit<ReplyRecord, 'correlationId' | 'replies'>, now = Date.now()): string {
    const correlationId = randomBytes(16).toString('hex')
    this.data = { ...this.data, records: addRecord(this.data.records, { ...rec, correlationId, replies: 0 }, now) }
    this.save()
    return correlationId
  }

  find(correlationId: string, now = Date.now()): ReplyRecord | undefined {
    const r = this.data.records.find((x) => x.correlationId === correlationId)
    return r && now - r.sentAt < REPLY_LIMITS.keepMs ? r : undefined
  }

  update(correlationId: string, patch: Partial<ReplyRecord>): void {
    this.data = { ...this.data, records: this.data.records.map((r) => (r.correlationId === correlationId ? { ...r, ...patch } : r)) }
    this.save()
  }

  /** Records with replies waiting for a project's window. */
  waitingFor(projectRoot: string): ReplyRecord[] {
    // the same folder may come back spelled differently (c:\x, C:/X): the window lookup compares the same way
    return this.data.records.filter((r) => r.waiting?.length && samePath(r.projectRoot, projectRoot))
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch (e) {
      this.log(`[grok-reply] could not save ${this.file}: ${(e as Error).message}`)
    }
  }
}

export type ReplyHandler = (reply: Extract<ParsedReply, { ok: true }>) => { status: number; body: Record<string, unknown> }

function readBody(req: http.IncomingMessage, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    let size = 0
    let over = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      // the rest is read and dropped (the request timeout bounds it), so the 413 reaches the sender instead of a reset
      if (size > limit) {
        if (!over) resolve({ ok: false, status: 413 })
        over = true
        chunks.length = 0
      } else if (!over) chunks.push(c)
    })
    req.on('end', () => {
      if (over) return
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        resolve({ ok: false, status: 400 })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400 }))
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status === 413 ? { connection: 'close' } : {}) }).end(JSON.stringify(body))
}

/**
 * Off unless the owner turns it on. Behind Funnel every request comes from 127.0.0.1, so failures on the reply route
 * are counted for the whole server: after REPLY_LIMITS.failuresPerMinute in a minute, it answers 429 until it passes.
 */
export class GrokReplyServer {
  private server: http.Server | null = null
  /** a server still binding: stop() closes it too, so a quick off-on cannot leave it holding the port */
  private binding: http.Server | null = null
  private failures: number[] = []
  private generation = 0
  port = 0
  error: string | undefined

  constructor(
    private store: ReplyStore,
    private onReply: ReplyHandler,
    private log: (line: string) => void = () => {},
    private now: () => number = Date.now
  ) {}

  get listening(): boolean {
    return this.server !== null
  }

  async apply(enabled: boolean, port: number): Promise<string | undefined> {
    const gen = ++this.generation
    this.stop()
    this.error = undefined
    if (!enabled) return undefined
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        this.log(`[grok-reply] ${(e as Error).message}`)
        json(res, 500, { error: 'internal error' })
      })
    })
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    server.maxConnections = 16
    this.binding = server
    const err = await new Promise<string | undefined>((resolve) => {
      server.once('error', (e) => resolve((e as Error).message))
      // loopback only: the internet reaches it through Tailscale Funnel, the home network not at all
      server.listen(port, '127.0.0.1', () => resolve(undefined))
    })
    if (this.binding === server) this.binding = null
    if (gen !== this.generation) {
      server.close()
      return this.error
    }
    if (err) return (this.error = `could not listen on 127.0.0.1:${port}: ${err}`)
    server.on('error', (e) => this.log(`[grok-reply] server error: ${(e as Error).message}`))
    this.server = server
    this.port = (server.address() as { port: number }).port
    this.log(`[grok-reply] listening on 127.0.0.1:${this.port}`)
    return undefined
  }

  stop(): void {
    for (const s of [this.server, this.binding]) {
      s?.close()
      s?.closeAllConnections?.()
    }
    this.server = null
    this.binding = null
  }

  private blocked(): boolean {
    const now = this.now()
    this.failures = this.failures.filter((t) => now - t < 60_000)
    return this.failures.length >= REPLY_LIMITS.failuresPerMinute
  }

  private fail(res: http.ServerResponse, status: number, error: string): void {
    this.failures.push(this.now())
    json(res, status, { ok: false, error })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    // the public name is in certificate logs, so scanners will knock: other paths are answered but not counted,
    // or any scanner could lock the routine out
    if (path !== REPLY_PATH) return json(res, 404, { ok: false, error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const auth = req.headers.authorization ?? ''
    const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? ''
    // a wrong key is not counted: the key cannot be guessed, and counting would let anyone lock the routine out
    if (!this.store.keyMatches(key)) return json(res, 401, { ok: false, error: this.store.hasKey ? 'wrong key' : 'no reply key is set in Ouroboros' })
    // past the key: only the routine (or someone holding its key) gets here; its own run of bad requests is slowed
    if (this.blocked()) return json(res, 429, { ok: false, error: 'too many failed requests; try again in a minute' })
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return this.fail(res, 415, 'Content-Type must be application/json')
    const body = await readBody(req, REPLY_LIMITS.body)
    if (!body.ok) return this.fail(res, body.status, body.status === 413 ? `body over ${REPLY_LIMITS.body} bytes` : 'body is not JSON')
    const parsed = parseReply(body.value)
    if (!parsed.ok) return this.fail(res, 400, parsed.error)
    const out = this.onReply(parsed)
    if (out.status >= 400) this.failures.push(this.now())
    json(res, out.status, out.body)
  }
}
