import http from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapCodexNotify, mapGeminiHook } from '../src/main/agent-hook'

const script = resolve(__dirname, '../out/main/agent-hook.js')

describe('agent-hook mappings (pure)', () => {
  it('maps Codex agent-turn-complete to a Stop with the thread as session id', () => {
    expect(mapCodexNotify({ type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'x', 'input-messages': ['hi'], 'last-assistant-message': 'done', cwd: '/p' })).toEqual({ hook_event_name: 'Stop', session_id: 't1', last_assistant_message: 'done', cwd: '/p' })
    expect(mapCodexNotify({ type: 'something-else' })).toBeNull()
    expect(mapCodexNotify({ type: 'agent-turn-complete', 'last-assistant-message': null })?.last_assistant_message).toBe('')
  })
  it('maps Gemini hook inputs to Claude-style events', () => {
    const b = { session_id: 's', cwd: '/p' }
    expect(mapGeminiHook({ ...b, hook_event_name: 'SessionStart', source: 'startup' })).toMatchObject({ hook_event_name: 'SessionStart', session_id: 's' })
    expect(mapGeminiHook({ ...b, hook_event_name: 'BeforeAgent', prompt: 'go' })).toMatchObject({ hook_event_name: 'UserPromptSubmit' })
    expect(mapGeminiHook({ ...b, hook_event_name: 'BeforeTool', tool_name: 'write_file' })).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'write_file' })
    expect(mapGeminiHook({ ...b, hook_event_name: 'AfterAgent', prompt_response: 'RESULT: ok' })).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: 'RESULT: ok' })
    expect(mapGeminiHook({ ...b, hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'Allow?' })).toMatchObject({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow?' })
    expect(mapGeminiHook({ ...b, hook_event_name: 'SessionEnd', reason: 'exit' })).toMatchObject({ hook_event_name: 'SessionEnd' })
    expect(mapGeminiHook({ ...b, hook_event_name: 'PreCompress' })).toBeNull()
  })
})

describe('agent-hook.js (bundled)', () => {
  it.skipIf(!existsSync(script))('posts to /hook/<node> from Codex argv and Gemini stdin, prints {} on stdout', async () => {
    const received: Array<{ url: string; body: unknown }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: JSON.parse(body) })
        res.writeHead(200).end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const run = (args: string[], stdin?: string, env: Record<string, string> = {}): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env } }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
        if (stdin !== undefined) child.stdin?.end(stdin)
        else child.stdin?.end()
      })
    const out1 = await run(['codex', '--url', url, '--node', 'card1', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thr', 'last-assistant-message': 'finished' })])
    expect(out1).toBe('{}')
    const out2 = await run(['gemini'], JSON.stringify({ hook_event_name: 'AfterAgent', session_id: 'g1', prompt_response: 'ok', cwd: '/p' }), { OUROBOROS_URL: url, OUROBOROS_NODE_ID: 'card2' })
    expect(out2).toBe('{}')
    const out3 = await run(['gemini'], JSON.stringify({ hook_event_name: 'AfterAgent' })) // no env → no-op
    expect(out3).toBe('{}')
    server.close()
    expect(received).toEqual([
      { url: '/hook/card1', body: { hook_event_name: 'Stop', session_id: 'thr', last_assistant_message: 'finished' } },
      { url: '/hook/card2', body: { hook_event_name: 'Stop', session_id: 'g1', last_assistant_message: 'ok', cwd: '/p' } }
    ])
  }, 20000)
})
