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

async function api(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    // the caller's card id scopes every call to the window (board) that owns it
    headers: { 'content-type': 'application/json', 'x-ouroboros-token': TOKEN, ...(SELF ? { 'x-ouroboros-self': SELF } : {}) },
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
  'list_roles',
  {
    title: 'List specialist roles for cards',
    description:
      "The roles a card can be given: the owner's and the project's .claude/agents files and the agency catalog (msitarzewski/agency-agents: engineering, design, marketing, testing, security, product, support, …), each with id, name, description, division and source, plus the catalog's runbooks (team rosters for a startup MVP, an enterprise feature, a marketing campaign, an incident). query narrows to roles whose name, id, description or division contain every word of it (one topic per call: 'frontend', then 'security'); without a query every role comes back, one line each, plus the runbooks. Pass an id as role to create_agent; the file's persona becomes that card's system prompt. An empty list with no catalog means the owner has not fetched it (Build board → Get the Agency roster).",
    inputSchema: { query: z.string().optional() }
  },
  async ({ query }) => {
    const r = (await api('GET', `/api/roles${query ? `?q=${encodeURIComponent(query)}` : ''}`)) as {
      roles: Array<{ id: string; name: string; description?: string; division: string; source: string }>
      runbooks: Array<{ slug: string; title: string; duration?: string; groups: Array<{ group: string; activation: string; agents: string[] }> }>
      catalog?: { version?: string }
    }
    const lines = r.roles.map((x) => `${x.id} — ${x.name} [${x.division}${x.source === 'agency' ? '' : `, ${x.source}`}]${x.description ? `: ${x.description.slice(0, 120)}` : ''}`)
    const head = `${r.roles.length} role${r.roles.length === 1 ? '' : 's'}${query ? ` for "${query}"` : ''}${r.catalog ? ` (Agency catalog ${r.catalog.version ?? 'fetched'})` : ' (no Agency catalog: the owner can fetch it in Build board)'}`
    const runbooks = query ? [] : r.runbooks.map((rb) => `runbook ${rb.slug} — ${rb.title}${rb.duration ? ` (${rb.duration})` : ''}: ${rb.groups.map((g) => `${g.group} [${g.activation}]: ${g.agents.join(', ')}`).join('; ')}`)
    return text([head, ...lines, ...(runbooks.length ? ['', ...runbooks] : [])].join('\n'))
  }
)

server.registerTool(
  'create_agent',
  {
    title: 'Create a new Claude Code agent card',
    description:
      'Add a card to the board. kind=claude (default) runs an interactive coding agent: engine=claude (Claude Code), codex (OpenAI Codex CLI) or gemini (Gemini CLI); omitted = the owner\'s default engine from Settings. All get the same hooks, lines and board tools. kind=command runs any CLI: command_template is a shell line with {{prompt}} (quoted single line) or {{prompt_file}} (temp file with the full text), e.g. Aside browser agent: `aside exec {{prompt}}`, Codex: `codex exec {{prompt}}`. The command output until it exits is the card\'s reply, so lines and reports work the same. By default a report line is drawn from the new card back to you, so its finished replies arrive in your input automatically (report_to_me=false to skip). role_prompt becomes its extra system prompt (define the role, the markers it must end replies with, what it must never do). role=<id from list_roles> gives the card a specialist persona (its agent file) as that prompt, with role_prompt appended after it; an unknown id fails with the reason. worktree=true gives it its own git worktree branch of cwd. board_tools=true gives the card this same MCP server (a team lead that creates and wires its own sub-cards); default false. prompt is typed in as soon as the session is ready. Returns the new id (use it for lines and send_prompt). A title that already exists in the same folder reuses that card when it is idle or done (the prompt goes to it; a changed role_prompt is given to it first; the result says reused=true) and replaces it when its process has ended (replaced=<old id>), so keep one stable title per role instead of inventing new names each round; a card that is still working is left alone and a second one is created. Cards you create are dispatched by you: they are retired automatically 5 minutes after their report reaches you (send them more work before then to keep them), you may have at most 6 live ones at once (maxWorkersPerLead in settings.json), and the chain goes no deeper than Conductor → team → worker — the call fails with the reason.',
    inputSchema: {
      cwd: z.string().optional(),
      title: z.string().optional(),
      prompt: z.string().optional(),
      role_prompt: z.string().optional(),
      role: z.string().optional(),
      permission_mode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']).optional(),
      model: z.string().optional(),
      worktree: z.boolean().optional(),
      continue: z.boolean().optional(),
      resume: z.string().optional(),
      report_to_me: z.boolean().optional(),
      kind: z.enum(['claude', 'command']).optional(),
      engine: z.enum(['claude', 'codex', 'gemini']).optional(),
      command_template: z.string().optional(),
      board_tools: z.boolean().optional()
    }
  },
  async ({ report_to_me, kind, ...input }) => text(await api('POST', '/api/agents', { ...input, kind: kind ?? 'claude', report_to: report_to_me === false ? undefined : SELF || undefined }))
)

server.registerTool(
  'remove_agent',
  { title: 'Close an agent card', description: 'Stop the card\'s process and remove it from the board (its worktree stays on disk).', inputSchema: { agent_id: z.string() } },
  async ({ agent_id }) => {
    if (agent_id === SELF) throw new Error('refusing to remove yourself')
    return text(await api('DELETE', `/api/agents/${encodeURIComponent(agent_id)}`))
  }
)

server.registerTool(
  'set_board_tools',
  {
    title: 'Give or take a card the board tools',
    description:
      'Enable (or disable) the ouroboros MCP server on an existing Claude card so it can create cards and lines itself (a team lead). Claude cards only. Applies on relaunch: restart=true (default) relaunches the card right away, resuming its current session so nothing is lost.',
    inputSchema: { agent_id: z.string(), enabled: z.boolean().optional(), restart: z.boolean().optional() }
  },
  async ({ agent_id, enabled, restart }) => {
    if (agent_id === SELF) throw new Error('refusing to change yourself')
    return text(await api('PATCH', `/api/agents/${encodeURIComponent(agent_id)}`, { board_tools: enabled ?? true, restart: restart ?? true }))
  }
)

server.registerTool(
  'get_changes',
  {
    title: 'Uncommitted changes of a card',
    description:
      'git status of the card\'s folder (its worktree if it has one): files with +added/-deleted counts and the branch. diff=true adds the unified diff (capped), file=<path> the diff of one file. Use it to review a worker\'s result before accepting it or asking for fixes.',
    inputSchema: { agent_id: z.string(), diff: z.boolean().optional(), file: z.string().optional() }
  },
  async ({ agent_id, diff, file }) => {
    const q = new URLSearchParams()
    if (diff) q.set('diff', '1')
    if (file) q.set('file', file)
    return text(await api('GET', `/api/agents/${encodeURIComponent(agent_id)}/changes?${q.toString()}`))
  }
)

server.registerTool(
  'create_checkpoint',
  {
    title: "Git snapshot of a card's folder",
    description:
      "Take a git snapshot of the card's folder (its worktree if it has one): every non-gitignored file, committed or not. Changes nothing on disk. Take one before a risky stage (Implement, Bug fix, anything that edits files) so the stage can be rolled back with restore_checkpoint. label: a short name for the stage.",
    inputSchema: { agent_id: z.string(), label: z.string().optional() }
  },
  async ({ agent_id, label }) => text(await api('POST', `/api/agents/${encodeURIComponent(agent_id)}/checkpoints`, { label }))
)

server.registerTool(
  'list_checkpoints',
  {
    title: "Git snapshots of a card's folder",
    description: "The snapshots taken in the card's folder, newest first. headMoved=true means commits were made since that snapshot: restoring it needs move_head.",
    inputSchema: { agent_id: z.string() }
  },
  async ({ agent_id }) => text(await api('GET', `/api/agents/${encodeURIComponent(agent_id)}/checkpoints`))
)

server.registerTool(
  'restore_checkpoint',
  {
    title: 'Restore a git snapshot',
    description:
      "Put the card's folder back exactly as it was in the snapshot (gitignored files and the board file are left alone). The current state is saved first as a \"before restore\" snapshot, so a restore can be undone. Refused while a card is working (or waiting for the owner) in that folder, and when HEAD moved since the snapshot unless move_head=true, which also moves the branch back to the commit of that time (for the whole repository: everything in it is unstaged, only this card's folder is restored) — destructive git: propose it and wait for APPROVED BY OWNER.",
    inputSchema: { agent_id: z.string(), checkpoint_id: z.string(), move_head: z.boolean().optional() }
  },
  async ({ agent_id, checkpoint_id, move_head }) =>
    text(await api('POST', `/api/agents/${encodeURIComponent(agent_id)}/checkpoints/${encodeURIComponent(checkpoint_id)}/restore`, { move_head: Boolean(move_head) }))
)

server.registerTool(
  'delete_checkpoint',
  {
    title: 'Delete a git snapshot',
    description: 'Forget a snapshot of the card\'s folder (its ref is removed; git keeps the objects until it prunes them).',
    inputSchema: { agent_id: z.string(), checkpoint_id: z.string() }
  },
  async ({ agent_id, checkpoint_id }) => text(await api('DELETE', `/api/agents/${encodeURIComponent(agent_id)}/checkpoints/${encodeURIComponent(checkpoint_id)}`))
)

server.registerTool(
  'wait_for_agents',
  {
    title: 'Wait until agents finish',
    description:
      'Block up to timeout_seconds (max 25) until at least one of the given agents reaches one of the statuses (default: done, needs-you, ended). Returns ready/pending lists with last messages. Call it in a loop instead of polling list_agents.',
    inputSchema: { agent_ids: z.array(z.string()).optional(), statuses: z.array(z.enum(['idle', 'working', 'needs-you', 'done', 'ended'])).optional(), timeout_seconds: z.number().int().min(1).max(25).optional() }
  },
  async ({ agent_ids, statuses, timeout_seconds }) => {
    const q = new URLSearchParams()
    if (agent_ids?.length) q.set('ids', agent_ids.join(','))
    if (statuses?.length) q.set('status', statuses.join(','))
    q.set('timeout', String(timeout_seconds ?? 20))
    return text(await api('GET', `/api/agents-wait?${q.toString()}`))
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

const TASK_STATE = z.enum(['todo', 'doing', 'blocked', 'done', 'dropped'])
const TASK_ID = z.string().max(8).describe('task id, e.g. T3')

server.registerTool(
  'task_create',
  {
    title: 'Add a task to the ledger',
    description:
      'The task ledger is the durable list of work on this board: one task per stage or work item, with dependencies. Create them at intake, before dispatching. Returns the new task (T1, T2, …). deps = tasks that must be done before this one can be claimed; parent groups sub-tasks; owner = agent_id to claim it at once.',
    inputSchema: {
      title: z.string().max(120),
      detail: z.string().max(2000).optional().describe('what to do, for the card that takes it'),
      parent: TASK_ID.optional(),
      deps: z.array(TASK_ID).max(50).optional(),
      owner: z.string().optional().describe('agent_id that starts on it now (claims it)')
    }
  },
  async ({ title, detail, parent, deps, owner }) => text(await api('POST', '/api/tasks', { title, detail, parent, deps, owner }))
)

server.registerTool(
  'task_claim',
  {
    title: 'Claim a task for a card',
    description:
      'Mark a task as being worked on by a card (agent_id; omitted = you). Do this when you dispatch the work. Refused while a dependency is not done or another live card owns it (task_update owner= reassigns). A card that ends with the task still doing hands it back to todo on its own.',
    inputSchema: { task_id: TASK_ID, agent_id: z.string().optional() }
  },
  async ({ task_id, agent_id }) => text(await api('POST', `/api/tasks/${encodeURIComponent(task_id)}/claim`, { agent_id }))
)

server.registerTool(
  'task_update',
  {
    title: 'Update a task',
    description:
      "Change a task's state or fields. done needs result (what was done, how it was checked: the worker's RESULT line, after get_changes for code). blocked needs reason; start it with \"APPROVAL NEEDED:\" when the owner must decide, so it is listed first for them. dropped = not needed. todo reopens it. owner reassigns it to a card.",
    inputSchema: {
      task_id: TASK_ID,
      state: TASK_STATE.optional(),
      result: z.string().max(2000).optional(),
      reason: z.string().max(300).optional(),
      title: z.string().max(120).optional(),
      detail: z.string().max(2000).optional(),
      deps: z.array(TASK_ID).max(50).optional(),
      parent: TASK_ID.nullable().optional(),
      owner: z.string().nullable().optional()
    }
  },
  async ({ task_id, ...patch }) => text(await api('PATCH', `/api/tasks/${encodeURIComponent(task_id)}`, patch))
)

server.registerTool(
  'task_list',
  {
    title: 'List the task ledger',
    description: 'Open tasks (todo, doing, blocked) with owner, deps, reason and result, one line each; all=true includes done and dropped. Filter by state, owner (agent_id) or parent.',
    inputSchema: { state: TASK_STATE.optional(), owner: z.string().optional(), parent: TASK_ID.optional(), all: z.boolean().optional() }
  },
  async ({ state, owner, parent, all }) => {
    const q = new URLSearchParams()
    if (state) q.set('state', state)
    if (owner) q.set('owner', owner)
    if (parent) q.set('parent', parent)
    if (all) q.set('all', '1')
    const r = (await api('GET', `/api/tasks${q.size ? `?${q}` : ''}`)) as { text?: string }
    return text(r.text ?? '')
  }
)

server.registerTool(
  'tidy_board',
  {
    title: 'Close finished cards you dispatched',
    description:
      'Close the cards you (or your teams) created whose job is over: process exited, report delivered to you and the turn is over, or done/idle longer than older_than_minutes (default 30) with no report line. Reported cards also retire on their own 5 minutes after their turn (retireMinutes in settings.json). Never touches conductors, pinned cards, cards that are working, waiting or starting, cards wired to one of those, or cards the owner made. dry_run=true only lists candidates.',
    inputSchema: { older_than_minutes: z.number().int().min(1).max(1440).optional(), dry_run: z.boolean().optional() }
  },
  async ({ older_than_minutes, dry_run }) => text(await api(dry_run ? 'GET' : 'POST', `/api/tidy?minutes=${older_than_minutes ?? 30}${dry_run ? '&dry_run=1' : ''}`, dry_run ? undefined : {}))
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
  { title: 'Open a browser card', description: 'Add a browser card to the canvas (optionally at a URL) and return its id. A card that already shows that URL is returned instead of a second copy.', inputSchema: { url: z.string().optional(), title: z.string().optional() } },
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
  'browser_bookmarks',
  { title: 'Owner bookmarks', description: 'Bookmarks from the owner\'s Chrome/Edge profiles (folder, title, url), optionally filtered by query. Use them to find the sites the owner already works with.', inputSchema: { query: z.string().optional() } },
  async ({ query }) => text(await api('GET', `/api/bookmarks${query ? `?q=${encodeURIComponent(query)}` : ''}`))
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
