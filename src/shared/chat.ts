/**
 * Chat view: a Claude card's conversation read from its Claude Code transcript (JSON lines) and shown as a chat
 * instead of a terminal. The session is the same interactive `claude` in the same PTY: hooks, the inbox, the
 * board tools and the sign-in are untouched, and the terminal is one click away. Pure: transcript text in, chat
 * items out; the visuals a reply may carry (```mermaid, ```svg) are split out here and drawn by the renderer.
 */
import { Marked, type Token } from 'marked'
import { stripAnsi } from './ansi'
import type { AgentEngine, AgentStatus, NodeKind } from './types'

export type CardView = 'chat' | 'terminal'

/** Stored view value: one of the two, else undefined (the Settings default). */
export function normalizeCardView(v: unknown): CardView | undefined {
  return v === 'chat' || v === 'terminal' ? v : undefined
}

/** Pure: can this card show a chat view? Claude Code cards on this machine only: the others keep no transcript we read. */
export function chatCapable(d: { kind?: NodeKind; engine?: AgentEngine | string; claude?: { wsl?: boolean } }): boolean {
  return (d.kind === 'claude' || d.kind === 'conductor') && (d.engine ?? 'claude') === 'claude' && d.claude?.wsl !== true
}

/** Pure: the view a card shows: its own choice, else the Settings default, and always the terminal where chat cannot work. */
export function cardView(d: { kind?: NodeKind; engine?: AgentEngine | string; claude?: { wsl?: boolean }; view?: unknown }, settingsDefault: unknown): CardView {
  if (!chatCapable(d)) return 'terminal'
  return normalizeCardView(d.view) ?? normalizeCardView(settingsDefault) ?? 'terminal'
}

/**
 * Added to the system prompt of a Claude card launched in chat view, so its replies use what the view can draw.
 * Fixed text: nothing from the board file goes into it.
 */
export const CHAT_VIEW_PROMPT =
  'Your replies in this session are shown to the owner in a chat view that renders GitHub-flavoured markdown (headings, lists, tables, code blocks). ' +
  'When a picture explains something better than prose (how files or parts relate, a flow, a structure, a sequence), include a diagram as a fenced ```mermaid block ' +
  '(flowchart, sequence, class, state or ER diagram; short labels; put labels that contain punctuation in double quotes), or as a small self-contained ```svg block with a viewBox. ' +
  'Say in a sentence what the diagram shows. Use a diagram only where it helps; a short answer stays short. ' +
  'HTML pages, scripts, remote images and remote fonts are not rendered.'

export const CHAT_LIMITS = {
  /** a transcript is read from at most this far before its end (older turns stay in the terminal's scrollback and the file) */
  readBytes: 2 * 1024 * 1024,
  /** items a card keeps in memory; older ones are dropped from the top */
  items: 400,
  textChars: 120_000,
  toolInputChars: 6000,
  toolResultChars: 8000,
  summaryChars: 160,
  noteChars: 600,
  /** a prompt sent from the chat that the transcript has not shown after this long is marked unconfirmed (never removed by itself) */
  pendingMs: 20_000,
  composerChars: 20_000,
  diagramChars: 20_000
} as const

interface Base {
  /** stable within a transcript: the line's uuid and the block's index */
  id: string
  at?: number
}
export type ChatItem =
  | (Base & { type: 'user'; text: string })
  | (Base & { type: 'assistant'; text: string })
  | (Base & { type: 'thinking'; text: string })
  | (Base & { type: 'tool'; toolId: string; name: string; summary: string; input: string; result?: { text: string; error: boolean } })
  | (Base & { type: 'note'; text: string })

/** What a piece of transcript adds: items, and the results of tool calls seen earlier. */
export type ChatEvent = ChatItem | { type: 'result'; toolId: string; text: string; error: boolean }

// control characters (tab and line break kept) and bidi overrides: a reply or a tool result must not hide or reorder what the owner reads
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
/** Pure: text safe to show: line endings as line feeds, terminal colour codes and control characters gone. */
export function cleanChatText(text: string): string {
  return stripAnsi(text.replace(/\r\n?/g, '\n')).replace(UNSAFE, '')
}
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString('en-US')} more characters not shown)` : s)
const oneLine = (s: string, max: number): string => {
  const t = cleanChatText(s).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** Pure: one line that says what a tool call does (the command, the file, the pattern). */
export function toolSummary(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string) : undefined)
  const file = str('file_path') ?? str('notebook_path') ?? str('path')
  let s: string | undefined
  if (name === 'Bash' || name === 'PowerShell') s = str('command')
  else if (name === 'Grep' || name === 'Glob') s = [str('pattern'), file ? `in ${base(file)}` : ''].filter(Boolean).join(' ')
  else if (file) s = file
  else if (name === 'TodoWrite' && Array.isArray(o.todos)) s = `${o.todos.length} item(s)`
  else s = str('description') ?? str('prompt') ?? str('query') ?? str('url') ?? str('skill') ?? str('subject') ?? str('text') ?? str('message')
  if (s === undefined) s = Object.values(o).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return oneLine(s ?? '', CHAT_LIMITS.summaryChars)
}

/** Pure: a tool name as shown: `mcp__server__tool` reads "server: tool". */
export function toolLabel(name: string): string {
  return name.startsWith('mcp__') ? name.slice(5).replace('__', ': ') : name
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const o = (b && typeof b === 'object' ? b : {}) as { type?: unknown; text?: unknown }
      if (o.type === 'text' && typeof o.text === 'string') return o.text
      if (o.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const HARNESS_TAGS = new Set(['local-command-stdout', 'local-command-stderr', 'bash-stdout', 'bash-stderr', 'task-notification', 'cross-session-message', 'user-memory-input'])
const tag = (text: string, name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()

/**
 * Pure: what a `user` line's text is to the owner: their prompt, a note (a slash command's output, a harness
 * message), or nothing (reminders and caveats Claude Code adds for the model).
 */
export function userText(raw: string): { type: 'user' | 'note'; text: string } | undefined {
  const text = raw.replace(REMINDER, '').trim()
  if (!text) return undefined
  const command = tag(text, 'command-name')
  if (command) return { type: 'user', text: [command.startsWith('/') ? command : `/${command}`, tag(text, 'command-args')].filter(Boolean).join(' ') }
  if (text.startsWith('<local-command-caveat>')) return undefined
  if (/^\[Request interrupted by user/.test(text)) return { type: 'note', text: 'Interrupted' }
  // `!command` typed by the owner
  const bash = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)
  if (bash) return bash[1].trim() ? { type: 'user', text: `!${bash[1].trim()}` } : undefined
  // what the harness wraps (a command's output, a finished background task, another session's message): its words,
  // as a note. Any other tag is the owner's own text (a prompt may well be written as <task>…</task>).
  const wrapped = /^<([a-z][\w-]*)>([\s\S]*)<\/\1>$/.exec(text)
  if (wrapped && HARNESS_TAGS.has(wrapped[1])) {
    const inner = wrapped[2].replace(/<[^>]{1,80}>/g, ' ').trim()
    return inner ? { type: 'note', text: oneLine(inner, CHAT_LIMITS.noteChars) } : undefined
  }
  return { type: 'user', text }
}

/**
 * Pure: the chat events in a piece of a Claude Code transcript. Lines that are not the conversation (snapshots,
 * titles, request logs), a subagent's own turns and lines cut at a read boundary are skipped.
 */
export function parseChatLines(text: string): ChatEvent[] {
  const out: ChatEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!d || typeof d !== 'object' || d.isSidechain === true) continue
    const uuid = typeof d.uuid === 'string' ? d.uuid : ''
    if (!uuid) continue
    const atMs = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
    const at = Number.isFinite(atMs) ? atMs : undefined
    if (d.type === 'system') {
      if (d.subtype === 'compact_boundary') out.push({ type: 'note', id: uuid, at, text: 'Conversation compacted' })
      continue
    }
    // a prompt that arrived while the card worked (typed by the owner, or put in by the board) is recorded only as
    // this attachment when Claude Code hands it to the model mid-turn: no `user` line repeats it
    const queued = d.type === 'attachment' ? (d.attachment as { type?: unknown; prompt?: unknown } | undefined) : undefined
    if (queued) {
      if (queued.type !== 'queued_command') continue
      const said = typeof queued.prompt === 'string' ? queued.prompt : resultText(queued.prompt)
      const u = userText(said)
      if (u) out.push({ type: u.type, id: `${uuid}:0`, at, text: u.type === 'user' ? clip(cleanChatText(u.text), CHAT_LIMITS.textChars) : u.text })
      continue
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    const content = (d.message as { content?: unknown } | undefined)?.content
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    blocks.forEach((raw, i) => {
      const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const id = `${uuid}:${i}`
      if (d.type === 'assistant') {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ type: 'assistant', id, at, text: clip(cleanChatText(b.text), CHAT_LIMITS.textChars) })
        else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) out.push({ type: 'thinking', id, at, text: clip(cleanChatText(b.thinking), CHAT_LIMITS.textChars) })
        else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          let input = ''
          try {
            input = JSON.stringify(b.input ?? {}, null, 2)
          } catch {
            input = '(input could not be shown)'
          }
          out.push({ type: 'tool', id, at, toolId: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: clip(cleanChatText(input), CHAT_LIMITS.toolInputChars) })
        }
        return
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        out.push({ type: 'result', toolId: b.tool_use_id, text: clip(cleanChatText(resultText(b.content)), CHAT_LIMITS.toolResultChars), error: b.is_error === true })
        return
      }
      if (d.isMeta === true) return
      if (b.type === 'image') return void out.push({ type: 'note', id, at, text: 'Image attached' })
      if (b.type !== 'text' || typeof b.text !== 'string') return
      if (d.isCompactSummary === true) return void out.push({ type: 'note', id, at, text: 'Conversation compacted (the summary replaces the earlier turns)' })
      const u = userText(b.text)
      if (u) out.push({ type: u.type, id, at, text: u.type === 'user' ? clip(cleanChatText(u.text), CHAT_LIMITS.textChars) : u.text })
    })
  }
  return out
}

/** Pure: items after more events: new items appended (one per id), tool results attached to their call, the oldest dropped past the cap. */
export function applyChatEvents(items: readonly ChatItem[], events: readonly ChatEvent[], cap: number = CHAT_LIMITS.items): ChatItem[] {
  if (!events.length) return items as ChatItem[]
  const next = items.slice()
  const seen = new Set(next.map((i) => i.id))
  for (const e of events) {
    if (e.type === 'result') {
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]
        if (it.type === 'tool' && it.toolId === e.toolId) {
          next[i] = { ...it, result: { text: e.text, error: e.error } }
          break
        }
      }
      continue
    }
    if (seen.has(e.id)) continue
    seen.add(e.id)
    next.push(e)
  }
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Pure: the tool call a card waiting on the owner is asking about: its last call without a result, when nothing came after it. */
export function pendingTool(items: readonly ChatItem[]): Extract<ChatItem, { type: 'tool' }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'tool') return it.result ? undefined : it
    if (it.type === 'user' || it.type === 'assistant') return undefined
  }
  return undefined
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Pure: which prompts sent from the chat the transcript now shows. A prompt is matched to a `user` item with the
 * same text (whitespace aside) recorded no earlier than it was sent (2 s of slack: the same machine's clock), the
 * oldest prompt first, and every item answers for one prompt only (its id goes into `used`): the same words sent
 * twice need two items, and a later, longer prompt never stands in for one that did not arrive.
 */
export function confirmPending<P extends { text: string; at: number }>(pending: readonly P[], items: readonly ChatItem[], used: ReadonlySet<string>): { left: P[]; used: Set<string> } {
  const taken = new Set(used)
  const left: P[] = []
  for (const p of pending) {
    // the transcript shows a long prompt cut at the cap, with a note after it
    const want = norm(p.text).slice(0, 2000)
    const hit = items.find((i) => i.type === 'user' && !taken.has(i.id) && i.at !== undefined && i.at >= p.at - 2000 && norm(i.text).slice(0, 2000) === want)
    if (hit) taken.add(hit.id)
    else left.push(p)
  }
  return { left, used: taken }
}

/** Pure: may the owner's prompt be typed into this card now? Typing into a card that asks a question would answer the question. */
export function composerBlock(status: AgentStatus | undefined, ptyAlive: boolean | undefined): string | undefined {
  if (status === 'ended' || ptyAlive === false) return 'The card is not running. Restart it, then send.'
  if (status === 'starting' || status === undefined) return 'The card is still starting. Send once it is ready.'
  if (status === 'needs-you') return 'The card is waiting on a question in its terminal. Answer it there first: a prompt typed now would be taken as the answer.'
  return undefined
}

export type ReplyPart = { type: 'md'; text: string } | { type: 'mermaid'; code: string } | { type: 'svg'; code: string }

const lexer = new Marked({ gfm: true, breaks: true })

/**
 * Pure: a reply split into markdown and the visuals it carries. Only a top-level fenced block named `mermaid`
 * or `svg` (an svg one must start with `<svg`) is a visual; one inside a list or a quote, or too large, stays code.
 */
export function splitReply(markdown: string): ReplyPart[] {
  let tokens: Token[]
  try {
    tokens = lexer.lexer(markdown)
  } catch {
    return [{ type: 'md', text: markdown }]
  }
  const parts: ReplyPart[] = []
  let md = ''
  const flush = (): void => {
    if (md.trim()) parts.push({ type: 'md', text: md })
    md = ''
  }
  for (const t of tokens) {
    const lang = t.type === 'code' && typeof t.lang === 'string' ? t.lang.trim().toLowerCase() : ''
    const code = t.type === 'code' && typeof t.text === 'string' ? t.text : ''
    const visual = code.trim() && code.length <= CHAT_LIMITS.diagramChars ? (lang === 'mermaid' ? 'mermaid' : lang === 'svg' && /^\s*<svg[\s>]/i.test(code) ? 'svg' : undefined) : undefined
    if (visual) {
      flush()
      parts.push({ type: visual, code })
    } else md += t.raw
  }
  flush()
  return parts.length ? parts : [{ type: 'md', text: markdown }]
}

/** The result of reading a card's transcript (main → renderer). */
export interface ChatRead {
  ok: boolean
  /** ok=false: why there is nothing to show, for the owner */
  error?: string
  /** the transcript read (its path): a different key is a different conversation */
  key?: string
  /** where the next read starts */
  offset?: number
  /** the events start over: what the renderer holds for this key is replaced */
  reset?: boolean
  /** the transcript is longer than what was read: its older part is not shown */
  clipped?: boolean
  /** the read stopped at its size limit: read again from `offset` */
  more?: boolean
  events: ChatEvent[]
}
