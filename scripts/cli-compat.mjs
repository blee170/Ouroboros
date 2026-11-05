// CLI compatibility check: does each installed agent CLI still have what Ouroboros relies on?
//
//   npm run compat                    every installed CLI (claude, codex, gemini, grok); a missing one is skipped
//   npm run compat -- claude gemini   only these
//   npm run compat -- --live          also one tiny real Claude turn: hook payload keys against the contract
//
// The table is src/shared/cli-contract.ts. A flag is "ok" when `--help` lists it, "hidden" when only the installed
// files have it (works today, may go without notice), "MISSING" otherwise. Strings are searched in the installed
// files (the native binary, or the npm package). Exit 1 on any MISSING. Nothing is installed or changed.
// The check itself is src/main/cli-compat.ts, which the app runs too (Settings → Engines).
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_HOOK_EVENTS, CLAUDE_PAYLOAD_KEYS, CLI_CONTRACTS } from '../src/shared/cli-contract.ts'
import { checkCli, whichCli } from '../src/main/cli-compat.ts'

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const only = argv.filter((a) => !a.startsWith('--'))
let failures = 0

const line = (status, engine, kind, text, why) => {
  if (status === 'MISSING') failures++
  console.log(`${status.padEnd(9)} ${engine.padEnd(7)} ${kind.padEnd(6)} ${text}${why ? `  (${why})` : ''}`)
}

for (const c of CLI_CONTRACTS) {
  if (only.length && !only.includes(c.engine)) continue
  const r = await checkCli(c)
  if (!r.installed) {
    console.log(`skipped   ${c.engine.padEnd(7)} ${c.bin} is not on PATH`)
    continue
  }
  console.log(`\n${c.engine} ${r.version || '(no version output)'}  (${r.path})`)
  for (const l of r.lines) line(l.status === 'missing' ? 'MISSING' : l.status, c.engine, l.kind, l.kind === 'string' ? JSON.stringify(l.text) : l.text, l.status === 'ok' ? '' : l.why)
}

if (live) await liveProbe()
console.log(failures ? `\n${failures} assumption(s) MISSING` : '\nall assumptions found')
process.exit(failures ? 1 : 0)

/**
 * One tiny Claude turn (haiku, low effort, one Read) with Ouroboros's hook shape pointed at a throwaway server on a
 * random port (never the app's 47821), in a folder outside Temp. `--setting-sources project,local` keeps the owner's
 * user hooks (and the app's external-session hook) out; this session's CLAUDE markers are stripped from the child.
 */
async function liveProbe() {
  const claude = await whichCli('claude')
  if (!claude) return console.log('\nlive: skipped, claude is not on PATH')
  // a .cmd shim only starts through a shell, which would split the prompt: the native install is probed only
  if (/\.(cmd|bat)$/i.test(claude)) return console.log(`\nlive: skipped, ${claude} is an npm shim (the probe runs the native claude)`)
  const seen = new Map()
  const token = Math.random().toString(36).slice(2)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.headers['x-ouroboros-token'] === token) {
        try {
          const j = JSON.parse(body)
          if (typeof j.hook_event_name === 'string') seen.set(j.hook_event_name, new Set([...(seen.get(j.hook_event_name) ?? []), ...Object.keys(j)]))
        } catch {
          // not JSON: ignored, the missing event shows below
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/hook/compat`
  const dir = join(homedir(), '.ouroboros-compat-probe')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'probe.txt'), 'compat probe\n')
  const handler = { type: 'http', url, timeout: 5, headers: { 'x-ouroboros-token': token } }
  const hooks = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((ev) => [ev, [ev.endsWith('ToolUse') || ev === 'PostToolUseFailure' ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }]]))
  const settingsPath = join(dir, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ hooks }))
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_(CHILD_SESSION|SIMPLE|SESSION_ID|HOST_SESSION_ID|ENTRYPOINT|SESSION_ATTENDED|MESSAGING_.*)|CLAUDE_PID|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)$/.test(k)) delete env[k]
  }
  const args = ['-p', 'Read the file probe.txt with the Read tool, then reply with the single word ok.', '--model', 'haiku', '--effort', 'low', '--setting-sources', 'project,local', '--settings', settingsPath, '--allowedTools', 'Read', '--no-session-persistence']
  console.log(`\nlive probe: claude -p (haiku, low effort) in ${dir}`)
  const code = await new Promise((resolve) => {
    const p = spawn(claude, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => p.kill(), 120_000)
    p.on('error', (e) => {
      clearTimeout(timer)
      console.log(`live: claude did not start: ${e.message}`)
      resolve(-1)
    })
    p.on('close', (c) => {
      clearTimeout(timer)
      if (c !== 0) console.log(`live: claude exited ${c}: ${err.trim().slice(0, 300)}`)
      resolve(c)
    })
  })
  // SessionEnd may land just after the process exits
  await new Promise((r) => setTimeout(r, 500))
  server.close()
  rmSync(dir, { recursive: true, force: true })
  if (code !== 0) return line('MISSING', 'claude', 'live', 'a completed -p turn', 'the probe could not run a turn')
  for (const [event, keys] of Object.entries(CLAUDE_PAYLOAD_KEYS)) {
    const got = seen.get(event)
    if (!got) {
      line('MISSING', 'claude', 'live', event, 'no such hook arrived')
      continue
    }
    const missing = keys.filter((k) => !got.has(k))
    line(missing.length ? 'MISSING' : 'ok', 'claude', 'live', event, missing.length ? `keys not sent: ${missing.join(', ')}` : '')
  }
  if (seen.has('SessionStart')) line('news', 'claude', 'live', 'SessionStart', 'now reaches http hooks: card readiness could use it')
}
