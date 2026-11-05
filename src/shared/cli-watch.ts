/**
 * Keeping up with CLI updates. Pure: which installed CLIs changed version since they were last checked against
 * the contract (shared/cli-contract.ts), what a check found, and the text a "CLI update watch" routine hands its
 * card: the version changes, the check's result, and the Claude Code changelog lines that mention what Ouroboros
 * relies on. Main (main/cli-watch.ts) runs the check, keeps the state in the app's data folder and fetches the changelog.
 */
import type { AgentEngine } from './types'

export const ENGINES: readonly AgentEngine[] = ['claude', 'codex', 'gemini', 'grok']
export const CLAUDE_CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
/** In a routine's prompt: replaced, when it runs, by what changed since its last run (and nothing is sent when nothing did). */
export const CLI_UPDATES_TOKEN = '{{cli-updates}}'
export const WATCH_LIMITS = { issues: 60, text: 300, changelogLines: 120, digestChars: 10_000 }

export interface CompatIssue {
  kind: 'flag' | 'string' | 'run'
  text: string
  /** where Ouroboros relies on it */
  why: string
}

/** What the last check of one CLI found. */
export interface EngineCompat {
  version: string
  checkedAt: number
  /** assumptions checked */
  total: number
  missing: CompatIssue[]
  /** flags that still work but left `--help` */
  hidden: CompatIssue[]
  /** the version checked before this one */
  previousVersion?: string
}

export interface CompatState {
  engines: Partial<Record<AgentEngine, EngineCompat>>
  /** the version of each CLI the last CLI-watch routine run covered */
  reviewed: Partial<Record<AgentEngine, string>>
}

/** What Settings → Engines shows. */
export interface CompatView {
  engines: Partial<Record<AgentEngine, EngineCompat>>
  checking: boolean
  /** the check itself could not run */
  error?: string
}

export interface DetectedCli {
  engine: AgentEngine
  label: string
  installed: boolean
  version?: string
}

/** A check's result for one CLI, as the check process reports it (main/cli-compat.ts CompatReport). */
export interface CheckReport {
  engine: string
  installed: boolean
  version?: string
  lines: Array<{ status: string; kind: string; text: string; why: string }>
}

const str = (v: unknown, max = WATCH_LIMITS.text): string => (typeof v === 'string' ? v.slice(0, max) : '')
const isEngine = (v: unknown): v is AgentEngine => ENGINES.includes(v as AgentEngine)

function cleanIssues(raw: unknown): CompatIssue[] {
  if (!Array.isArray(raw)) return []
  const out: CompatIssue[] = []
  for (const i of raw.slice(0, WATCH_LIMITS.issues)) {
    const o = (i && typeof i === 'object' ? i : {}) as Record<string, unknown>
    const kind = o.kind === 'flag' || o.kind === 'string' || o.kind === 'run' ? o.kind : undefined
    if (kind && str(o.text)) out.push({ kind, text: str(o.text), why: str(o.why) })
  }
  return out
}

/** Pure: the state file as read from disk; anything that is not a check result is dropped. */
export function sanitizeCompatState(raw: unknown): CompatState {
  const state: CompatState = { engines: {}, reviewed: {} }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const [k, v] of Object.entries((o.engines && typeof o.engines === 'object' ? o.engines : {}) as Record<string, unknown>)) {
    const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    if (!isEngine(k) || !str(e.version, 80) || typeof e.checkedAt !== 'number' || !Number.isFinite(e.checkedAt)) continue
    state.engines[k] = {
      version: str(e.version, 80),
      checkedAt: e.checkedAt,
      total: typeof e.total === 'number' && Number.isFinite(e.total) ? e.total : 0,
      missing: cleanIssues(e.missing),
      hidden: cleanIssues(e.hidden),
      ...(str(e.previousVersion, 80) ? { previousVersion: str(e.previousVersion, 80) } : {})
    }
  }
  for (const [k, v] of Object.entries((o.reviewed && typeof o.reviewed === 'object' ? o.reviewed : {}) as Record<string, unknown>)) if (isEngine(k) && str(v, 80)) state.reviewed[k] = str(v, 80)
  return state
}

/** Pure: the installed CLIs whose version is not the one last checked (all installed ones with `force`). */
export function staleEngines(state: CompatState, detected: readonly DetectedCli[], force = false): AgentEngine[] {
  return detected.filter((d) => d.installed && d.version && (force || state.engines[d.engine]?.version !== d.version)).map((d) => d.engine)
}

/**
 * Pure: the state after a check. `versions` are the versions the app detected (a report's own version line is the
 * fallback). `broke` lists the CLIs whose new version lacks something Ouroboros relies on, for a toast.
 */
export function applyReports(state: CompatState, reports: readonly CheckReport[], versions: Partial<Record<AgentEngine, string>>, now: number): { state: CompatState; broke: Array<{ engine: AgentEngine; version: string; missing: CompatIssue[] }> } {
  const engines = { ...state.engines }
  const broke: Array<{ engine: AgentEngine; version: string; missing: CompatIssue[] }> = []
  for (const r of reports) {
    if (!isEngine(r.engine) || !r.installed) continue
    const version = versions[r.engine] ?? str(r.version, 80)
    if (!version) continue
    const lines = Array.isArray(r.lines) ? r.lines : []
    const pick = (status: string): CompatIssue[] => cleanIssues(lines.filter((l) => l.status === status))
    const prev = engines[r.engine]
    const next: EngineCompat = { version, checkedAt: now, total: lines.length, missing: pick('missing'), hidden: pick('hidden') }
    const previousVersion = prev && prev.version !== version ? prev.version : prev?.previousVersion
    if (previousVersion) next.previousVersion = previousVersion
    engines[r.engine] = next
    if (next.missing.length > 0) broke.push({ engine: r.engine, version, missing: next.missing })
  }
  return { state: { ...state, engines }, broke }
}

/** Pure: compare dotted versions by their numbers ("2.1.9" < "2.1.10"); a version without numbers sorts first. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string): number[] => (/\d+(\.\d+)*/.exec(v)?.[0] ?? '').split('.').filter(Boolean).map(Number)
  const x = nums(a)
  const y = nums(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export interface CliUpdate {
  engine: AgentEngine
  label: string
  /** the version the last watch run covered; undefined on the first run */
  from?: string
  to: string
}

/** Pure: the installed CLIs whose version differs from the one the last watch run covered. */
export function cliUpdates(state: CompatState, detected: readonly DetectedCli[]): CliUpdate[] {
  const out: CliUpdate[] = []
  for (const d of detected) {
    if (!d.installed || !d.version || state.reviewed[d.engine] === d.version) continue
    out.push({ engine: d.engine, label: d.label, ...(state.reviewed[d.engine] ? { from: state.reviewed[d.engine] } : {}), to: d.version })
  }
  return out
}

/** Pure: the state once a watch run covered these versions. */
export function markReviewed(state: CompatState, updates: readonly CliUpdate[]): CompatState {
  const reviewed = { ...state.reviewed }
  for (const u of updates) reviewed[u.engine] = u.to
  return { ...state, reviewed }
}

// lines about other surfaces (the VS Code extension, cloud sessions, the Slack app…) never touch a card
const OTHER_SURFACE = /^-\s*(\[[^\]]+\]|Self-hosted runner:)/
const RELEVANT =
  /hook|status ?line|--[a-z][a-z-]+|trust|permission (prompt|dialog|mode)|messaging|inbox|subagent|background (task|agent)|transcript|settings\.json|setting sources|plugin|\bmods?\b|\beffort\b|interrupt|notification|session ?(start|end)|compact|\bMCP\b|deprecat|\bremoved\b|\brenamed\b|no longer/i

/**
 * Pure: the changelog entries of the versions after `from` up to `to` (only `to` when there is no `from`) that
 * mention something Ouroboros relies on: a word from the list above, or one of `texts` (the contract's flags and
 * strings). Sections are `## <version>` headings, newest first, as in Claude Code's CHANGELOG.md.
 */
export function relevantChangelog(markdown: string, from: string | undefined, to: string, texts: readonly string[] = []): { lines: string[]; more: number; versions: string[] } {
  const lines: string[] = []
  const versions: string[] = []
  let more = 0
  let inRange = false
  let headed = false
  let version = ''
  const needles = texts.filter((t) => t.length >= 6).map((t) => t.toLowerCase())
  for (const raw of markdown.split(/\r?\n/)) {
    const h = /^##\s+\[?v?(\d+(?:\.\d+)+)\]?/.exec(raw)
    if (h) {
      version = h[1]
      inRange = compareVersions(version, to) <= 0 && (from ? compareVersions(version, from) > 0 : compareVersions(version, to) === 0)
      headed = false
      continue
    }
    if (!inRange || !/^\s*[-*]\s/.test(raw) || OTHER_SURFACE.test(raw.trim())) continue
    const low = raw.toLowerCase()
    if (!RELEVANT.test(raw) && !needles.some((n) => low.includes(n))) continue
    if (lines.length >= WATCH_LIMITS.changelogLines) {
      more++
      continue
    }
    if (!headed) {
      lines.push(`## ${version}`)
      versions.push(version)
      headed = true
    }
    lines.push(raw.trim().slice(0, 400))
  }
  return { lines, more, versions }
}

/** Pure: one CLI's check in a sentence. */
export function compatSentence(label: string, c: EngineCompat): string {
  const hidden = c.hidden.length ? `; ${c.hidden.length} flag${c.hidden.length === 1 ? '' : 's'} no longer in --help (still works): ${c.hidden.map((h) => h.text).join(', ')}` : ''
  if (c.missing.length === 0) return `${label} ${c.version}: everything Ouroboros relies on is there (${c.total} checked)${hidden}`
  return `${label} ${c.version}: ${c.missing.length} of ${c.total} MISSING: ${c.missing.map((m) => `${m.text} (${m.why})`).join('; ')}${hidden}`
}

/** Pure: the text a CLI-watch routine hands its card in place of the token. */
export function buildDigest(input: { updates: readonly CliUpdate[]; state: CompatState; changelog?: { lines: string[]; more: number }; changelogError?: string }): string {
  const out: string[] = ['CLI versions on this PC that changed since the last CLI watch:']
  for (const u of input.updates) out.push(`- ${u.label}: ${u.from ? `${u.from} → ${u.to}` : `${u.to} (first watch)`}`)
  out.push('', "Ouroboros's own compatibility check (the same as Settings → Engines; flags in --help, strings in the installed files):")
  for (const u of input.updates) {
    const c = input.state.engines[u.engine]
    out.push(`- ${c && c.version === u.to ? compatSentence(u.label, c) : `${u.label} ${u.to}: not checked yet`}`)
  }
  const claude = input.updates.find((u) => u.engine === 'claude')
  if (claude) {
    out.push('')
    if (input.changelog && input.changelog.lines.length > 0) {
      out.push(`Claude Code changelog entries that mention hooks, flags, the status line, prompts or other things Ouroboros relies on (${CLAUDE_CHANGELOG_URL}):`, ...input.changelog.lines)
      if (input.changelog.more > 0) out.push(`… ${input.changelog.more} more such entries are in the changelog.`)
    } else if (input.changelogError) out.push(`The Claude Code changelog could not be fetched (${input.changelogError}). Read it at ${CLAUDE_CHANGELOG_URL}.`)
    else out.push(`No Claude Code changelog entry in that range mentions what Ouroboros relies on (${CLAUDE_CHANGELOG_URL}).`)
  }
  const others = input.updates.filter((u) => u.engine !== 'claude')
  if (others.length) out.push('', `Release notes of the other CLIs are not fetched: look them up for ${others.map((u) => `${u.label} ${u.to}`).join(', ')}.`)
  const text = out.join('\n')
  return text.length > WATCH_LIMITS.digestChars ? `${text.slice(0, WATCH_LIMITS.digestChars)}\n… (cut: the rest is in the changelog)` : text
}

/** The "CLI update watch" routine the Routines tab offers as a starting point. */
export const CLI_WATCH_ROUTINE = {
  name: 'CLI update watch',
  schedule: 'weekly' as const,
  weekday: 1,
  at: '09:00',
  prompt: `An agent CLI on this PC was updated since the last watch. Ouroboros (the app running you as a card) depends on these CLIs: their flags, hook events and payloads, the status line, the folder-trust and permission prompts, and Claude Code's messaging inbox.

${CLI_UPDATES_TOKEN}

Read the above and report, in plain words:
1. Anything that could break Ouroboros cards. A MISSING line in the compatibility check is one; so is a changelog entry that changes a hook, a flag or a prompt Ouroboros reads. Open the full release notes when a line is unclear.
2. New CLI features Ouroboros could use.
3. If neither: say that nothing needs doing.
Do not change any code. End with "OWNER: REPORT — <one line>" only when 1 or 2 has something.`
}
