import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_LIMITS, CHAT_VIEW_PROMPT, applyChatEvents, cardView, chatCapable, cleanChatText, composerBlock, confirmPending, normalizeCardView, parseChatLines, pendingTool, splitReply, toolLabel, toolSummary, userText, type ChatItem } from '../src/shared/chat'
import { MERMAID_LOCKED, cssLoadsNothing, localRef, plainMermaid, remoteFileUrl } from '../src/shared/visuals'
import { readChat } from '../src/main/chat-transcript'

const line = (o: unknown): string => JSON.stringify(o) + '\n'
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): string => line({ type: 'user', uuid, timestamp: '2026-11-05T10:00:00.000Z', message: { role: 'user', content }, ...extra })
const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}): string => line({ type: 'assistant', uuid, timestamp: '2026-11-05T10:00:05.000Z', message: { role: 'assistant', content }, ...extra })

describe('cardView', () => {
  const claude = { kind: 'claude' as const }
  it('is the terminal unless the card or Settings says chat', () => {
    expect(cardView(claude, undefined)).toBe('terminal')
    expect(cardView(claude, 'chat')).toBe('chat')
    expect(cardView({ ...claude, view: 'terminal' }, 'chat')).toBe('terminal')
    expect(cardView({ ...claude, view: 'chat' }, 'terminal')).toBe('chat')
    expect(cardView({ ...claude, view: 'nonsense' }, 'also nonsense')).toBe('terminal')
  })
  it('is always the terminal where there is no transcript to read', () => {
    expect(cardView({ kind: 'claude', engine: 'codex', view: 'chat' }, 'chat')).toBe('terminal')
    expect(cardView({ kind: 'terminal', view: 'chat' }, 'chat')).toBe('terminal')
    expect(cardView({ kind: 'claude', claude: { wsl: true }, view: 'chat' }, 'chat')).toBe('terminal')
    expect(chatCapable({ kind: 'conductor' })).toBe(true)
    expect(chatCapable({ kind: 'conductor', engine: 'grok' })).toBe(false)
    expect(normalizeCardView('chat')).toBe('chat')
    expect(normalizeCardView('')).toBeUndefined()
  })
  it('tells a chat card what the view draws, in fixed words', () => {
    expect(CHAT_VIEW_PROMPT).toContain('```mermaid')
    expect(CHAT_VIEW_PROMPT).toContain('```svg')
  })
})

describe('userText', () => {
  it('keeps a prompt and drops what Claude Code adds for the model', () => {
    expect(userText('fix the menu page')).toEqual({ type: 'user', text: 'fix the menu page' })
    expect(userText('hello <system-reminder>secret rules</system-reminder>')).toEqual({ type: 'user', text: 'hello' })
    expect(userText('<system-reminder>only this</system-reminder>')).toBeUndefined()
    expect(userText('<local-command-caveat>Caveat: ...</local-command-caveat>')).toBeUndefined()
  })
  it('shows a slash command as the owner typed it and harness output as a note', () => {
    expect(userText('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toEqual({ type: 'user', text: '/clear' })
    expect(userText('<command-message>x</command-message><command-name>compact</command-name><command-args>keep the plan</command-args>')).toEqual({ type: 'user', text: '/compact keep the plan' })
    expect(userText('<local-command-stdout>Compacted</local-command-stdout>')).toEqual({ type: 'note', text: 'Compacted' })
    expect(userText('<local-command-stdout></local-command-stdout>')).toBeUndefined()
    expect(userText('<task-notification><task-id>t1</task-id><status>completed</status></task-notification>')).toEqual({ type: 'note', text: 't1 completed' })
    // the owner's own words, even when they look like markup
    expect(userText('<task>do X</task>')).toEqual({ type: 'user', text: '<task>do X</task>' })
    expect(userText('<bash-input>git status</bash-input>')).toEqual({ type: 'user', text: '!git status' })
    expect(userText('[Request interrupted by user for tool use]')).toEqual({ type: 'note', text: 'Interrupted' })
  })
})

describe('parseChatLines', () => {
  it('reads prompts, replies, thinking, tool calls and their results', () => {
    const text =
      line({ type: 'custom-title', customTitle: 'x', sessionId: 's' }) +
      user('u1', 'build a bakery menu page') +
      assistant('a1', [{ type: 'thinking', thinking: 'plan it' }]) +
      assistant('a2', [{ type: 'text', text: 'Here is the plan.' }]) +
      assistant('a3', [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'C:\\site\\menu.html', content: '<html>' } }]) +
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'File created' }] }]) +
      assistant('a4', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test\nmore' } }]) +
      user('u3', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }])
    const events = parseChatLines(text)
    expect(events.map((e) => e.type)).toEqual(['user', 'thinking', 'assistant', 'tool', 'result', 'tool', 'result'])
    expect(events[0]).toMatchObject({ type: 'user', id: 'u1:0', text: 'build a bakery menu page', at: Date.parse('2026-11-05T10:00:00.000Z') })
    expect(events[3]).toMatchObject({ type: 'tool', toolId: 'toolu_1', name: 'Write', summary: 'C:\\site\\menu.html' })
    expect(events[4]).toEqual({ type: 'result', toolId: 'toolu_1', text: 'File created', error: false })
    expect(events[5]).toMatchObject({ summary: 'npm test more' })
    expect(events[6]).toEqual({ type: 'result', toolId: 'toolu_2', text: 'boom', error: true })
  })
  it('skips subagent turns, meta lines, lines cut at a read boundary and lines without an id', () => {
    const text =
      user('s1', 'subagent prompt', { isSidechain: true }) +
      assistant('s2', [{ type: 'text', text: 'subagent reply' }], { isSidechain: true }) +
      user('m1', 'Caveat for the model', { isMeta: true }) +
      line({ type: 'user', message: { content: 'no uuid' } }) +
      '{"type":"assistant","uuid":"cut","message":{"content":[{"type":"te'
    expect(parseChatLines(text)).toEqual([])
  })
  it('shows a prompt that reached the model mid-turn (recorded only as a queued_command attachment)', () => {
    const q = (uuid: string, prompt: unknown): string => line({ type: 'attachment', uuid, timestamp: '2026-11-05T10:01:00.000Z', attachment: { type: 'queued_command', prompt, commandMode: 'prompt' } })
    const at = Date.parse('2026-11-05T10:01:00.000Z')
    const text =
      q('q1', 'also update the README') +
      q('q2', [{ type: 'text', text: 'see this' }, { type: 'image', source: {} }]) +
      q('q3', '<task-notification><summary>Agent finished</summary></task-notification>') +
      line({ type: 'attachment', uuid: 'x1', attachment: { type: 'file', filename: 'a.ts' } })
    expect(parseChatLines(text)).toEqual([
      { type: 'user', id: 'q1:0', at, text: 'also update the README' },
      { type: 'user', id: 'q2:0', at, text: 'see this\n[image]' },
      { type: 'note', id: 'q3:0', at, text: 'Agent finished' }
    ])
  })
  it('keeps a tool result that arrives on a meta line and marks compaction', () => {
    const text = user('m2', [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }], { isMeta: true }) + line({ type: 'system', subtype: 'compact_boundary', uuid: 'c1' }) + user('c2', 'This session is being continued…', { isCompactSummary: true })
    expect(parseChatLines(text)).toEqual([
      { type: 'result', toolId: 't9', text: 'ok', error: false },
      { type: 'note', id: 'c1', at: undefined, text: 'Conversation compacted' },
      { type: 'note', id: 'c2:0', at: Date.parse('2026-11-05T10:00:00.000Z'), text: 'Conversation compacted (the summary replaces the earlier turns)' }
    ])
  })
  it('cleans terminal codes and control characters, and caps long text', () => {
    expect(cleanChatText('a\x1b[31mred\x1b[0m\r\nb\tc\u202e\u0007')).toBe('ared\nb\tc')
    const big = 'x'.repeat(CHAT_LIMITS.toolResultChars + 500)
    const [r] = parseChatLines(user('u', [{ type: 'tool_result', tool_use_id: 't', content: big }]))
    expect(r.type === 'result' && r.text.length).toBeLessThan(big.length)
    expect(r.type === 'result' && r.text).toContain('500 more characters not shown')
  })
})

describe('applyChatEvents', () => {
  const tool = (toolId: string, id = toolId): ChatItem => ({ type: 'tool', id, toolId, name: 'Bash', summary: 'ls', input: '{}' })
  it('appends each item once and attaches a result to its call', () => {
    const a = applyChatEvents([], [{ type: 'user', id: 'u', text: 'hi' }, tool('t1')])
    const b = applyChatEvents(a, [{ type: 'user', id: 'u', text: 'hi' }, { type: 'result', toolId: 't1', text: 'out', error: false }])
    expect(b).toHaveLength(2)
    expect(b[1]).toMatchObject({ result: { text: 'out', error: false } })
    expect(b[0]).toBe(a[0]) // untouched rows keep their identity (no re-render)
  })
  it('ignores a result whose call was never seen, returns the same list when nothing came, and drops the oldest past the cap', () => {
    const a = applyChatEvents([], [{ type: 'user', id: 'u', text: 'hi' }])
    expect(applyChatEvents(a, [{ type: 'result', toolId: 'nope', text: 'x', error: false }])).toEqual(a)
    expect(applyChatEvents(a, [])).toBe(a)
    const many = applyChatEvents([], Array.from({ length: 10 }, (_, i): ChatItem => ({ type: 'note', id: `n${i}`, text: String(i) })), 4)
    expect(many.map((i) => i.id)).toEqual(['n6', 'n7', 'n8', 'n9'])
  })
  it('knows the call a waiting card asks about', () => {
    const items = applyChatEvents([], [{ type: 'assistant', id: 'a', text: 'running it' }, tool('t1')])
    expect(pendingTool(items)?.toolId).toBe('t1')
    expect(pendingTool(applyChatEvents(items, [{ type: 'result', toolId: 't1', text: '', error: false }]))).toBeUndefined()
    expect(pendingTool(applyChatEvents(items, [{ type: 'assistant', id: 'b', text: 'done' }]))).toBeUndefined()
    expect(pendingTool([])).toBeUndefined()
  })
})

describe('the composer', () => {
  it('refuses to type into a card that is not ready or is asking a question', () => {
    expect(composerBlock('idle', undefined)).toBeUndefined()
    expect(composerBlock('working', undefined)).toBeUndefined()
    expect(composerBlock('done', true)).toBeUndefined()
    expect(composerBlock('needs-you', undefined)).toContain('Answer it there first')
    expect(composerBlock('starting', undefined)).toContain('still starting')
    expect(composerBlock(undefined, undefined)).toContain('still starting')
    expect(composerBlock('ended', undefined)).toContain('not running')
    expect(composerBlock('idle', false)).toContain('not running')
  })
  it('confirms a sent prompt only from a prompt recorded after it was sent, one line per prompt', () => {
    const at = Date.parse('2026-11-05T10:00:00.000Z')
    const items: ChatItem[] = [{ type: 'user', id: 'u', at, text: 'fix   the\nmenu' }]
    const none = new Set<string>()
    expect(confirmPending([{ text: 'fix the menu', at: at - 1000 }], items, none).left).toEqual([])
    // the same words recorded before this prompt was sent: not this prompt
    expect(confirmPending([{ text: 'fix the menu', at: at + 60_000 }], items, none).left).toHaveLength(1)
    expect(confirmPending([{ text: 'something else', at }], items, none).left).toHaveLength(1)
    expect(confirmPending([{ text: 'fix the menu', at }], [{ type: 'assistant', id: 'a', at, text: 'fix the menu' }], none).left).toHaveLength(1)
    // a later, longer prompt does not stand in for a short one that never arrived
    expect(confirmPending([{ text: 'ok', at }], [{ type: 'user', id: 'u2', at: at + 9000, text: 'ok, now do X' }], none).left).toHaveLength(1)
    // "continue" sent twice, recorded once: the first is confirmed, the second stays; the line is not used again later
    const twice = [
      { text: 'continue', at },
      { text: 'continue', at: at + 3000 }
    ]
    const once: ChatItem[] = [{ type: 'user', id: 'c1', at: at + 100, text: 'continue' }]
    const r = confirmPending(twice, once, none)
    expect(r.left).toEqual([twice[1]])
    expect([...r.used]).toEqual(['c1'])
    expect(confirmPending(r.left, once, r.used).left).toEqual([twice[1]])
    expect(confirmPending(r.left, [...once, { type: 'user', id: 'c2', at: at + 3100, text: 'continue' }], r.used).left).toEqual([])
    // a long prompt is shown clipped: it still confirms
    const long = 'word '.repeat(40_000)
    const [shown] = parseChatLines(user('L', long))
    expect(confirmPending([{ text: long, at }], [shown as ChatItem], none).left).toEqual([])
  })
})

describe('tool lines', () => {
  it('summarise a call in one line', () => {
    expect(toolSummary('Bash', { command: 'git status\n&& ls', description: 'look' })).toBe('git status && ls')
    expect(toolSummary('Grep', { pattern: 'TODO', path: 'C:/repo/src' })).toBe('TODO in src')
    expect(toolSummary('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolSummary('TodoWrite', { todos: [1, 2, 3] })).toBe('3 item(s)')
    expect(toolSummary('mcp__ouroboros__send_message', { to: 'Conductor', body: 'done' })).toBe('Conductor')
    expect(toolSummary('Weird', null)).toBe('')
    expect(toolSummary('Bash', { command: 'x'.repeat(500) }).length).toBe(CHAT_LIMITS.summaryChars)
    expect(toolLabel('mcp__ouroboros__send_message')).toBe('ouroboros: send_message')
    expect(toolLabel('Bash')).toBe('Bash')
  })
})

describe('splitReply', () => {
  it('takes top-level mermaid and svg fences out as visuals', () => {
    const md = 'Three files:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nand a drawing:\n\n```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```\n\nDone.'
    expect(splitReply(md)).toEqual([
      { type: 'md', text: 'Three files:\n\n' },
      { type: 'mermaid', code: 'flowchart LR\n  A --> B' },
      { type: 'md', text: '\n\nand a drawing:\n\n' },
      { type: 'svg', code: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
      { type: 'md', text: '\n\nDone.' }
    ])
  })
  it('leaves other code, nested fences, non-svg "svg" blocks and oversized diagrams as markdown', () => {
    const plain = 'text\n\n```ts\nconst a = 1\n```'
    expect(splitReply(plain)).toEqual([{ type: 'md', text: plain }])
    const nested = '- item\n  ```mermaid\n  graph TD\n  ```'
    expect(splitReply(nested).every((p) => p.type === 'md')).toBe(true)
    expect(splitReply('```svg\nnot a drawing\n```').every((p) => p.type === 'md')).toBe(true)
    expect(splitReply('```mermaid\n' + 'A-->B\n'.repeat(CHAT_LIMITS.diagramChars) + '```').every((p) => p.type === 'md')).toBe(true)
    expect(splitReply('')).toEqual([{ type: 'md', text: '' }])
  })
})

describe('drawing rules', () => {
  it('lets a reference point only inside the drawing', () => {
    expect(localRef('#arrow')).toBe(true)
    expect(localRef(' #a-1.b ')).toBe(true)
    for (const bad of ['https://evil.example/x.svg#a', '//host/share/x.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file.svg#a', '#', '#a b', '']) expect(localRef(bad)).toBe(false)
  })
  it('refuses CSS that would load something', () => {
    for (const ok of ['fill:#fff;stroke:url(#grad)', 'url("#a")', '.node rect { fill: #1f2020; } /* url(x) in a comment */', 'M0 0L10 10', '']) expect(cssLoadsNothing(ok)).toBe(true)
    for (const bad of [
      'background:url(//host/share/x.png)',
      'fill: url( https://evil.example/a.svg#p )',
      '@import "https://evil.example/a.css";',
      'background-image: image-set("a.png" 1x)',
      'u\\72l(//host/x)',
      'width: expression(alert(1))',
      'url(#ok) url(http://x)',
      'URL(x.png)',
      'javascript:alert(1)'
    ])
      expect(cssLoadsNothing(bad)).toBe(false)
  })
})

describe('remoteFileUrl', () => {
  it('is a file: URL on another machine, and nothing else', () => {
    for (const bad of ['file://nas/share/x.png', 'file://127.0.0.1/c$/x', 'file://EVIL.example/a.css', 'FILE://host/x']) expect(remoteFileUrl(bad)).toBe(true)
    for (const ok of ['file:///C:/Users/me/app/index.html', 'file:///home/me/app/a.js', 'https://example.com/x', 'data:image/png;base64,AAAA', 'blob:file:///abc', 'devtools://devtools/x', 'not a url', '']) expect(remoteFileUrl(ok)).toBe(false)
    // the app itself installed on a share keeps loading its own files, and only its own
    expect(remoteFileUrl('file://nas/apps/ouroboros/index.html', 'NAS')).toBe(false)
    expect(remoteFileUrl('file://other/apps/x.png', 'nas')).toBe(true)
  })
  it('locks the Mermaid settings that put CSS or markup into a drawing', () => {
    for (const k of ['securityLevel', 'htmlLabels', 'themeCSS', 'fontFamily', 'themeVariables', 'dompurifyConfig']) expect(MERMAID_LOCKED).toContain(k)
  })
})

describe('plainMermaid', () => {
  it('makes markup in a diagram plain text and leaves Mermaid syntax alone', () => {
    expect(plainMermaid('A["<img src=x onerror=alert(1)>"] --> B')).toBe('A["&lt;img src=x onerror=alert(1)>"] --> B')
    expect(plainMermaid('A["x</b><script>1</script><!-- c --><?p?>"]')).toBe('A["x&lt;/b>&lt;script>1&lt;/script>&lt;!-- c -->&lt;?p?>"]')
    const fine = 'flowchart LR\n  A["one<br/>two<br>three<BR />four"] <--> B{"a < b"}\n  B -->|yes| C\n  X <|-- Y\n  class S {\n    <<interface>>\n  }\n  P->>Q: hi'
    expect(plainMermaid(fine)).toBe(fine)
  })
})

describe('readChat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-chat-'))
  const file = join(dir, 's.jsonl')
  it('reads a conversation, then only what was added, and waits for a line still being written', async () => {
    writeFileSync(file, user('u1', 'first') + assistant('a1', [{ type: 'text', text: 'reply' }]))
    const first = await readChat(file, undefined)
    expect(first).toMatchObject({ ok: true, key: file, reset: true })
    expect(first.clipped).toBeUndefined()
    expect(first.events.map((e) => e.type)).toEqual(['user', 'assistant'])
    const half = user('u2', 'second')
    appendFileSync(file, half.slice(0, 30))
    const mid = await readChat(file, { key: first.key, offset: first.offset })
    expect(mid).toMatchObject({ ok: true, reset: false, offset: first.offset, events: [] })
    appendFileSync(file, half.slice(30))
    const next = await readChat(file, { key: first.key, offset: mid.offset })
    expect(next.events).toMatchObject([{ type: 'user', text: 'second' }])
    expect((await readChat(file, { key: first.key, offset: next.offset })).events).toEqual([])
  })
  it('starts over for another file, a replaced file and a nonsense cursor', async () => {
    writeFileSync(file, user('u1', 'only'))
    for (const cursor of [{ key: join(dir, 'other.jsonl'), offset: 10 }, { key: file, offset: 999_999 }, { key: file, offset: -1 }, { key: file, offset: 1.5 }]) {
      const r = await readChat(file, cursor)
      expect(r).toMatchObject({ ok: true, reset: true })
      expect(r.events).toHaveLength(1)
    }
  })
  it('reads only the end of a long conversation and says so', async () => {
    writeFileSync(file, Array.from({ length: 50 }, (_, i) => user(`u${i}`, `prompt ${i} ${'.'.repeat(100)}`)).join(''))
    const r = await readChat(file, undefined, 2000)
    expect(r).toMatchObject({ ok: true, reset: true, clipped: true })
    expect(r.events.length).toBeGreaterThan(0)
    expect(r.events.length).toBeLessThan(50)
    expect(r.events.at(-1)).toMatchObject({ text: expect.stringContaining('prompt 49') })
    expect(r.events[0]).toMatchObject({ type: 'user' }) // the line the read started inside is not shown as garbage
  })
  it('keeps the first line when a clipped read starts exactly on a line boundary', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => user(`b${i}`, `boundary ${i}`))
    writeFileSync(file, lines.join(''))
    const r = await readChat(file, undefined, Buffer.byteLength(lines.slice(3).join('')))
    expect(r.clipped).toBe(true)
    expect(r.more).toBeUndefined()
    expect(r.events.map((e) => (e.type === 'user' ? e.text : ''))).toEqual(['boundary 3', 'boundary 4', 'boundary 5'])
  })
  it('catches up in steps and steps over an entry larger than a read, saying so', async () => {
    writeFileSync(file, user('u1', 'before'))
    const first = await readChat(file, undefined, 4000)
    appendFileSync(file, user('big', 'B'.repeat(9000)) + user('u2', 'after'))
    const events = []
    let cursor = { key: first.key, offset: first.offset }
    let more = true
    for (let i = 0; i < 10 && more; i++) {
      const r = await readChat(file, cursor, 4000)
      expect(r.ok).toBe(true)
      expect(r.reset).toBe(false)
      events.push(...r.events)
      cursor = { key: r.key, offset: r.offset }
      more = r.more === true
    }
    expect(more).toBe(false)
    expect(events.some((e) => e.type === 'note' && /very large entry/.test(e.text))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'user', text: 'after' })
    expect(events.some((e) => e.type === 'user' && e.text.startsWith('BBB'))).toBe(false)
  })
  it('says why when the file cannot be read', async () => {
    const r = await readChat(join(dir, 'missing.jsonl'), undefined)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ENOENT')
    rmSync(dir, { recursive: true, force: true })
  })
})
