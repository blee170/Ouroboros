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
const bmFile = join(claudeCfg, 'Bookmarks')
writeFileSync(bmFile, JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'bar', children: [{ type: 'url', name: 'Smoke Site', url: 'https://example.com/smoke' }] } } }))
// no internet in CI: point new browser cards at the local hook server
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ browserHome: 'http://127.0.0.1:47821/health', tourSeen: true }))
mkdirSync(join(claudeCfg, 'projects', 'enc'), { recursive: true })
writeFileSync(join(claudeCfg, 'projects', 'enc', 'sess-1.jsonl'), JSON.stringify({ type: 'user', sessionId: 'sess-1', cwd: join(project, 'sub'), message: { content: 'smoke session title' } }) + '\n')
const { execFileSync } = await import('node:child_process')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const t0 = Date.now()
// 0.7 shell: Terminal lives in the New card menu (the button itself adds the default agent)
const addTerminal = async (p) => { await p.click('.new-card-more'); await p.click('.menu >> text=Terminal') }
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`); if (!cond) failures++ }

// SMOKE_EXE=release/linux-unpacked/ouroboros tests the packaged build instead of out/.
const app = await electron.launch({
  ...(process.env.SMOKE_EXE ? { executablePath: process.env.SMOKE_EXE } : {}),
  args: [...(process.env.SMOKE_EXE ? [] : ['out/main/index.js']), '--no-sandbox', `--user-data-dir=${userData}`],
  env: { ...process.env, CHROME_BOOKMARKS_FILE: bmFile, CLAUDE_CONFIG_DIR: claudeCfg, OUROBOROS_API_TOKEN: TOKEN, OUROBOROS_PROJECT: project, OUROBOROS_SHELL: '/bin/bash', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
})
app.process().stderr.on('data', (d) => process.stderr.write(`[electron] ${d}`))
const page = await app.firstWindow()
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++ })
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()) })
await page.waitForSelector('.react-flow', { timeout: 20000 })
check(true, 'app window shows the canvas for the initial project')

const info = await page.evaluate(() => window.ouroboros.app.info())
const base = `http://127.0.0.1:${info.hookPort}`
const api = async (method, path, body, self) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-ouroboros-token': TOKEN, ...(self ? { 'x-ouroboros-self': self } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
check((await api('GET', '/api/agents')).status === 200, 'api authenticates with token')
check((await fetch(base + '/api/agents')).status === 401, 'api rejects missing token')
const appPath = await app.evaluate(({ app: a }) => a.getAppPath())
// dev: app path is out/main (we launched out/main/index.js); packaged: <app.asar>
const mcpPath = (appPath.endsWith(join('out', 'main')) ? join(appPath, 'mcp-server.js') : join(appPath, 'out/main/mcp-server.js')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
check((await import('node:fs')).existsSync(mcpPath), `mcp server script resolvable at runtime (${mcpPath})`)

// Two terminal nodes
await addTerminal(page)
await addTerminal(page)
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
await page.click('[aria-label="Build board"]')
await page.waitForSelector('.builder-grid')
await page.fill('.modal.wide input.text >> nth=0', project) // root = project so "sub" shows up
await sleep(800)
await page.check('.folder-item:has-text("sub") input[type=checkbox]') // extra card for the sub folder
await page.click('text=Create board')
await sleep(1500)
const after = await page.evaluate(() => window.__board.getState().nodes.map((n) => n.data.kind))
check(after.length === before + 8, `Build board added note+conductor+4 roles+browser+1 extra (${after.length - before})`)
const edgeCount = await page.evaluate(() => window.__board.getState().edges.length)
check(edgeCount === 9, `Build board wired 3 flow lines + 5 report lines on top of the existing one (${edgeCount - 1})`)
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

// create_agent with report_to draws a line back and the report arrives
const rep = await api('POST', '/api/agents', { cwd: project, title: 'worker', kind: 'terminal', report_to: a })
await sleep(800)
check((await api('GET', '/api/handoffs')).json.handoffs.some((h) => h.source === rep.json.id && h.target === a), 'create_agent(report_to) draws a report line')
await fetch(`${base}/hook/${rep.json.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'REPORT_PAYLOAD_5' }) })
out = ''
for (let i = 0; i < 30 && !out.includes('[worker finished]'); i++) { await sleep(300); out = (await api('GET', `/api/agents/${a}/output?lines=80`)).json.output ?? '' }
check(out.includes('[worker finished]') && out.includes('REPORT_PAYLOAD_5'), 'finished worker reports into the conductor card')

// command card: template runs per prompt, output becomes the reply, lines fire
const cc = await api('POST', '/api/agents', { cwd: project, title: 'cmd', kind: 'command', command_template: 'echo RUN:{{prompt}}; cat {{prompt_file}} | wc -l', report_to: a })
await sleep(1200)
check((await api('POST', `/api/agents/${cc.json.id}/prompt`, { text: 'hello world\nline2' })).status === 200, 'command card accepts a prompt')
let cs = null
for (let i = 0; i < 30 && cs?.status !== 'done'; i++) { await sleep(300); cs = (await api('GET', '/api/agents')).json.agents.find((x) => x.id === cc.json.id) }
check(cs?.status === 'done' && /RUN:hello world line2/.test(cs.lastAssistantMessage ?? '') && /\b1\b/.test(cs.lastAssistantMessage ?? ''), `command card finished with its output as the reply (${JSON.stringify(cs?.lastAssistantMessage)})`)
out = ''
for (let i = 0; i < 20 && !out.includes('[cmd finished]'); i++) { await sleep(300); out = (await api('GET', `/api/agents/${a}/output?lines=80`)).json.output ?? '' }
check(out.includes('[cmd finished]'), 'command card reported back through its line')

// wait_for_agents + remove_agent
const w1 = await api('GET', `/api/agents-wait?ids=${a}&status=done&timeout=2`)
check(w1.json.timedOut === false && w1.json.ready.some((r) => r.id === a), 'wait_for_agents returns immediately for an already-done agent')
await fetch(`${base}/hook/${b}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }) })
await sleep(300)
const waitP = api('GET', `/api/agents-wait?ids=${b}&status=done&timeout=10`)
await sleep(500)
await fetch(`${base}/hook/${b}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'b finished' }) })
const w2 = await waitP
check(w2.json.timedOut === false && w2.json.ready[0]?.lastAssistantMessage === 'b finished', 'wait_for_agents wakes up on a Stop hook')
const rc = await api('POST', '/api/agents', { cwd: project, title: 'temp', kind: 'terminal' })
await sleep(800)
const nBefore = await page.evaluate(() => window.__board.getState().nodes.length)
check((await api('DELETE', `/api/agents/${rc.json.id}`)).status === 200, 'remove_agent accepts a known id')
await sleep(500)
check((await page.evaluate(() => window.__board.getState().nodes.length)) === nBefore - 1, 'removed agent disappears from the canvas')

// bookmarks
const bm = await api('GET', '/api/bookmarks?q=smoke')
check(bm.json.bookmarks?.[0]?.url === 'https://example.com/smoke', 'bookmarks api reads the Chrome bookmarks file')

// tidy: the removed terminal is gone; an exited card shows up as a candidate and is closed by POST
const tc = await api('POST', '/api/agents', { cwd: project, title: 'tidy-me', kind: 'terminal' })
await sleep(1000)
await page.evaluate((id) => window.ouroboros.pty.write(id, 'exit\r'), tc.json.id)
await sleep(800)
const dry = await api('GET', '/api/tidy?minutes=30')
check(dry.json.candidates.some((c) => c.id === tc.json.id), `tidy dry-run lists the exited card (${dry.json.candidates.map((c) => c.title).join(',')})`)
const wet = await api('POST', '/api/tidy?minutes=30', {})
await sleep(500)
check(wet.json.removed >= 1 && !(await page.evaluate((id) => window.__board.getState().nodes.some((n) => n.id === id), tc.json.id)), 'tidy closes the exited card')

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

// --- Codex / Gemini hook bridge: the bundled script turns their notifications into card status ---
const hookScript = mcpPath.replace(/mcp-server\.js$/, 'agent-hook.js')
check((await import('node:fs')).existsSync(hookScript), `agent-hook.js resolvable at runtime (${hookScript})`)
execFileSync(process.execPath, [hookScript, 'codex', '--url', base, '--node', a, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'codex-thr', 'last-assistant-message': 'CODEX_DONE_1' })])
await sleep(400)
txt = await page.textContent(`.react-flow__node[data-id="${a}"] .status-text`)
check(txt.includes('Done') && (await api('GET', '/api/agents')).json.agents.find((x) => x.id === a)?.lastAssistantMessage === 'CODEX_DONE_1', `codex notify → Done with the reply (${txt})`)
execFileSync(process.execPath, [hookScript, 'gemini'], { input: JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'write_file', session_id: 'g-1', cwd: project }), env: { ...process.env, OUROBOROS_URL: base, OUROBOROS_NODE_ID: a } })
await sleep(400)
txt = await page.textContent(`.react-flow__node[data-id="${a}"] .status-text`)
check(txt.includes('Working') && txt.includes('write_file'), `gemini BeforeTool hook → Working (${txt})`)
// a Codex card's launch line carries the notify override and the board MCP server
const codexNode = await page.evaluate(() => window.__board.getState().addNode('claude', { engine: 'codex', title: 'codexcard', claude: { boardTools: true } }))
await sleep(2500)
const codexOut = (await api('GET', `/api/agents/${codexNode}/output?lines=40`)).json.output ?? ''
check(/codex .*-c .*notify=\[/.test(codexOut.replace(/\n/g, ' ')) && codexOut.includes('mcp_servers.ouroboros'), 'codex card launch line has notify + mcp overrides')
const geminiNode = await page.evaluate(() => window.__board.getState().addNode('claude', { engine: 'gemini', title: 'geminicard' }))
await sleep(2500)
const geminiOut = (await api('GET', `/api/agents/${geminiNode}/output?lines=40`)).json.output ?? ''
check(/gemini/.test(geminiOut) && (await import('node:fs')).existsSync(join(userData, 'claude-launch', `${geminiNode}.gemini.json`)), 'gemini card writes its per-card settings file and launches gemini')
await api('DELETE', `/api/agents/${codexNode}`)
await api('DELETE', `/api/agents/${geminiNode}`)
await sleep(500)

// --- changes api (git diff of a card's folder) + set_board_tools (PATCH) ---
execFileSync('git', ['init', '-q', project])
writeFileSync(join(project, 'hello.txt'), 'hi\n')
const chg = await api('GET', `/api/agents/${a}/changes?diff=1`)
check(chg.status === 200 && chg.json.repo === true && chg.json.files.some((f) => f.path === 'hello.txt' && f.status === '?') && String(chg.json.diff).includes('+hi'), `changes api lists untracked hello.txt with its diff (${chg.json.files?.length} files)`)
const patched = await api('PATCH', `/api/agents/${a}`, { board_tools: true, restart: false })
await sleep(400)
const bt = await page.evaluate((id) => window.__board.getState().nodes.find((n) => n.id === id)?.data.claude?.boardTools, a)
check(patched.status === 404 && bt !== true, `PATCH board_tools on a terminal card is refused (claude cards only) (${patched.status})`)

// --- engines setup: detection runs and reports all three CLIs; default engine flows into new cards ---
const engines = await page.evaluate(() => window.ouroboros.engines.detect())
check(Array.isArray(engines) && engines.map((e) => e.engine).join(',') === 'claude,codex,gemini' && engines.every((e) => typeof e.installed === 'boolean' && e.installCommand), `engines.detect lists claude/codex/gemini (${engines.map((e) => `${e.engine}:${e.installed}`).join(' ')})`)
await page.evaluate(() => window.__board.getState().setSettings({ defaultEngine: 'gemini' }))
const defId = await page.evaluate(() => window.__board.getState().addNode('claude', { title: 'defaultEngineCard' }))
const defEngine = await page.evaluate((id) => window.__board.getState().nodes.find((n) => n.id === id)?.data.engine, defId)
check(defEngine === 'gemini', `new agent cards take the default engine (${defEngine})`)
await page.evaluate(() => window.__board.getState().setSettings({ defaultEngine: undefined }))
await api('DELETE', `/api/agents/${defId}`)
await sleep(300)

// --- card size presets + webview drag shield ---
const sizeBefore = await page.evaluate((id) => { const n = window.__board.getState().nodes.find((x) => x.id === id); return n.measured?.width ?? n.width }, bid)
await page.evaluate((id) => window.__board.getState().resizeNode(id, 960, 720), bid)
await sleep(500)
const sizeAfter = await page.evaluate((id) => window.__board.getState().nodes.find((x) => x.id === id).width, bid)
check(sizeBefore === 640 && sizeAfter === 960, `resizeNode applies a size preset (${sizeBefore} → ${sizeAfter})`)
await page.evaluate(() => document.body.classList.add('ouro-dragging'))
const shielded = await page.evaluate(() => getComputedStyle(document.querySelector('webview')).pointerEvents)
await page.evaluate(() => document.body.classList.remove('ouro-dragging'))
check(shielded === 'none', `webviews ignore the pointer while dragging (${shielded})`)

// --- a second window is a second project, fully separated from the first ---
const project2 = mkdtempSync(join(tmpdir(), 'ouro-smoke2-'))
await page.evaluate((p) => window.ouroboros.window.open(p), project2)
let win2page = null
for (let i = 0; i < 40 && !win2page; i++) { await sleep(250); win2page = app.windows().find((w) => w !== page && w.url() === page.url()) ?? null } // webviews are windows too
check(Boolean(win2page), 'window.open creates a second window')
await win2page.waitForSelector('.react-flow', { timeout: 20000 })
await sleep(500)
const title2 = await win2page.title()
check(title2.startsWith(project2.split('/').pop()), `second window is titled after its project (${title2})`)
await addTerminal(win2page)
await sleep(1500)
const ids2 = await win2page.evaluate(() => window.__board.getState().nodes.map((n) => n.id))
check(ids2.length === 1, `second window has its own board (${ids2.length} card)`)
const card2 = ids2[0]
const scoped2 = (await api('GET', '/api/agents', undefined, card2)).json.agents.map((x) => x.id)
const scoped1 = (await api('GET', '/api/agents', undefined, a)).json.agents.map((x) => x.id)
check(scoped2.length === 1 && scoped2[0] === card2 && !scoped1.includes(card2) && scoped1.includes(a), 'api calls are scoped to the window of the calling card')
const made2 = await api('POST', '/api/agents', { kind: 'terminal', title: 'win2' }, card2)
await sleep(1500)
const in2 = await win2page.evaluate((id) => window.__board.getState().nodes.some((n) => n.id === id), made2.json.id)
const in1 = await page.evaluate((id) => window.__board.getState().nodes.some((n) => n.id === id), made2.json.id)
check(in2 && !in1, 'create_agent from a window-2 card lands on window 2 only')
await fetch(`${base}/hook/${card2}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }) })
await sleep(400)
check((await win2page.textContent(`.react-flow__node[data-id="${card2}"] .status-text`)).includes('Working'), 'hooks reach the card in its own window')
await page.evaluate((p) => window.ouroboros.window.open(p), project2)
await sleep(800)
const realWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
check((await realWindows()) === 2, 'opening an already-open project focuses its window instead of duplicating it')
await app.evaluate(({ BrowserWindow }, t) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith(t))?.close(), project2.split('/').pop())
await sleep(1500)
check((await realWindows()) === 1, 'closing the second window leaves the first')
check((await api('GET', `/api/agents/${card2}/output`)).status === 404, 'cards of the closed window are gone')
check((await api('GET', '/api/agents', undefined, a)).json.agents.some((x) => x.id === a), 'first window keeps its cards')
rmSync(project2, { recursive: true, force: true })

await app.close()
rmSync(claudeCfg, { recursive: true, force: true })
rmSync(project, { recursive: true, force: true })
rmSync(userData, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall smoke checks passed')
process.exit(failures ? 1 : 0)
