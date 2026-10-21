/**
 * Stdio MCP server launched by the Conductor's `claude --mcp-config`. Runs under
 * `ELECTRON_RUN_AS_NODE=1 <electron> mcp-server.js` and talks to the main process' local JSON API.
 * Never write to stdout here (it is the MCP transport).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.OUROBOROS_URL ?? 'http://127.0.0.1:47821'
const TOKEN = process.env.OUROBOROS_TOKEN ?? ''
const SELF = process.env.OUROBOROS_SELF_ID ?? ''

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-ouroboros-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
  return json
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

const server = new McpServer({ name: 'ouroboros', version: '0.1.0' })

server.registerTool(
  'list_agents',
  {
    title: 'List agents on the board',
    description:
      'Every agent card on the Ouroboros board with id, title, cwd, status (starting|idle|working|needs-you|done|ended), statusDetail and lastAssistantMessage. Your own id is marked self=true.',
    inputSchema: {}
  },
  async () => {
    const r = (await api('GET', '/api/agents')) as { agents: Array<Record<string, unknown>> }
    return text(r.agents.map((a) => ({ ...a, self: a.id === SELF })))
  }
)

server.registerTool(
  'read_output',
  {
    title: 'Read an agent terminal',
    description: 'Return the last N lines (default 80, max 2000) of an agent terminal, ANSI stripped.',
    inputSchema: { agent_id: z.string(), lines: z.number().int().min(1).max(2000).optional() }
  },
  async ({ agent_id, lines }) => {
    const r = (await api('GET', `/api/agents/${encodeURIComponent(agent_id)}/output?lines=${lines ?? 80}`)) as { output: string }
    return text(r.output)
  }
)

server.registerTool(
  'send_prompt',
  {
    title: 'Send a prompt to an agent',
    description: 'Type a prompt into the agent terminal and press Enter. Use for delegation; keep prompts self-contained.',
    inputSchema: { agent_id: z.string(), text: z.string().min(1) }
  },
  async ({ agent_id, text: prompt }) => {
    if (agent_id === SELF) throw new Error('refusing to prompt yourself')
    await api('POST', `/api/agents/${encodeURIComponent(agent_id)}/prompt`, { text: prompt })
    return text({ ok: true })
  }
)

server.registerTool(
  'create_agent',
  {
    title: 'Create a new Claude Code agent',
    description: 'Add a Claude Code agent card to the board in the given folder and optionally send it a first prompt.',
    inputSchema: { cwd: z.string().optional(), title: z.string().optional(), prompt: z.string().optional() }
  },
  async (input) => {
    const r = (await api('POST', '/api/agents', { ...input, kind: 'claude' })) as { id: string }
    return text(r)
  }
)

server.registerTool(
  'set_note',
  {
    title: 'Write a note card',
    description: 'Replace the markdown body of a note card (agent_id of a note node).',
    inputSchema: { note_id: z.string(), note: z.string() }
  },
  async ({ note_id, note }) => {
    await api('POST', `/api/notes/${encodeURIComponent(note_id)}`, { note })
    return text({ ok: true })
  }
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`ouroboros mcp server failed: ${String(err)}\n`)
  process.exit(1)
})
