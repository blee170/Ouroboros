import { describe, expect, it } from 'vitest'
import { detectClaudeReady, reduceHook } from '@shared/status'

describe('reduceHook', () => {
  it('maps lifecycle events to statuses', () => {
    expect(reduceHook(undefined, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' })).toMatchObject({ status: 'idle', sessionId: 's1' })
    expect(reduceHook('idle', { hook_event_name: 'UserPromptSubmit' })?.status).toBe('working')
    expect(reduceHook('working', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toMatchObject({ status: 'working', statusDetail: 'tool: Bash' })
    expect(reduceHook('working', { hook_event_name: 'Stop', last_assistant_message: 'done!' })).toMatchObject({ status: 'done', lastAssistantMessage: 'done!' })
    expect(reduceHook('done', { hook_event_name: 'SessionEnd' })?.status).toBe('ended')
  })
  it('turns permission/idle notifications into needs-you and ignores others', () => {
    expect(reduceHook('working', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' })).toMatchObject({ status: 'needs-you', statusDetail: 'Allow Bash?' })
    expect(reduceHook('working', { hook_event_name: 'Notification', notification_type: 'auth_success' })).toBeNull()
    expect(reduceHook('done', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.status).toBe('done')
    expect(reduceHook('idle', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })?.status).toBe('idle')
  })
  it('keeps a card idle or done through an idle compaction, and working through a mid-turn one', () => {
    // Claude Code compacts while idle ("Compacted while idle, before the prompt cache expired") with no Stop after it
    expect(reduceHook('done', { hook_event_name: 'PreCompact', trigger: 'auto' })).toBeNull()
    expect(reduceHook('done', { hook_event_name: 'PostCompact' })).toBeNull()
    expect(reduceHook('idle', { hook_event_name: 'PreCompact', trigger: 'manual' })).toBeNull()
    expect(reduceHook('working', { hook_event_name: 'PreCompact' })).toMatchObject({ status: 'working', statusDetail: 'compacting context' })
    expect(reduceHook('working', { hook_event_name: 'PostCompact' })).toMatchObject({ status: 'working', statusDetail: 'working' })
  })
  it('ignores unknown events', () => {
    expect(reduceHook('idle', { hook_event_name: 'SomethingNew' })).toBeNull()
  })
})

describe('detectClaudeReady', () => {
  it('recognises the TUI banner or footer even with ANSI codes', () => {
    expect(detectClaudeReady('\u001b[1mClaude Code v2.1.306\u001b[0m')).toBe(true)
    expect(detectClaudeReady('>  \u001b[2m? for shortcuts\u001b[0m')).toBe(true)
    expect(detectClaudeReady('PS C:\\Users\\me> ')).toBe(false)
  })
})
