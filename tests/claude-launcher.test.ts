import { describe, expect, it } from 'vitest'
import { buildClaudeCommand, buildHookSettings, quoteArg } from '../src/main/claude-launcher'

describe('buildHookSettings', () => {
  it('registers http hooks for every lifecycle event with matcher on tool events', () => {
    const s = buildHookSettings('http://127.0.0.1:1234', 'node1') as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ url: string }> }>> }
    expect(s.hooks.Stop[0].hooks[0].url).toBe('http://127.0.0.1:1234/hook/node1')
    expect(s.hooks.PreToolUse[0].matcher).toBe('*')
    expect(s.hooks.Stop[0].matcher).toBeUndefined()
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
      { settingsPath: '/tmp/a b.json', mcpConfigPath: '/tmp/m.json' },
      'posix'
    )
    expect(cmd).toBe("claude --settings '/tmp/a b.json' --continue --model claude-opus-5-5 --permission-mode acceptEdits --mcp-config /tmp/m.json --append-system-prompt 'be brief please'")
    expect(buildClaudeCommand({}, { settingsPath: 'C:\\x\\s.json' }, 'powershell')).toBe('& claude --settings C:\\x\\s.json')
  })
})
