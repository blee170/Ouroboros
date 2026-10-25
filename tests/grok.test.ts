import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildGrokLaunch, buildGrokPlugin, type EngineLaunchInput } from '../src/main/agent-launcher'
import { mapGrokHook } from '../src/main/agent-hook'
import { credentialEnvKeys, signedInFromFiles } from '../src/main/engines'
import { relaunchAction } from '../src/shared/autonomy'
import { MODEL_PRESETS, modelChoice } from '../src/shared/models'
import { normalizeEngine } from '../src/shared/types'

const base: EngineLaunchInput = {
  nodeId: 'n1',
  claude: {},
  boardTools: false,
  baseUrl: 'http://127.0.0.1:47821',
  tokenFile: 'C:\\data\\n1.token',
  mcpTokenFile: 'C:\\data\\n1.mail-token',
  nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
  hookScriptPath: 'C:\\App\\out\\main\\agent-hook.js',
  mcpScriptPath: 'C:\\App\\out\\main\\mcp-server.js',
  shell: 'powershell'
}

describe('Grok engine: plugin folder and launch line', () => {
  it('writes both plugin manifests, the hooks and the board MCP server without the token itself', () => {
    const files = buildGrokPlugin({ ...base, claude: { mcpServers: { aside: { command: 'aside', args: ['mcp'] } } } })
    expect(Object.keys(files).sort()).toEqual(['.claude-plugin/plugin.json', '.grok-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json'])
    const hooks = JSON.parse(files['hooks/hooks.json']).hooks as Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'])
    const cmd = hooks.Stop[0].hooks[0].command
    // the first word is never quoted (PowerShell and cmd /c both misread a leading quote): node by name when its path has a space
    expect(cmd).toBe('node C:/App/out/main/agent-hook.js grok --url http://127.0.0.1:47821 --node n1 --token-file C:/data/n1.token')
    const spaced = JSON.parse(buildGrokPlugin({ ...base, nodeBin: 'C:\\node\\node.exe', tokenFile: 'C:\\Users\\Jo Smith\\n1.token' })['hooks/hooks.json']).hooks.Stop[0].hooks[0].command
    expect(spaced).toBe('C:/node/node.exe C:/App/out/main/agent-hook.js grok --url http://127.0.0.1:47821 --node n1 --token-file "C:/Users/Jo Smith/n1.token"')
    const mcp = JSON.parse(files['.mcp.json']).mcpServers
    expect(mcp.ouroboros).toMatchObject({ command: base.nodeBin, args: [base.mcpScriptPath], env: { OUROBOROS_SELF_ID: 'n1', OUROBOROS_TOOLS: 'mail', OUROBOROS_TOKEN_FILE: base.mcpTokenFile } })
    expect(mcp.aside.command).toBe('aside')
    expect(JSON.parse(buildGrokPlugin({ ...base, boardTools: true })['.mcp.json']).mcpServers.ouroboros.env.OUROBOROS_TOOLS).toBeUndefined()
  })
  it('passes the plugin folder, model, approval and resume flags; the role is typed on Windows', () => {
    const l = buildGrokLaunch({ ...base, rolePrompt: 'You review.', claude: { model: 'grok-4.7', permissionMode: 'bypassPermissions', resume: 'abc' } }, 'C:\\tmp\\n1.grok')
    expect(l.command).toBe('& grok --plugin-dir C:\\tmp\\n1.grok -m grok-4.7 --always-approve -r abc')
    expect(l.initialPrompt).toContain('You review.')
    expect(Object.keys(l.files ?? {})).toContain('C:\\tmp\\n1.grok/hooks/hooks.json')
    // plan / acceptEdits have no Grok flag: the card starts in Grok's own default mode
    expect(buildGrokLaunch({ ...base, claude: { permissionMode: 'plan', continue: true } }, 'C:\\p').command).toBe('& grok --plugin-dir C:\\p -c')
  })
  it('puts the role in --rules on posix and falls back to a message when the line would be too long', () => {
    const posix = { ...base, shell: 'posix' as const, nodeBin: '/usr/bin/node', hookScriptPath: '/app/h.js', mcpScriptPath: '/app/m.js', tokenFile: '/d/t', mcpTokenFile: '/d/m' }
    const l = buildGrokLaunch({ ...posix, rolePrompt: 'a role\nline two' }, '/tmp/n1.grok')
    expect(l.command).toBe("grok --plugin-dir /tmp/n1.grok --rules 'a role\nline two'")
    expect(l.initialPrompt).toBeUndefined()
    const long = buildGrokLaunch({ ...posix, rolePrompt: 'x'.repeat(200000) }, '/tmp/n1.grok')
    expect(long.command).toBe('grok --plugin-dir /tmp/n1.grok')
    expect(long.initialPrompt).toContain('xxx')
  })
})

describe('Grok engine: hook mapping', () => {
  const b = { sessionId: 's', cwd: '/p' }
  it('maps camelCase Grok events (and snake_case Claude-style ones) to Ouroboros events', () => {
    expect(mapGrokHook({ ...b, hookEventName: 'SessionStart' })).toEqual({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/p' })
    expect(mapGrokHook({ ...b, hookEventName: 'UserPromptSubmit' })).toMatchObject({ hook_event_name: 'UserPromptSubmit' })
    expect(mapGrokHook({ ...b, hookEventName: 'PreToolUse', toolName: 'bash' })).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'bash' })
    expect(mapGrokHook({ ...b, hookEventName: 'Stop', lastAssistantMessage: 'RESULT: ok' })).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: 'RESULT: ok' })
    expect(mapGrokHook({ hook_event_name: 'Stop', session_id: 'x', last_assistant_message: 'done' })).toMatchObject({ session_id: 'x', last_assistant_message: 'done' })
    expect(mapGrokHook({ ...b, hookEventName: 'Stop' })).toMatchObject({ last_assistant_message: '' })
    expect(mapGrokHook({ ...b, hookEventName: 'StopFailure', error: 'rate limited' })).toEqual({ hook_event_name: 'StopFailure', session_id: 's', cwd: '/p', message: 'rate limited' })
    expect(mapGrokHook({ ...b, hookEventName: 'Notification', message: 'Approve bash: rm x?' })).toMatchObject({ notification_type: 'permission_prompt' })
    expect(mapGrokHook({ ...b, hookEventName: 'Notification', notificationType: 'idle', message: 'waiting' })).toMatchObject({ notification_type: 'idle' })
    expect(mapGrokHook({ ...b, hookEventName: 'SessionEnd' })).toMatchObject({ hook_event_name: 'SessionEnd' })
    expect(mapGrokHook({ ...b, hookEventName: 'PreCompact' })).toBeNull()
    // the event name from GROK_HOOK_EVENT when the payload has none
    expect(mapGrokHook({ ...b }, 'SessionStart')).toMatchObject({ hook_event_name: 'SessionStart' })
  })
})

describe('Grok engine: sign-in, credentials, autonomy, models', () => {
  it('counts a ~/.grok sign-in file or XAI_API_KEY as signed in', () => {
    const files = new Set<string>()
    const exists = (p: string): boolean => files.has(p.split('\\').join('/'))
    expect(signedInFromFiles('grok', '/h', {}, exists, () => '')).toBe(false)
    expect(signedInFromFiles('grok', '/h', { XAI_API_KEY: 'k' }, exists, () => '')).toBe(true)
    // a ~/.grok folder without a sign-in file we know is unknown, not signed out
    files.add('/h/.grok')
    expect(signedInFromFiles('grok', '/h', {}, exists, () => '')).toBeUndefined()
    files.add('/h/.grok/auth.json')
    expect(signedInFromFiles('grok', '/h', {}, exists, () => '')).toBe(true)
  })
  it('keeps XAI_API_KEY for Grok cards only and strips the other engines keys from them', () => {
    const env = { XAI_API_KEY: 'x', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }
    expect(credentialEnvKeys(env, 'grok', false).sort()).toEqual(['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'])
    for (const e of ['claude', 'codex', 'gemini'] as const) expect(credentialEnvKeys(env, e, false)).toContain('XAI_API_KEY')
    expect(credentialEnvKeys(env, 'grok', true)).toEqual([])
  })
  it('closes Grok cards when a run starts, normalizes the engine and offers grok-4.7', () => {
    expect(relaunchAction({ kind: 'claude', engine: 'grok', ptyAlive: true, status: 'idle' })).toBe('close')
    expect(normalizeEngine('grok')).toBe('grok')
    expect(MODEL_PRESETS.grok.map((p) => p.value)).toContain('grok-4.7')
    expect(modelChoice('grok', 'grok-4.7')).toBe('grok-4.7')
    expect(modelChoice('grok', 'grok-code-x')).toBe('custom')
  })
})

const script = resolve(__dirname, '../out/main/agent-hook.js')
describe('agent-hook.js grok adapter (bundled)', () => {
  it.skipIf(!existsSync(script))('reads the stdin event, posts it with the token from --token-file and prints {}', async () => {
    const received: Array<{ url: string; body: unknown; token: string }> = []
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'ouro-grok-')), 'card.token')
    writeFileSync(tokenFile, 'tok\n')
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: JSON.parse(body), token: String(req.headers['x-ouroboros-token'] ?? '') })
        res.writeHead(200).end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const out = await new Promise<string>((ok, fail) => {
      const child = execFile(process.execPath, [script, 'grok', '--url', url, '--node', 'g1', '--token-file', tokenFile], (err, stdout) => (err ? fail(err) : ok(stdout)))
      child.stdin?.end(JSON.stringify({ hookEventName: 'Stop', sessionId: 'S', lastAssistantMessage: 'done' }))
    })
    server.close()
    expect(out).toBe('{}')
    expect(received).toEqual([{ url: '/hook/g1', body: { hook_event_name: 'Stop', session_id: 'S', last_assistant_message: 'done' }, token: 'tok' }])
  }, 20000)
})
