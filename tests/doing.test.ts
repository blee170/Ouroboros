import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { aiTitleOf, cleanLine, shownDetail, stepOf } from '../src/shared/doing'
import { transcriptPath } from '../src/main/claude-history'
import type { HookEvent } from '../src/shared/types'

const pre = (tool_name: string, tool_input: unknown, extra: Partial<HookEvent> = {}): HookEvent => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra })

describe('stepOf', () => {
  it("takes the tool call's own description first", () => {
    expect(stepOf(pre('PowerShell', { command: 'npm test', description: 'Run the unit tests' }))).toBe('Run the unit tests')
  })
  it('names the file an edit, write or read touches, not its whole path', () => {
    expect(stepOf(pre('Edit', { file_path: 'C:/repo/src/main/ipc.ts', old_string: 'a' }))).toBe('editing ipc.ts')
    expect(stepOf(pre('Write', { file_path: '/home/u/repo/README.md' }))).toBe('writing README.md')
    expect(stepOf(pre('Read', { file_path: 'C:\\repo\\notes.txt' }))).toBe('reading notes.txt')
  })
  it('shows only the host of a fetched page, and the server and tool of an MCP call', () => {
    expect(stepOf(pre('WebFetch', { url: 'https://docs.example.com/a?token=secret' }))).toBe('reading docs.example.com')
    expect(stepOf(pre('WebFetch', { url: 'not a url' }))).toBe('reading a web page')
    expect(stepOf(pre('mcp__ouroboros__send_message', { to: 'x', body: 'private' }))).toBe('ouroboros: send_message')
    expect(stepOf(pre('Grep', { pattern: 'TODO' }))).toBe('searching TODO')
    expect(stepOf(pre('Task', {}))).toBe('Task')
  })
  it("says nothing for a subagent's call or another event", () => {
    expect(stepOf(pre('Edit', { file_path: '/x/a.ts' }, { agent_id: 'sub-1' }))).toBeUndefined()
    expect(stepOf({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } })).toBeUndefined()
    expect(stepOf(pre('', {}))).toBeUndefined()
  })
  it('drops control and bidi characters and caps the length', () => {
    const rlo = String.fromCharCode(0x202e)
    expect(stepOf(pre('Bash', { description: `run${rlo}\u001b[31m  it\n now` }))).toBe('run [31m it now')
    const long = stepOf(pre('Bash', { description: 'x'.repeat(200) })) as string
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
    expect(cleanLine(' \t ')).toBe('')
  })
})

describe('aiTitleOf', () => {
  it('takes the last conversation title and skips lines cut at the read boundary', () => {
    const chunk = ['ai-title":"cut', JSON.stringify({ type: 'ai-title', aiTitle: 'First' }), JSON.stringify({ type: 'user', message: { content: '"ai-title"' } }), JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the login bug' }), ''].join('\n')
    expect(aiTitleOf(chunk)).toBe('Fix the login bug')
    expect(aiTitleOf(JSON.stringify({ type: 'user' }))).toBeUndefined()
    expect(aiTitleOf(JSON.stringify({ type: 'ai-title', aiTitle: '   ' }))).toBeUndefined()
  })
})

describe('shownDetail', () => {
  it('shows the step only while the card works', () => {
    expect(shownDetail({ status: 'working', statusDetail: 'tool: Edit', doing: 'editing ipc.ts' })).toBe('editing ipc.ts')
    expect(shownDetail({ status: 'idle', statusDetail: 'ready', doing: 'editing ipc.ts' })).toBe('ready')
    expect(shownDetail({ status: 'working', statusDetail: 'tool: Edit' })).toBe('tool: Edit')
  })
})

describe('transcriptPath', () => {
  const config = join(tmpdir(), 'cfg-claude')
  it('takes a transcript under the config dir only', () => {
    const ok = join(config, 'projects', 'C--repo', 'abc.jsonl')
    expect(transcriptPath(ok, config)).toBe(ok)
    for (const bad of [join(config, 'projects', '..', 'settings.jsonl'), join(config, 'projects', 'C--repo', 'abc.json'), join(tmpdir(), 'other', 'abc.jsonl'), 'projects/abc.jsonl', join(config, 'projects'), 7, undefined]) {
      expect(transcriptPath(bad, config)).toBeUndefined()
    }
  })
})
