import type { AgentStatus, HookEvent } from './types'

export interface StatusUpdate {
  status: AgentStatus
  statusDetail?: string
  lastAssistantMessage?: string
  sessionId?: string
}

const NEEDS_YOU_NOTIFICATIONS = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog'])

function detailOf(event: HookEvent): string | undefined {
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim().slice(0, 200)
  return undefined
}

/**
 * Pure reducer: previous status + Claude Code hook event -> next status.
 * Returns null when the event does not change anything we track.
 */
export function reduceHook(prev: AgentStatus | undefined, event: HookEvent): StatusUpdate | null {
  const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
  switch (event.hook_event_name) {
    case 'SessionStart':
      return { status: 'idle', statusDetail: event.source ? `session ${event.source}` : 'session started', sessionId }
    case 'UserPromptSubmit':
      return { status: 'working', statusDetail: 'thinking', sessionId }
    case 'PreToolUse':
      return { status: 'working', statusDetail: event.tool_name ? `tool: ${event.tool_name}` : 'tool', sessionId }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'PostCompact':
      return { status: 'working', statusDetail: prev === 'working' ? undefined : 'working', sessionId }
    case 'PreCompact':
      return { status: 'working', statusDetail: 'compacting context', sessionId }
    case 'Notification': {
      const type = typeof event.notification_type === 'string' ? event.notification_type : ''
      if (NEEDS_YOU_NOTIFICATIONS.has(type)) {
        return { status: 'needs-you', statusDetail: detailOf(event) ?? type, sessionId }
      }
      // idle_prompt just means "no input for a while": keep Done if it finished, otherwise Idle
      if (type === 'idle_prompt') return { status: prev === 'done' ? 'done' : 'idle', statusDetail: prev === 'done' ? 'finished · idle' : 'idle', sessionId }
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
      return { status: 'needs-you', statusDetail: detailOf(event) ?? 'turn failed (API error)', sessionId }
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

export const STATUS_COLOR: Record<AgentStatus, string> = {
  starting: '#8b8b8b',
  idle: '#6b7280',
  working: '#3b82f6',
  'needs-you': '#f59e0b',
  done: '#22c55e',
  ended: '#525252'
}

/** True when a chunk of terminal output shows the Claude Code TUI is up (fallback when SessionStart hooks do not arrive). */
export function detectClaudeReady(chunk: string): boolean {
  // eslint-disable-next-line no-control-regex
  const clean = chunk.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  return /Claude Code v\d|\? for shortcuts|Try "|auto mode on|accept edits on|plan mode on/.test(clean)
}
