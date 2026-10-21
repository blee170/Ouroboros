import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const script = resolve(__dirname, '../out/main/mcp-server.js')

describe('bundled mcp server', () => {
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
        else res.writeHead(404).end('{"error":"nf"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env: { ...process.env, OUROBOROS_URL: `http://127.0.0.1:${port}`, OUROBOROS_TOKEN: 'tok', OUROBOROS_SELF_ID: 'me' } as Record<string, string>
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['create_agent', 'list_agents', 'read_output', 'send_prompt', 'set_note'])

    const list = await client.callTool({ name: 'list_agents', arguments: {} })
    const listText = (list.content as Array<{ text: string }>)[0].text
    expect(JSON.parse(listText)).toEqual([{ id: 'me', title: 'Conductor', self: true }, { id: 'a1', title: 'A', self: false }])

    const out = await client.callTool({ name: 'read_output', arguments: { agent_id: 'a1', lines: 5 } })
    expect((out.content as Array<{ text: string }>)[0].text).toBe('hello\nworld')

    await client.callTool({ name: 'send_prompt', arguments: { agent_id: 'a1', text: 'go' } })
    expect(calls.find((c) => c.url === '/api/agents/a1/prompt')?.body).toBe('{"text":"go"}')

    const self = await client.callTool({ name: 'send_prompt', arguments: { agent_id: 'me', text: 'loop' } })
    expect(self.isError).toBe(true)

    const created = await client.callTool({ name: 'create_agent', arguments: { cwd: '/tmp', prompt: 'hi' } })
    expect((created.content as Array<{ text: string }>)[0].text).toContain('new1')

    await client.close()
    server.close()
  }, 20000)
})
