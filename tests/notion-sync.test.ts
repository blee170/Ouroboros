import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { TASK_SCHEMA, UPDATE_SCHEMA, taskProperties, taskQuery, updateProperties } from '../src/shared/notion'
import { changelogSection } from '../src/shared/changelog'
import { forgetDataSources, publishUpdate, rememberDataSource, testNotion, upsertTask } from '../src/main/notion'
import { NotionMap, TaskSync } from '../src/main/notion-sync'
import type { Task } from '../src/shared/ledger'
import changelog from '../CHANGELOG.md?raw'

const T0 = 1_800_000_000_000
const DB = '3ff04ad6-43a8-41b1-8ef6-5bcf8c96a81d'
const PAGE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PAGE2 = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
const DS = 'cccccccc-1111-2222-3333-444444444444'
beforeEach(() => {
  forgetDataSources()
  rememberDataSource(DB, DS)
})

type Call = { method: string; path: string; body: Record<string, unknown> }
/** A fetch that answers each call from the queue in order and records what was sent. */
function fakeFetch(answers: Array<[number, unknown]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), path: url.replace('https://api.notion.com/v1', ''), body: init.body ? JSON.parse(String(init.body)) : {} })
    const [status, body] = answers.shift() ?? [500, { message: 'no answer queued' }]
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

const row = { id: 'T3', title: 'Ship the gate', state: 'done', owner: 'Chief', result: 'merged', updatedAt: T0 }

describe('task and update properties', () => {
  it('maps a task to every Tasks column', () => {
    const p = taskProperties(row, 'Ouro,boros') as Record<string, Record<string, unknown>>
    expect(Object.keys(p).sort()).toEqual(Object.keys(TASK_SCHEMA).sort())
    expect(p.Project).toEqual({ select: { name: 'Ouro boros' } })
    expect(p.State).toEqual({ select: { name: 'done' } })
    expect(p.Reason).toEqual({ rich_text: [] })
    expect(p.Updated).toEqual({ date: { start: new Date(T0).toISOString() } })
    expect(taskQuery('T3', 'Ouro,boros')).toEqual({ filter: { and: [{ property: 'Task ID', rich_text: { equals: 'T3' } }, { property: 'Project', select: { equals: 'Ouro boros' } }] }, page_size: 1 })
  })
  it('maps a version to every Updates column, with today when the heading has no date', () => {
    const p = updateProperties('0.9.0', undefined, 'Mail · Gates', T0) as Record<string, unknown>
    expect(Object.keys(p).sort()).toEqual(Object.keys(UPDATE_SCHEMA).sort())
    expect(p.Date).toEqual({ date: { start: new Date(T0).toISOString().slice(0, 10) } })
    expect((updateProperties('0.9.0', '2026-10-26', '') as Record<string, unknown>).Date).toEqual({ date: { start: '2026-10-26' } })
  })
})

describe('changelogSection', () => {
  it('cuts one version out of the real changelog', () => {
    const s = changelogSection(changelog, '0.8.4')
    expect(s?.date).toBe('2026-10-25')
    expect(s?.body.startsWith('### Security')).toBe(true)
    expect(s?.body).not.toContain('## [0.8.3]')
    expect(s?.highlights).toBe('One token per card, and hooks need it')
  })
  it('takes highlights from the change sections only', () => {
    expect(changelogSection(changelog, '0.15.0')?.highlights).toBe('Ouro: work the board from the car through Discord · Settings is a section list instead of one long scroll')
    const s = changelogSection(changelog, '0.16.0')?.highlights ?? ''
    expect(s).toContain("Ouro can tell you it's ready when you get in the car")
    expect(s).toContain('Phone Graph and Orbit: teams in colour, status as a ring')
    expect(s).not.toMatch(/About 75 s|Repeat calls|Live probe|Built-app probe|The 75 s timing/)
  })
  it('knows no section for a version that has none', () => {
    expect(changelogSection(changelog, '9.9.9')).toBeUndefined()
    expect(changelogSection('## [0.8.40] — 2026-01-01\n- x', '0.8.4')).toBeUndefined()
  })
})

describe('upsertTask', () => {
  const target = (f: typeof fetch) => ({ token: 'ntn_secret', databaseId: DB, fetch: f })
  it('updates the cached page', async () => {
    const { fetch, calls } = fakeFetch([[200, { id: PAGE }]])
    expect(await upsertTask(target(fetch), row, 'p', PAGE)).toEqual({ ok: true, pageId: PAGE })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH /pages/${PAGE}`])
  })
  it('finds the row again when the cached page was deleted, else creates it', async () => {
    const a = fakeFetch([[404, { message: 'gone' }], [200, { results: [{ id: PAGE2 }] }], [200, { id: PAGE2 }]])
    expect(await upsertTask(target(a.fetch), row, 'p', PAGE)).toEqual({ ok: true, pageId: PAGE2 })
    expect(a.calls.map((c) => c.method + ' ' + c.path)).toEqual([`PATCH /pages/${PAGE}`, `POST /data_sources/${DS}/query`, `PATCH /pages/${PAGE2}`])
    const b = fakeFetch([[200, { results: [] }], [200, { id: PAGE }]])
    expect(await upsertTask(target(b.fetch), row, 'p')).toEqual({ ok: true, pageId: PAGE })
    expect(b.calls[1].body.parent).toEqual({ type: 'data_source_id', data_source_id: DS })
  })
  it('creates anew when the cached page is archived and the query finds only it', async () => {
    const { fetch, calls } = fakeFetch([[400, { message: "Can't edit block that is archived." }], [200, { results: [{ id: PAGE }] }], [200, { id: PAGE2 }]])
    expect(await upsertTask(target(fetch), row, 'p', PAGE)).toEqual({ ok: true, pageId: PAGE2 })
    expect(calls[2].path).toBe('/pages')
  })
  it("creates a project's first row when Notion doesn't know the project option yet", async () => {
    const msg = 'select option "chill-shuttle" not found for property "Project". Available options: "Ouroboros".'
    const { fetch, calls } = fakeFetch([[400, { message: msg }], [200, { id: PAGE }]])
    expect(await upsertTask(target(fetch), row, 'chill-shuttle')).toEqual({ ok: true, pageId: PAGE })
    expect(calls.map((c) => c.method + ' ' + c.path)).toEqual([`POST /data_sources/${DS}/query`, 'POST /pages'])
    expect((calls[1].body.properties as Record<string, unknown>).Project).toEqual({ select: { name: 'chill-shuttle' } })
    // any other 400 on the query still fails
    const b = fakeFetch([[400, { message: 'Could not find property with name or id: Project' }]])
    expect(await upsertTask(target(b.fetch), row, 'chill-shuttle')).toMatchObject({ ok: false, status: 400, stage: 'query' })
  })
  it('passes a rate limit or a bad token through with its status', async () => {
    const a = fakeFetch([[429, {}]])
    expect(await upsertTask(target(a.fetch), row, 'p', PAGE)).toMatchObject({ ok: false, status: 429 })
    const b = fakeFetch([[401, {}]])
    expect(await upsertTask(target(b.fetch), row, 'p')).toMatchObject({ ok: false, status: 401 })
  })
})

describe('publishUpdate and testNotion schemas', () => {
  it('publishes the notes as one page', async () => {
    const { fetch, calls } = fakeFetch([[200, { results: [] }], [200, { id: PAGE, url: 'https://notion.so/x' }]])
    const r = await publishUpdate({ token: 't', databaseId: DB, fetch }, '0.8.4', '2026-10-25', 'One token', '### Security\n- **One token per card**')
    expect(r).toEqual({ ok: true, url: 'https://notion.so/x' })
    expect(calls[0].body.filter).toEqual({ property: 'Name', title: { equals: '0.8.4' } })
    expect((calls[1].body.children as unknown[]).length).toBe(2)
    const again = fakeFetch([[200, { results: [{ id: PAGE, url: 'https://notion.so/x' }] }]])
    expect(await publishUpdate({ token: 't', databaseId: DB, fetch: again.fetch }, '0.8.4', undefined, '', 'x')).toEqual({ ok: true, url: 'https://notion.so/x', partial: 'already published' })
    expect(again.calls).toHaveLength(1)
  })
  it('names the columns a Tasks database lacks', async () => {
    const { fetch, calls } = fakeFetch([[200, { title: [{ plain_text: 'Tasks' }], data_sources: [{ id: DS }] }], [200, { properties: { Name: { type: 'title' } } }]])
    const r = await testNotion({ token: 't', databaseId: DB, fetch }, TASK_SCHEMA, 'a task row')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/Task ID \(rich_text\).*a task row would be refused/)
    expect(calls.map((c) => c.path)).toEqual([`/databases/${DB}`, `/data_sources/${DS}`])
  })
})

describe('TaskSync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-notion-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const task = (id: string, updatedAt: number, extra: Partial<Task> = {}): Task => ({ id, title: id, state: 'todo', deps: [], createdBy: 'owner', createdAt: T0, updatedAt, ...extra })

  it('sends only tasks that changed since their last sync, and keeps the map on disk', async () => {
    const file = join(dir, 'map.json')
    const sent: string[] = []
    const failed: string[] = []
    const sync = new TaskSync({
      target: () => ({ token: 't', databaseId: DB }),
      project: () => 'p',
      ownerTitle: (id) => (id === 'c1' ? 'Chief' : undefined),
      map: new NotionMap(file),
      log: () => {},
      failed: (e) => failed.push(e),
      spacingMs: 0,
      upsert: async (_t, r, _p, cached) => (sent.push(`${r.id}:${r.owner ?? ''}:${cached ?? ''}`), { ok: true, pageId: r.id === 'T1' ? PAGE : PAGE2 })
    })
    await sync.run([task('T1', 1, { owner: 'c1' }), task('T2', 1)])
    expect(sent).toEqual(['T1:Chief:', 'T2::'])
    await sync.run([task('T1', 1), task('T2', 2)])
    expect(sent.slice(2)).toEqual([`T2::${PAGE2}`])
    expect(JSON.parse(readFileSync(file, 'utf8')).entries[`${DB}|p|T1`]).toEqual({ pageId: PAGE, synced: 1 })
    // a fresh map from the file knows both rows
    expect(new NotionMap(file).get(`${DB}|p|T2`)).toEqual({ pageId: PAGE2, synced: 2 })
    sync.dispose()
    expect(failed).toEqual([])
  })

  it('skips a refused task, stops on a bad token, and says why once per round', async () => {
    const failed: string[] = []
    const sent: string[] = []
    const answers: Record<string, { ok: false; error: string; status: number }> = { T1: { ok: false, error: 'bad property', status: 400 }, T3: { ok: false, error: 'Notion rejected the token (401)', status: 401 } }
    const sync = new TaskSync({
      target: () => ({ token: 't', databaseId: DB }),
      project: () => 'p',
      ownerTitle: () => undefined,
      map: new NotionMap(join(dir, 'm2.json')),
      log: () => {},
      failed: (e) => failed.push(e),
      spacingMs: 0,
      upsert: async (_t, r) => (sent.push(r.id), answers[r.id] ?? { ok: true, pageId: 'x' })
    })
    await sync.run([task('T1', 1), task('T2', 1), task('T3', 1), task('T4', 1)])
    expect(sent).toEqual(['T1', 'T2', 'T3'])
    expect(failed).toEqual(['task T1 was refused: bad property', 'Notion rejected the token (401)'])
    // the refused task waits for its next change; T3 and T4 are retried
    sent.length = 0
    delete answers.T3
    await sync.run()
    expect(sent).toEqual(['T3', 'T4'])
    sync.dispose()
  })

  it('does nothing when off, and reports a setup error', async () => {
    const failed: string[] = []
    let calls = 0
    const deps = { project: () => 'p', ownerTitle: () => undefined, map: new NotionMap(join(dir, 'm3.json')), log: () => {}, failed: (e: string) => failed.push(e), spacingMs: 0, upsert: async () => (calls++, { ok: true as const, pageId: 'x' }) }
    const off = new TaskSync({ ...deps, target: () => undefined })
    await off.run([task('T1', 1)])
    const broken = new TaskSync({ ...deps, target: () => ({ error: 'no Notion token in Settings → Notion' }) })
    await broken.run([task('T1', 1)])
    expect(calls).toBe(0)
    expect(failed).toEqual(['no Notion token in Settings → Notion'])
    off.dispose()
    broken.dispose()
  })

  it('backs off on a rate limit and tries again later', async () => {
    const sync = new TaskSync({
      target: () => ({ token: 't', databaseId: DB }),
      project: () => 'p',
      ownerTitle: () => undefined,
      map: new NotionMap(join(dir, 'm4.json')),
      log: () => {},
      failed: () => {},
      spacingMs: 0,
      retryMs: 5,
      upsert: (() => {
        let n = 0
        return async () => (n++ === 0 ? { ok: false as const, error: 'rate', status: 429 } : { ok: true as const, pageId: 'x' })
      })()
    })
    const sent: number[] = []
    const orig = sync.schedule.bind(sync)
    sync.schedule = (tasks, delay) => (sent.push(delay ?? -1), orig(tasks, delay))
    await sync.run([task('T1', 1)])
    expect(sent).toEqual([5])
    sync.dispose()
  })
})

describe('TaskSync after review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-notion2-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const task = (id: string, updatedAt: number): Task => ({ id, title: id, state: 'todo', deps: [], createdBy: 'owner', createdAt: T0, updatedAt })
  const make = (upsert: NonNullable<ConstructorParameters<typeof TaskSync>[0]['upsert']>, extra: Partial<ConstructorParameters<typeof TaskSync>[0]> = {}) => {
    const failed: string[] = []
    const sync = new TaskSync({ target: () => ({ token: 't', databaseId: DB }), project: () => 'p', ownerTitle: () => undefined, map: new NotionMap(join(dir, `m${Math.random()}.json`)), log: () => {}, failed: (e) => failed.push(e), spacingMs: 0, upsert, ...extra })
    return { sync, failed }
  }

  it('keeps tasks from an unvouched board out until they change here', async () => {
    const sent: string[] = []
    const { sync } = make(async (_t, r) => (sent.push(`${r.id}@${r.updatedAt}`), { ok: true, pageId: PAGE }))
    sync.hold([task('T1', 1), task('T2', 1)])
    await sync.run([task('T1', 1), task('T2', 2), task('T3', 1)])
    expect(sent).toEqual(['T2@2', 'T3@1'])
    sync.dispose()
  })

  it('does not mark the ledger synced when the database itself refuses (a renamed column)', async () => {
    let n = 0
    const { sync } = make(async () => (n++, { ok: false, error: 'Notion 400: Task ID is not a property that exists.', status: 400, stage: 'query' as const }), { retryMs: 60_000 })
    await sync.run([task('T1', 1), task('T2', 1)])
    expect(n).toBe(1)
    await sync.run()
    expect(n).toBe(2) // still due: nothing was hidden in the map
    sync.dispose()
  })

  it('retries a Notion outage, a conflict or the network, not a refused token', async () => {
    for (const [status, retried] of [[503, true], [409, true], [undefined, true], [401, false]] as const) {
      const delays: number[] = []
      const { sync } = make(async () => ({ ok: false, error: 'x', status }), { retryMs: 60_000 })
      const orig = sync.schedule.bind(sync)
      sync.schedule = (tasks, delay) => (delays.push(delay ?? -1), orig(tasks, delay))
      await sync.run([task('T1', 1)])
      expect(delays.length > 0).toBe(retried)
      sync.dispose()
    }
  })

  it('treats a throw as a refused task and goes on', async () => {
    const sent: string[] = []
    const { sync, failed } = make(async (_t, r) => {
      sent.push(r.id)
      if (r.id === 'T1') throw new RangeError('Invalid time value')
      return { ok: true, pageId: PAGE }
    })
    await sync.run([task('T1', 1), task('T2', 1)])
    expect(sent).toEqual(['T1', 'T2'])
    expect(failed[0]).toMatch(/T1 was refused: Invalid time value/)
    sync.dispose()
  })

  it('syncs a busy ledger at least every maxWait, and drops a page id of the wrong shape from the map', async () => {
    let runs = 0
    const { sync } = make(async () => (runs++, { ok: true, pageId: PAGE }), { debounceMs: 40, maxWaitMs: 60 })
    for (let i = 0; i < 8; i++) {
      sync.schedule([task('T1', i + 1)])
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(runs).toBeGreaterThan(0)
    sync.dispose()
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify({ entries: { a: { pageId: '../databases/x', synced: 1 }, b: { pageId: PAGE, synced: 1 } } }))
    const m = new NotionMap(file)
    expect(m.get('a')).toBeUndefined()
    expect(m.get('b')).toEqual({ pageId: PAGE, synced: 1 })
  })
})
