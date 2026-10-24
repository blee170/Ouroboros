/**
 * Account usage per engine (RESEARCH §12): the plan's rate-limit windows (percent used, when they reset) and
 * the token totals a CLI records. Pure parsers for what each CLI exposes; the reading lives in main/usage.ts.
 *
 * - Claude Code: the status-line JSON it pipes to `statusLine.command` on every API response (official:
 *   `rate_limits.five_hour/seven_day.used_percentage` + `resets_at` in Unix seconds; the per-model weekly
 *   buckets are in the same object), and as a fallback the response of `GET /api/oauth/usage` that its own
 *   `/usage` screen reads (`utilization` + `resets_at` ISO).
 * - Codex CLI: the last `token_count` event of a rollout file (`rate_limits.primary/secondary` with
 *   `used_percent`, `window_minutes`, `resets_at` in Unix seconds; `info.total_token_usage`).
 * - Gemini CLI: the per-message `tokens` of its session files (this machine only; no quota).
 */
import type { AgentEngine } from './types'

export interface UsageWindow {
  /** five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_oauth_apps | model:<name> | codex window ids */
  id: string
  label: string
  /** 0–100 */
  usedPct: number
  /** epoch ms, when known */
  resetsAt?: number
}

export type UsageState =
  /** windows (and maybe tokens) are there */
  | 'ok'
  | 'not-installed'
  | 'not-signed-in'
  /** signed in with an API key: billed per token, no plan windows */
  | 'api-key'
  /** signed in, but nothing read yet (no card has run, no file to read) */
  | 'no-data'
  /** a read failed; `message` says why, `windows` may hold the last known values */
  | 'unavailable'

export type UsageSourceKind = 'statusline' | 'oauth' | 'rollout' | 'sessions' | 'none'

export interface EngineUsage {
  engine: AgentEngine
  state: UsageState
  /** Plan or tier label when a source names one (Codex `plan_type`, Claude `subscriptionType`). */
  plan?: string
  windows: UsageWindow[]
  /** Token totals where the CLI records them; `label` says what they cover (exact numbers, narrow scope). */
  tokens?: { label: string; total: number; input?: number; output?: number; today?: number }
  /** Claude: sum of the running cards' `cost.total_cost_usd` (list-price estimate of this machine's sessions). */
  costUsd?: number
  /** Where the numbers came from; `detail` is a card id for statusline (the renderer names it), `at` when they were read. */
  source: { kind: UsageSourceKind; detail?: string; at?: number }
  /** The failure or caveat in words ("Not signed in", "rate limited until 14:30"). */
  message?: string
}

export interface UsageSnapshot {
  engines: EngineUsage[]
  at: number
}

/** Human labels for the known window ids; unknown ids are shown as they are. */
export function windowLabel(id: string): string {
  switch (id) {
    case 'five_hour':
      return 'Current session (5 h)'
    case 'seven_day':
      return 'This week (all models)'
    case 'seven_day_opus':
      return 'This week (Opus)'
    case 'seven_day_sonnet':
      return 'This week (Sonnet)'
    case 'seven_day_oauth_apps':
      return 'This week (OAuth apps)'
    case 'seven_day_cowork':
      return 'This week (Cowork)'
    case 'seven_day_overage_included':
      return 'This week (overage included)'
    default:
      return id.startsWith('model:') ? `This week (${id.slice(6)})` : id
  }
}

const pct = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined
}

/** Unix seconds, ms or ISO text → epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const asNum = Number(v)
    if (Number.isFinite(asNum) && asNum > 0) return toEpochMs(asNum)
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

const CLAUDE_WINDOW_IDS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_cowork', 'seven_day_overage_included']

/** A window from one Claude object: `used_percentage` (status line) or `utilization` (OAuth endpoint). */
function claudeWindow(id: string, label: string, o: unknown): UsageWindow | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const used = pct(r.used_percentage ?? r.utilization)
  if (used === undefined) return null
  return { id, label, usedPct: used, resetsAt: toEpochMs(r.resets_at ?? r.resetsAt) }
}

/** Pure: the windows in a Claude `rate_limits` object (status line) or OAuth usage response; the named buckets first, then `model_scoped`. */
export function parseClaudeRateLimits(raw: unknown): UsageWindow[] {
  if (!raw || typeof raw !== 'object') return []
  const r = raw as Record<string, unknown>
  const out: UsageWindow[] = []
  for (const id of CLAUDE_WINDOW_IDS) {
    const w = claudeWindow(id, windowLabel(id), r[id])
    if (w) out.push(w)
  }
  if (Array.isArray(r.model_scoped)) {
    for (const m of r.model_scoped) {
      if (!m || typeof m !== 'object') continue
      const name = typeof (m as { display_name?: unknown }).display_name === 'string' ? (m as { display_name: string }).display_name : 'model'
      const w = claudeWindow(`model:${name}`, windowLabel(`model:${name}`), m)
      if (w) out.push(w)
    }
  }
  return out
}

export interface ClaudeStatusLine {
  windows: UsageWindow[]
  /** this session's cost at list price, when given */
  costUsd?: number
  model?: string
  contextPct?: number
}

/** Pure: what matters in the status-line JSON Claude Code pipes to `statusLine.command`. null when it is not that JSON. */
export function parseClaudeStatusLine(raw: unknown): ClaudeStatusLine | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { rate_limits?: unknown; cost?: { total_cost_usd?: unknown }; model?: { display_name?: unknown; id?: unknown }; context_window?: { used_percentage?: unknown } }
  if (!('rate_limits' in r) && !('cost' in r) && !('model' in r) && !('context_window' in r)) return null
  const cost = r.cost?.total_cost_usd
  const model = r.model?.display_name ?? r.model?.id
  return {
    windows: parseClaudeRateLimits(r.rate_limits),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined,
    model: typeof model === 'string' ? model : undefined,
    contextPct: pct(r.context_window?.used_percentage)
  }
}

export interface ClaudeOauthUsage {
  windows: UsageWindow[]
  /** extra usage (overage credits) when the account has it switched on */
  extra?: { usedPct?: number; used?: number; limit?: number; currency?: string }
}

/** Pure: the body of `GET /api/oauth/usage` (the endpoint Claude Code's `/usage` reads). */
export function parseClaudeOauthUsage(raw: unknown): ClaudeOauthUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const windows = parseClaudeRateLimits(raw)
  const x = (raw as { extra_usage?: unknown }).extra_usage
  let extra: ClaudeOauthUsage['extra']
  if (x && typeof x === 'object' && (x as { is_enabled?: unknown }).is_enabled === true) {
    const e = x as Record<string, unknown>
    extra = {
      usedPct: pct(e.utilization),
      used: typeof e.used_credits === 'number' ? e.used_credits : undefined,
      limit: typeof e.monthly_limit === 'number' ? e.monthly_limit : undefined,
      currency: typeof e.currency === 'string' ? e.currency : undefined
    }
  }
  if (!windows.length && !extra) return null
  return { windows, extra }
}

export interface CodexRollout {
  windows: UsageWindow[]
  plan?: string
  /** `info.total_token_usage` of the last token_count event that had one */
  tokens?: { total: number; input: number; output: number }
  /** timestamp of the event the windows came from (epoch ms) */
  at?: number
}

/** A Codex window is told apart by its length, not its slot: 300 min = the 5-hour limit, 10080 = weekly. */
export function codexWindowId(windowMinutes: number | undefined, slot: 'primary' | 'secondary'): string {
  if (windowMinutes === 300) return 'five_hour'
  if (windowMinutes === 10080) return 'seven_day'
  if (windowMinutes && windowMinutes > 0) return `codex:${windowMinutes}m`
  return `codex:${slot}`
}

export function codexWindowLabel(id: string): string {
  if (id === 'five_hour' || id === 'seven_day') return windowLabel(id)
  const m = /^codex:(\d+)m$/.exec(id)
  if (m) {
    const min = Number(m[1])
    if (min % 1440 === 0) return `${min / 1440}-day limit`
    if (min % 60 === 0) return `${min / 60}-hour limit`
    return `${min}-minute limit`
  }
  return id === 'codex:primary' ? 'Primary limit' : id === 'codex:secondary' ? 'Secondary limit' : id
}

function codexSnapshot(rl: unknown): { windows: UsageWindow[]; plan?: string } | null {
  if (!rl || typeof rl !== 'object') return null
  const r = rl as Record<string, unknown>
  const windows: UsageWindow[] = []
  for (const slot of ['primary', 'secondary'] as const) {
    const w = r[slot]
    if (!w || typeof w !== 'object') continue
    const o = w as Record<string, unknown>
    const used = pct(o.used_percent ?? o.usedPercent)
    if (used === undefined) continue
    const mins = o.window_minutes ?? o.windowDurationMins
    const id = codexWindowId(typeof mins === 'number' ? mins : undefined, slot)
    windows.push({ id, label: codexWindowLabel(id), usedPct: used, resetsAt: toEpochMs(o.resets_at ?? o.resetsAt) })
  }
  if (!windows.length) return null
  const plan = r.plan_type ?? r.planType
  return { windows, plan: typeof plan === 'string' && plan ? plan : undefined }
}

/**
 * Pure: the last `token_count` event in the tail of a Codex rollout (`~/.codex/sessions/.../rollout-*.jsonl`):
 * `{"timestamp","type":"event_msg","payload":{"type":"token_count","info":{total_token_usage},"rate_limits":{primary,secondary,plan_type}}}`.
 * Windows and tokens are taken from the last line that has each (an exec rollout has `rate_limits: null`).
 */
export function parseCodexRollout(text: string): CodexRollout | null {
  let out: CodexRollout | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('token_count')) continue
    let d: { timestamp?: unknown; payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown> } | null; rate_limits?: unknown } }
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d?.payload?.type !== 'token_count') continue
    out ??= { windows: [] }
    const snap = codexSnapshot(d.payload.rate_limits)
    if (snap) {
      out.windows = snap.windows
      out.plan = snap.plan ?? out.plan
      out.at = toEpochMs(d.timestamp) ?? out.at
    }
    const t = d.payload.info?.total_token_usage
    if (t && typeof t === 'object') {
      const n = (k: string): number => (typeof t[k] === 'number' ? (t[k] as number) : 0)
      out.tokens = { total: n('total_tokens') || n('input_tokens') + n('output_tokens'), input: n('input_tokens'), output: n('output_tokens') }
    }
  }
  return out && (out.windows.length || out.tokens) ? out : null
}

export interface GeminiTally {
  total: number
  input: number
  output: number
  /** per-message timestamps (epoch ms) when the file has them, else the record's lastUpdated */
  messages: Array<{ at?: number; total: number; input: number; output: number }>
}

/**
 * Pure: token totals of one Gemini CLI session file (`~/.gemini/tmp/<hash>/chats/session-*.json` or `.jsonl`):
 * a `ConversationRecord` with `messages[].tokens: { input, output, cached, thoughts, tool, total }`.
 */
export function parseGeminiSession(text: string): GeminiTally | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  let messages: unknown[] = []
  let lastUpdated: number | undefined
  let whole: { messages?: unknown; lastUpdated?: unknown } | undefined
  try {
    whole = JSON.parse(trimmed) as { messages?: unknown; lastUpdated?: unknown }
  } catch {
    whole = undefined
  }
  if (whole && Array.isArray(whole.messages)) {
    messages = whole.messages
    lastUpdated = toEpochMs(whole.lastUpdated)
  } else {
    // jsonl: one record or message per line (a one-line file parses whole but has no `messages`)
    for (const line of trimmed.split('\n')) {
      try {
        const d = JSON.parse(line) as { messages?: unknown; tokens?: unknown; lastUpdated?: unknown }
        if (Array.isArray(d.messages)) messages.push(...d.messages)
        else if (d.tokens) messages.push(d)
        lastUpdated = toEpochMs(d.lastUpdated) ?? lastUpdated
      } catch {
        /* a cut line */
      }
    }
  }
  const out: GeminiTally = { total: 0, input: 0, output: 0, messages: [] }
  for (const m of messages) {
    const tk = (m as { tokens?: Record<string, unknown> })?.tokens
    if (!tk || typeof tk !== 'object') continue
    const n = (k: string): number => (typeof tk[k] === 'number' ? (tk[k] as number) : 0)
    const row = { at: toEpochMs((m as { timestamp?: unknown }).timestamp) ?? lastUpdated, total: n('total') || n('input') + n('output'), input: n('input'), output: n('output') }
    out.messages.push(row)
    out.total += row.total
    out.input += row.input
    out.output += row.output
  }
  return out.messages.length ? out : null
}

/**
 * Pure: a window whose reset time has passed is empty again until the next request reports it, so its old
 * percentage must not stay on screen (a week-old Codex rollout at 98% would otherwise show an orange chip).
 */
export function settleWindows(windows: UsageWindow[], now: number): UsageWindow[] {
  return windows.map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPct: 0 } : w))
}

/** "resets in 2h 10m" / "resets in 3d 4h" / "reset" for a passed time. */
export function resetsIn(resetsAt: number | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = resetsAt - now
  if (ms <= 0) return 'reset'
  const min = Math.ceil(ms / 60_000)
  if (min < 60) return `resets in ${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `resets in ${h}h ${min % 60}m`
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
}

/** "2 min ago" / "just now" for a read time. */
export function agoText(at: number | undefined, now: number): string {
  if (!at) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/** The window the status-bar chip leads with: the fullest of the two plan windows, else the fullest of any. */
export function hottestWindow(windows: UsageWindow[]): UsageWindow | undefined {
  const plan = windows.filter((w) => w.id === 'five_hour' || w.id === 'seven_day')
  const pool = plan.length ? plan : windows
  return pool.reduce<UsageWindow | undefined>((best, w) => (!best || w.usedPct > best.usedPct ? w : best), undefined)
}
