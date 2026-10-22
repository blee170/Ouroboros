import { describe, expect, it } from 'vitest'
import { Board } from '../src/main/board'
import type { ExternalSessionPayload } from '@shared/protocol'

describe('Board external-session dedupe', () => {
  it('removes a stray external card once the session is claimed by a card', () => {
    const b = new Board()
    b.sync({ projectRoot: '/p', nodes: [{ id: 'n1', data: { kind: 'claude', title: 'A', cwd: '/p' } }], edges: [] })
    const events: ExternalSessionPayload[] = []
    b.on('external', (p: ExternalSessionPayload) => events.push(p))
    // global hook arrives first
    b.applyExternalHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/p' })
    expect(b.externalSessions.has('s1')).toBe(true)
    expect(events[0].status).toBe('working')
    // then the node-addressed hook with the same session id
    b.applyHook('n1', { hook_event_name: 'UserPromptSubmit', session_id: 's1' })
    expect(b.externalSessions.has('s1')).toBe(false)
    expect(events[1]).toMatchObject({ sessionId: 's1', status: 'ended' })
    expect(b.nodeForSession('s1')).toBe('n1')
    // later global events for s1 are ignored
    b.applyExternalHook({ hook_event_name: 'Stop', session_id: 's1', cwd: '/p' })
    expect(events).toHaveLength(2)
  })
  it('dropExternal ends the card once with the given reason', () => {
    const b = new Board()
    b.sync({ projectRoot: '/p', nodes: [], edges: [] })
    const events: ExternalSessionPayload[] = []
    b.on('external', (p: ExternalSessionPayload) => events.push(p))
    b.applyExternalHook({ hook_event_name: 'UserPromptSubmit', session_id: 's3', cwd: '/elsewhere' })
    b.dropExternal('s3', 'moved to its project window')
    b.dropExternal('s3', 'moved to its project window')
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ sessionId: 's3', cwd: '/elsewhere', status: 'ended', statusDetail: 'moved to its project window' })
    expect(b.externalSessions.has('s3')).toBe(false)
  })
  it('maps session ids from hooks that do not change status', () => {
    const b = new Board()
    b.sync({ projectRoot: '/p', nodes: [{ id: 'n1', data: { kind: 'claude', title: 'A', cwd: '/p' } }], edges: [] })
    b.applyHook('n1', { hook_event_name: 'Notification', notification_type: 'auth_success', session_id: 's2' })
    expect(b.nodeForSession('s2')).toBe('n1')
  })
})

describe('role turns', () => {
  it('the Stop that answers a typed role prompt ends idle and fires no stop event', () => {
    const b = new Board()
    b.sync({ projectRoot: '/p', nodes: [{ id: 'a', data: { kind: 'claude', title: 'A', cwd: '/p' } }], edges: [] })
    const stops: string[] = []
    b.on('stop', (id: string) => stops.push(id))
    b.markRoleTurn('a')
    b.applyHook('a', { hook_event_name: 'Stop', last_assistant_message: 'ready' })
    expect(b.nodes.get('a')?.data.status).toBe('idle')
    expect(stops).toEqual([])
    b.applyHook('a', { hook_event_name: 'Stop', last_assistant_message: 'RESULT: done' })
    expect(b.nodes.get('a')?.data.status).toBe('done')
    expect(stops).toEqual(['a'])
  })
})
