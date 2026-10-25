/**
 * Publishes the morning report to the owner's Notion "Reports" database over the REST API, with the
 * integration token from Settings. No Electron here: the token and the fetch are passed in, so the
 * paths (success, 401, 404, 429, network) run under vitest. Nothing here throws; nothing here logs the token.
 */
import { chunkBlocks, reportBlocks, reportProperties, type NotionBlock, type ReportMeta } from '@shared/notion'

export const NOTION_API = 'https://api.notion.com/v1'
export const NOTION_VERSION = '2022-06-28'
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
  if (status === 404) return 'Notion could not find the database (404): check the id, and share the database with the integration (⋯ → Connections)'
  if (status === 429) return 'Notion rate limit (429): the report was not published; the file and the note are complete'
  return `Notion ${status}${msg ? `: ${scrub(msg).slice(0, 200)}` : ''}`
}

async function call(target: NotionTarget, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> {
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
    if (!res.ok) return { ok: false, error: describe(res.status, json) }
    return { ok: true, json }
  } catch (err) {
    // undici keeps the reason (ENOTFOUND, ECONNRESET, a redirect refused) in err.cause
    const cause = err instanceof Error && err.cause && typeof err.cause === 'object' ? ((err.cause as { code?: string; message?: string }).code ?? (err.cause as { message?: string }).message) : undefined
    const m = `${err instanceof Error ? err.message : String(err)}${cause ? ` (${cause})` : ''}`
    return { ok: false, error: `Notion unreachable: ${scrub(m.split(target.token).join('[token]')).slice(0, 200)}` }
  }
}

/** The properties a published row sets, as the Reports database must have them. */
export const REPORT_SCHEMA: Record<string, string> = { Name: 'title', Date: 'date', Project: 'select', Ended: 'rich_text', 'Waiting on you': 'number', Dispatches: 'number', 'Report file': 'rich_text', Status: 'status' }

/** Settings → Notion → Test: the database the token can see, by title, and whether it has every property a report sets. */
export async function testNotion(target: NotionTarget): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  const r = await call(target, 'GET', `/databases/${target.databaseId}`)
  if (!r.ok) return r
  const title = Array.isArray(r.json.title) ? (r.json.title as Array<{ plain_text?: string }>).map((t) => t?.plain_text ?? '').join('') : ''
  const props = (typeof r.json.properties === 'object' && r.json.properties ? r.json.properties : {}) as Record<string, { type?: string } | undefined>
  const missing = Object.entries(REPORT_SCHEMA)
    .filter(([name, type]) => props[name]?.type !== type)
    .map(([name, type]) => `${name} (${type})`)
  if (missing.length) return { ok: false, error: `database "${title || target.databaseId}" lacks ${missing.join(', ')}: a run's report would be refused` }
  return { ok: true, title: title || '(untitled database)' }
}

/**
 * One page in the Reports database: the properties and the first 100 blocks go with the page, the rest are
 * appended in request-sized batches. A failed append leaves the page (and says so in `partial`).
 */
export async function publishReport(input: PublishInput): Promise<NotionResult> {
  const chunks = chunkBlocks(reportBlocks(input.markdown))
  const first: NotionBlock[] = chunks.shift() ?? []
  const created = await call(input, 'POST', '/pages', { parent: { database_id: input.databaseId }, properties: reportProperties(input.meta), children: first })
  if (!created.ok) return created
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
