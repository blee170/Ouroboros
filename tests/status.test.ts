import { describe, expect, it } from 'vitest'
import { detectClaudeReady, detectMissingCommand, failureOf, reduceHook } from '@shared/status'

describe('reduceHook', () => {
  it('maps lifecycle events to statuses', () => {
    expect(reduceHook(undefined, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' })).toMatchObject({ status: 'idle', sessionId: 's1' })
    expect(reduceHook('idle', { hook_event_name: 'UserPromptSubmit' })?.status).toBe('working')
    expect(reduceHook('working', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toMatchObject({ status: 'working', statusDetail: 'tool: Bash' })
    expect(reduceHook('working', { hook_event_name: 'Stop', last_assistant_message: 'done!' })).toMatchObject({ status: 'done', lastAssistantMessage: 'done!' })
    expect(reduceHook('done', { hook_event_name: 'SessionEnd' })?.status).toBe('ended')
    expect(reduceHook('done', { hook_event_name: 'SessionEnd', reason: 'clear' })).toMatchObject({ status: 'idle', statusDetail: 'cleared' })
    expect(reduceHook('idle', { hook_event_name: 'SessionEnd', reason: 'logout' })?.status).toBe('ended')
  })
  it('turns permission/idle notifications into needs-you and ignores others', () => {
    expect(reduceHook('working', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' })).toMatchObject({ status: 'needs-you', statusDetail: 'permission: Allow Bash?' })
    expect(reduceHook('working', { hook_event_name: 'Notification', notification_type: 'auth_success' })).toBeNull()
    expect(reduceHook('done', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })?.status).toBe('done')
    expect(reduceHook('idle', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })?.status).toBe('idle')
  })
  it('keeps a card idle or done through an idle compaction, and working through a mid-turn one', () => {
    // Claude Code compacts while idle ("Compacted while idle, before the prompt cache expired") with no Stop after it
    expect(reduceHook('done', { hook_event_name: 'PreCompact', trigger: 'auto' })).toBeNull()
    expect(reduceHook('done', { hook_event_name: 'PostCompact' })).toBeNull()
    expect(reduceHook('idle', { hook_event_name: 'PreCompact', trigger: 'manual' })).toBeNull()
    expect(reduceHook('working', { hook_event_name: 'PreCompact' })).toMatchObject({ status: 'working', statusDetail: 'compacting context' })
    expect(reduceHook('working', { hook_event_name: 'PostCompact' })).toMatchObject({ status: 'working', statusDetail: 'working' })
  })
  it('does not let a late tool or subagent event revive a finished card', () => {
    // a background agent or shell finishing after the Stop, or the post-turn recap: no Stop follows, so the card
    // would sit on "Working · working" for good
    for (const name of ['PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']) {
      for (const prev of ['done', 'idle', 'ended'] as const) {
        expect(reduceHook(prev, { hook_event_name: name, tool_name: 'Bash' }), `${name} after ${prev}`).toBeNull()
      }
      // mid-turn they keep the card working, and they end the wait on a permission prompt the owner answered
      // (a finished tool call resets the detail to "working"; subagent events leave it as it was)
      expect(reduceHook('working', { hook_event_name: name })).toMatchObject({ status: 'working', statusDetail: name.startsWith('PostToolUse') ? 'working' : undefined })
      expect(reduceHook('needs-you', { hook_event_name: name })).toMatchObject({ status: 'working', statusDetail: 'working' })
      expect(reduceHook('needs-you', { hook_event_name: name }, 'permission: Allow Bash?')?.status).toBe('working')
      // a turn that ended on an error (StopFailure) is finished too: a late event must not wipe the usage-limit park
      expect(reduceHook('needs-you', { hook_event_name: name }, 'failed: usage limit reached'), `${name} after failed`).toBeNull()
      // unknown or starting (first events after a relaunch): still a turn in progress
      expect(reduceHook(undefined, { hook_event_name: name })?.status).toBe('working')
      expect(reduceHook('starting', { hook_event_name: name })?.status).toBe('working')
    }
    // a real new turn after a finished one still starts with UserPromptSubmit or PreToolUse
    expect(reduceHook('done', { hook_event_name: 'UserPromptSubmit' })?.status).toBe('working')
    expect(reduceHook('done', { hook_event_name: 'PreToolUse', tool_name: 'Read' })).toMatchObject({ status: 'working', statusDetail: 'tool: Read' })
  })
  it('clears the tool detail once the tool call finishes, so a stall after it is not taken for a long tool', () => {
    expect(reduceHook('working', { hook_event_name: 'PostToolUse', tool_name: 'Read' })).toMatchObject({ status: 'working', statusDetail: 'working' })
    expect(reduceHook('working', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' })).toMatchObject({ status: 'working', statusDetail: 'working' })
  })
  it('does not let a tool call from a background subagent revive a finished card', () => {
    const sub = { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'agent-7' }
    for (const prev of ['done', 'idle', 'ended'] as const) expect(reduceHook(prev, sub)).toBeNull()
    expect(reduceHook('needs-you', sub, 'failed: usage limit')).toBeNull()
    // mid-turn, or after an answered permission prompt, a subagent tool call is work as usual
    expect(reduceHook('working', sub)).toMatchObject({ status: 'working', statusDetail: 'tool: Bash' })
    expect(reduceHook('needs-you', sub, 'permission: Bash')?.status).toBe('working')
    // an empty agent_id is the main agent
    expect(reduceHook('done', { ...sub, agent_id: '' })?.status).toBe('working')
  })
  it('ignores unknown events', () => {
    expect(reduceHook('idle', { hook_event_name: 'SomethingNew' })).toBeNull()
  })
})

describe('detectClaudeReady', () => {
  it('recognises the TUI banner or footer even with ANSI codes', () => {
    expect(detectClaudeReady('\u001b[1mClaude Code v2.1.306\u001b[0m')).toBe(true)
    expect(detectClaudeReady('>  \u001b[2m? for shortcuts\u001b[0m')).toBe(true)
    expect(detectClaudeReady('PS C:\\Users\\me> ')).toBe(false)
  })
})

describe('failures', () => {
  it('StopFailure is a needs-you marked "failed:" so the toast and the sidebar can say so', () => {
    const u = reduceHook('working', { hook_event_name: 'StopFailure', message: 'API error 529' })
    expect(u).toMatchObject({ status: 'needs-you', statusDetail: 'failed: API error 529' })
    expect(failureOf(u?.statusDetail)).toBe('API error 529')
    expect(failureOf(reduceHook('working', { hook_event_name: 'StopFailure' })?.statusDetail)).toBe('turn failed (API error)')
    expect(failureOf('permission: Bash')).toBeUndefined()
    expect(failureOf(undefined)).toBeUndefined()
  })
})

describe('detectMissingCommand', () => {
  it('names the command PowerShell, cmd, bash and zsh could not find, through ANSI codes and in Korean', () => {
    expect(detectMissingCommand("claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program.")).toBe('claude')
    // PowerShell 5.1 on a Korean Windows (the owner's): the message is localised, the category line is not
    expect(
      detectMissingCommand(
        "gemini : 'gemini' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.\r\n위치 줄:1 문자:1\r\n+ gemini --yolo\r\n+ ~~~~~~\r\n    + CategoryInfo          : ObjectNotFound: (gemini:String) [], CommandNotFoundException\r\n    + FullyQualifiedErrorId : CommandNotFoundException\r\n"
      )
    ).toBe('gemini')
    // PowerShell 7 ConciseView prints the first line only
    expect(detectMissingCommand("PS C:\\p> codex\r\ncodex: The term 'codex' is not recognized as a name of a cmdlet, function, script file, or executable program.")).toBe('codex')
    expect(detectMissingCommand("codex: 'codex' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.")).toBe('codex')
    expect(detectMissingCommand("'gemini'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는\r\n배치 파일이 아닙니다.")).toBe('gemini')
    // the app launches with the call operator ("& gemini …") in a ~60-column card: the first line names "&",
    // and the terminal wraps the category line mid-word
    expect(detectMissingCommand("& : 'gemini' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되\r\n지 않습니다.\r\n위치 줄:1 문자:3\r\n+ & gemini --yolo\r\n+   ~~~~~~\r\n    + CategoryInfo          : ObjectNotFound: (gemini:St\r\nring) [], CommandNotFoundException\r\n    + FullyQualifiedErrorId : CommandNotFoundException")).toBe('gemini')
    expect(detectMissingCommand("&: The term 'codex' is not recognized as a name of a cmdlet, function, script file, or\r\n executable program.")).toBe('codex')
    expect(detectMissingCommand("\u001b[31m'codex' is not recognized as an internal or external command,\u001b[0m\r\noperable program or batch file.")).toBe('codex')
    expect(detectMissingCommand('bash: gemini: command not found')).toBe('gemini')
    expect(detectMissingCommand('bash: line 1: claude: command not found')).toBe('claude')
    expect(detectMissingCommand('zsh: command not found: codex')).toBe('codex')
  })
  it('with an expected name, ignores a tool missing from the shell profile and accepts a path or .exe', () => {
    const profile = "oh-my-posh : The term 'oh-my-posh' is not recognized as the name of a cmdlet.\r\nPS C:\\p> & claude --name x\r\n"
    expect(detectMissingCommand(profile, 'claude')).toBeNull()
    expect(detectMissingCommand(profile + "& : The term 'claude' is not recognized as the name of a cmdlet.", 'claude')).toBe('claude')
    expect(detectMissingCommand("bash: /usr/local/bin/codex.cmd: command not found", 'codex')).toBe('/usr/local/bin/codex.cmd')
    expect(detectMissingCommand('zsh: command not found: thefuck', 'gemini')).toBeNull()
  })
  it('stays quiet on a normal launch and on the echoed command line', () => {
    expect(detectMissingCommand('PS C:\proj> claude --name "x" --append-system-prompt "if a command is not found, say so"\r\nClaude Code v2.1')).toBeNull()
    expect(detectMissingCommand('')).toBeNull()
  })
})
