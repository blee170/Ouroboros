import { describe, expect, it } from 'vitest'
import { buildCodexLaunch, buildGeminiLaunch, buildGeminiSettings, buildGrokLaunch, quoteWinCrt, tomlString, type EngineLaunchInput } from '../src/main/agent-launcher'

const base: EngineLaunchInput = {
  nodeId: 'n1',
  claude: {},
  boardTools: false,
  baseUrl: 'http://127.0.0.1:47821',
  tokenFile: 'C:\\data\\n1.token',
  mcpTokenFile: 'C:\\data\\n1.mail-token',
  nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
  hookScriptPath: 'C:\\App\\resources\\app.asar.unpacked\\out\\main\\agent-hook.js',
  mcpScriptPath: 'C:\\App\\resources\\app.asar.unpacked\\out\\main\\mcp-server.js',
  shell: 'powershell'
}

describe('quoteWinCrt', () => {
  it('escapes quotes and the backslashes before them the way the Windows C runtime expects', () => {
    expect(quoteWinCrt('plain')).toBe('"plain"')
    expect(quoteWinCrt('a "b" c')).toBe('"a \\"b\\" c"')
    expect(quoteWinCrt('C:\\dir\\')).toBe('"C:\\dir\\\\"') // trailing backslash doubled so the closing quote survives
    expect(quoteWinCrt('x\\"y')).toBe('"x\\\\\\"y"') // backslash + quote → 3 backslashes + quote
  })
})

describe('buildCodexLaunch', () => {
  it('passes notify, mcp server, instructions and permissions as -c overrides (PowerShell: verbatim after --%)', () => {
    const l = buildCodexLaunch({ ...base, boardTools: true, rolePrompt: 'Be "brief".\nEnd with RESULT:', claude: { model: 'gpt-5-codex', permissionMode: 'acceptEdits' } })
    expect(l.command.startsWith('& codex --% -c "notify=[')).toBe(true)
    expect(l.command).toContain('agent-hook.js')
    expect(l.command).toContain('codex\\",\\"--url\\",\\"http://127.0.0.1:47821\\",\\"--node\\",\\"n1\\",\\"--token-file\\",\\"C:\\\\data\\\\n1.token\\"]"')
    expect(l.command).toContain('mcp_servers.ouroboros.command=')
    expect(l.command).toContain('mcp_servers.ouroboros.env={OUROBOROS_URL=')
    expect(l.command).toContain('OUROBOROS_SELF_ID=\\"n1\\"')
    expect(l.command).toContain(' -m gpt-5-codex -s workspace-write -a on-request')
    // Windows: the role is typed as the first message (cmd.exe/npm shim would mangle it on the line)
    expect(l.command).not.toContain('developer_instructions')
    expect(l.initialPrompt).toContain('Be "brief".')
    const posix = buildCodexLaunch({ ...base, shell: 'posix', rolePrompt: 'Be "brief".\nEnd with RESULT:' })
    expect(posix.command).toContain(`-c 'developer_instructions="Be \\"brief\\".\\nEnd with RESULT:"'`)
    expect(posix.initialPrompt).toBeUndefined()
  })
  it('resumes by thread id or --last and falls back to a typed prompt when the role is too long for cmd.exe', () => {
    const r = buildCodexLaunch({ ...base, shell: 'posix', claude: { resume: 'thr-1', permissionMode: 'plan' } })
    expect(r.command.startsWith('codex -c ')).toBe(true)
    expect(r.command.endsWith(' -s read-only resume thr-1')).toBe(true)
    expect(r.command).toContain("'notify=[")
    const c = buildCodexLaunch({ ...base, shell: 'posix', claude: { continue: true } })
    expect(c.command.endsWith(' resume --last')).toBe(true)
    const long = buildCodexLaunch({ ...base, shell: 'posix', rolePrompt: 'x'.repeat(120_000) })
    expect(long.command).not.toContain('developer_instructions')
    expect(long.command).toMatch(/"--node","n1","--token-file","[^"]*n1.token"]'/)
    expect(long.initialPrompt).toContain('x'.repeat(120_000))
  })
})

describe('buildGeminiSettings / buildGeminiLaunch', () => {
  it('writes hooks with the card id in their env and the board MCP server when board tools are on', () => {
    const s = buildGeminiSettings({ ...base, boardTools: true, shell: 'posix', nodeBin: '/usr/bin/node', hookScriptPath: '/app/agent-hook.js', mcpScriptPath: '/app/mcp-server.js', claude: { mcpServers: { aside: { command: 'aside', args: ['mcp'] } } } }) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; env: Record<string, string>; type: string }> }>>
      mcpServers: Record<string, { command: string; env?: Record<string, string>; trust?: boolean }>
      hooksConfig: { enabled: boolean }
    }
    expect(s.hooksConfig.enabled).toBe(true)
    expect(Object.keys(s.hooks).sort()).toEqual(['AfterAgent', 'BeforeAgent', 'BeforeTool', 'Notification', 'SessionEnd', 'SessionStart'])
    expect(s.hooks.BeforeTool[0].matcher).toBe('*')
    expect(s.hooks.AfterAgent[0].hooks[0]).toMatchObject({ type: 'command', command: '/usr/bin/node /app/agent-hook.js gemini', env: { OUROBOROS_URL: 'http://127.0.0.1:47821', OUROBOROS_NODE_ID: 'n1' } })
    expect(s.mcpServers.ouroboros).toMatchObject({ command: '/usr/bin/node', trust: true, env: { OUROBOROS_SELF_ID: 'n1' } })
    expect(JSON.stringify(s)).not.toContain('OUROBOROS_TOKEN"') // the token itself is never in the settings file
    expect(s.mcpServers.aside.command).toBe('aside')
    expect(s.hooks.AfterAgent[0].hooks[0].env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    const asNode = buildGeminiSettings({ ...base, boardTools: true, electronAsNode: true }) as { hooks: Record<string, Array<{ hooks: Array<{ env: Record<string, string> }> }>>; mcpServers: Record<string, { env: Record<string, string> }> }
    expect(asNode.hooks.SessionStart[0].hooks[0].env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(asNode.mcpServers.ouroboros.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
  it('builds the gemini command, points the system settings env at the per-card file and types the role prompt', () => {
    const l = buildGeminiLaunch({ ...base, rolePrompt: 'You review.', claude: { model: 'pro', permissionMode: 'auto', resume: 'abc' } }, 'C:\\tmp\\n1.gemini.json')
    expect(l.command).toBe('& gemini -m pro --approval-mode yolo -r abc')
    expect(l.env).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: 'C:\\tmp\\n1.gemini.json' })
    expect(l.initialPrompt).toContain('You review.')
    expect(Object.keys(l.files ?? {})).toEqual(['C:\\tmp\\n1.gemini.json'])
    expect(tomlString('a"b')).toBe('"a\\"b"')
  })
})

describe('reasoning effort', () => {
  it('reaches Codex as a model_reasoning_effort override, after the fixed overrides and before the model', () => {
    const l = buildCodexLaunch({ ...base, claude: { model: 'gpt-5-codex', effort: 'high' } })
    expect(l.command).toContain(' -c "model_reasoning_effort=\\"high\\"" -m gpt-5-codex')
    const posix = buildCodexLaunch({ ...base, shell: 'posix', claude: { effort: 'xhigh' } })
    expect(posix.command).toContain(`-c 'model_reasoning_effort="xhigh"'`)
    expect(buildCodexLaunch(base).command).not.toContain('model_reasoning_effort')
  })
  it('is left out of Gemini and Grok lines, which have no such flag', () => {
    expect(buildGeminiLaunch({ ...base, claude: { effort: 'high' } }, 'C:\\tmp\\n1.gemini.json').command).toBe('& gemini')
    expect(buildGrokLaunch({ ...base, claude: { effort: 'high' } }, 'C:\\tmp\\n1.grok.md').command).toBe('& grok --agent C:\\tmp\\n1.grok.md')
  })
})

describe('card token', () => {
  it('reaches Codex and Gemini helpers as a file path, never on the command line', () => {
    const codex = buildCodexLaunch({ ...base, boardTools: true, mcpTokenFile: 'C:\\data\\n1.api-token' })
    expect(codex.command).toContain('--token-file')
    expect(codex.command).toContain('OUROBOROS_TOKEN_FILE=')
    expect(codex.command).not.toMatch(/OUROBOROS_TOKEN=/)
    const gem = buildGeminiSettings({ ...base, boardTools: true, mcpTokenFile: 'C:\\data\\n1.api-token' }) as { hooks: Record<string, Array<{ hooks: Array<{ env: Record<string, string> }> }>> }
    expect(gem.hooks.AfterAgent[0].hooks[0].env.OUROBOROS_TOKEN_FILE).toBe('C:\\data\\n1.token')
    expect((gem as unknown as { mcpServers: { ouroboros: { env: Record<string, string> } } }).mcpServers.ouroboros.env.OUROBOROS_TOKEN_FILE).toBe('C:\\data\\n1.api-token')
    expect(codex.command).toContain('n1.api-token')
  })
  it('gives a card without board tools the mail-only MCP server', () => {
    const codex = buildCodexLaunch(base)
    expect(codex.command).toContain('mcp_servers.ouroboros.env=')
    expect(codex.command).toContain('OUROBOROS_TOOLS=')
    expect(codex.command).toContain('n1.mail-token')
    const gem = buildGeminiSettings(base) as unknown as { mcpServers: { ouroboros: { env: Record<string, string> } } }
    expect(gem.mcpServers.ouroboros.env.OUROBOROS_TOOLS).toBe('mail')
    expect(buildCodexLaunch({ ...base, boardTools: true, mcpTokenFile: 'x' }).command).not.toContain('OUROBOROS_TOOLS')
  })
})

describe('buildCodexLaunch in an autonomous run', () => {
  const run: EngineLaunchInput = { nodeId: 'n1', claude: {}, boardTools: false, baseUrl: 'http://127.0.0.1:47821', tokenFile: '/t/n1.token', mcpTokenFile: '/t/n1.mail-token', nodeBin: '/usr/bin/node', hookScriptPath: '/a/agent-hook.js', mcpScriptPath: '/a/mcp.js', shell: 'posix', autonomous: true }
  it('forces workspace-write with no network, never asking, and drops extra args', () => {
    const l = buildCodexLaunch({ ...run, claude: { permissionMode: 'auto', extraArgs: ['--dangerously-bypass-approvals-and-sandbox'] } })
    expect(l.command).toContain("-s workspace-write -a never -c sandbox_workspace_write.network_access=false -c 'sandbox_workspace_write.writable_roots=[]'")
    expect(l.command).not.toContain('dangerously')
    expect(l.command).not.toContain('on-request')
  })
  it('keeps plan read-only', () => {
    expect(buildCodexLaunch({ ...run, claude: { permissionMode: 'plan' } }).command).toContain('-s read-only -a never')
  })
})
