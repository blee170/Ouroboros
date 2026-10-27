/**
 * Publishes the morning report to the owner's Notion "Reports" database over the REST API, with the
 * integration token from Settings. No Electron here: the token and the fetch are passed in, so the
 * paths (success, 401, 404, 429, network) run under vitest. Nothing here throws; nothing here logs the token.
 */
import { chunkBlocks, reportBlocks, reportProperties, taskProperties, taskQuery, updateProperties, viewBody, type NotionBlock, type ReportMeta, type TaskRow, type ViewSpec } from '@shared/notion'

export const NOTION_API = 'https://api.notion.com/v1'
/** 2026-03-11: rows live in a database's data source (2025-09-03), and views can be created (`POST /views`). */
export const NOTION_VERSION = '2026-03-11'
const TIMEOUT_MS = 15_000

export type NotionResult = { ok: true; url: string; partial?: string } | { ok: false; error: string }

export interface NotionTarget {
  token: string
  databaseId: string
  fetch?: typeof fetch
}

export interface PublishInput extends NotionTarget {
  markdown: string
  meta: ReportMeta
}

/** Anything that looks like a Notion token is never echoed, whatever Notion or a thrown error put in its text. */
export function scrub(s: string): string {
  return s.replace(/\b(?:ntn_|secret_)[A-Za-z0-9]+/g, '[token]')
}

function describe(status: number, body: unknown): string {
  const msg = typeof body === 'object' && body && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : ''
  if (status === 401) return 'Notion rejected the token (401): check it in Settings → Notion'
  if (status === 404) return 'Notion could not find it (404): check the database id, and share the database with the integration (⋯ → Connections)'
  if (status === 429) return 'Notion rate limit (429): nothing was written this time; try again in a minute (local files are complete)'
  return `Notion ${status}${msg ? `: ${scrub(msg).slice(0, 200)}` : ''}`
}

async function call(target: NotionTarget, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const f = target.fetch ?? fetch
  try {
    const res = await f(NOTION_API + path, {
      method,
      headers: { Authorization: `Bearer ${target.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    let json: Record<string, unknown> = {}
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      /* a body that is not JSON: the status is the answer */
    }
    // a 404 on the data source (a query, a new row in it) may mean it was replaced: look it up again next time;
    // a 404 on one page is that row gone, not the data source
    if (res.status === 404 && (path.startsWith('/data_sources/') || (method === 'POST' && path === '/pages'))) dataSources.delete(target.databaseId)
    if (!res.ok) return { ok: false, error: describe(res.status, json), status: res.status }
    return { ok: true, json }
  } catch (err) {
    // undici keeps the reason (ENOTFOUND, ECONNRESET, a redirect refused) in err.cause
    const cause = err instanceof Error && err.cause && typeof err.cause === 'object' ? ((err.cause as { code?: string; message?: string }).code ?? (err.cause as { message?: string }).message) : undefined
    const m = `${err instanceof Error ? err.message : String(err)}${cause ? ` (${cause})` : ''}`
    return { ok: false, error: `Notion unreachable: ${scrub(m.split(target.token).join('[token]')).slice(0, 200)}` }
  }
}

const ID_RE = /^[0-9a-f-]{32,36}$/i
const safeId = (v: unknown): string | undefined => (typeof v === 'string' && ID_RE.test(v) ? v : undefined)

/** database id → its (first) data source id: one lookup per database per run of the app. */
const dataSources = new Map<string, string>()
/** Tests: start with a known data source, or with none. */
export function rememberDataSource(databaseId: string, dataSourceId: string): void {
  dataSources.set(databaseId, dataSourceId)
}
export function forgetDataSources(): void {
  dataSources.clear()
}

type DatabaseInfo = { ok: true; title: string; dataSourceId: string; databaseId: string } | { ok: false; error: string; status?: number }

/** The database's title and data source (rows are created in and queried from the data source since 2025-09-03). */
async function databaseInfo(target: NotionTarget): Promise<DatabaseInfo> {
  const r = await call(target, 'GET', `/databases/${target.databaseId}`)
  // the id in Settings may be the data source's (Notion's "Copy link to data source", collection://…): use it as one
  if (!r.ok && r.status === 404) return (await dataSourceInfo(target)) ?? r
  if (!r.ok) return r
  const title = Array.isArray(r.json.title) ? (r.json.title as Array<{ plain_text?: string }>).map((t) => t?.plain_text ?? '').join('') : ''
  const list = Array.isArray(r.json.data_sources) ? (r.json.data_sources as Array<{ id?: unknown } | null>) : []
  const dataSourceId = list.map((d) => safeId(d?.id)).find(Boolean)
  // a broken database, not a passing failure: task sync waits for the next change instead of retrying
  if (!dataSourceId) return { ok: false, error: `Notion returned no data source for database "${title || target.databaseId}"`, status: 400 }
  dataSources.set(target.databaseId, dataSourceId)
  return { ok: true, title, dataSourceId, databaseId: target.databaseId }
}

/** The id in Settings read as a data source: its title and the database it belongs to, or undefined when it is not one. */
async function dataSourceInfo(target: NotionTarget): Promise<DatabaseInfo | undefined> {
  const r = await call(target, 'GET', `/data_sources/${target.databaseId}`)
  if (!r.ok) return undefined
  const parent = (r.json.parent ?? {}) as { database_id?: unknown }
  const databaseId = safeId(parent.database_id)
  if (!databaseId) return undefined
  const title = Array.isArray(r.json.title) ? (r.json.title as Array<{ plain_text?: string }>).map((t) => t?.plain_text ?? '').join('') : ''
  dataSources.set(target.databaseId, target.databaseId)
  return { ok: true, title, dataSourceId: target.databaseId, databaseId }
}

async function dataSourceOf(target: NotionTarget): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  const known = dataSources.get(target.databaseId)
  if (known) return { ok: true, id: known }
  const info = await databaseInfo(target)
  return info.ok ? { ok: true, id: info.dataSourceId } : info
}

const rowParent = (dataSourceId: string): { type: 'data_source_id'; data_source_id: string } => ({ type: 'data_source_id', data_source_id: dataSourceId })

/** The properties a published row sets, as the Reports database must have them. */
export const REPORT_SCHEMA: Record<string, string> = { Name: 'title', Date: 'date', Project: 'select', Ended: 'rich_text', 'Waiting on you': 'number', Dispatches: 'number', 'Report file': 'rich_text', Status: 'status' }

/** Settings → Notion → Test: the database the token can see, by title, and whether it has every property a report sets. */
export async function testNotion(target: NotionTarget, schema: Record<string, string> = REPORT_SCHEMA, what = "a run's report"): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const info = await databaseInfo(target)
  if (!info.ok) return { ok: false, error: info.error }
  const { title } = info
  const r = await call(target, 'GET', `/data_sources/${info.dataSourceId}`)
  if (!r.ok) return { ok: false, error: r.error }
  const props = (typeof r.json.properties === 'object' && r.json.properties ? r.json.properties : {}) as Record<string, { type?: string } | undefined>
  const missing = Object.entries(schema)
    .filter(([name, type]) => props[name]?.type !== type)
    .map(([name, type]) => `${name} (${type})`)
  if (missing.length) return { ok: false, error: `database "${title || target.databaseId}" lacks ${missing.join(', ')}: ${what} would be refused` }
  return { ok: true, title: title || '(untitled database)' }
}

/**
 * One page in the Reports database: the properties and the first 100 blocks go with the page, the rest are
 * appended in request-sized batches. A failed append leaves the page (and says so in `partial`).
 */
export async function publishReport(input: PublishInput): Promise<NotionResult> {
  const ds = await dataSourceOf(input)
  if (!ds.ok) return { ok: false, error: ds.error }
  const chunks = chunkBlocks(reportBlocks(input.markdown))
  const first: NotionBlock[] = chunks.shift() ?? []
  const created = await call(input, 'POST', '/pages', { parent: rowParent(ds.id), properties: reportProperties(input.meta), children: first })
  if (!created.ok) return { ok: false, error: created.error }
  const id = typeof created.json.id === 'string' && /^[0-9a-f-]{32,36}$/i.test(created.json.id) ? created.json.id : ''
  const url = typeof created.json.url === 'string' ? created.json.url : `https://www.notion.so/${id.replace(/-/g, '')}`
  if (!id && typeof created.json.url !== 'string') return { ok: false, error: 'Notion answered without a page id' }
  if (!id) return chunks.length ? { ok: true, url, partial: 'Notion returned no page id; only the first 100 blocks are there' } : { ok: true, url }
  for (let i = 0; i < chunks.length; i++) {
    const r = await call(input, 'PATCH', `/blocks/${id}/children`, { children: chunks[i] })
    if (!r.ok) return { ok: true, url, partial: `the page holds the first ${(i + 1) * 100} blocks; the rest did not go up (${r.error})` }
  }
  return { ok: true, url }
}

const pageIdOf = (json: Record<string, unknown>): string | undefined => (typeof json.id === 'string' && /^[0-9a-f-]{32,36}$/i.test(json.id) ? json.id : undefined)

export type UpsertResult = { ok: true; pageId: string } | { ok: false; error: string; status?: number; stage?: 'query' | 'write' }

/**
 * One task's row in the Tasks database: the cached page is updated; without one (or when the row was deleted
 * or archived in Notion) the row is looked up by Task ID + Project, then created.
 */
export async function upsertTask(target: NotionTarget, task: TaskRow, project: string, cachedPageId?: string): Promise<UpsertResult> {
  const properties = taskProperties(task, project)
  if (cachedPageId) {
    const r = await call(target, 'PATCH', `/pages/${cachedPageId}`, { properties })
    if (r.ok) return { ok: true, pageId: cachedPageId }
    // 2026-03-11 says "in trash" where older versions said "archived"
    const gone = r.status === 404 || (r.status === 400 && /archived|in.?trash/i.test(r.error))
    if (!gone) return r
  }
  const ds = await dataSourceOf(target)
  if (!ds.ok) return { ...ds, stage: 'query' }
  const found = await call(target, 'POST', `/data_sources/${ds.id}/query`, taskQuery(task.id, project))
  // a project's first task: Notion refuses a filter on a select option the database doesn't have yet, and no row
  // can hold it, so the row is created (which adds the option)
  const newOption = !found.ok && found.status === 400 && /select option .* not found/i.test(found.error)
  if (!found.ok && !newOption) return { ...found, stage: 'query' }
  const hit = found.ok && Array.isArray(found.json.results) ? (found.json.results as Array<Record<string, unknown>>).map(pageIdOf).find(Boolean) : undefined
  if (hit && hit !== cachedPageId) {
    const r = await call(target, 'PATCH', `/pages/${hit}`, { properties })
    return r.ok ? { ok: true, pageId: hit } : r
  }
  const created = await call(target, 'POST', '/pages', { parent: rowParent(ds.id), properties })
  if (!created.ok) return created
  const id = pageIdOf(created.json)
  return id ? { ok: true, pageId: id } : { ok: false, error: 'Notion answered without a page id' }
}

/** A version's release notes as one page in the Updates database; a version already there (an earlier answer lost on the way back) is not published twice. */
export async function publishUpdate(target: NotionTarget, version: string, date: string | undefined, highlights: string, markdown: string): Promise<NotionResult> {
  const ds = await dataSourceOf(target)
  if (!ds.ok) return { ok: false, error: ds.error }
  const existing = await call(target, 'POST', `/data_sources/${ds.id}/query`, { filter: { property: 'Name', title: { equals: version } }, page_size: 1 })
  if (!existing.ok) return { ok: false, error: existing.error }
  const prior = Array.isArray(existing.json.results) ? (existing.json.results as Array<Record<string, unknown>>)[0] : undefined
  if (prior) return { ok: true, url: typeof prior.url === 'string' ? prior.url : '', partial: 'already published' }
  const chunks = chunkBlocks(reportBlocks(markdown))
  const first: NotionBlock[] = chunks.shift() ?? []
  const created = await call(target, 'POST', '/pages', { parent: rowParent(ds.id), properties: updateProperties(version, date, highlights), children: first })
  if (!created.ok) return { ok: false, error: created.error }
  const id = pageIdOf(created.json)
  const url = typeof created.json.url === 'string' ? created.json.url : id ? `https://www.notion.so/${id.replace(/-/g, '')}` : ''
  if (!id) return url ? { ok: true, url, ...(chunks.length ? { partial: 'Notion returned no page id; only the first 100 blocks are there' } : {}) } : { ok: false, error: 'Notion answered without a page id' }
  for (let i = 0; i < chunks.length; i++) {
    const r = await call(target, 'PATCH', `/blocks/${id}/children`, { children: chunks[i] })
    if (!r.ok) return { ok: true, url, partial: `the page holds the first ${(i + 1) * 100} blocks; the rest did not go up (${r.error})` }
  }
  return { ok: true, url }
}

const MAX_VIEWS_READ = 100
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

export type ViewsResult ={ ok: true; created: string[]; existing: string[]; failed: string[] } | { ok: false; error: string }

/**
 * Settings → Notion → Add views: the views in `specs` that the database does not have yet (by name) are created.
 * Running it again creates nothing; a view the owner renamed or deleted in Notion is made again.
 */
export async function ensureViews(target: NotionTarget, specs: ViewSpec[], readGapMs = 350): Promise<ViewsResult> {
  const info = await databaseInfo(target)
  if (!info.ok) return { ok: false, error: info.error }
  const ds = await call(target, 'GET', `/data_sources/${info.dataSourceId}`)
  if (!ds.ok) return { ok: false, error: ds.error }
  const props = (typeof ds.json.properties === 'object' && ds.json.properties ? ds.json.properties : {}) as Record<string, { id?: string; type?: string } | undefined>
  // the list gives ids only; each view is read for its name (a database has a handful)
  const names = new Set<string>()
  let cursor: string | undefined
  let read = 0
  for (let page = 0; page < 5; page++) {
    const list = await call(target, 'GET', `/views?database_id=${encodeURIComponent(info.databaseId)}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!list.ok) return { ok: false, error: list.error }
    const ids = Array.isArray(list.json.results) ? (list.json.results as Array<{ id?: unknown } | null>).map((v) => safeId(v?.id)).filter((v): v is string => Boolean(v)) : []
    for (const id of ids) {
      // a name that could not be read might be one of ours: creating now could make a duplicate, so stop
      if (++read > MAX_VIEWS_READ) return { ok: false, error: `the database has more than ${MAX_VIEWS_READ} views; add the Ouroboros views by hand` }
      const v = await call(target, 'GET', `/views/${id}`)
      if (!v.ok) return { ok: false, error: `could not read the existing views (${v.error}); nothing was added` }
      if (typeof v.json.name === 'string') names.add(v.json.name)
      await sleep(readGapMs) // Notion allows about 3 requests a second
    }
    cursor = list.json.has_more === true && typeof list.json.next_cursor === 'string' ? list.json.next_cursor : undefined
    if (!cursor) break
    if (page === 4) return { ok: false, error: 'the list of views did not end; nothing was added' }
  }
  const out = { ok: true as const, created: [] as string[], existing: [] as string[], failed: [] as string[] }
  for (const spec of specs) {
    if (names.has(spec.name)) {
      out.existing.push(spec.name)
      continue
    }
    const body = viewBody(spec, info.databaseId, info.dataSourceId, props)
    if (!body.ok) {
      out.failed.push(body.error)
      continue
    }
    const r = await call(target, 'POST', '/views', body.body)
    if (r.ok) out.created.push(spec.name)
    else out.failed.push(`"${spec.name}": ${r.error}`)
  }
  return out
}
