import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { HookEvent } from '@shared/types'

export const PREFERRED_HOOK_PORT = 47821

export interface ApiHandlers {
  listAgents(): unknown
  readOutput(nodeId: string, lines: number): string | null
  sendPrompt(nodeId: string, text: string): boolean
  createAgent(input: {
    cwd?: string
    title?: string
    prompt?: string
    kind?: 'claude' | 'terminal' | 'command'
    /** command cards: shell template with {{prompt}} / {{prompt_file}} */
    command_template?: string
    role_prompt?: string
    permission_mode?: string
    model?: string
    worktree?: boolean
    continue?: boolean
    resume?: string
    /** Agent id (usually the caller) that gets an automatic report line from the new card. */
    report_to?: string
  }): Promise<{ id: string; cwd: string; worktree?: string }>
  removeAgent(id: string): Promise<boolean>
  tidy(olderThanMinutes: number, dryRun: boolean): Promise<{ candidates: Array<{ id: string; title: string; reason: string }>; removed: number }>
  waitForAgents(ids: string[], statuses: string[], timeoutMs: number): Promise<unknown>
  setNote(nodeId: string, note: string): boolean
  listHandoffs(): unknown
  createHandoff(input: { source: string; target: string; mode?: 'auto' | 'manual'; template?: string; condition?: string }): { id: string } | { error: string }
  removeHandoff(id: string): boolean
  fireHandoff(id: string): { ok: boolean; error?: string }
  bookmarks(query?: string): unknown
  browser: {
    list(): unknown
    create(input: { url?: string; title?: string }): Promise<{ id: string }>
    navigate(id: string, url: string): Promise<unknown>
    read(id: string, maxChars?: number): Promise<unknown>
    links(id: string, limit?: number): Promise<unknown>
    click(id: string, target: { selector?: string; text?: string }): Promise<unknown>
    type(id: string, input: { selector?: string; text: string; submit?: boolean }): Promise<unknown>
    screenshot(id: string): Promise<unknown>
  }
}

export interface HookServerDeps {
  onHook(nodeId: string, event: HookEvent): void
  onExternalHook(event: HookEvent): void
  /** API scoped to the window that owns `selfId` (the caller's own card id); unscoped = current window. */
  resolveApi(selfId?: string): ApiHandlers | undefined
}

function readJson(req: http.IncomingMessage, limit = 2_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Local HTTP server that (1) receives Claude Code HTTP hooks and (2) serves the small JSON API the
 * MCP server process uses. Binds to 127.0.0.1 only. API routes require the per-launch token.
 */
export class HookServer {
  /** Per-launch secret for the JSON API; OUROBOROS_API_TOKEN overrides it (tests). */
  readonly token = process.env.OUROBOROS_API_TOKEN || randomBytes(24).toString('hex')
  port = 0
  private server: http.Server | null = null

  constructor(private deps: HookServerDeps) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        send(res, 500, { error: String(err?.message ?? err) })
      })
    })
    const server = this.server
    const tryListen = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.off('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          server.off('error', onError)
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
    try {
      this.port = await tryListen(PREFERRED_HOOK_PORT)
    } catch {
      this.port = await tryListen(0)
    }
    return this.port
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'

    // --- Claude Code hooks ---------------------------------------------------
    if (method === 'POST' && path.startsWith('/hook/')) {
      const target = decodeURIComponent(path.slice('/hook/'.length))
      const body = (await readJson(req)) as HookEvent
      // Respond immediately so Claude Code is never blocked by our processing.
      send(res, 200, {})
      if (!body || typeof body !== 'object' || typeof body.hook_event_name !== 'string') return
      if (target === 'external') this.deps.onExternalHook(body)
      else this.deps.onHook(target, body)
      return
    }

    // --- JSON API (MCP server, tests) --------------------------------------
    if (path.startsWith('/api/')) {
      const token = req.headers['x-ouroboros-token']
      if (token !== this.token) return send(res, 401, { error: 'unauthorized' })
      const selfHeader = req.headers['x-ouroboros-self']
      const self = (Array.isArray(selfHeader) ? selfHeader[0] : selfHeader) || url.searchParams.get('self') || undefined
      const api = this.deps.resolveApi(self)
      if (!api) return send(res, 503, { error: 'no window open' })
      const m = /^\/api\/agents\/([^/]+)(?:\/(output|prompt))?$/.exec(path)
      if (method === 'GET' && path === '/api/agents') return send(res, 200, { agents: api.listAgents() })
      if (method === 'GET' && path === '/api/bookmarks') return send(res, 200, { bookmarks: api.bookmarks(url.searchParams.get('q') ?? undefined) })
      if (path === '/api/tidy' && (method === 'GET' || method === 'POST')) {
        const minutes = Number(url.searchParams.get('minutes') ?? 30) | 0 || 30
        const dry = method === 'GET' || url.searchParams.get('dry_run') === '1'
        return send(res, 200, await api.tidy(minutes, dry))
      }
      if (method === 'GET' && path === '/api/agents-wait') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
        const statuses = (url.searchParams.get('status') ?? 'done,needs-you,ended').split(',').filter(Boolean)
        const timeout = Math.min(25_000, Math.max(1_000, Number(url.searchParams.get('timeout') ?? 20) * 1000))
        return send(res, 200, await api.waitForAgents(ids, statuses, timeout))
      }
      if (m && method === 'DELETE' && !m[2]) return send(res, (await api.removeAgent(decodeURIComponent(m[1]))) ? 200 : 404, { ok: true })
      if (method === 'GET' && path === '/api/handoffs') return send(res, 200, { handoffs: api.listHandoffs() })
      if (method === 'POST' && path === '/api/handoffs') {
        const body = (await readJson(req)) as Parameters<ApiHandlers['createHandoff']>[0]
        if (!body || typeof body.source !== 'string' || typeof body.target !== 'string') return send(res, 400, { error: 'source and target required' })
        const r = api.createHandoff(body)
        return send(res, 'error' in r ? 400 : 200, r)
      }
      const h = /^\/api\/handoffs\/([^/]+)(?:\/(fire))?$/.exec(path)
      if (h && method === 'DELETE') return send(res, api.removeHandoff(decodeURIComponent(h[1])) ? 200 : 404, { ok: true })
      if (h && h[2] === 'fire' && method === 'POST') {
        const r = api.fireHandoff(decodeURIComponent(h[1]))
        return send(res, r.ok ? 200 : 400, r)
      }
      if (method === 'POST' && path === '/api/agents') {
        const body = (await readJson(req)) as Parameters<ApiHandlers['createAgent']>[0]
        const created = await api.createAgent(body ?? {})
        return send(res, 200, created)
      }
      if (m && method === 'GET' && m[2] === 'output') {
        const lines = Math.min(2000, Math.max(1, Number(url.searchParams.get('lines') ?? 80) | 0))
        const out = api.readOutput(decodeURIComponent(m[1]), lines)
        if (out === null) return send(res, 404, { error: 'unknown agent' })
        return send(res, 200, { output: out })
      }
      if (m && method === 'POST' && m[2] === 'prompt') {
        const body = (await readJson(req)) as { text?: string }
        if (!body || typeof body.text !== 'string') return send(res, 400, { error: 'text required' })
        const ok = api.sendPrompt(decodeURIComponent(m[1]), body.text)
        return send(res, ok ? 200 : 404, { ok })
      }
      // --- browser cards ---
      if (method === 'GET' && path === '/api/browsers') return send(res, 200, { browsers: api.browser.list() })
      if (method === 'POST' && path === '/api/browsers') {
        const body = (await readJson(req)) as { url?: string; title?: string }
        return send(res, 200, await api.browser.create(body ?? {}))
      }
      const b = /^\/api\/browsers\/([^/]+)\/(navigate|read|links|click|type|screenshot)$/.exec(path)
      if (b) {
        const id = decodeURIComponent(b[1])
        const action = b[2]
        try {
          if (action === 'read' && method === 'GET') return send(res, 200, await api.browser.read(id, Number(url.searchParams.get('max') ?? 20000) | 0 || 20000))
          if (action === 'links' && method === 'GET') return send(res, 200, { links: await api.browser.links(id, Number(url.searchParams.get('limit') ?? 100) | 0 || 100) })
          if (method !== 'POST') return send(res, 405, { error: 'method' })
          const body = (await readJson(req)) as Record<string, unknown>
          if (action === 'navigate') return send(res, 200, await api.browser.navigate(id, String(body.url ?? '')))
          if (action === 'click') return send(res, 200, await api.browser.click(id, { selector: body.selector as string | undefined, text: body.text as string | undefined }))
          if (action === 'type') return send(res, 200, await api.browser.type(id, { selector: body.selector as string | undefined, text: String(body.text ?? ''), submit: Boolean(body.submit) }))
          if (action === 'screenshot') return send(res, 200, await api.browser.screenshot(id))
        } catch (err) {
          return send(res, 400, { error: (err as Error).message })
        }
      }
      const n = /^\/api\/notes\/([^/]+)$/.exec(path)
      if (n && method === 'POST') {
        const body = (await readJson(req)) as { note?: string }
        if (!body || typeof body.note !== 'string') return send(res, 400, { error: 'note required' })
        const ok = api.setNote(decodeURIComponent(n[1]), body.note)
        return send(res, ok ? 200 : 404, { ok })
      }
      return send(res, 404, { error: 'not found' })
    }

    if (path === '/health') return send(res, 200, { ok: true })
    send(res, 404, { error: 'not found' })
  }
}
