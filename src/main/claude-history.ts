import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ClaudeProjectHistory, ClaudeSessionInfo, FolderInfo, SessionUsage } from '@shared/protocol'

const HEAD_BYTES = 64 * 1024

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** A session transcript under the Claude Code config dir (a hook payload names it; nothing outside is read), else undefined. */
export function transcriptPath(p: unknown, configDir = claudeConfigDir()): string | undefined {
  if (typeof p !== 'string' || !p.endsWith('.jsonl') || !isAbsolute(p)) return undefined
  const full = resolve(p)
  const rel = relative(join(configDir, 'projects'), full)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : undefined
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: string }).text === 'string') {
        return (block as { text: string }).text
      }
    }
  }
  return undefined
}

function cleanTitle(raw: string): string {
  const firstLine = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('<') && !l.startsWith('@"') && !l.startsWith('@/'))
  const t = (firstLine ?? raw.trim()).replace(/\s+/g, ' ')
  return t.length > 90 ? t.slice(0, 87) + '…' : t
}

/** Parse the head of a Claude Code session transcript (JSONL). Pure; safe on truncated input. */
export function parseSessionHead(text: string, fallbackId: string): { id: string; cwd?: string; title?: string; branch?: string } {
  let id = fallbackId
  let cwd: string | undefined
  let branch: string | undefined
  let summary: string | undefined
  let firstUser: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // truncated last line
    }
    if (typeof d.sessionId === 'string') id = d.sessionId
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd
    if (!branch && typeof d.gitBranch === 'string' && d.gitBranch) branch = d.gitBranch
    if (d.type === 'summary' && typeof d.summary === 'string' && !summary) summary = d.summary
    // session names given with --name or /rename (field names vary across versions)
    for (const key of ['customTitle', 'sessionName', 'name', 'title']) {
      if ((d.type === 'custom-title' || d.type === 'session-name' || d.type === 'rename') && typeof d[key] === 'string' && d[key]) {
        summary = d[key] as string
      }
    }
    if (d.type === 'user' && !firstUser) {
      const msg = d.message as { content?: unknown } | undefined
      const t = msg ? textOf(msg.content) : undefined
      if (t && !/^<(command|local-command|system-reminder)/.test(t.trim())) firstUser = cleanTitle(t)
    }
    if (summary && firstUser && cwd) break
  }
  return { id, cwd, title: summary ?? firstUser, branch }
}

/** Read `length` bytes of a file starting at `start` (bounded, no full read of big transcripts). */
function readRange(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function readHead(file: string): string {
  return readRange(file, 0, HEAD_BYTES)
}

function samePathPrefix(path: string, root: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  let a = norm(path)
  let b = norm(root)
  if (process.platform === 'win32') {
    a = a.toLowerCase()
    b = b.toLowerCase()
  }
  return a === b || a.startsWith(b + '/')
}

/** All Claude Code sessions on this machine grouped by working directory, newest first. */
export function listClaudeSessions(configDir = claudeConfigDir(), opts: { rootFilter?: string } = {}): ClaudeProjectHistory[] {
  const projectsDir = join(configDir, 'projects')
  if (!existsSync(projectsDir)) return []
  const byCwd = new Map<string, ClaudeSessionInfo[]>()
  for (const dirName of readdirSync(projectsDir)) {
    const dir = join(projectsDir, dirName)
    let entries: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      try {
        const st = statSync(file)
        if (!st.isFile() || st.size === 0) continue
        const head = parseSessionHead(readHead(file), name.replace(/\.jsonl$/, ''))
        const cwd = head.cwd ?? dirName
        if (opts.rootFilter && !samePathPrefix(cwd, opts.rootFilter)) continue
        const info: ClaudeSessionInfo = { id: head.id, cwd, title: head.title ?? '(untitled session)', lastAt: st.mtimeMs, branch: head.branch, size: st.size }
        const key = process.platform === 'win32' ? cwd.toLowerCase() : cwd
        const list = byCwd.get(key) ?? []
        list.push(info)
        byCwd.set(key, list)
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  const out: ClaudeProjectHistory[] = []
  for (const sessions of byCwd.values()) {
    sessions.sort((a, b) => b.lastAt - a.lastAt)
    out.push({ cwd: sessions[0].cwd, sessions })
  }
  out.sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt)
  return out
}

/** Immediate subfolders of `root` with hints that help pick project folders. */
export function listSubfolders(root: string): FolderInfo[] {
  if (!existsSync(root)) return []
  const out: FolderInfo[] = []
  for (const name of readdirSync(root)) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const path = join(root, name)
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    let packageName: string | undefined
    const pkg = join(path, 'package.json')
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }
        if (typeof parsed.name === 'string') packageName = parsed.name
      } catch {
        /* ignore */
      }
    }
    out.push({ path, name, isGit: existsSync(join(path, '.git')), hasClaudeMd: existsSync(join(path, 'CLAUDE.md')), packageName })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const TAIL_BYTES = 512 * 1024

function readTail(file: string): string {
  const size = statSync(file).size
  const start = Math.max(0, size - TAIL_BYTES)
  return readRange(file, start, size - start)
}

/** Context window we assume for a model id (Claude 5 family and "[1m]" variants: 1M; else 200k). */
export function contextWindowFor(model?: string): number {
  if (!model) return 200_000
  if (/\[1m\]/i.test(model)) return 1_000_000
  if (/fable/i.test(model)) return 1_000_000
  // claude-<family>-5[-minor]: the Claude 5 generation
  if (/^claude-(opus|sonnet|haiku)-5(?:-\d+)?(?:-\d{8})?$/i.test(model)) return 1_000_000
  return 200_000
}

/** Pure: last assistant usage in a transcript tail (the tail is bounded, so no turn counting). */
export function parseUsageTail(text: string): SessionUsage | null {
  let last: SessionUsage | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let d: { type?: string; timestamp?: string; message?: { model?: string; usage?: Record<string, number> } }
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type !== 'assistant' || !d.message?.usage) continue
    const u = d.message.usage
    const model = d.message.model
    last = {
      contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      contextWindow: contextWindowFor(model),
      model,
      outputTokens: u.output_tokens ?? 0,
      at: d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now()
    }
  }
  return last
}

const usageFileCache = new Map<string, string>()

/** Find a session's transcript (any project folder) and report the context usage of its last turn. */
export function readSessionUsage(sessionId: string, configDir = claudeConfigDir()): SessionUsage | null {
  if (!/^[\w-]+$/.test(sessionId)) return null
  let file = usageFileCache.get(sessionId)
  if (!file || !existsSync(file)) {
    file = undefined
    const projectsDir = join(configDir, 'projects')
    if (!existsSync(projectsDir)) return null
    for (const dirName of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dirName, `${sessionId}.jsonl`)
      if (existsSync(candidate)) {
        file = candidate
        break
      }
    }
    if (!file) return null
    usageFileCache.set(sessionId, file)
  }
  try {
    return parseUsageTail(readTail(file))
  } catch {
    return null
  }
}
