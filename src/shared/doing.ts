/**
 * What a card is doing, without asking it to report (idea from Reason Network): the step comes from the tool call
 * its hooks announce (a shell command's own description, the file it edits), the topic from the title Claude Code
 * gives the conversation (`ai-title` lines in its transcript). Pure: hook events and transcript text in, short lines out.
 */
import type { HookEvent } from './types'

const MAX = 80
// control characters, bidi marks and overrides, zero-width characters
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Pure: text with control, bidi and invisible characters replaced by spaces (line breaks kept). */
export function stripUnsafe(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE, (c) => (c === '\n' ? c : ' '))
}

export function cleanLine(text: string): string {
  const t = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t
}

const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const VERB: Record<string, string> = { Edit: 'editing', MultiEdit: 'editing', Write: 'writing', NotebookEdit: 'editing', Read: 'reading' }

/** Pure: the step a main-agent PreToolUse announces, or undefined (a subagent's call, or nothing to say). */
export function stepOf(event: HookEvent): string | undefined {
  if (event.hook_event_name !== 'PreToolUse' || (typeof event.agent_id === 'string' && event.agent_id)) return undefined
  const tool = typeof event.tool_name === 'string' ? event.tool_name : ''
  const input = (event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof input[k] === 'string' && (input[k] as string).trim() ? (input[k] as string) : undefined)
  let step: string | undefined
  const desc = str('description')
  const file = str('file_path') ?? str('notebook_path')
  if (desc) step = desc
  else if (file) step = `${VERB[tool] ?? tool.toLowerCase()} ${base(file)}`
  else if (tool === 'Grep' || tool === 'Glob') step = `searching ${str('pattern') ?? ''}`
  else if (tool === 'WebFetch' && str('url')) {
    try {
      step = `reading ${new URL(str('url') as string).host}`
    } catch {
      step = 'reading a web page'
    }
  } else if (tool === 'WebSearch' && str('query')) step = `searching the web: ${str('query')}`
  else if (tool.startsWith('mcp__')) step = tool.slice(5).replace('__', ': ')
  else if (tool) step = tool
  const line = step ? cleanLine(step) : ''
  return line || undefined
}

/** Pure: the last conversation title in a piece of transcript (JSON lines), or undefined. */
export function aiTitleOf(chunk: string): string | undefined {
  let title: string | undefined
  for (const line of chunk.split('\n')) {
    if (!line.includes('"ai-title"')) continue
    try {
      const j = JSON.parse(line) as { type?: unknown; aiTitle?: unknown }
      if (j.type === 'ai-title' && typeof j.aiTitle === 'string' && j.aiTitle.trim()) title = cleanLine(j.aiTitle)
    } catch {
      // a line cut at the read boundary
    }
  }
  return title
}

/** Pure: the status detail a card shows: its step while it works, else the status detail. */
export function shownDetail(d: { status?: string; statusDetail?: string; doing?: string }): string | undefined {
  return d.status === 'working' && d.doing ? d.doing : d.statusDetail
}
