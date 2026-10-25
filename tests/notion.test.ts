import { describe, expect, it } from 'vitest'
import { NOTION_CHILDREN_MAX, NOTION_TEXT_MAX, chunkBlocks, notionDatabaseId, reportBlocks, reportProperties, reportTitle, richText, tableCells } from '../src/shared/notion'
import { NOTION_VERSION, REPORT_SCHEMA, publishReport, scrub, testNotion } from '../src/main/notion'
import { newRunState, reportMarkdown } from '../src/shared/autonomy'
import type { AgentSnapshot } from '../src/shared/types'

const T0 = 1_800_000_000_000

const meta = { project: 'Ouroboros', startedAt: T0, endedAt: T0 + 4 * 3_600_000, reason: 'deadline reached', waiting: 2, dispatches: 5, reportPath: 'C:\\data\\run.md' }

describe('notionDatabaseId', () => {
  it('takes a URL, a dashed id or a bare id and gives the dashed form', () => {
    const dashed = '3ff04ad6-43a8-41b1-8ef6-5bcf8c96a81d'
    expect(notionDatabaseId('https://app.notion.com/p/3ff04ad643a841b18ef65bcf8c96a81d?pvs=204')).toBe(dashed)
    expect(notionDatabaseId('https://www.notion.so/brian/Reports-3ff04ad643a841b18ef65bcf8c96a81d?v=0123456789abcdef0123456789abcdef')).toBe(dashed)
    expect(notionDatabaseId(` ${dashed} `)).toBe(dashed)
    expect(notionDatabaseId('3FF04AD643A841B18EF65BCF8C96A81D')).toBe(dashed)
    expect(notionDatabaseId('not an id')).toBeUndefined()
    expect(notionDatabaseId(undefined)).toBeUndefined()
    expect(notionDatabaseId('3ff04ad643a841b18ef65bcf8c96a81')).toBeUndefined() // 31 hex
  })
})

describe('richText and tables', () => {
  it('marks bold and code runs, leaves the rest plain', () => {
    expect(richText('Ended: **deadline** · `git push`')).toEqual([
      { type: 'text', text: { content: 'Ended: ' } },
      { type: 'text', text: { content: 'deadline' }, annotations: { bold: true } },
      { type: 'text', text: { content: ' · ' } },
      { type: 'text', text: { content: 'git push' }, annotations: { code: true } }
    ])
  })
  it('splits a long run at the 2000-character limit and never sends an empty array', () => {
    const runs = richText('x'.repeat(NOTION_TEXT_MAX * 2 + 5))
    expect(runs.map((r) => r.text.content.length)).toEqual([2000, 2000, 5])
    expect(richText('')).toEqual([{ type: 'text', text: { content: '' } }])
  })
  it('sends a line with over 100 formatting runs plain', () => {
    const runs = richText(Array.from({ length: 101 }, () => '`x`').join(' '))
    expect(runs).toHaveLength(1)
    expect(runs[0].annotations).toBeUndefined()
  })
  it('reads escaped pipes inside cells the way the report writes them', () => {
    expect(tableCells('| a \\| b | c\\\\d | — |')).toEqual(['a | b', 'c\\d', '—'])
  })
})

describe('reportBlocks', () => {
  it('turns the real morning report into headings, bullets, tables and paragraphs', () => {
    const state = newRunState({ until: T0 + 3_600_000, maxDispatches: 5, maxRetriesPerTitle: 3, stallMinutes: 10 }, T0)
    state.stopped = { at: T0 + 60_000, reason: 'deadline reached' }
    state.parked = { w1: { at: T0, title: 'Reviewer | lead', reason: 'asked: which branch?' } }
    const agents: AgentSnapshot[] = [{ id: 'w1', kind: 'claude', title: 'Reviewer | lead', cwd: 'C:/p', status: 'needs-you', ptyAlive: true, lastAssistantMessage: 'Which branch?\nsecond line' }]
    const md = reportMarkdown(state, [{ at: T0, kind: 'start', detail: 'until …' }], agents, { w1: { branch: 'main', added: 3, removed: 1, files: 1 } })
    const blocks = reportBlocks(md)
    const kinds = blocks.map((b) => b.type)
    expect(kinds[0]).toBe('heading_1')
    expect(kinds).toContain('heading_2')
    expect(kinds).toContain('bulleted_list_item')
    expect(kinds.filter((k) => k === 'table')).toHaveLength(1) // the Cards table (no tasks given)
    const table = blocks.find((b) => b.type === 'table') as unknown as { table: { table_width: number; children: Array<{ table_row: { cells: unknown[][] } }> } }
    expect(table.table.table_width).toBe(4)
    expect(table.table.children).toHaveLength(2) // header + one card; the |---| separator is dropped
    expect(table.table.children[1].table_row.cells).toHaveLength(4)
    expect(JSON.stringify(table.table.children[1].table_row.cells[0])).toContain('Reviewer | lead')
    const last = blocks[blocks.length - 1] as unknown as { paragraph: { rich_text: Array<{ annotations?: { italic?: boolean } }> } }
    expect(last.paragraph.rich_text[0].annotations).toEqual({ italic: true })
    expect(blocks.every((b) => !JSON.stringify(b).includes('\n'))).toBe(true)
  })
  it('pads ragged rows, splits a long table, and keeps every request under 100 children', () => {
    const rows = ['| a | b |', '|---|---|', ...Array.from({ length: 250 }, (_, i) => (i % 2 ? `| r${i} |` : `| r${i} | x | extra |`))]
    const blocks = reportBlocks(rows.join('\n'))
    const tables = blocks.filter((b) => b.type === 'table') as unknown as Array<{ table: { table_width: number; children: unknown[] } }>
    expect(tables).toHaveLength(3)
    expect(tables.every((t) => t.table.children.length <= NOTION_CHILDREN_MAX)).toBe(true)
    expect(tables.every((t) => t.table.table_width === 3)).toBe(true)
    expect(tables.reduce((n, t) => n + t.table.children.length, 0)).toBe(250 + 3) // one header per table
    const many = Array.from({ length: 205 }, (_, i) => `- line ${i}`).join('\n')
    const chunks = chunkBlocks(reportBlocks(many))
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 5])
  })
})

describe('reportProperties', () => {
  it('names the row and fills every property the database has', () => {
    expect(reportTitle(meta)).toMatch(/^Ouroboros · \d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{2}:\d{2}$/)
    const p = reportProperties({ ...meta, project: 'a,b' })
    expect(Object.keys(p).sort()).toEqual(['Date', 'Dispatches', 'Ended', 'Name', 'Project', 'Report file', 'Status', 'Waiting on you'].sort())
    expect(p.Project).toEqual({ select: { name: 'a b' } }) // commas are not allowed in select names
    expect(p.Status).toEqual({ status: { name: 'New' } })
    expect(p['Waiting on you']).toEqual({ number: 2 })
    expect(p.Date).toEqual({ date: { start: new Date(T0).toISOString() } })
  })
})

type Call = { url: string; init: RequestInit }
function fakeFetch(handler: (c: Call, n: number) => Response | Promise<Response> | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} }
    calls.push(c)
    const r = handler(c, calls.length)
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
  return { fetch: f, calls }
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const TOKEN = 'ntn_SECRETTOKENVALUE123'
const DB = '3ff04ad6-43a8-41b1-8ef6-5bcf8c96a81d'

describe('publishReport', () => {
  it('creates the page with properties and the first 100 blocks, appends the rest, returns the URL', async () => {
    const { fetch, calls } = fakeFetch((c) => (c.url.endsWith('/pages') ? json(200, { id: '11111111-2222-3333-4444-555555555555', url: 'https://www.notion.so/page1' }) : json(200, { results: [] })))
    const md = Array.from({ length: 150 }, (_, i) => `- line ${i}`).join('\n')
    const r = await publishReport({ token: TOKEN, databaseId: DB, markdown: md, meta, fetch })
    expect(r).toEqual({ ok: true, url: 'https://www.notion.so/page1' })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://api.notion.com/v1/pages')
    const h = calls[0].init.headers as Record<string, string>
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(h['Notion-Version']).toBe(NOTION_VERSION)
    const body = JSON.parse(String(calls[0].init.body)) as { parent: unknown; properties: Record<string, unknown>; children: unknown[] }
    expect(body.parent).toEqual({ database_id: DB })
    expect(body.properties.Status).toEqual({ status: { name: 'New' } })
    expect(body.children).toHaveLength(100)
    expect(calls[1].url).toBe('https://api.notion.com/v1/blocks/11111111-2222-3333-4444-555555555555/children')
    expect(calls[1].init.method).toBe('PATCH')
    expect((JSON.parse(String(calls[1].init.body)) as { children: unknown[] }).children).toHaveLength(50)
  })
  it('says what went wrong on 401, 404 and 429 without throwing or echoing the token', async () => {
    for (const [status, re] of [
      [401, /rejected the token/],
      [404, /share the database/],
      [429, /rate limit/]
    ] as const) {
      const { fetch } = fakeFetch(() => json(status, { object: 'error', message: `bad ${TOKEN}` }))
      const r = await publishReport({ token: TOKEN, databaseId: DB, markdown: '# x', meta, fetch })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toMatch(re)
        expect(r.error).not.toContain(TOKEN)
      }
    }
  })
  it('passes Notion\'s own message for other statuses, scrubbed, and reports a network error', async () => {
    const bad = fakeFetch(() => json(400, { message: `body.children[3] is invalid (token ${TOKEN})` }))
    const r1 = await publishReport({ token: TOKEN, databaseId: DB, markdown: '# x', meta, fetch: bad.fetch })
    expect(r1).toEqual({ ok: false, error: 'Notion 400: body.children[3] is invalid (token [token])' })
    const down = fakeFetch(() => new TypeError(`fetch failed ${TOKEN}`, { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.notion.com'), { code: 'ENOTFOUND' }) }))
    const r2 = await publishReport({ token: TOKEN, databaseId: DB, markdown: '# x', meta, fetch: down.fetch })
    expect(r2).toEqual({ ok: false, error: 'Notion unreachable: fetch failed [token] (ENOTFOUND)' })
    // a token of another shape is scrubbed by value, not by pattern
    const odd = fakeFetch(() => new TypeError('Headers.append: "Bearer mytoken" is an invalid header value'))
    expect(await publishReport({ token: 'mytoken', databaseId: DB, markdown: '# x', meta, fetch: odd.fetch })).toEqual({ ok: false, error: 'Notion unreachable: Headers.append: "Bearer [token]" is an invalid header value' })
    const html = fakeFetch(() => new Response('<html>gateway</html>', { status: 502 }))
    expect(await publishReport({ token: TOKEN, databaseId: DB, markdown: '# x', meta, fetch: html.fetch })).toEqual({ ok: false, error: 'Notion 502' })
  })
  it('keeps the page when an append fails and says how much is there', async () => {
    const { fetch } = fakeFetch((c, n) => (n === 1 ? json(200, { id: '11111111222233334444555555555555', url: 'u' }) : json(429, {})))
    const md = Array.from({ length: 150 }, (_, i) => `- ${i}`).join('\n')
    const r = await publishReport({ token: TOKEN, databaseId: DB, markdown: md, meta, fetch })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.partial).toMatch(/first 100 blocks.*429/)
  })
  it('does not PATCH a path from a page id that is not an id', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { id: '../../evil', url: 'u' }))
    const md = Array.from({ length: 150 }, (_, i) => `- ${i}`).join('\n')
    const r = await publishReport({ token: TOKEN, databaseId: DB, markdown: md, meta, fetch })
    expect(calls).toHaveLength(1)
    expect(r).toEqual({ ok: true, url: 'u', partial: expect.stringMatching(/no page id/) })
    // no id and no url: the page may not exist; not a success
    const none = fakeFetch(() => new Response('ok', { status: 200 }))
    expect(await publishReport({ token: TOKEN, databaseId: DB, markdown: '# x', meta, fetch: none.fetch })).toEqual({ ok: false, error: 'Notion answered without a page id' })
  })
  it('testNotion reads the database title', async () => {
    const props = Object.fromEntries(Object.entries(REPORT_SCHEMA).map(([k, type]) => [k, { type }]))
    const { fetch, calls } = fakeFetch(() => json(200, { title: [{ plain_text: 'Rep' }, null, { plain_text: 'orts' }], properties: props }))
    expect(await testNotion({ token: TOKEN, databaseId: DB, fetch })).toEqual({ ok: true, title: 'Reports' })
    // a database without the properties a report sets, or with the wrong type: said at Test time, not at the end of the night
    const bad = fakeFetch(() => json(200, { title: [{ plain_text: 'Other' }], properties: { ...props, Status: { type: 'select' }, Dispatches: undefined } }))
    expect(await testNotion({ token: TOKEN, databaseId: DB, fetch: bad.fetch })).toEqual({ ok: false, error: 'database "Other" lacks Dispatches (number), Status (status): a run\'s report would be refused' })
    expect(calls[0].url).toBe(`https://api.notion.com/v1/databases/${DB}`)
    expect(calls[0].init.method).toBe('GET')
    expect(scrub('secret_abc ntn_def x')).toBe('[token] [token] x')
  })
})
