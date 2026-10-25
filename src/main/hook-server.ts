import http from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentEngine, HookEvent } from '@shared/types'
import type { LedgerApiResult, Task, TaskFilter, TaskInput, TaskPatch, TaskState } from '@shared/ledger'
import { TASK_STATES } from '@shared/ledger'

export const PREFERRED_HOOK_PORT = 47821

export type CheckpointApiResult = ({ ok: boolean; error?: string } & Record<string, unknown>) | null

/** a /api/tasks caller with no x-ouroboros-self header (a raw curl): attributed to nobody, never to the owner */
const UNKNOWN_CARD = 'unknown card'

/** What a card's hook gets back: Claude Code reads it (Stop may block the turn's end, others add context). */
export type HookReply = Record<string, unknown>

/** Events whose reply carries mail to a Claude card; the server waits for main to build it (synchronous, no I/O). */
const REPLY_EVENTS = new Set(['Stop', 'UserPromptSubmit', 'PostToolUse'])

export interface ApiHandlers {
  listAgents(): unknown
  /** Queue a message from `from` (the caller's own card id) to another card. */
  mailSend(input: { to: string; body: string; kind?: string; reply_to?: string }, from: string): { ok: true; id: string; to: string } | { ok: false; error: string }
  /** The caller's inbox (marked delivered); unreadOnly = not yet acknowledged. */
  mailInbox(self: string, unreadOnly: boolean): { text: string; count: number }
  mailAck(id: string, self: string): { ok: boolean; error?: string }
  /** Specialist roles the board can give a card, and the catalog's runbooks (team rosters). */
  listRoles(query?: string): Promise<unknown>
  readOutput(nodeId: string, lines: number): string | null
  sendPrompt(nodeId: string, text: string): boolean
  createAgent(input: {
    cwd?: string
    title?: string
    prompt?: string
    kind?: 'claude' | 'terminal' | 'command'
    /** claude (default) | codex | gemini for kind=claude */
    engine?: AgentEngine
    /** command cards: shell template with {{prompt}} / {{prompt_file}} */
    command_template?: string
    role_prompt?: string
    /** A role id from list_roles: its file becomes the extra system prompt (role_prompt is appended after it). */
    role?: string
    permission_mode?: string
    model?: string
    worktree?: boolean
    continue?: boolean
    resume?: string
    /** Agent id (usually the caller) that gets an automatic report line from the new card. */
    report_to?: string
    /** Give the card the ouroboros MCP server too (team lead). */
    board_tools?: boolean
    /** The caller's card id: the new card is dispatched by it (retired once its report is in; counted against the caller's cap). */
    created_by?: string
  }): Promise<{ id: string; cwd: string; worktree?: string; reused?: boolean; replaced?: string } | { error: string }>
  removeAgent(id: string): Promise<boolean>
  /** Change a card's launch options (board_tools) and optionally restart it so they apply. */
  updateAgent(id: string, patch: { board_tools?: boolean; title?: string; restart?: boolean }): boolean
  /** Uncommitted git changes in the card's folder; with diff=true (or a file) the unified diff too. */
  changes(id: string, opts: { file?: string; diff?: boolean }): Promise<unknown>
  /** Git snapshots of the card's folder (its worktree if it has one). null = unknown card; ok=false carries the reason. */
  listCheckpoints(id: string): Promise<CheckpointApiResult>
  createCheckpoint(id: string, label?: string): Promise<CheckpointApiResult>
  restoreCheckpoint(id: string, checkpointId: string, moveHead: boolean): Promise<CheckpointApiResult>
  deleteCheckpoint(id: string, checkpointId: string): Promise<CheckpointApiResult>
  /** Close finished cards: dispatched ones whose report is in (or stale), owner-made ones only with includeOwn; scope = only that card's workers. */
  tidy(opts: { olderThanMinutes?: number; includeOwn?: boolean; scope?: string; auto?: boolean }, dryRun: boolean): Promise<{ candidates: Array<{ id: string; title: string; reason: string }>; removed: number }>
  waitForAgents(ids: string[], statuses: string[], timeoutMs: number): Promise<unknown>
  setNote(nodeId: string, note: string): boolean
  /** The task ledger: text for task_list (one line per task) plus the raw tasks. */
  taskList(filter: TaskFilter): { text: string; tasks: Task[] }
  /** `by` is the card id, or OWNER for the Tasks tab (main's IPC handlers only; the HTTP side never attributes to the owner) */
  taskCreate(input: TaskInput, by: string): LedgerApiResult
  /** Claim for agent_id (default: the caller); refused while a dependency is not done or a live card owns it. */
  taskClaim(id: string, agentId: string | undefined, self?: string): LedgerApiResult
  taskUpdate(id: string, patch: TaskPatch, by: string): LedgerApiResult
  listHandoffs(): unknown
  createHandoff(input: { source: string; target: string; mode?: 'auto' | 'manual'; template?: string; condition?: string }): { id: string } | { error: string }
  removeHandoff(id: string): boolean
  fireHandoff(id: string): { ok: boolean; error?: string }
  bookmarks(query?: string): unknown
  browser: {
    list(): unknown
    create(input: { url?: string; title?: string; near?: string }): Promise<{ id: string }>
    navigate(id: string, url: string): Promise<unknown>
    read(id: string, maxChars?: number): Promise<unknown>
    links(id: string, limit?: number): Promise<unknown>
    click(id: string, target: { selector?: string; text?: string }): Promise<unknown>
    type(id: string, input: { selector?: string; text: string; submit?: boolean }): Promise<unknown>
    screenshot(id: string): Promise<unknown>
  }
}

export interface GateInput {
  command: string
  cwd?: string
  tool?: string
}
/** allow / deny decides the tool call; none leaves it to the normal permission flow */
export interface GateReply {
  decision: 'allow' | 'deny' | 'none'
  reason: string
}

export interface HookServerDeps {
  /** A card's hook event; for Stop / UserPromptSubmit / PostToolUse the return value is the reply (mail for the card). */
  onHook(nodeId: string, event: HookEvent): HookReply | void
  onExternalHook(event: HookEvent): void
  /** A Claude card's status-line JSON (its `statusLine` command POSTs it on every API response). */
  onStatusLine?(nodeId: string, body: unknown): void
  /** Autonomous run: a card's shell command that may push, open or merge a PR (its PreToolUse gate helper asks). */
  onGate?(nodeId: string, input: GateInput): Promise<GateReply>
  /** API scoped to the window that owns `selfId` (the caller's own card id); unscoped = current window. */
  resolveApi(selfId?: string): ApiHandlers | undefined
  /** The token the global hook in the owner's Claude Code settings sends with `/hook/external` (persisted across launches). */
  externalToken?: string
  /** Diagnostics line (refused requests: a CLI only logs a failed hook, so this is where a broken card shows why). */
  log?(line: string): void
}

/** Header every authenticated call carries: a card's own token, the external-hook token, or the app's master token. */
export const TOKEN_HEADER = 'x-ouroboros-token'

const headerOf = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Constant-time string compare (different lengths are simply unequal). */
function same(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
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
 * MCP server process uses. Binds to 127.0.0.1 only and answers only requests addressed to that host with no
 * `Origin` (a browser page cannot reach it). Every card has its own hook token, derived from its id, required on
 * its hook route; the Conductor and cards with board tools also get an API token, which is what makes the API caller that
 * card (`x-ouroboros-self` is checked against it).
 */
export class HookServer {
  /** Master token for the JSON API, for the main process and tests only (never given to a card); OUROBOROS_API_TOKEN overrides it. */
  readonly token = process.env.OUROBOROS_API_TOKEN || randomBytes(24).toString('hex')
  /** Per-launch key the card tokens are derived from; it never leaves this process. */
  private readonly secret = randomBytes(32)
  port = 0
  private server: http.Server | null = null
  /** refusals already logged (route + reason), so a card that keeps failing logs once */
  private refusedLogged = new Set<string>()

  constructor(private deps: HookServerDeps) {}

  /** What the global hook in the owner's Claude Code settings sends (empty: the external route answers nobody). */
  get externalToken(): string {
    return this.deps.externalToken ?? ''
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** A card's hook token: HMAC of its id, so nothing is stored and a card restarted in this launch keeps it. Every card has one. */
  hookToken(nodeId: string): string {
    return createHmac('sha256', this.secret).update(`hook\0${nodeId}`).digest('hex')
  }

  /** A card's API token (a different HMAC domain): only the Conductor and cards with board tools are given one. */
  apiToken(nodeId: string): string {
    return createHmac('sha256', this.secret).update(`api\0${nodeId}`).digest('hex')
  }

  /** A card's mail token (a third domain): every agent card has one; it reaches only /api/mail, as that card. */
  mailToken(nodeId: string): string {
    return createHmac('sha256', this.secret).update(`mail\0${nodeId}`).digest('hex')
  }

  private refuse(res: http.ServerResponse, status: number, error: string, route: string): void {
    const key = `${status} ${route}`
    if (!this.refusedLogged.has(key) && this.refusedLogged.size < 200) {
      this.refusedLogged.add(key)
      this.deps.log?.(`[hook-server] refused ${route}: ${status} ${error}`)
    }
    send(res, status, { error })
  }

  /** Only requests to our own address, never from a browser page (CLIs send no Origin; a page's fetch always does). */
  private allowed(req: http.IncomingMessage): boolean {
    if (req.headers.origin !== undefined) return false
    const host = (req.headers.host ?? '').toLowerCase()
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  async start(preferredPort = PREFERRED_HOOK_PORT): Promise<number> {
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
      this.port = await tryListen(preferredPort)
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
    if (!this.allowed(req)) return this.refuse(res, 403, req.headers.origin !== undefined ? 'browser origin' : `host ${String(req.headers.host ?? '(none)').slice(0, 60)}`, path.slice(0, 80))
    // hooks and the status line are JSON from a CLI: anything else (a form post, text/plain) is not one of ours
    if (method === 'POST' && path.startsWith('/hook/') && !(headerOf(req, 'content-type') ?? '').toLowerCase().startsWith('application/json')) return this.refuse(res, 415, 'application/json only', path.slice(0, 80))

    // --- Claude Code status line (plan usage, cost, context per card) ---------
    const sl = /^\/hook\/([^/]+)\/statusline$/.exec(path)
    if (method === 'POST' && sl) {
      const body = await readJson(req, 200_000)
      // no body: the card's curl prints nothing, so Claude Code shows no status line in the terminal
      res.writeHead(204).end()
      // no token here (it would sit in the shell command, in the settings file): the worst a forged one does is a wrong usage chip
      if (body && typeof body === 'object') this.deps.onStatusLine?.(decodeURIComponent(sl[1]), body)
      return
    }

    // --- Action gate (PreToolUse command hook during an Autonomous run) -------
    const gate = path.startsWith('/hook/') && path.endsWith('/gate') ? [path, path.slice('/hook/'.length, -'/gate'.length)] : null
    if (method === 'POST' && gate) {
      const target = decodeURIComponent(gate[1])
      const token = headerOf(req, TOKEN_HEADER)
      if (target === 'external' || !same(token, this.hookToken(target))) return this.refuse(res, 401, token ? 'wrong token' : 'no token', `/hook/${target.slice(0, 64)}/gate`)
      const body = (await readJson(req)) as Partial<GateInput> | undefined
      if (!body || typeof body.command !== 'string') return send(res, 400, { decision: 'deny', reason: 'no command' })
      // no handler (or it throws): the helper gets an error and blocks the call, it never fails open
      if (!this.deps.onGate) return send(res, 503, { decision: 'deny', reason: 'gate not available' })
      try {
        send(res, 200, await this.deps.onGate(target, { command: body.command, cwd: typeof body.cwd === 'string' ? body.cwd : undefined, tool: typeof body.tool === 'string' ? body.tool : undefined }))
      } catch (e) {
        send(res, 500, { decision: 'deny', reason: `gate error: ${(e as Error).message}` })
      }
      return
    }

    // --- Claude Code hooks ---------------------------------------------------
    if (method === 'POST' && path.startsWith('/hook/')) {
      const target = decodeURIComponent(path.slice('/hook/'.length))
      const token = headerOf(req, TOKEN_HEADER)
      // a card's events only with that card's token: a forged Stop would type its "reply" into the Conductor
      if (!same(token, target === 'external' ? this.deps.externalToken : this.hookToken(target))) return this.refuse(res, 401, token ? 'wrong token' : 'no token', `/hook/${target.slice(0, 64)}`)
      const body = (await readJson(req)) as HookEvent
      const valid = Boolean(body) && typeof body === 'object' && typeof body.hook_event_name === 'string'
      // a card's Stop / prompt / tool-result hook carries its mail back: main answers synchronously (no I/O)
      if (valid && target !== 'external' && REPLY_EVENTS.has(body.hook_event_name)) {
        let reply: HookReply | void = undefined
        try {
          reply = this.deps.onHook(target, body)
        } finally {
          send(res, 200, reply ?? {})
        }
        return
      }
      // Respond immediately so Claude Code is never blocked by our processing.
      send(res, 200, {})
      if (!valid) return
      if (target === 'external') this.deps.onExternalHook(body)
      else this.deps.onHook(target, body)
      return
    }

    // --- Agent mail (every agent card) ----------------------------------------
    if (path === '/api/mail' || path.startsWith('/api/mail/')) {
      const token = headerOf(req, TOKEN_HEADER)
      const claimed = headerOf(req, 'x-ouroboros-self') || undefined
      // the sender is who its token says, always a card: mail token, the board API token, or the master token naming one
      if (!claimed || !(same(token, this.mailToken(claimed)) || same(token, this.apiToken(claimed)) || same(token, this.token))) return this.refuse(res, 401, 'unauthorized', `/api/mail as ${String(claimed ?? '(nobody)').slice(0, 64)}`)
      const api = this.deps.resolveApi(claimed)
      if (!api) return send(res, 503, { error: 'no window open' })
      if (method === 'POST' && path === '/api/mail') {
        const body = (await readJson(req, 64_000)) as { to?: unknown; body?: unknown; kind?: unknown; reply_to?: unknown }
        if (typeof body?.to !== 'string' || typeof body.body !== 'string') return send(res, 400, { error: 'to and body required' })
        const r = api.mailSend({ to: body.to, body: body.body, kind: typeof body.kind === 'string' ? body.kind : undefined, reply_to: typeof body.reply_to === 'string' ? body.reply_to : undefined }, claimed)
        return send(res, r.ok ? 200 : 400, r)
      }
      if (method === 'GET' && path === '/api/mail') return send(res, 200, api.mailInbox(claimed, url.searchParams.get('unread') !== '0'))
      const ack = /^\/api\/mail\/([^/]+)\/ack$/.exec(path)
      if (method === 'POST' && ack) {
        const r = api.mailAck(decodeURIComponent(ack[1]), claimed)
        return send(res, r.ok ? 200 : 404, r)
      }
      return send(res, 404, { error: 'not found' })
    }

    // --- JSON API (MCP server, tests) --------------------------------------
    if (path.startsWith('/api/')) {
      const token = headerOf(req, TOKEN_HEADER)
      const claimed = headerOf(req, 'x-ouroboros-self') || url.searchParams.get('self') || undefined
      // a card is who its token says: the master token (main process, tests) may name any card or none
      let self: string | undefined
      if (same(token, this.token)) self = claimed
      // a hook token is no API credential: a card without board tools must not drive the board with it
      else if (claimed && same(token, this.apiToken(claimed))) self = claimed
      else return this.refuse(res, 401, 'unauthorized', `/api as ${String(claimed ?? '(nobody)').slice(0, 64)}`)
      const api = this.deps.resolveApi(self)
      if (!api) return send(res, 503, { error: 'no window open' })
      const m = /^\/api\/agents\/([^/]+)(?:\/(output|prompt|changes))?$/.exec(path)
      if (method === 'GET' && path === '/api/agents') return send(res, 200, { agents: api.listAgents() })
      if (method === 'GET' && path === '/api/roles') return send(res, 200, await api.listRoles(url.searchParams.get('q') ?? undefined))
      if (method === 'GET' && path === '/api/bookmarks') return send(res, 200, { bookmarks: api.bookmarks(url.searchParams.get('q') ?? undefined) })
      if (path === '/api/tidy' && (method === 'GET' || method === 'POST')) {
        const minutes = Number(url.searchParams.get('minutes') ?? 30) | 0 || 30
        const dry = method === 'GET' || url.searchParams.get('dry_run') === '1'
        // a card tidies only what it (or its teams) dispatched, never the owner's own cards
        return send(res, 200, await api.tidy({ olderThanMinutes: minutes, scope: self }, dry))
      }
      if (method === 'GET' && path === '/api/agents-wait') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
        const statuses = (url.searchParams.get('status') ?? 'done,needs-you,ended').split(',').filter(Boolean)
        const timeout = Math.min(25_000, Math.max(1_000, Number(url.searchParams.get('timeout') ?? 20) * 1000))
        return send(res, 200, await api.waitForAgents(ids, statuses, timeout))
      }
      if (m && method === 'DELETE' && !m[2]) return send(res, (await api.removeAgent(decodeURIComponent(m[1]))) ? 200 : 404, { ok: true })
      if (m && method === 'PATCH' && !m[2]) {
        const body = (await readJson(req)) as Parameters<ApiHandlers['updateAgent']>[1]
        return send(res, api.updateAgent(decodeURIComponent(m[1]), body ?? {}) ? 200 : 404, { ok: true })
      }
      if (m && method === 'GET' && m[2] === 'changes') {
        const r = await api.changes(decodeURIComponent(m[1]), { file: url.searchParams.get('file') ?? undefined, diff: url.searchParams.get('diff') === '1' })
        return send(res, r === null ? 404 : 200, r ?? { error: 'unknown agent' })
      }
      const cp = /^\/api\/agents\/([^/]+)\/checkpoints(?:\/([^/]+)(?:\/(restore))?)?$/.exec(path)
      if (cp) {
        const id = decodeURIComponent(cp[1])
        const cpId = cp[2] ? decodeURIComponent(cp[2]) : undefined
        let r: CheckpointApiResult
        if (method === 'GET' && !cpId) r = await api.listCheckpoints(id)
        else if (method === 'POST' && !cpId) {
          const body = ((await readJson(req)) ?? {}) as { label?: unknown }
          r = await api.createCheckpoint(id, typeof body.label === 'string' ? body.label : undefined)
        } else if (method === 'POST' && cpId && cp[3] === 'restore') {
          const body = ((await readJson(req)) ?? {}) as { move_head?: unknown }
          r = await api.restoreCheckpoint(id, cpId, body.move_head === true)
        } else if (method === 'DELETE' && cpId && !cp[3]) r = await api.deleteCheckpoint(id, cpId)
        else return send(res, 404, { error: 'not found' })
        return send(res, r === null ? 404 : r.ok ? 200 : 400, r ?? { error: 'unknown agent' })
      }
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
        const created = await api.createAgent({ ...(body ?? {}), created_by: self })
        return send(res, 'error' in created ? 400 : 200, created)
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
      if (path === '/api/tasks') {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? undefined
          if (state && !TASK_STATES.includes(state as TaskState)) return send(res, 400, { error: `bad state: ${state}` })
          return send(res, 200, api.taskList({ state: state as TaskState | undefined, owner: url.searchParams.get('owner') ?? undefined, parent: url.searchParams.get('parent') ?? undefined, all: url.searchParams.get('all') === '1' }))
        }
        if (method === 'POST') {
          const body = (await readJson(req)) as TaskInput | null
          if (!body || typeof body.title !== 'string') return send(res, 400, { error: 'title required' })
          const r = api.taskCreate(body, self || UNKNOWN_CARD)
          return send(res, r.ok ? 200 : 400, r)
        }
      }
      const t = /^\/api\/tasks\/([^/]+)(?:\/(claim))?$/.exec(path)
      if (t) {
        const id = decodeURIComponent(t[1])
        if (t[2] === 'claim' && method === 'POST') {
          const body = ((await readJson(req)) ?? {}) as { agent_id?: string }
          const r = api.taskClaim(id, typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : undefined, self)
          return send(res, r.ok ? 200 : r.error.startsWith('no task') ? 404 : 400, r)
        }
        if (!t[2] && method === 'PATCH') {
          const body = (await readJson(req)) as TaskPatch | null
          if (!body || typeof body !== 'object') return send(res, 400, { error: 'patch required' })
          const r = api.taskUpdate(id, body, self || UNKNOWN_CARD)
          return send(res, r.ok ? 200 : r.error.startsWith('no task') ? 404 : 400, r)
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
