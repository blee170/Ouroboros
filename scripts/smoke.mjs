// End-to-end smoke test: launches the built app under Electron (use xvfb-run on Linux),
// opens a temp project, creates terminal nodes, checks PTY output, hook-driven status and handoff.
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOKEN = 'smoke-token'
const project = mkdtempSync(join(tmpdir(), 'ouro-smoke-'))
const userData = mkdtempSync(join(tmpdir(), 'ouro-userdata-'))
mkdirSync(join(project, 'sub'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++ }

const app = await electron.launch({
  args: ['out/main/index.js', '--no-sandbox', `--user-data-dir=${userData}`],
  env: { ...process.env, OUROBOROS_API_TOKEN: TOKEN, OUROBOROS_PROJECT: project, OUROBOROS_SHELL: '/bin/bash', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})
app.process().stderr.on('data', (d) => process.stderr.write(`[electron] ${d}`))
const page = await app.firstWindow()
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++ })
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()) })
await page.waitForSelector('.react-flow', { timeout: 20000 })
check(true, 'app window shows the canvas for the initial project')

const info = await page.evaluate(() => window.ouroboros.app.info())
const base = `http://127.0.0.1:${info.hookPort}`
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-ouroboros-token': TOKEN }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
check((await api('GET', '/api/agents')).status === 200, 'api authenticates with token')
check((await fetch(base + '/api/agents')).status === 401, 'api rejects missing token')

// Two terminal nodes
await page.click('text=+ Terminal')
await page.click('text=+ Terminal')
await page.waitForSelector('.agent-node', { timeout: 10000 })
await sleep(1500)
const ids = await page.evaluate(() => window.__board.getState().nodes.map((n) => n.id))
check(ids.length === 2, `two terminal nodes created (${ids.length})`)
const [a, b] = ids

// PTY round trip
await page.evaluate((id) => window.ouroboros.pty.write(id, 'echo SMOKE_OK_$((40+2))\r'), a)
let out = ''
for (let i = 0; i < 30 && !out.includes('SMOKE_OK_42'); i++) { await sleep(300); out = (await api('GET', `/api/agents/${a}/output?lines=50`)).json.output ?? '' }
check(out.includes('SMOKE_OK_42'), 'pty executes a command and output is readable through the api')
const alive = (await api('GET', '/api/agents')).json.agents.find((x) => x.id === a)
check(alive?.ptyAlive === true && alive.status === 'idle', `agent snapshot reports alive+idle (${alive?.status})`)

// Hook-driven status
await fetch(`${base}/hook/${a}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sess-a' }) })
await sleep(400)
let txt = await page.textContent(`.react-flow__node[data-id="${a}"] .status-text`)
check(txt.includes('Working') && txt.includes('Bash'), `PreToolUse hook -> Working (${txt})`)
await fetch(`${base}/hook/${a}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow rm?' }) })
await sleep(400)
txt = await page.textContent(`.react-flow__node[data-id="${a}"] .status-text`)
check(txt.includes('Needs you'), `Notification hook -> Needs you (${txt})`)

// Handoff edge A -> B, fired by Stop
await page.evaluate(([s, t]) => window.__board.getState().onConnect({ source: s, target: t, sourceHandle: null, targetHandle: null }), [a, b])
await sleep(500)
check((await api('GET', '/api/handoffs')).json.handoffs.length === 1, 'handoff edge synced to main')
await fetch(`${base}/hook/${a}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'HANDOFF_PAYLOAD_777 done' }) })
out = ''
for (let i = 0; i < 30 && !out.includes('HANDOFF_PAYLOAD_777'); i++) { await sleep(300); out = (await api('GET', `/api/agents/${b}/output?lines=80`)).json.output ?? '' }
check(out.includes('HANDOFF_PAYLOAD_777'), 'Stop on A pasted the rendered template into B')
txt = await page.textContent(`.react-flow__node[data-id="${a}"] .status-text`)
check(txt.includes('Done'), `Stop hook -> Done (${txt})`)

// create_agent through the api (what the MCP server calls)
const created = await api('POST', '/api/agents', { cwd: join(project, 'sub'), title: 'viaApi', kind: 'terminal' })
await sleep(1500)
const n = await page.evaluate((id) => window.__board.getState().nodes.find((x) => x.id === id)?.data.title, created.json.id)
check(n === 'viaApi', 'api create_agent adds a node on the canvas')

// external session hook -> external card
await fetch(`${base}/hook/external`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'ext-1', cwd: project }) })
await sleep(500)
check((await page.$$('.external-node')).length === 1, 'external session appears as a card')

// persistence
await page.evaluate(() => window.__board.getState().persist())
await sleep(500)
const { existsSync, readFileSync } = await import('node:fs')
const wsFile = join(project, '.ouroboros.json')
check(existsSync(wsFile), 'workspace file written')
const ws = JSON.parse(readFileSync(wsFile, 'utf8'))
check(ws.nodes.length === 3 && ws.edges.length === 1 && !ws.nodes.some((x) => x.data.kind === 'external'), `workspace persisted 3 nodes / 1 edge, externals excluded (${ws.nodes.length}/${ws.edges.length})`)

await app.close()
rmSync(project, { recursive: true, force: true })
rmSync(userData, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall smoke checks passed')
process.exit(failures ? 1 : 0)
