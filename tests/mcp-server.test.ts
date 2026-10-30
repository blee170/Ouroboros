import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** The test runner's env without a Claude Code inbox: run inside a Claude session, the server would register that session's inbox. */
const childEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_MESSAGING_'))) as Record<string, string>

const script = resolve(__dirname, '../out/main/mcp-server.js')

describe('bundled mcp server', () => {
  it.skipIf(!existsSync(script))('is a single self-contained file (no relative requires, no node_modules)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(script, 'utf8')
    expect(src).not.toMatch(/require\("\.\//)
    expect(src).not.toMatch(/require\("@modelcontextprotocol/)
    expect(src).not.toMatch(/require\("zod"\)/)
  })

  it.skipIf(!existsSync(script))('exposes the conductor tools and proxies them to the json api', async () => {
    const calls: Array<{ method: string; url: string; body: string }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        calls.push({ method: req.method ?? '', url: req.url ?? '', body })
        if (req.headers['x-ourob' + 'oros-token'] !== 'tok') {
          res.writeHead(401).end('{"error":"unauthorized"}')
          return
        }
        res.setHeader('content-type', 'application/json')
        if (req.url === '/api/agents' && req.method === 'GET') res.end(JSON.stringify({ agents: [{ id: 'me', title: 'Conductor' }, { id: 'a1', title: 'A' }] }))
        else if (req.url?.startsWith('/api/agents/a1/output')) res.end(JSON.stringify({ output: 'hello\nworld' }))
        else if (req.url === '/api/agents/a1/prompt') res.end(JSON.stringify({ ok: true }))
        else if (req.url === '/api/agents' && req.method === 'POST') res.end(JSON.stringify({ id: 'new1' }))
        else if (req.url === '/api/agents/a1' && req.method === 'PATCH') res.end(JSON.stringify({ ok: true }))
        else if (req.url?.startsWith('/api/tidy')) res.end(JSON.stringify({ candidates: [{ id: 'a1', title: 'A', reason: 'reported, done for 6 min' }], removed: 0 }))
        else if (req.url?.startsWith('/api/agents/a1/changes')) res.end(JSON.stringify({ repo: true, files: [{ path: 'x.ts', status: 'M', added: 1, deleted: 0 }] }))
        else if (req.url === '/api/agents/a1/checkpoints' && req.method === 'POST') res.end(JSON.stringify({ ok: true, checkpoint: { id: '1700000000000-abcd', label: 'before implement' } }))
        else if (req.url === '/api/agents/a1/checkpoints' && req.method === 'GET') res.end(JSON.stringify({ ok: true, checkpoints: [] }))
        else if (req.url === '/api/agents/a1/checkpoints/1700000000000-abcd/restore' && req.method === 'POST') res.end(JSON.stringify({ ok: true }))
        else if (req.url === '/api/agents/a1/checkpoints/1700000000000-abcd' && req.method === 'DELETE') res.end(JSON.stringify({ ok: true, id: '1700000000000-abcd' }))
        else if (req.url === '/api/tasks' && req.method === 'POST') res.end(JSON.stringify({ ok: true, task: { id: 'T1', title: 'plan', state: 'todo' } }))
        else if (req.url === '/api/tasks/T1/claim' && req.method === 'POST') res.end(JSON.stringify({ ok: true, task: { id: 'T1', state: 'doing', owner: 'a1' } }))
        else if (req.url === '/api/tasks/T1' && req.method === 'PATCH') res.writeHead(400).end(JSON.stringify({ ok: false, error: 'done needs a result: what was done and how it was checked' }))
        else if (req.url?.startsWith('/api/tasks') && req.method === 'GET') res.end(JSON.stringify({ text: '1 tasks: 0 todo · 1 doing · 0 blocked · 0 done · 0 dropped\nT1 [doing] plan · owner: A', tasks: [] }))
        else res.writeHead(404).end('{"error":"nf"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env: { ...childEnv(), OUROBOROS_URL: `http://127.0.0.1:${port}`, OUROBOROS_TOKEN: 'tok', OUROBOROS_SELF_ID: 'me' } as Record<string, string>
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['ack', 'ask_owner', 'browser_bookmarks', 'browser_click', 'browser_links', 'browser_list', 'browser_navigate', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_type', 'check_inbox', 'connect_agents', 'create_agent', 'create_checkpoint', 'delete_checkpoint', 'fire_handoff', 'get_changes', 'handoff_to_grok_bot', 'list_agents', 'list_checkpoints', 'list_grok_bots', 'list_handoffs', 'list_roles', 'post_discord', 'read_output', 'remove_agent', 'remove_handoff', 'restore_checkpoint', 'send_message', 'send_prompt', 'set_board_tools', 'set_note', 'task_claim', 'task_create', 'task_list', 'task_update', 'tidy_board', 'wait_for_agents'])

    const list = await client.callTool({ name: 'list_agents', arguments: {} })
    const listText = (list.content as Array<{ text: string }>)[0].text
    expect(JSON.parse(listText)).toEqual([{ id: 'me', title: 'Conductor', self: true }, { id: 'a1', title: 'A', self: false }])

    const out = await client.callTool({ name: 'read_output', arguments: { agent_id: 'a1', lines: 5 } })
    expect((out.content as Array<{ text: string }>)[0].text).toBe('hello\nworld')

    await client.callTool({ name: 'send_prompt', arguments: { agent_id: 'a1', text: 'go' } })
    expect(calls.find((c) => c.url === '/api/agents/a1/prompt')?.body).toBe('{"text":"go"}')

    const self = await client.callTool({ name: 'send_prompt', arguments: { agent_id: 'me', text: 'loop' } })
    expect(self.isError).toBe(true)

    const created = await client.callTool({ name: 'create_agent', arguments: { cwd: '/tmp', prompt: 'hi', engine: 'codex' } })
    expect((created.content as Array<{ text: string }>)[0].text).toContain('new1')
    expect(JSON.parse(calls.find((c) => c.url === '/api/agents' && c.method === 'POST')?.body ?? '{}')).toMatchObject({ engine: 'codex', kind: 'claude', report_to: 'me' })

    const self2 = await client.callTool({ name: 'set_board_tools', arguments: { agent_id: 'me' } })
    expect(self2.isError).toBe(true)
    await client.callTool({ name: 'set_board_tools', arguments: { agent_id: 'a1' } })

    const tidy = await client.callTool({ name: 'tidy_board', arguments: { dry_run: true } })
    expect((tidy.content as Array<{ text: string }>)[0].text).toContain('reported, done for 6 min')
    expect(calls.find((c) => c.url.startsWith('/api/tidy'))).toMatchObject({ method: 'GET', url: '/api/tidy?minutes=30&dry_run=1' })
    expect(calls.find((c) => c.url === '/api/agents/a1' && c.method === 'PATCH')?.body).toBe('{"board_tools":true,"restart":true}')
    expect(calls.every((c) => c.method !== 'PATCH' || c.url === '/api/agents/a1')).toBe(true)
    const ch = await client.callTool({ name: 'get_changes', arguments: { agent_id: 'a1', diff: true } })
    expect((ch.content as Array<{ text: string }>)[0].text).toContain('x.ts')
    expect(calls.find((c) => c.url.startsWith('/api/agents/a1/changes'))?.url).toBe('/api/agents/a1/changes?diff=1')

    const cpc = await client.callTool({ name: 'create_checkpoint', arguments: { agent_id: 'a1', label: 'before implement' } })
    expect((cpc.content as Array<{ text: string }>)[0].text).toContain('1700000000000-abcd')
    expect(calls.find((c) => c.url === '/api/agents/a1/checkpoints' && c.method === 'POST')?.body).toBe('{"label":"before implement"}')
    await client.callTool({ name: 'list_checkpoints', arguments: { agent_id: 'a1' } })
    expect(calls.some((c) => c.url === '/api/agents/a1/checkpoints' && c.method === 'GET')).toBe(true)
    await client.callTool({ name: 'restore_checkpoint', arguments: { agent_id: 'a1', checkpoint_id: '1700000000000-abcd' } })
    expect(calls.find((c) => c.url === '/api/agents/a1/checkpoints/1700000000000-abcd/restore')?.body).toBe('{"move_head":false}')
    await client.callTool({ name: 'delete_checkpoint', arguments: { agent_id: 'a1', checkpoint_id: '1700000000000-abcd' } })
    expect(calls.some((c) => c.url === '/api/agents/a1/checkpoints/1700000000000-abcd' && c.method === 'DELETE')).toBe(true)

    // the task ledger
    const tc = await client.callTool({ name: 'task_create', arguments: { title: 'plan', deps: [], detail: 'write it' } })
    expect((tc.content as Array<{ text: string }>)[0].text).toContain('"id": "T1"')
    expect(calls.find((c) => c.url === '/api/tasks' && c.method === 'POST')?.body).toBe('{"title":"plan","detail":"write it","deps":[]}')
    await client.callTool({ name: 'task_claim', arguments: { task_id: 'T1', agent_id: 'a1' } })
    expect(calls.find((c) => c.url === '/api/tasks/T1/claim')?.body).toBe('{"agent_id":"a1"}')
    const tu = await client.callTool({ name: 'task_update', arguments: { task_id: 'T1', state: 'done' } })
    expect(tu.isError).toBe(true)
    expect((tu.content as Array<{ text: string }>)[0].text).toContain('done needs a result')
    expect(calls.find((c) => c.url === '/api/tasks/T1' && c.method === 'PATCH')?.body).toBe('{"state":"done"}')
    const tl = await client.callTool({ name: 'task_list', arguments: { owner: 'a1', all: true } })
    expect((tl.content as Array<{ text: string }>)[0].text).toBe('1 tasks: 0 todo · 1 doing · 0 blocked · 0 done · 0 dropped\nT1 [doing] plan · owner: A')
    expect(calls.find((c) => c.url.startsWith('/api/tasks?'))?.url).toBe('/api/tasks?owner=a1&all=1')

    await client.close()
    server.close()
  }, 20000)

  it.skipIf(!existsSync(script))('a mail-only server (no board tools) lists the mail tools and sends as the card', async () => {
    const calls: Array<{ method: string; url: string; body: string; self?: string }> = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        calls.push({ method: req.method ?? '', url: req.url ?? '', body, self: String(req.headers['x-ouroboros-self'] ?? '') })
        res.setHeader('content-type', 'application/json')
        if (req.url === '/api/mail' && req.method === 'POST') res.end(JSON.stringify({ ok: true, id: 'M4', to: 'chief' }))
        else if (req.url?.startsWith('/api/mail?') && req.method === 'GET') res.end(JSON.stringify({ count: 0, text: 'No messages.' }))
        else if (req.url === '/api/mail/ask') res.end(JSON.stringify({ ok: true, id: 'D1', answered: false, text: 'pending D1: wait' }))
        else if (req.url === '/api/mail/M4/ack') res.writeHead(404).end(JSON.stringify({ ok: false, error: 'no message M4 in your inbox' }))
        else res.writeHead(404).end('{"error":"nf"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env: { ...childEnv(), OUROBOROS_URL: `http://127.0.0.1:${port}`, OUROBOROS_TOKEN: 'mail-tok', OUROBOROS_SELF_ID: 'w1', OUROBOROS_TOOLS: 'mail' } as Record<string, string>
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual(['ack', 'ask_owner', 'check_inbox', 'send_message'])
    const s = await client.callTool({ name: 'send_message', arguments: { to: 'chief', body: 'done: tests pass', kind: 'worker_done' } })
    expect((s.content as Array<{ text: string }>)[0].text).toBe('Sent M4 to chief.')
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/mail', self: 'w1', body: '{"to":"chief","body":"done: tests pass","kind":"worker_done"}' })
    const inbox = await client.callTool({ name: 'check_inbox', arguments: {} })
    expect((inbox.content as Array<{ text: string }>)[0].text).toBe('No messages.')
    expect(calls[1].url).toBe('/api/mail?unread=1')
    const ack = await client.callTool({ name: 'ack', arguments: { id: 'M4' } })
    expect(ack.isError).toBe(true)
    const ask = await client.callTool({ name: 'ask_owner', arguments: { question: 'Ship it?', choices: ['Yes', 'Not yet'] } })
    expect((ask.content as Array<{ text: string }>)[0].text).toBe('pending D1: wait')
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/mail/ask', self: 'w1', body: '{"question":"Ship it?","choices":["Yes","Not yet"]}' })
    await client.close()
    server.close()
  }, 20000)
})
