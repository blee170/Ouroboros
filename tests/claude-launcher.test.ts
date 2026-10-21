import { describe, expect, it } from 'vitest'
import { buildClaudeCommand, buildHookSettings, quoteArg, safeSessionName } from '../src/main/claude-launcher'

describe('buildHookSettings', () => {
  it('registers http hooks for every lifecycle event with matcher on tool events', () => {
    const s = buildHookSettings('http://127.0.0.1:1234', 'node1') as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ url: string }> }>> }
    expect(s.hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:1234/hook/node1')
    expect(s.hooks.PreToolUse[0].matcher).toBe('*')
    expect(s.hooks.Stop[0].matcher).toBeUndefined()
  })
})

describe('safeSessionName', () => {
  it('strips shell-hostile characters', () => {
    expect(safeSessionName('  🎼 Conductor · "chill"\n$x `y`  ')).toBe('🎼 Conductor · chill x y')
  })
})

describe('quoteArg / buildClaudeCommand', () => {
  it('quotes for powershell, cmd and posix', () => {
    expect(quoteArg('C:\\Users\\me\\x y.json', 'powershell')).toBe('"C:\\Users\\me\\x y.json"')
    expect(quoteArg('say "hi" $x', 'powershell')).toBe('"say `"hi`" `$x"')
    expect(quoteArg('a "b"', 'cmd')).toBe('"a ""b"""')
    expect(quoteArg("it's", 'posix')).toBe("'it'\\''s'")
  })
  it('builds a claude command line', () => {
    const cmd = buildClaudeCommand(
      { continue: true, model: 'claude-opus-5-5', permissionMode: 'acceptEdits', appendSystemPrompt: 'be  brief\nplease' },
      { settingsPath: '/tmp/a b.json', mcpConfigPath: '/tmp/m.json', systemPromptPath: '/tmp/s.md', sessionName: 'Reviewer card' },
      'posix'
    )
    expect(cmd).toBe("claude --settings '/tmp/a b.json' --continue --model claude-opus-5-5 --permission-mode acceptEdits --mcp-config /tmp/m.json --append-system-prompt-file /tmp/s.md --system-prompt-snapshot off --name 'Reviewer card'")
    expect(cmd).not.toContain('be brief')
    expect(buildClaudeCommand({}, { settingsPath: 'C:\\x\\s.json' }, 'powershell')).toBe('& claude --settings C:\\x\\s.json')
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareLaunch } from '../src/main/claude-launcher'

describe('prepareLaunch', () => {
  it('writes an mcp config when a plain claude card has extra servers, and merges the board server for conductors', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ouro-launch-'))
    const base = { shell: '/bin/bash', baseUrl: 'http://127.0.0.1:1', token: 't', tmpDir: tmp, execPath: '/el', mcpScriptPath: '/mcp.js' }
    const plain = prepareLaunch({ ...base, nodeId: 'p1', kind: 'claude', claude: {} })
    expect(plain.mcpConfigPath).toBeUndefined()
    expect(plain.systemPromptPath).toBeUndefined()
    const role = prepareLaunch({ ...base, nodeId: 'r1', kind: 'claude', title: 'Ops "card"', claude: { appendSystemPrompt: 'Role: Ops. Say "APPROVED BY OWNER" only when asked.' } })
    expect(readFileSync(role.systemPromptPath!, 'utf8')).toContain('APPROVED BY OWNER')
    expect(role.command).toContain(`--append-system-prompt-file ${role.systemPromptPath}`)
    expect(role.command).not.toContain('APPROVED')
    expect(role.command).not.toContain('--system-prompt-snapshot')
    expect(role.command).toContain("--name 'Ops card'")
    expect(role.command).not.toMatch(/"/)
    const withAside = prepareLaunch({ ...base, nodeId: 'p2', kind: 'claude', claude: { mcpServers: { aside: { command: 'aside', args: ['mcp'] } } } })
    expect(JSON.parse(readFileSync(withAside.mcpConfigPath!, 'utf8'))).toEqual({ mcpServers: { aside: { command: 'aside', args: ['mcp'] } } })
    expect(withAside.command).toContain('--mcp-config')
    const cond = prepareLaunch({ ...base, nodeId: 'c1', kind: 'conductor', claude: { continue: true, mcpServers: { aside: { command: 'aside', args: ['mcp'] } } } })
    expect(cond.command).toContain('--system-prompt-snapshot off')
    expect(readFileSync(cond.systemPromptPath!, 'utf8')).toContain('Conductor')
    const cfg = JSON.parse(readFileSync(cond.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, { command: string }> }
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['aside', 'ouroboros'])
    expect(cfg.mcpServers.ouroboros.command).toBe('/el')
    rmSync(tmp, { recursive: true, force: true })
  })
})
