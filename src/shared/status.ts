import type { AgentStatus, HookEvent } from './types'

export interface StatusUpdate {
  status: AgentStatus
  statusDetail?: string
  lastAssistantMessage?: string
  sessionId?: string
}

const NEEDS_YOU_NOTIFICATIONS = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

/** The detail of a "done" that only repeats a finished turn (Claude Code's idle reminder): not a new turn. */
export const DONE_ECHO_DETAIL = 'finished · idle'

function detailOf(event: HookEvent): string | undefined {
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim().slice(0, 200)
  return undefined
}

/** A card whose turn is over: done, idle, ended, or stopped on an error (a needs-you marked "failed:"). */
function isFinished(prev: AgentStatus | undefined, prevDetail: string | undefined): boolean {
  return prev === 'done' || prev === 'idle' || prev === 'ended' || (prev === 'needs-you' && !!failureOf(prevDetail))
}

/**
 * Pure reducer: previous status + Claude Code hook event -> next status.
 * Returns null when the event does not change anything we track.
 */
export function reduceHook(prev: AgentStatus | undefined, event: HookEvent, prevDetail?: string): StatusUpdate | null {
  const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
  switch (event.hook_event_name) {
    case 'SessionStart':
      return { status: 'idle', statusDetail: event.source ? `session ${event.source}` : 'session started', sessionId }
    case 'UserPromptSubmit':
      return { status: 'working', statusDetail: 'thinking', sessionId }
    case 'PreToolUse':
      // a subagent's tool calls carry agent_id (the main agent's do not): a background subagent still working after
      // the turn ended does not make the finished card Working again; its report back starts a turn with UserPromptSubmit
      if (typeof event.agent_id === 'string' && event.agent_id && isFinished(prev, prevDetail)) return null
      return { status: 'working', statusDetail: event.tool_name ? `tool: ${event.tool_name}` : 'tool', sessionId }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'SubagentStart':
    case 'SubagentStop':
      // These also arrive after a turn has ended (a background agent or shell finishing, the post-turn recap) and no
      // Stop follows them, so they never start a turn: a turn starts with UserPromptSubmit or PreToolUse. They keep a
      // working card working and resume one that was waiting on a permission prompt the owner just answered; a
      // needs-you marked "failed:" is a turn that ended on an error (StopFailure), not a prompt.
      if (isFinished(prev, prevDetail)) return null
      // a finished tool call is no longer in progress: "tool: …" (which earns the stall rules their longer grace) goes
      if (event.hook_event_name === 'PostToolUse' || event.hook_event_name === 'PostToolUseFailure') return { status: 'working', statusDetail: 'working', sessionId }
      return { status: 'working', statusDetail: prev === 'working' ? undefined : 'working', sessionId }
    // Compaction is not a turn: Claude Code also compacts while idle ("Compacted while idle, before the prompt
    // cache expired"), and no Stop follows that, so a card that was not working must stay idle/done.
    case 'PreCompact':
      return prev === 'working' ? { status: 'working', statusDetail: 'compacting context', sessionId } : null
    case 'PostCompact':
      return prev === 'working' ? { status: 'working', statusDetail: 'working', sessionId } : null
    case 'Notification': {
      const type = typeof event.notification_type === 'string' ? event.notification_type : ''
      if (NEEDS_YOU_NOTIFICATIONS.has(type)) {
        // a permission prompt is marked as such: during an autonomous run no card may answer one
        const detail = detailOf(event) ?? type
        return { status: 'needs-you', statusDetail: type === 'permission_prompt' ? `permission: ${detail}` : detail, sessionId }
      }
      // idle_prompt just means "no input for a while": keep Done if it finished, otherwise Idle
      if (type === 'idle_prompt') return { status: prev === 'done' ? 'done' : 'idle', statusDetail: prev === 'done' ? DONE_ECHO_DETAIL : 'idle', sessionId }
      return null
    }
    case 'Stop':
      return {
        status: 'done',
        statusDetail: 'finished responding',
        lastAssistantMessage: typeof event.last_assistant_message === 'string' ? event.last_assistant_message : undefined,
        sessionId
      }
    case 'StopFailure':
      // "failed:" marks a turn that ended in an error (API failure, usage limit): the toast and the sidebar say so
      return { status: 'needs-you', statusDetail: `failed: ${detailOf(event) ?? 'turn failed (API error)'}`, sessionId }
    case 'SessionEnd':
      return { status: 'ended', statusDetail: 'session ended', sessionId }
    default:
      return null
  }
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  'needs-you': 'Needs you',
  done: 'Done',
  ended: 'Ended'
}

/** State colours for what cannot carry a glyph (the minimap). Colour marks state only; the chrome itself is grey. */
export const STATUS_COLOR: Record<AgentStatus, string> = {
  starting: '#737373',
  idle: '#525252',
  working: '#f0b100',
  'needs-you': '#ff6900',
  done: '#00bc7d',
  ended: '#3a3a3a'
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')

/** True when a chunk of terminal output shows the Claude Code TUI is up (fallback when SessionStart hooks do not arrive). */
export function detectClaudeReady(chunk: string): boolean {
  return /Claude Code v\d|\? for shortcuts|Try "|auto mode on|accept edits on|plan mode on|OpenAI Codex|Tips for getting started|Type your message/i.test(stripAnsi(chunk))
}

/** A "failed:" detail (StopFailure, a launch whose CLI is missing) without the marker, or undefined. */
export function failureOf(statusDetail: string | undefined): string | undefined {
  const m = /^failed:\s*(.*)$/s.exec(statusDetail ?? '')
  return m ? m[1].trim() || 'failed' : undefined
}

/**
 * The command the shell could not find in a launch's output, or null. PowerShell's message is localised
 * ("The term 'claude' is not recognized …" / "'claude' 용어가 … 인식되지 않습니다"), so it is read from the parts
 * that are not: the `ObjectNotFound: (claude:String) [], CommandNotFoundException` line (5.1), or the first
 * line's shape `claude : 'claude' …` / `claude: The term 'claude'` (7, ConciseView). cmd: "'claude' is not
 * recognized as an internal or external command" (English; Korean cmd keeps the quoted name too). bash/zsh/sh:
 * "bash: claude: command not found", "zsh: command not found: claude". Read within seconds of the launch, so a
 * card whose CLI is not installed does not sit on "starting" until a stall timer gives up on it.
 */
export function detectMissingCommand(output: string, expect?: string): string | null {
  const names = findMissingCommands(output)
  if (!expect) return names[0] ?? null
  // only the CLI the card launches counts: a tool missing from the shell's own profile (oh-my-posh, starship)
  // is not this card's failure
  const base = (n: string): string => n.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() ?? ''
  return names.find((n) => base(n) === expect.toLowerCase()) ?? null
}

/** Every command the output says was not found, first first. */
function findMissingCommands(output: string): string[] {
  const clean = stripAnsi(output)
  // a card is ~60 columns wide: the terminal wraps PowerShell's lines mid-word, so they are read joined
  const flat = clean.replace(/\r?\n/g, '')
  const patterns: Array<[RegExp, string]> = [
    [/ObjectNotFound:\s*\(([^:)\s]+):String\)\s*\[\],\s*CommandNotFoundException/g, flat],
    [/(?:^|\n)\s*([^\s:'"]+) ?: (?:The term )?'\1'/g, clean],
    [/The term '([^']+)' is not recognized/g, flat],
    [/'([^']+)' 용어가/g, flat],
    [/'([^']+)' is not recognized as an internal or external command/g, flat],
    [/'([^']+)'(?:은\(는\)|은|는) 내부 또는 외부 명령/g, flat],
    [/command not found: ([^\s'"]+)/g, clean], // zsh, before bash's shape: "zsh: command not found: x" would read as "zsh"
    [/(?:^|\n)\s*(?:[\w.-]+: )?(?:line \d+: )?([^\s:'"]+): command not found/g, clean]
  ]
  const out: string[] = []
  for (const [re, text] of patterns) for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1])
  return out
}
