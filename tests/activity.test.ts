import { describe, expect, it } from 'vitest'
import { ACTIVITY_LIMITS, editDiff, elapsedText, emptyActivity, endRunningSubagents, recordActivity, shownPath, summarize } from '../src/shared/activity'
import type { HookEvent } from '../src/shared/types'

// payload shapes as Claude Code 2.1.316 sent them to an http hook (captured 2026-11-05)
const base = { session_id: 's1', cwd: 'C:\\proj', prompt_id: 'p1' }
const edit = (over: Partial<HookEvent> = {}): HookEvent => ({
  ...base,
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'C:\\proj\\a.txt', old_string: 'beta', new_string: 'BETA', replace_all: false },
  tool_response: { filePath: 'C:\\proj\\a.txt', originalFile: 'alpha\nbeta\ngamma\n', structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' alpha', '-beta', '+BETA', ' gamma'] }] },
  ...over
})
const writeNew: HookEvent = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'C:\\proj\\b.txt', content: 'one\ntwo' }, tool_response: { type: 'create', structuredPatch: [], originalFile: null } }
const agentCall = (description: string, type = 'general-purpose'): HookEvent => ({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description, prompt: 'x', subagent_type: type } })
const start = (id: string, type = 'general-purpose'): HookEvent => ({ ...base, hook_event_name: 'SubagentStart', agent_id: id, agent_type: type })
const stop = (id: string, msg = 'done\nmore'): HookEvent => ({ ...base, hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'general-purpose', last_assistant_message: msg })

describe('editDiff', () => {
  it("reads the tool's own patch: hunk header, context, removed and added lines", () => {
    const e = edit()
    const d = editDiff('Edit', e.tool_input as Record<string, unknown>, e.tool_response as Record<string, unknown>)
    expect(d).toEqual({
      kind: 'update',
      added: 1,
      removed: 1,
      lines: [
        { op: '@', text: '@@ -1,3 +1,3 @@' },
        { op: ' ', text: 'alpha' },
        { op: '-', text: 'beta' },
        { op: '+', text: 'BETA' },
        { op: ' ', text: 'gamma' }
      ]
    })
  })
  it('shows a new file as added lines (Write sends no patch for it)', () => {
    const d = editDiff('Write', writeNew.tool_input as Record<string, unknown>, writeNew.tool_response as Record<string, unknown>)
    expect(d).toEqual({
      kind: 'create',
      added: 2,
      removed: 0,
      lines: [
        { op: '+', text: 'one' },
        { op: '+', text: 'two' }
      ]
    })
  })
  it('falls back to what the tool was asked when the payload has no response', () => {
    expect(editDiff('Edit', { old_string: 'a\nb', new_string: 'c' }, {})).toMatchObject({ kind: 'update', added: 1, removed: 2 })
    expect(editDiff('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd\ne' }] }, {})).toMatchObject({ added: 3, removed: 2 })
    expect(editDiff('Write', { content: 'x\n' }, {})).toMatchObject({ kind: 'create', added: 1, lines: [{ op: '+', text: 'x' }] })
    expect(editDiff('Write', { content: 'x' }, { type: 'update' })).toMatchObject({ kind: 'update' })
  })
  it('keeps the counts and cuts the stored lines of a long diff, and cuts a long line', () => {
    const content = Array.from({ length: ACTIVITY_LIMITS.linesPerEdit + 50 }, (_, i) => `l${i}`).join('\n')
    const d = editDiff('Write', { content }, { type: 'create' })
    expect(d.added).toBe(ACTIVITY_LIMITS.linesPerEdit + 50)
    expect(d.lines).toHaveLength(ACTIVITY_LIMITS.linesPerEdit)
    expect(d.truncated).toBe(true)
    expect(editDiff('Write', { content: 'x'.repeat(2000) }, {}).lines[0].text).toHaveLength(ACTIVITY_LIMITS.lineLength)
  })
  it('replaces control and bidi characters, keeps tabs, and survives a malformed patch', () => {
    expect(editDiff('Write', { content: '\ta\u202eb\u0007' }, {}).lines[0].text).toBe('\ta b ')
    expect(editDiff('Edit', {}, { structuredPatch: [null, { lines: 'no' }, { lines: [5, '+ok'] }] })).toMatchObject({ added: 1, lines: [{ op: '@' }, { op: '+', text: 'ok' }] })
  })
})

describe('recordActivity: edits by turn', () => {
  it('groups edits by prompt_id and keeps the last turns that edited', () => {
    const a = emptyActivity()
    expect(recordActivity(a, edit(), 10)).toBe(true)
    expect(recordActivity(a, writeNew, 20)).toBe(true)
    expect(a.turns).toHaveLength(1)
    expect(a.turns[0]).toMatchObject({ id: 'p1', startedAt: 10 })
    expect(a.turns[0].edits.map((e) => [e.tool, e.path, e.kind])).toEqual([
      ['Edit', 'C:\\proj\\a.txt', 'update'],
      ['Write', 'C:\\proj\\b.txt', 'create']
    ])
    // a turn without edits (a question, a background task's report) leaves the replay as it was
    recordActivity(a, { ...base, prompt_id: 'p2', hook_event_name: 'UserPromptSubmit' }, 30)
    recordActivity(a, { ...base, prompt_id: 'p2', hook_event_name: 'Stop', background_tasks: [] }, 40)
    expect(a.turns).toHaveLength(1)
    for (let i = 3; i < 3 + ACTIVITY_LIMITS.turns; i++) recordActivity(a, edit({ prompt_id: `p${i}` }), i * 10)
    expect(a.turns).toHaveLength(ACTIVITY_LIMITS.turns)
    expect(a.turns[0].id).toBe('p3')
  })
  it("puts a background subagent's late edit in the turn that launched it", () => {
    const a = emptyActivity()
    recordActivity(a, edit(), 1)
    recordActivity(a, edit({ prompt_id: 'p2' }), 2)
    recordActivity(a, edit({ agent_id: 'ag1' }), 3)
    expect(a.turns.map((t) => t.edits.length)).toEqual([2, 1])
    expect(a.turns[0].edits[1].agentId).toBe('ag1')
  })
  it('counts prompts for the turn when the payload has no prompt_id', () => {
    const a = emptyActivity()
    const noId = (e: HookEvent): HookEvent => ({ ...e, prompt_id: undefined })
    recordActivity(a, noId({ ...base, hook_event_name: 'UserPromptSubmit' }), 1)
    recordActivity(a, noId(edit()), 2)
    recordActivity(a, noId({ ...base, hook_event_name: 'UserPromptSubmit' }), 3)
    recordActivity(a, noId(edit()), 4)
    expect(a.turns.map((t) => t.id)).toEqual(['t1', 't2'])
  })
  it('counts edits past the cap without keeping them', () => {
    const a = emptyActivity()
    for (let i = 0; i < ACTIVITY_LIMITS.editsPerTurn + 3; i++) recordActivity(a, edit(), i)
    expect(a.turns[0].edits).toHaveLength(ACTIVITY_LIMITS.editsPerTurn)
    expect(a.turns[0].dropped).toBe(3)
    expect(summarize('n', a, 1).edits).toBe(ACTIVITY_LIMITS.editsPerTurn + 3)
  })
  it('keeps at most a fixed number of diff lines per turn', () => {
    const a = emptyActivity()
    const big = Array.from({ length: ACTIVITY_LIMITS.linesPerEdit }, (_, i) => `l${i}`).join('\n')
    const n = ACTIVITY_LIMITS.linesPerTurn / ACTIVITY_LIMITS.linesPerEdit + 2
    for (let i = 0; i < n; i++) recordActivity(a, { ...writeNew, tool_input: { file_path: `C:\\proj\\f${i}`, content: big } }, i)
    const edits = a.turns[0].edits
    expect(edits.reduce((sum, x) => sum + x.lines.length, 0)).toBe(ACTIVITY_LIMITS.linesPerTurn)
    expect(edits[n - 1]).toMatchObject({ added: ACTIVITY_LIMITS.linesPerEdit, lines: [], truncated: true })
    expect(edits[0].truncated).toBeUndefined()
  })
  it('ignores a failed edit, an edit without a path and other tools', () => {
    const a = emptyActivity()
    expect(recordActivity(a, { ...edit(), hook_event_name: 'PostToolUseFailure' }, 1)).toBe(false)
    expect(recordActivity(a, edit({ tool_input: {} }), 1)).toBe(false)
    expect(recordActivity(a, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls', file_path: 'x' } }, 1)).toBe(false)
    expect(a).toEqual(emptyActivity())
  })
})

describe('recordActivity: files', () => {
  it('lists read and written files, most recent first, with counts', () => {
    const a = emptyActivity()
    const read = (p: string): HookEvent => ({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: p } })
    recordActivity(a, read('C:\\proj\\a.txt'), 1)
    recordActivity(a, read('C:\\proj\\c.txt'), 2)
    recordActivity(a, edit(), 3)
    recordActivity(a, read('C:\\proj\\a.txt'), 4)
    expect(a.files).toEqual([
      { path: 'C:\\proj\\a.txt', reads: 2, writes: 1, lastAt: 4 },
      { path: 'C:\\proj\\c.txt', reads: 1, writes: 0, lastAt: 2 }
    ])
    for (let i = 0; i < ACTIVITY_LIMITS.files + 10; i++) recordActivity(a, read(`C:\\proj\\f${i}`), 10 + i)
    expect(a.files).toHaveLength(ACTIVITY_LIMITS.files)
    expect(a.files[0].path).toBe(`C:\\proj\\f${ACTIVITY_LIMITS.files + 9}`)
  })
})

describe('recordActivity: subagents', () => {
  it('names a subagent from the Agent call that announced it, and ends it with its report', () => {
    const a = emptyActivity()
    expect(recordActivity(a, agentCall('count lines'), 1)).toBe(false)
    expect(recordActivity(a, start('ag1'), 2)).toBe(true)
    expect(a.subagents).toEqual([{ id: 'ag1', type: 'general-purpose', description: 'count lines', startedAt: 2 }])
    expect(summarize('n', a, 7)).toMatchObject({ nodeId: 'n', running: [{ id: 'ag1' }], rev: 7 })
    expect(recordActivity(a, stop('ag1', '2 lines\n\ncounted by reading'), 9)).toBe(true)
    expect(a.subagents[0]).toMatchObject({ endedAt: 9, result: '2 lines counted by reading' })
    // a second SubagentStop for the same one (Claude Code before 2.1.311 repeated it) changes nothing
    expect(recordActivity(a, stop('ag1', 'again'), 12)).toBe(false)
    expect(summarize('n', a, 8).running).toEqual([])
  })
  it('matches calls made together by type, in order, and takes the certain name from the tool answer', () => {
    const a = emptyActivity()
    recordActivity(a, agentCall('explore hooks', 'Explore'), 1)
    recordActivity(a, agentCall('write tests'), 1)
    recordActivity(a, agentCall('explore ui', 'Explore'), 1)
    recordActivity(a, start('g', 'general-purpose'), 2)
    recordActivity(a, start('e1', 'Explore'), 2)
    recordActivity(a, start('e2', 'Explore'), 2)
    expect(a.subagents.map((r) => [r.id, r.description])).toEqual([
      ['g', 'write tests'],
      ['e1', 'explore hooks'],
      ['e2', 'explore ui']
    ])
    expect(a.pending).toEqual([])
    const answer: HookEvent = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'explore ui' }, tool_response: { agentId: 'e1', description: 'explore ui' } }
    expect(recordActivity(a, answer, 3)).toBe(true)
    expect(a.subagents[1].description).toBe('explore ui')
    expect(recordActivity(a, answer, 4)).toBe(false)
  })
  it("does not give a failed launch's name to a later subagent", () => {
    const a = emptyActivity()
    recordActivity(a, agentCall('first'), 1)
    recordActivity(a, { ...agentCall('first'), hook_event_name: 'PostToolUseFailure' }, 2)
    recordActivity(a, start('x'), 3)
    expect(a.subagents[0].description).toBeUndefined()
  })
  it("ends at the turn's Stop a subagent that Stop does not list as running; keeps a background one", () => {
    const a = emptyActivity()
    recordActivity(a, start('fg'), 1)
    recordActivity(a, start('bg'), 1)
    recordActivity(a, start('finished-bg'), 1)
    const turnEnd: HookEvent = {
      ...base,
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'bg', type: 'subagent', status: 'running' },
        { id: 'finished-bg', type: 'subagent', status: 'completed' }
      ]
    }
    expect(recordActivity(a, turnEnd, 5)).toBe(true)
    expect(a.subagents.map((r) => r.endedAt)).toEqual([5, undefined, 5])
    // a Stop without the list (an older Claude Code) ends nothing
    expect(recordActivity(a, { ...base, hook_event_name: 'Stop' }, 6)).toBe(false)
    expect(a.subagents[1].endedAt).toBeUndefined()
  })
  it('ends every running subagent when the session or the process ends', () => {
    const a = emptyActivity()
    recordActivity(a, start('a1'), 1)
    expect(recordActivity(a, { ...base, hook_event_name: 'SessionEnd', reason: 'other' }, 4)).toBe(true)
    expect(a.subagents[0].endedAt).toBe(4)
    recordActivity(a, start('a2'), 5)
    expect(endRunningSubagents(a, 8)).toBe(true)
    expect(endRunningSubagents(a, 9)).toBe(false)
    expect(a.subagents[1].endedAt).toBe(8)
  })
  it('keeps running subagents past the cap and drops the oldest finished one; ignores an unknown stop', () => {
    const a = emptyActivity()
    recordActivity(a, start('keep'), 0)
    for (let i = 0; i < ACTIVITY_LIMITS.subagents + 5; i++) {
      recordActivity(a, start(`s${i}`), i)
      recordActivity(a, stop(`s${i}`), i)
    }
    expect(a.subagents).toHaveLength(ACTIVITY_LIMITS.subagents)
    expect(a.subagents[0].id).toBe('keep')
    expect(recordActivity(a, stop('nobody'), 99)).toBe(false)
    expect(recordActivity(a, { ...base, hook_event_name: 'SubagentStart' }, 99)).toBe(false)
  })
})

describe('shownPath / elapsedText', () => {
  it("shows a path inside the card's folder relative to it", () => {
    expect(shownPath('C:\\proj\\src\\a.ts', 'c:\\proj\\')).toBe('src/a.ts')
    expect(shownPath('/home/u/proj/a.ts', '/home/u/proj')).toBe('a.ts')
    expect(shownPath('C:\\project2\\a.ts', 'C:\\proj')).toBe('C:/project2/a.ts')
    expect(shownPath('C:\\other\\a.ts', undefined)).toBe('C:/other/a.ts')
  })
  it('writes a duration in words', () => {
    expect([elapsedText(-5), elapsedText(42_400), elapsedText(185_000), elapsedText(4_320_000)]).toEqual(['0s', '42s', '3m 05s', '1h 12m'])
  })
})
