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

// ---- browser cards -------------------------------------------------------
const BROWSER_NOTE = 'Browser cards are real Chromium views on the canvas; the user sees everything you do and can log in for you. Prefer browser_read over screenshots.'

server.registerTool(
  'browser_list',
  { title: 'List browser cards', description: `Browser cards on the board with id, title, url and ready flag. ${BROWSER_NOTE}`, inputSchema: {} },
  async () => text(await api('GET', '/api/browsers'))
)
server.registerTool(
  'browser_open',
  { title: 'Open a browser card', description: 'Add a new browser card to the canvas (optionally at a URL) and return its id.', inputSchema: { url: z.string().optional(), title: z.string().optional() } },
  async (input) => text(await api('POST', '/api/browsers', input))
)
server.registerTool(
  'browser_navigate',
  { title: 'Navigate a browser card', description: 'Load a URL in a browser card. Returns the final URL.', inputSchema: { browser_id: z.string(), url: z.string() } },
  async ({ browser_id, url }) => text(await api('POST', `/api/browsers/${encodeURIComponent(browser_id)}/navigate`, { url }))
)
server.registerTool(
  'browser_read',
  { title: 'Read a browser page', description: 'Current URL, title and visible text of the page (truncated to max_chars, default 20000).', inputSchema: { browser_id: z.string(), max_chars: z.number().int().min(500).max(200000).optional() } },
  async ({ browser_id, max_chars }) => text(await api('GET', `/api/browsers/${encodeURIComponent(browser_id)}/read?max=${max_chars ?? 20000}`))
)
server.registerTool(
  'browser_links',
  { title: 'List links on the page', description: 'Anchor texts and hrefs on the current page.', inputSchema: { browser_id: z.string(), limit: z.number().int().min(1).max(500).optional() } },
  async ({ browser_id, limit }) => text(await api('GET', `/api/browsers/${encodeURIComponent(browser_id)}/links?limit=${limit ?? 100}`))
)
server.registerTool(
  'browser_click',
  { title: 'Click something', description: 'Click an element by CSS selector or by its visible text (buttons, links, inputs).', inputSchema: { browser_id: z.string(), selector: z.string().optional(), text: z.string().optional() } },
  async ({ browser_id, selector, text: t }) => text(await api('POST', `/api/browsers/${encodeURIComponent(browser_id)}/click`, { selector, text: t }))
)
server.registerTool(
  'browser_type',
  { title: 'Type into a field', description: 'Set the value of an input/textarea (by selector, else the focused or first text field) and optionally press Enter.', inputSchema: { browser_id: z.string(), text: z.string(), selector: z.string().optional(), submit: z.boolean().optional() } },
  async ({ browser_id, text: t, selector, submit }) => text(await api('POST', `/api/browsers/${encodeURIComponent(browser_id)}/type`, { selector, text: t, submit }))
)
server.registerTool(
  'browser_screenshot',
  { title: 'Screenshot a browser card', description: 'Capture the page to a PNG file and return its path (open it with the Read tool).', inputSchema: { browser_id: z.string() } },
  async ({ browser_id }) => text(await api('POST', `/api/browsers/${encodeURIComponent(browser_id)}/screenshot`, {}))
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`ouroboros mcp server failed: ${String(err)}\n`)
  process.exit(1)
})
