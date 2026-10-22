/**
 * Tiny bridge that turns other CLIs' lifecycle notifications into Ouroboros hook events.
 * Built as ONE self-contained file (out/main/agent-hook.js) and run with a plain node binary:
 *
 *   codex:  `node agent-hook.js codex --url <base> --node <id> '<json>'`
 *           (Codex `notify` passes its JSON payload as the last argv and no environment)
 *   gemini: `node agent-hook.js gemini` with the hook JSON on stdin and
 *           OUROBOROS_URL / OUROBOROS_NODE_ID in the environment (set per hook in settings)
 *
 * The pure mapping functions are exported for tests; `main` only runs when executed directly.
 */
import http from 'node:http'

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

function post(url: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body)
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: 3000 }, (res) => {
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

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [adapter, ...rest] = argv
  let url = env.OUROBOROS_URL ?? ''
  let node = env.OUROBOROS_NODE_ID ?? ''
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--url') url = rest[++i] ?? url
    else if (rest[i] === '--node') node = rest[++i] ?? node
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
  } catch {
    event = null
  }
  if (event) await post(`${url.replace(/\/$/, '')}/hook/${encodeURIComponent(node)}`, event)
  // hooks must print only JSON on stdout; {} = no-op
  process.stdout.write('{}')
}

if (require.main === module) {
  void main(process.argv.slice(2), process.env).then(() => process.exit(0))
}
