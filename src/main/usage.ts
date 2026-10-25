/**
 * Account usage per engine, read the way the CLIs themselves get it (RESEARCH §12), never by touching a
 * token beyond the one HTTP call Claude Code's own `/usage` makes:
 *
 * - Claude: every card's `statusLine` command POSTs Claude Code's status-line JSON here (`onStatusLine`), so the
 *   plan windows arrive exactly, per API response, with no credential involved. When no card has reported for
 *   a while the fallback is `GET /api/oauth/usage` with the sign-in Claude Code stored (`.credentials.json`,
 *   read for the request only, never refreshed, never logged), at most every 5 min, backing off 30 min on 429.
 * - Codex: the newest rollout files under `~/.codex/sessions` (the last `token_count` event).
 * - Gemini: the session files under `~/.gemini/tmp/<hash>/chats` (token totals of this machine).
 */
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEngine } from '@shared/types'
import type { EngineInfo } from '@shared/protocol'
import { parseClaudeOauthUsage, parseClaudeStatusLine, parseCodexRollout, parseGeminiSession, settleWindows, type ClaudeStatusLine, type EngineUsage, type UsageSnapshot, type UsageWindow } from '@shared/usage'
import { claudeConfigDirOf, signedInFromFiles } from './engines'

/** A card's status line counts as current this long; after that the OAuth fallback may be asked. */
export const STATUSLINE_FRESH_MS = 30 * 60_000
/** The OAuth usage endpoint is asked at most this often (Claude Code's own screen caches it too; 30–60 s pollers get 429). */
export const OAUTH_MIN_INTERVAL_MS = 5 * 60_000
/** After a 429 the endpoint is left alone this long and the last values are shown. */
export const OAUTH_BACKOFF_MS = 30 * 60_000
const OAUTH_URL = 'https://api.anthropic.com/api/oauth/usage'
const TAIL_BYTES = 256 * 1024
/** Installed / signed-in detection runs the CLIs' `--version`; its answer is kept this long. */
const DETECT_TTL_MS = 10 * 60_000
/** Codex / Gemini file scans are reused this long unless a refresh is asked for. */
export const FILE_SCAN_TTL_MS = 2 * 60_000
/** A Gemini session file larger than this is skipped (they are read whole to sum tokens). */
const GEMINI_MAX_FILE = 16 * 1024 * 1024

export interface UsageDeps {
  home: string
  env: NodeJS.ProcessEnv
  now: () => number
  fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) => Promise<{ status: number; json(): Promise<unknown> }>
  /** Installed / signed-in / version of the three CLIs (engines.ts). */
  detect: () => Promise<EngineInfo[]>
}

interface OauthState {
  windows: UsageWindow[]
  extra?: { usedPct?: number; used?: number; limit?: number; currency?: string }
  at?: number
  lastTry?: number
  backoffUntil?: number
  error?: string
}

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function readTail(file: string, bytes = TAIL_BYTES): string {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** mtime in ms, 0 for a file that went away mid-scan (never throws out of a scan). */
const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Pure: the Claude sign-in token Claude Code stored, for one request; undefined when there is none or it has expired. */
export function claudeAccessToken(configDir: string, env: NodeJS.ProcessEnv, now: number, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): { token: string; expired?: boolean; subscription?: string } | undefined {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { token: env.CLAUDE_CODE_OAUTH_TOKEN }
  try {
    const j = JSON.parse(read(join(configDir, '.credentials.json'))) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown } }
    const o = j.claudeAiOauth
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return undefined
    const expired = typeof o.expiresAt === 'number' && o.expiresAt < now
    return { token: o.accessToken, expired, subscription: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined }
  } catch {
    return undefined
  }
}

/** Newest rollout files under a Codex sessions folder (`YYYY/MM/DD/rollout-*.jsonl`), newest day first, at most `limit`. */
export function listCodexRollouts(sessionsDir: string, limit = 8): string[] {
  const out: string[] = []
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => Number(b) - Number(a))
    } catch {
      return []
    }
  }
  for (const y of dirs(sessionsDir)) {
    for (const m of dirs(join(sessionsDir, y))) {
      for (const d of dirs(join(sessionsDir, y, m))) {
        const day = join(sessionsDir, y, m, d)
        let files: string[]
        try {
          files = readdirSync(day).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
        } catch {
          continue
        }
        const stamped = files.map((f) => ({ f: join(day, f), t: mtime(join(day, f)) })).sort((a, b) => b.t - a.t)
        for (const s of stamped) {
          out.push(s.f)
          if (out.length >= limit) return out
        }
      }
    }
  }
  return out
}

/** Gemini session files (`<tmp>/<project-hash>/chats/session-*`) modified since `since`. */
export function listGeminiSessions(tmpDir: string, since: number): string[] {
  const out: string[] = []
  let hashes: string[]
  try {
    hashes = readdirSync(tmpDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const h of hashes) {
    const chats = join(tmpDir, h, 'chats')
    let files: string[]
    try {
      files = readdirSync(chats).filter((f) => f.startsWith('session-') && /\.jsonl?$/.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(chats, f)
      if (mtime(p) >= since) out.push(p)
    }
  }
  return out
}

export class UsageMonitor {
  private statusLines = new Map<string, { at: number; sl: ClaudeStatusLine }>()
  private oauth: OauthState = { windows: [] }
  private detected?: { at: number; engines: EngineInfo[] }
  private fileScan?: { at: number; codex: EngineUsage; gemini: EngineUsage }
  private detecting?: Promise<EngineInfo[]>
  private listeners = new Set<() => void>()
  private notifyTimer?: ReturnType<typeof setTimeout>

  constructor(private deps: UsageDeps) {}

  /** Called for each status-line POST from a Claude card. Returns false when the body was not a status line. */
  onStatusLine(nodeId: string, body: unknown): boolean {
    const sl = parseClaudeStatusLine(body)
    if (!sl) return false
    // the route has no auth (like the hooks): a bounded map and a bounded window list keep a local spammer cheap
    if (sl.windows.length > 32) sl.windows = sl.windows.slice(0, 32)
    if (!this.statusLines.has(nodeId) && this.statusLines.size >= 200) {
      let oldest: [string, number] | undefined
      for (const [id, e] of this.statusLines) if (!oldest || e.at < oldest[1]) oldest = [id, e.at]
      if (oldest) this.statusLines.delete(oldest[0])
    }
    this.statusLines.set(nodeId, { at: this.deps.now(), sl })
    this.notify()
    return true
  }

  /** The card is gone: its session cost leaves the sum (its windows were the account's and stay as last known). */
  forgetCard(nodeId: string): void {
    const e = this.statusLines.get(nodeId)
    if (!e) return
    this.statusLines.set(nodeId, { at: e.at, sl: { ...e.sl, costUsd: undefined } })
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      for (const cb of this.listeners) cb()
    }, 1500)
  }

  private async engines(): Promise<EngineInfo[]> {
    const now = this.deps.now()
    if (this.detected && now - this.detected.at < DETECT_TTL_MS) return this.detected.engines
    this.detecting ??= this.deps
      .detect()
      .then((engines) => {
        this.detected = { at: this.deps.now(), engines }
        return engines
      })
      .catch(() => this.detected?.engines ?? [])
      .finally(() => {
        this.detecting = undefined
      })
    return this.detecting
  }

  /** The whole picture; `refresh` asks the Claude endpoint now when its interval allows and no card is reporting. */
  async snapshot(opts: { refresh?: boolean } = {}): Promise<UsageSnapshot> {
    const engines = await this.engines()
    const info = (e: AgentEngine): EngineInfo | undefined => engines.find((x) => x.engine === e)
    const now = this.deps.now()
    // the Codex and Gemini file scans are kept for a couple of minutes: a status line arrives on every API
    // response of every card, and each one rebuilds the snapshot for the chip
    const files = !opts.refresh && this.fileScan && now - this.fileScan.at < FILE_SCAN_TTL_MS ? this.fileScan : undefined
    const claude = await this.claude(info('claude'), opts.refresh === true)
    const [codex, gemini] = files ? [files.codex, files.gemini] : await Promise.all([this.codex(info('codex')), this.gemini(info('gemini'))])
    if (!files) this.fileScan = { at: now, codex, gemini }
    const settled = [claude, codex, gemini].map((e) => ({ ...e, windows: settleWindows(e.windows, now) }))
    return { engines: settled, at: now }
  }

  /** The freshest status line that carried plan windows, and the cost sum over every card seen. */
  private statusLineView(): { windows: UsageWindow[]; at: number; nodeId: string } | undefined {
    let best: { windows: UsageWindow[]; at: number; nodeId: string } | undefined
    for (const [nodeId, e] of this.statusLines) {
      if (!e.sl.windows.length) continue
      if (!best || e.at > best.at) best = { windows: e.sl.windows, at: e.at, nodeId }
    }
    return best
  }

  private costSum(): number | undefined {
    let sum = 0
    let any = false
    for (const e of this.statusLines.values()) {
      if (typeof e.sl.costUsd === 'number') {
        sum += e.sl.costUsd
        any = true
      }
    }
    return any ? sum : undefined
  }

  private async claude(info: EngineInfo | undefined, refresh: boolean): Promise<EngineUsage> {
    const now = this.deps.now()
    const base: EngineUsage = { engine: 'claude', state: 'no-data', windows: [], source: { kind: 'none' }, costUsd: this.costSum() }
    if (info && !info.installed) return { ...base, state: 'not-installed', message: 'Claude Code is not installed.' }
    const configDir = claudeConfigDirOf(this.deps.env, this.deps.home)
    const signedIn = signedInFromFiles('claude', this.deps.home, this.deps.env, existsSync, (p) => readFileSync(p, 'utf8'))
    const hasKey = Boolean(this.deps.env.ANTHROPIC_API_KEY || this.deps.env.ANTHROPIC_AUTH_TOKEN)

    const live = this.statusLineView()
    if (live && now - live.at < STATUSLINE_FRESH_MS) {
      return { ...base, state: 'ok', windows: live.windows, source: { kind: 'statusline', detail: live.nodeId, at: live.at } }
    }
    // a card reported, but without plan windows: an API key pays per token and has no 5-hour or weekly bar
    const anyLine = [...this.statusLines.values()].some((e) => now - e.at < STATUSLINE_FRESH_MS)
    if (anyLine && !signedIn) return { ...base, state: 'api-key', message: 'Signed in with an API key: billed per token, no plan limits to show.' }

    if (signedIn) await this.refreshOauth(configDir, refresh, info?.version)
    // whichever is newer: the endpoint's last answer or the last card status line (a failed refresh must not
    // bring back hours-old endpoint numbers over a 31-minute-old status line)
    if (this.oauth.windows.length && (!live || (this.oauth.at ?? 0) >= live.at)) {
      const o = this.oauth
      let message = o.error
      if (o.backoffUntil && o.backoffUntil > now) message = `Showing last-known usage: the usage endpoint is rate limited until ${hhmm(o.backoffUntil)}.`
      let extra: string | undefined
      if (o.extra && typeof o.extra.usedPct === 'number') {
        const amounts = o.extra.limit != null ? ` (${o.extra.used ?? '?'} / ${o.extra.limit} ${o.extra.currency ?? ''})`.trimEnd() : ''
        extra = `Extra usage ${Math.round(o.extra.usedPct)}% of the monthly limit${amounts}.`
      }
      return { ...base, state: message && !o.backoffUntil ? 'unavailable' : 'ok', windows: o.windows, source: { kind: 'oauth', at: o.at }, message: [message, extra].filter(Boolean).join(' ') || undefined }
    }
    if (live) return { ...base, state: 'ok', windows: live.windows, source: { kind: 'statusline', detail: live.nodeId, at: live.at }, message: this.oauth.error }
    if (signedIn === false) return { ...base, state: hasKey ? 'api-key' : 'not-signed-in', message: hasKey ? 'An API key is set: billed per token, no plan limits to show.' : 'Not signed in: run `claude` in a card once.' }
    if (this.oauth.error) return { ...base, state: 'unavailable', message: this.oauth.error }
    return { ...base, message: 'Start a Claude card: the limits arrive with its first reply.' }
  }

  /** One careful request to the endpoint Claude Code's `/usage` reads, within the interval and backoff. */
  private async refreshOauth(configDir: string, force: boolean, version: string | undefined): Promise<void> {
    const now = this.deps.now()
    const o = this.oauth
    if (o.backoffUntil && o.backoffUntil > now) return
    o.backoffUntil = undefined // passed; a new 429 sets a new one
    if (o.lastTry && now - o.lastTry < OAUTH_MIN_INTERVAL_MS && (!force || now - o.lastTry < 60_000)) return
    const cred = claudeAccessToken(configDir, this.deps.env, now)
    if (!cred) {
      o.error = 'The Claude sign-in could not be read: run `claude` in a card once.'
      return
    }
    if (cred.expired) {
      o.error = 'The Claude sign-in token has expired: a Claude card refreshes it on its next turn.'
      return
    }
    o.lastTry = now
    try {
      const res = await this.deps.fetch(OAUTH_URL, {
        headers: { Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': `claude-code/${version ?? '2.1.0'}` },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error' // the bearer goes to api.anthropic.com and nowhere else
      })
      if (res.status === 429) {
        o.backoffUntil = now + OAUTH_BACKOFF_MS
        o.error = `The usage endpoint is rate limited until ${hhmm(o.backoffUntil)}.`
        return
      }
      if (res.status === 401 || res.status === 403) {
        o.error = 'The Claude sign-in was not accepted: a Claude card refreshes it on its next turn.'
        return
      }
      if (res.status >= 400) {
        o.error = `The usage endpoint answered ${res.status}.`
        return
      }
      const parsed = parseClaudeOauthUsage(await res.json())
      if (!parsed) {
        o.error = 'The usage endpoint answered in a shape this version does not read.'
        return
      }
      o.windows = parsed.windows
      o.extra = parsed.extra
      o.at = now
      o.error = undefined
      o.backoffUntil = undefined
    } catch (err) {
      o.error = `Could not reach the usage endpoint: ${(err as Error)?.name === 'TimeoutError' ? 'timed out' : 'network error'}.`
    }
  }

  private async codex(info: EngineInfo | undefined): Promise<EngineUsage> {
    const now = this.deps.now()
    const base: EngineUsage = { engine: 'codex', state: 'no-data', windows: [], source: { kind: 'none' } }
    if (info && !info.installed) return { ...base, state: 'not-installed', message: 'Codex CLI is not installed.' }
    const codexHome = this.deps.env.CODEX_HOME || join(this.deps.home, '.codex')
    const hasAuth = existsSync(join(codexHome, 'auth.json')) // CODEX_HOME aware, unlike engines.ts
    const signedIn = hasAuth || Boolean(this.deps.env.OPENAI_API_KEY)
    const files = listCodexRollouts(join(codexHome, 'sessions'))
    let windows: UsageWindow[] = []
    let plan: string | undefined
    let at: number | undefined
    let tokensToday = 0
    let anyTokens = false
    const today = startOfDay(now)
    for (const f of files) {
      let r
      try {
        r = parseCodexRollout(readTail(f))
      } catch {
        continue
      }
      if (!r) continue
      // the newest snapshot by its own time, not by folder: a resumed session keeps writing under its start day
      const rAt = r.at ?? mtime(f)
      if (r.windows.length && (!windows.length || rAt > (at ?? 0))) {
        windows = r.windows
        plan = r.plan
        at = rAt
      }
      if (r.tokens && mtime(f) >= today) {
        tokensToday += r.tokens.total
        anyTokens = true
      }
    }
    const tokens = anyTokens ? { label: 'Tokens today (this machine, per rollout total)', total: tokensToday, today: tokensToday } : undefined
    if (windows.length) return { ...base, state: 'ok', windows, plan, tokens, source: { kind: 'rollout', at }, message: at && now - at > 60 * 60_000 ? 'As of the last Codex request on this machine; a new turn refreshes it.' : undefined }
    if (!signedIn) return { ...base, state: 'not-signed-in', tokens, message: 'Not signed in: run `codex login` in a card.' }
    if (!hasAuth) return { ...base, state: 'api-key', tokens, message: 'An API key is set: billed per token, no plan limits to show.' }
    return { ...base, tokens, message: files.length ? 'No rate-limit snapshot in the recent rollouts: run a Codex card once.' : 'Start a Codex card: the limits arrive with its first reply.' }
  }

  private async gemini(info: EngineInfo | undefined): Promise<EngineUsage> {
    const now = this.deps.now()
    const base: EngineUsage = { engine: 'gemini', state: 'no-data', windows: [], source: { kind: 'none' } }
    if (info && !info.installed) return { ...base, state: 'not-installed', message: 'Gemini CLI is not installed.' }
    const geminiKey = Boolean(this.deps.env.GEMINI_API_KEY || this.deps.env.GOOGLE_API_KEY)
    // signedInFromFiles counts a key as signed in; here a key means "no plan windows to read", so look at the file alone
    const signedIn = existsSync(join(this.deps.home, '.gemini', 'oauth_creds.json')) ? true : geminiKey ? ('api-key' as const) : false
    const weekAgo = now - 7 * 24 * 3_600_000
    const today = startOfDay(now)
    let total = 0
    let todayTotal = 0
    let any = false
    for (const f of listGeminiSessions(join(this.deps.home, '.gemini', 'tmp'), weekAgo)) {
      let t
      try {
        if (statSync(f).size > GEMINI_MAX_FILE) continue
        t = parseGeminiSession(readFileSync(f, 'utf8'))
      } catch {
        continue
      }
      if (!t) continue
      any = true
      const fileAt = mtime(f)
      for (const m of t.messages) {
        if (m.at !== undefined && m.at < weekAgo) continue
        total += m.total
        if ((m.at ?? fileAt) >= today) todayTotal += m.total
      }
    }
    const quotaNote = 'Gemini CLI publishes no live quota here: /stats in a card shows the requests left (1,000 a day on a Google login).'
    const tokens = any ? { label: 'Tokens, 7 days (this machine)', total, today: todayTotal } : undefined
    if (signedIn === 'api-key') return { ...base, state: 'api-key', tokens, message: 'An API key is set: billed per token (free tier 250 requests a day).' }
    if (signedIn === false) return { ...base, state: 'not-signed-in', tokens, message: 'Not signed in: run `gemini` in a card once.' }
    if (any) return { ...base, state: 'ok', tokens, source: { kind: 'sessions', at: now }, message: quotaNote }
    return { ...base, message: `No Gemini sessions in the last 7 days on this machine. ${quotaNote}` }
  }
}
