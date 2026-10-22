/**
 * Stdio MCP server launched by the Conductor's `claude --mcp-config`. Runs under
 * `ELECTRON_RUN_AS_NODE=1 <electron> mcp-server.js` and talks to the main process' local JSON API.
 * Never write to stdout here (it is the MCP transport).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG = join(tmpdir(), 'ouroboros-mcp.log')
function log(line: string): void {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => {
  log(`uncaught: ${String(e?.stack ?? e)}`)
  process.exit(1)
})

const BASE = process.env.OUROBOROS_URL ?? 'http://127.0.0.1:47821'
const TOKEN = process.env.OUROBOROS_TOKEN ?? ''
const SELF = process.env.OUROBOROS_SELF_ID ?? ''

async function api(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
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

// ---- handoff lines ---------------------------------------------------------
server.registerTool(
  'list_handoffs',
  { title: 'List handoff lines', description: 'Lines between agent cards: id, source/target (ids and titles), mode (auto|manual), condition, template, lastFiredAt.', inputSchema: {} },
  async () => text(await api('GET', '/api/handoffs'))
)
server.registerTool(
  'connect_agents',
  {
    title: 'Draw a handoff line',
    description:
      'Create a line from one agent card to another. mode auto: whenever the source finishes a reply, the template is rendered and typed into the target ({{last_assistant_message}}, {{source_title}}, {{source_cwd}}, {{target_title}}); mode manual: only when fired. condition (optional) is a substring or /regex/ the source reply must match. Lines are visible on the canvas and the user can edit them.',
    inputSchema: {
      source_id: z.string(),
      target_id: z.string(),
      mode: z.enum(['auto', 'manual']).optional(),
      template: z.string().optional(),
      condition: z.string().optional()
    }
  },
  async ({ source_id, target_id, mode, template, condition }) => text(await api('POST', '/api/handoffs', { source: source_id, target: target_id, mode, template, condition }))
)
server.registerTool(
  'remove_handoff',
  { title: 'Remove a handoff line', description: 'Delete a line by id.', inputSchema: { handoff_id: z.string() } },
  async ({ handoff_id }) => text(await api('DELETE', `/api/handoffs/${encodeURIComponent(handoff_id)}`))
)
server.registerTool(
  'fire_handoff',
  { title: 'Fire a handoff line now', description: 'Send the line\'s rendered template to its target immediately, using the source\'s last reply.', inputSchema: { handoff_id: z.string() } },
  async ({ handoff_id }) => text(await api('POST', `/api/handoffs/${encodeURIComponent(handoff_id)}/fire`, {}))
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
  log(`start node=${process.version} exec=${process.execPath} base=${BASE} self=${SELF}`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('connected')
}

main().catch((err) => {
  log(`failed: ${String(err?.stack ?? err)}`)
  process.stderr.write(`ouroboros mcp server failed: ${String(err)}\n`)
  process.exit(1)
})
