import { describe, expect, it } from 'vitest'
import { reduceHook } from '@shared/status'

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
  })
  it('ignores unknown events', () => {
    expect(reduceHook('idle', { hook_event_name: 'SomethingNew' })).toBeNull()
  })
})
