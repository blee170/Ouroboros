/**
 * Tiny bridge that turns other CLIs' lifecycle notifications into Ouroboros hook events.
 * Built as ONE self-contained file (out/main/agent-hook.js) and run with a plain node binary:
 *
 *   codex:  `node agent-hook.js codex --url <base> --node <id> '<json>'`
 *           (Codex `notify` passes its JSON payload as the last argv and no environment)
 *   gemini: `node agent-hook.js gemini` with the hook JSON on stdin and
 *           OUROBOROS_URL / OUROBOROS_NODE_ID in the environment (set per hook in settings)
 *   grok:   `node agent-hook.js grok --url <base> --node <id> --token-file <f>` with the hook JSON on stdin
 *           (Grok Build plugin hooks take no environment of ours)
 *
 * The pure mapping functions are exported for tests; `main` only runs when executed directly.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { mayBeGated } from '../shared/gate'

export interface OuroHook {
  hook_event_name: string
  session_id?: string
  last_assistant_message?: string
  tool_name?: string
  notification_type?: string
  message?: string
  cwd?: string
}

/** Codex legacy `notify` payload → Ouroboros hook event (only turn completion exists there). */
export function mapCodexNotify(payload: Record<string, unknown>): OuroHook | null {
  if (payload.type !== 'agent-turn-complete') return null
  const last = payload['last-assistant-message']
  return {
    hook_event_name: 'Stop',
    session_id: typeof payload['thread-id'] === 'string' ? (payload['thread-id'] as string) : undefined,
    last_assistant_message: typeof last === 'string' ? last : '',
    cwd: typeof payload.cwd === 'string' ? (payload.cwd as string) : undefined
  }
}

/** Gemini CLI hook input (stdin JSON) → Ouroboros hook event. */
export function mapGeminiHook(input: Record<string, unknown>): OuroHook | null {
  const name = String(input.hook_event_name ?? '')
  const base = {
    session_id: typeof input.session_id === 'string' ? (input.session_id as string) : undefined,
    cwd: typeof input.cwd === 'string' ? (input.cwd as string) : undefined
  }
  switch (name) {
    case 'SessionStart':
      return { ...base, hook_event_name: 'SessionStart' }
    case 'BeforeAgent':
      return { ...base, hook_event_name: 'UserPromptSubmit' }
    case 'BeforeTool':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: typeof input.tool_name === 'string' ? (input.tool_name as string) : undefined }
    case 'AfterAgent':
      return { ...base, hook_event_name: 'Stop', last_assistant_message: typeof input.prompt_response === 'string' ? (input.prompt_response as string) : '' }
    case 'Notification': {
      const t = String(input.notification_type ?? '')
      return { ...base, hook_event_name: 'Notification', notification_type: /permission/i.test(t) ? 'permission_prompt' : t, message: typeof input.message === 'string' ? (input.message as string) : undefined }
    }
    case 'SessionEnd':
      return { ...base, hook_event_name: 'SessionEnd' }
    default:
      return null
  }
}

/** First string among the given keys (Grok sends camelCase; snake_case is accepted for Claude-style payloads). */
function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) if (typeof input[k] === 'string') return input[k] as string
  return undefined
}

/** Grok Build hook input (stdin JSON) → Ouroboros hook event. Grok uses Claude Code's event names. */
export function mapGrokHook(input: Record<string, unknown>, envEvent?: string): OuroHook | null {
  const name = pick(input, 'hookEventName', 'hook_event_name') ?? envEvent ?? ''
  const base = { session_id: pick(input, 'sessionId', 'session_id'), cwd: pick(input, 'cwd', 'workspaceRoot') }
  switch (name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'SessionEnd':
      return { ...base, hook_event_name: name }
    case 'PreToolUse':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: pick(input, 'toolName', 'tool_name') }
    case 'Stop':
      // the reply's field is not documented; `message` is left out (a stop reason could sit there and pass as the reply)
      return { ...base, hook_event_name: 'Stop', last_assistant_message: pick(input, 'lastAssistantMessage', 'last_assistant_message', 'response') ?? '' }
    case 'StopFailure':
      // a turn that ended on an API error: the card shows "failed:" (not a reply, so no line fires on it)
      return { ...base, hook_event_name: 'StopFailure', message: pick(input, 'error', 'message', 'reason') }
    case 'Notification': {
      const t = pick(input, 'notificationType', 'notification_type') ?? ''
      const message = pick(input, 'message', 'title')
      return { ...base, hook_event_name: 'Notification', notification_type: /permission|approv/i.test(`${t} ${message ?? ''}`) ? 'permission_prompt' : t, message }
    }
    default:
      return null
  }
}

function post(url: string, body: unknown, token: string): Promise<void> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body)
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ouroboros-token': token }, timeout: 3000 }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', () => resolve())
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.end(data)
  })
}

/** The card's token from the file the launcher wrote (Codex runs notify with no environment of ours). */
function readToken(file: string): string {
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (buf += c))
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(buf))
    setTimeout(() => resolve(buf), 2000)
  })
}

/** POST and read the JSON answer; rejects on a network error, a timeout or a non-200 status. */
function ask(url: string, body: unknown, token: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-ouroboros-token': token }, timeout: timeoutMs }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        try {
          const json = JSON.parse(raw) as Record<string, unknown>
          if (res.statusCode !== 200) reject(new Error(String(json.reason ?? `status ${res.statusCode}`)))
          else resolve(json)
        } catch {
          reject(new Error(`status ${res.statusCode}, not JSON`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.end(data)
  })
}

export interface GateOutcome {
  /** what the hook prints on stdout */
  stdout: string
  /** 2 blocks the tool call (Claude Code shows stderr to the model) */
  exitCode: 0 | 2
  stderr?: string
}

/**
 * Claude Code PreToolUse (Bash / PowerShell) during an Autonomous run: a command that may push, open or merge a PR
 * is decided by the app. Fails closed: no app, no token, an error or a malformed answer blocks the call (exit 2).
 */
export async function runGate(input: Record<string, unknown>, opts: { url: string; node: string; token: string; timeoutMs?: number }): Promise<GateOutcome> {
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
  const block = (why: string): GateOutcome => ({ stdout: '', exitCode: 2, stderr: `Ouroboros action gate: ${why}. The command was not run.` })
  // a shell tool call whose command we cannot read is not let through (another field name, an empty or late stdin)
  if (typeof toolInput.command !== 'string') return block('no command in the hook input')
  const command = toolInput.command
  if (!mayBeGated(command)) return { stdout: '{}', exitCode: 0 }
  if (!opts.url || !opts.node || !opts.token) return block('the gate is not configured for this card')
  try {
    const r = await ask(`${opts.url.replace(/\/$/, '')}/hook/${encodeURIComponent(opts.node)}/gate`, { command, cwd: typeof input.cwd === 'string' ? input.cwd : undefined, tool: input.tool_name }, opts.token, opts.timeoutMs ?? 8000)
    const reason = typeof r.reason === 'string' ? r.reason : ''
    if (r.decision === 'none') return { stdout: '{}', exitCode: 0 }
    if (r.decision !== 'allow' && r.decision !== 'deny') return block('the app gave no decision')
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: reason } }), exitCode: 0 }
  } catch (e) {
    return block(`could not reach Ouroboros (${(e as Error).message})`)
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [adapter, ...rest] = argv
  if (adapter === 'gate') {
    // an exception anywhere (a closed pipe included) must block, never exit 1, which Claude Code treats as a pass
    process.on('uncaughtException', () => process.exit(2))
    let url = ''
    let node = ''
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--url') url = rest[++i] ?? ''
      else if (rest[i] === '--node') node = rest[++i] ?? ''
    }
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse((await readStdin()) || '{}') as Record<string, unknown>
    } catch {
      process.stderr.write('Ouroboros action gate: unreadable hook input. The command was not run.')
      process.exitCode = 2
      return
    }
    const out = await runGate(input, { url, node, token: env.OUROBOROS_HOOK_TOKEN ?? '' })
    // pipes are asynchronous on Windows: wait for the write before the process exits
    if (out.stdout) await new Promise<void>((r) => process.stdout.write(out.stdout, () => r()))
    if (out.stderr) await new Promise<void>((r) => process.stderr.write(out.stderr!, () => r()))
    process.exitCode = out.exitCode
    return
  }
  let url = env.OUROBOROS_URL ?? ''
  let node = env.OUROBOROS_NODE_ID ?? ''
  let tokenFile = env.OUROBOROS_TOKEN_FILE ?? ''
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--url') url = rest[++i] ?? url
    else if (rest[i] === '--node') node = rest[++i] ?? node
    else if (rest[i] === '--token-file') tokenFile = rest[++i] ?? tokenFile
    else positional.push(rest[i])
  }
  if (!url || !node) {
    process.stdout.write('{}')
    return
  }
  let event: OuroHook | null = null
  try {
    if (adapter === 'codex') event = mapCodexNotify(JSON.parse(positional[positional.length - 1] ?? '{}'))
    else if (adapter === 'gemini') event = mapGeminiHook(JSON.parse((await readStdin()) || '{}'))
    else if (adapter === 'grok') event = mapGrokHook(JSON.parse((await readStdin()) || '{}'), env.GROK_HOOK_EVENT)
  } catch {
    event = null
  }
  if (event) await post(`${url.replace(/\/$/, '')}/hook/${encodeURIComponent(node)}`, event, readToken(tokenFile))
  // hooks must print only JSON on stdout; {} = no-op
  process.stdout.write('{}')
}

if (require.main === module) {
  const gate = process.argv[2] === 'gate'
  // the gate fails closed: anything unexpected exits 2, which blocks the tool call
  void main(process.argv.slice(2), process.env).then(
    () => process.exit(gate ? (Number(process.exitCode) || 0) : 0),
    () => process.exit(gate ? 2 : 0)
  )
}
