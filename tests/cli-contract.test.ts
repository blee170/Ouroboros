import { describe, expect, it } from 'vitest'
import { buildClaudeCommand, buildHookSettings } from '../src/main/claude-launcher'
import { buildCodexLaunch, buildGeminiLaunch, buildGeminiSettings, buildGrokLaunch, type EngineLaunchInput } from '../src/main/agent-launcher'
import { CLAUDE_HOOK_EVENTS, CLI_CONTRACTS, type CliContract } from '../src/shared/cli-contract'
import type { ClaudeOptions } from '../src/shared/types'

// A launcher that starts passing a new flag or registering a new hook must add it to the contract, so that
// `npm run compat` checks it against the installed CLI.
const contract = (engine: CliContract['engine']): CliContract => CLI_CONTRACTS.find((c) => c.engine === engine)!
const flagsOf = (engine: CliContract['engine']): string[] => contract(engine).flags.map((f) => f.text)
const stringsOf = (engine: CliContract['engine']): string[] => contract(engine).strings.map((s) => s.text)
/** The option tokens of a launch line (bare words only: values in quotes never start a token with a dash). */
const flagTokens = (command: string): string[] => command.split(' ').filter((t) => /^-{1,2}[A-Za-z]/.test(t))

const MODES: Array<ClaudeOptions['permissionMode']> = [undefined, 'default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']
const RESUMES: ClaudeOptions[] = [{}, { continue: true }, { resume: 'abc' }]

const input: EngineLaunchInput = {
  nodeId: 'n1',
  claude: {},
  boardTools: false,
  baseUrl: 'http://127.0.0.1:1',
  tokenFile: '/data/n1.token',
  mcpTokenFile: '/data/n1.mail-token',
  nodeBin: '/usr/bin/node',
  hookScriptPath: '/app/agent-hook.js',
  mcpScriptPath: '/app/mcp-server.js',
  shell: 'posix'
}

/** Every launch variant of an engine: each permission mode, each resume form, with and without an autonomous run. */
function variants(): ClaudeOptions[] {
  const out: ClaudeOptions[] = []
  for (const permissionMode of MODES) for (const r of RESUMES) out.push({ ...r, permissionMode, model: 'm', effort: 'high' })
  out.push({ lightMcp: true })
  return out
}

describe('cli contract', () => {
  it('lists every hook event a Claude card registers', () => {
    const hooks = Object.keys((buildHookSettings('http://127.0.0.1:1', 'n1') as { hooks: Record<string, unknown> }).hooks)
    expect(hooks.sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort())
    for (const ev of CLAUDE_HOOK_EVENTS) expect(stringsOf('claude')).toContain(ev)
  })

  it('lists every flag a Claude card can be launched with', () => {
    const files = { settingsPath: '/t/s.json', mcpConfigPath: '/t/m.json', systemPromptPath: '/t/p.md', sessionName: 'card' }
    const seen = new Set<string>()
    for (const v of variants()) for (const t of flagTokens(buildClaudeCommand(v, files, 'posix'))) seen.add(t)
    expect(seen.size).toBeGreaterThan(5)
    for (const t of seen) expect(flagsOf('claude'), t).toContain(t)
  })

  it('lists every flag and subcommand a Codex card can be launched with', () => {
    const seen = new Set<string>()
    for (const autonomous of [false, true]) {
      for (const v of variants()) {
        const command = buildCodexLaunch({ ...input, claude: v, autonomous }).command
        for (const t of flagTokens(command)) seen.add(t)
        if (/ resume( |$)/.test(command)) seen.add('resume')
      }
    }
    expect(seen).toContain('resume')
    for (const t of seen) expect(flagsOf('codex'), t).toContain(t)
  })

  it('lists every flag, approval mode and hook event of a Gemini card', () => {
    const seen = new Set<string>()
    for (const v of variants()) {
      const command = buildGeminiLaunch({ ...input, claude: v }, '/t/g.json').command
      for (const t of flagTokens(command)) seen.add(t)
      const mode = / --approval-mode (\S+)/.exec(command)?.[1]
      if (mode) seen.add(mode)
    }
    expect(seen).toContain('--approval-mode')
    for (const t of seen) expect(flagsOf('gemini'), t).toContain(t)
    const hooks = Object.keys((buildGeminiSettings(input) as { hooks: Record<string, unknown> }).hooks)
    for (const ev of hooks) expect(stringsOf('gemini'), ev).toContain(ev)
  })

  it('lists every flag a Grok card can be launched with', () => {
    const seen = new Set<string>()
    for (const v of variants()) for (const t of flagTokens(buildGrokLaunch({ ...input, claude: v }, '/t/a.md').command)) seen.add(t)
    expect(seen).toContain('--agent')
    for (const t of seen) expect(flagsOf('grok'), t).toContain(t)
  })
})
