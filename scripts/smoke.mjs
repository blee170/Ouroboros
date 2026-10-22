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
// fake Claude Code history for the Board Builder
const claudeCfg = mkdtempSync(join(tmpdir(), 'ouro-cfg-'))
const { writeFileSync } = await import('node:fs')
// no internet in CI: point new browser cards at the local hook server
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ browserHome: 'http://127.0.0.1:47821/health' }))
mkdirSync(join(claudeCfg, 'projects', 'enc'), { recursive: true })
writeFileSync(join(claudeCfg, 'projects', 'enc', 'sess-1.jsonl'), JSON.stringify({ type: 'user', sessionId: 'sess-1', cwd: join(project, 'sub'), message: { content: 'smoke session title' } }) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const t0 = Date.now()
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`); if (!cond) failures++ }

// SMOKE_EXE=release/linux-unpacked/ouroboros tests the packaged build instead of out/.
const app = await electron.launch({
  ...(process.env.SMOKE_EXE ? { executablePath: process.env.SMOKE_EXE } : {}),
  args: [...(process.env.SMOKE_EXE ? [] : ['out/main/index.js']), '--no-sandbox', `--user-data-dir=${userData}`],
  env: { ...process.env, CLAUDE_CONFIG_DIR: claudeCfg, OUROBOROS_API_TOKEN: TOKEN, OUROBOROS_PROJECT: project, OUROBOROS_SHELL: '/bin/bash', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
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
const appPath = await app.evaluate(({ app: a }) => a.getAppPath())
// dev: app path is out/main (we launched out/main/index.js); packaged: <app.asar>
const mcpPath = (appPath.endsWith(join('out', 'main')) ? join(appPath, 'mcp-server.js') : join(appPath, 'out/main/mcp-server.js')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
check((await import('node:fs')).existsSync(mcpPath), `mcp server script resolvable at runtime (${mcpPath})`)

// Two terminal nodes
await page.click('text=+ Terminal')
await page.click('text=+ Terminal')
await page.waitForSelector('.agent-node', { timeout: 10000 })
await sleep(1500)
const hostStyle = await page.getAttribute('.agent-node .terminal-host', 'style')
check(/scale\(/.test(hostStyle ?? ''), `terminal host is counter-scaled against the canvas zoom (${hostStyle})`)
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

// history + folders api, then Board Builder end to end
const hist = await page.evaluate((root) => window.ouroboros.history.list(root), project)
check(hist.length === 1 && hist[0].sessions[0].title === 'smoke session title', 'history.list reads fake Claude Code transcripts')
const fl = await page.evaluate((root) => window.ouroboros.folders.list(root), project)
check(fl.some((f) => f.name === 'sub'), 'folders.list lists subfolders')
const before = await page.evaluate(() => window.__board.getState().nodes.length)
await page.click('text=Build board')
await page.waitForSelector('.builder-grid')
await page.fill('.modal.wide input.text >> nth=0', project) // root = project so "sub" shows up
await sleep(800)
await page.check('.folder-item:has-text("sub") input[type=checkbox]') // extra card for the sub folder
await page.click('text=Create board')
await sleep(1500)
const after = await page.evaluate(() => window.__board.getState().nodes.map((n) => n.data.kind))
check(after.length === before + 8, `Build board added note+conductor+4 roles+browser+1 extra (${after.length - before})`)
const edgeCount = await page.evaluate(() => window.__board.getState().edges.length)
check(edgeCount === 4, `Build board wired 3 role lines on top of the existing one (${edgeCount - 1})`)
check((await api('GET', '/api/handoffs')).json.handoffs.length === edgeCount, 'generated lines synced to main')

// handoff lines through the api (what connect_agents calls)
const hc = await api('POST', '/api/handoffs', { source: b, target: a, mode: 'auto', template: 'LOOP {{last_assistant_message}}', condition: 'ship' })
check(typeof hc.json.id === 'string', 'connect_agents creates a line')
await sleep(400)
check((await page.evaluate(() => window.__board.getState().edges.length)) === edgeCount + 1, 'created line appears on the canvas')
await fetch(`${base}/hook/${b}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'ready to ship RETURN_PAYLOAD_9' }) })
out = ''
for (let i = 0; i < 30 && !out.includes('LOOP ready to ship RETURN_PAYLOAD_9'); i++) { await sleep(300); out = (await api('GET', `/api/agents/${a}/output?lines=80`)).json.output ?? '' }
check(out.includes('LOOP ready to ship RETURN_PAYLOAD_9'), 'api-created line fires on a matching Stop')
check((await api('DELETE', `/api/handoffs/${hc.json.id}`)).status === 200, 'remove_handoff deletes the line')
await sleep(300)
check((await page.evaluate(() => window.__board.getState().edges.length)) === edgeCount, 'deleted line disappears from the canvas')

// browser card: create via api, navigate to the hook server, read, type+click on a data: page
const bcreated = await api('POST', '/api/browsers', { url: `${base}/health`, title: 'smoke browser' })
check(typeof bcreated.json.id === 'string', 'browser card created through the api')
const bid = bcreated.json.id
let page1 = null
for (let i = 0; i < 20 && !page1?.json?.text?.includes('"ok":true'); i++) { await sleep(300); page1 = await api('GET', `/api/browsers/${bid}/read`) }
check(Boolean(page1?.json?.text?.includes('"ok":true')), `browser_read returns page text (${(page1?.json?.text ?? '').slice(0, 40)})`)
const form = 'data:text/html,' + encodeURIComponent('<input id="q"><button id="b" onclick="document.title=\'clicked:\'+document.getElementById(\'q\').value">go</button>')
await api('POST', `/api/browsers/${bid}/navigate`, { url: form })
await sleep(500)
await api('POST', `/api/browsers/${bid}/type`, { selector: '#q', text: 'hello' })
const clicked = await api('POST', `/api/browsers/${bid}/click`, { text: 'go' })
await sleep(300)
const page2 = await api('GET', `/api/browsers/${bid}/read`)
check(clicked.json.ok === true && page2.json.title === 'clicked:hello', `browser_type + browser_click work (${page2.json.title})`)
const shot = await api('POST', `/api/browsers/${bid}/screenshot`, {})
const shotOk = typeof shot.json.path === 'string' && (await import('node:fs')).existsSync(shot.json.path)
check(shotOk || /timed out/.test(String(shot.json.error)), `browser_screenshot writes a png or times out cleanly without a compositor (${shotOk ? 'png' : shot.json.error})`)
check((await api('GET', '/api/browsers')).json.browsers.some((b) => b.id === bid && b.ready), 'browser_list shows the card as ready')

await app.close()
rmSync(claudeCfg, { recursive: true, force: true })
rmSync(project, { recursive: true, force: true })
rmSync(userData, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall smoke checks passed')
process.exit(failures ? 1 : 0)
