/**
 * Notion publishing, the pure half: the morning report's markdown becomes Notion blocks and database
 * properties here; the main process (src/main/notion.ts) sends them. Everything that could be rejected by
 * Notion is bounded here: 2000 characters per rich-text run, 100 children per request, one table width.
 */

export const NOTION_TEXT_MAX = 2000
export const NOTION_CHILDREN_MAX = 100
/** Rich-text runs per array; a line with more formatting runs than this is sent plain. */
export const NOTION_RUNS_MAX = 100
/** Status option every published report starts in (the owner moves it to Read / Done). */
export const NOTION_STATUS_NEW = 'New'

export interface NotionRichText {
  type: 'text'
  text: { content: string }
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean }
}

/** A Notion block as the REST API takes it (`object` is implied). Loosely typed: the API's shape is wide and we send a handful of kinds. */
export type NotionBlock = { type: string } & Record<string, unknown>

/** What the Reports row says about the run; the page body is the report itself. */
export interface ReportMeta {
  /** Project folder the board was open on (the Project select). */
  project: string
  startedAt: number
  endedAt: number
  /** Why the run ended. */
  reason: string
  /** Parked cards plus blocked tasks. */
  waiting: number
  dispatches: number
  /** Local path of the markdown report. */
  reportPath: string
}

/**
 * The database id out of what the owner pastes: a notion.so / app.notion.com URL (with or without `?v=`),
 * a dashed UUID or a bare 32-hex id. Returns the dashed form the API accepts, or undefined.
 */
export function notionDatabaseId(input: string | undefined): string | undefined {
  const s = (input ?? '').trim().split(/[?#]/)[0]
  const m = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i.exec(s)
  if (!m) return undefined
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase()
}

/** `**bold**` and `` `code` `` runs out of one line of report markdown, every run cut to the 2000-character limit. */
export function richText(line: string, base: NotionRichText['annotations'] = {}): NotionRichText[] {
  const out: NotionRichText[] = []
  const push = (content: string, ann: NotionRichText['annotations']): void => {
    for (let i = 0; i < content.length; i += NOTION_TEXT_MAX) {
      const chunk = content.slice(i, i + NOTION_TEXT_MAX)
      const annotations = Object.fromEntries(Object.entries({ ...base, ...ann }).filter(([, v]) => v))
      out.push(Object.keys(annotations).length ? { type: 'text', text: { content: chunk }, annotations } : { type: 'text', text: { content: chunk } })
    }
  }
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) push(line.slice(last, m.index), {})
    if (m[1] !== undefined) push(m[1], { bold: true })
    else push(m[2], { code: true })
    last = m.index + m[0].length
  }
  if (last < line.length) push(line.slice(last), {})
  if (out.length > NOTION_RUNS_MAX) {
    out.length = 0
    push(line, {})
    if (out.length > NOTION_RUNS_MAX) out.length = NOTION_RUNS_MAX // 200 000 characters on one line: cut
  }
  // Notion refuses an empty rich_text array on a table cell but takes it on a paragraph; one empty run is accepted everywhere
  return out.length ? out : [{ type: 'text', text: { content: '' } }]
}

const SEPARATOR_ROW = /^\|(\s*:?-+:?\s*\|)+\s*$/

/** The cells of one `| a | b |` row; `\|` inside a cell is a pipe (the report escapes them that way). */
export function tableCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '\\' && i + 1 < inner.length) {
      cur += inner[i + 1]
      i++
    } else if (c === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

function tableBlocks(rows: string[]): NotionBlock[] {
  const parsed = rows.filter((r) => !SEPARATOR_ROW.test(r)).map(tableCells)
  if (!parsed.length) return []
  const width = Math.max(...parsed.map((r) => r.length))
  const out: NotionBlock[] = []
  // every table of a request is sent with its rows nested: keep each table under the children cap, header repeated
  const header = parsed[0]
  const body = parsed.slice(1)
  const perTable = NOTION_CHILDREN_MAX - 1
  for (let i = 0; i < Math.max(1, body.length); i += perTable) {
    const chunk = [header, ...body.slice(i, i + perTable)]
    out.push({
      type: 'table',
      table: {
        table_width: width,
        has_column_header: true,
        has_row_header: false,
        children: chunk.map((cells) => ({
          type: 'table_row',
          table_row: { cells: Array.from({ length: width }, (_, k) => richText(cells[k] ?? '')) }
        }))
      }
    })
  }
  return out
}

/**
 * The report's markdown as Notion blocks: `#`/`##`/`###` headings, `- ` bullets, `|` tables (separator rows
 * dropped, ragged rows padded, long tables split), an `_italic_` line, and paragraphs. The title line is
 * kept as a heading too: the database row's Name says the same, but the page should read on its own.
 */
export function reportBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: NotionBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim())
      i--
      out.push(...tableBlocks(rows))
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(t)
    if (h) {
      const kind = `heading_${h[1].length}`
      out.push({ type: kind, [kind]: { rich_text: richText(h[2]) } })
      continue
    }
    if (t.startsWith('- ')) {
      out.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(t.slice(2)) } })
      continue
    }
    const it = /^_(.+)_$/.exec(t)
    if (it) {
      out.push({ type: 'paragraph', paragraph: { rich_text: richText(it[1], { italic: true }) } })
      continue
    }
    out.push({ type: 'paragraph', paragraph: { rich_text: richText(t) } })
  }
  return out
}

/** Blocks in request-sized groups: the first goes with the page, the rest are appended. */
export function chunkBlocks(blocks: NotionBlock[], size = NOTION_CHILDREN_MAX): NotionBlock[][] {
  const out: NotionBlock[][] = []
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size))
  return out
}

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const ymd = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The row's title: `Ouroboros · 2026-10-25 02:10 → 06:40`. */
export function reportTitle(meta: Pick<ReportMeta, 'project' | 'startedAt' | 'endedAt'>): string {
  return `${meta.project} · ${ymd(meta.startedAt)} ${hhmm(meta.startedAt)} → ${hhmm(meta.endedAt)}`
}

/** The Reports database properties for one run, named as the database was created. */
export function reportProperties(meta: ReportMeta): Record<string, unknown> {
  const text = (s: string): NotionRichText[] => richText(s.slice(0, NOTION_TEXT_MAX))
  return {
    Name: { title: text(reportTitle(meta)) },
    Date: { date: { start: new Date(meta.startedAt).toISOString() } },
    // select names take no commas and at most 100 characters
    Project: { select: { name: (meta.project.replace(/,/g, ' ').trim() || 'no-project').slice(0, 100) } },
    Ended: { rich_text: text(meta.reason) },
    'Waiting on you': { number: meta.waiting },
    Dispatches: { number: meta.dispatches },
    'Report file': { rich_text: text(meta.reportPath) },
    Status: { status: { name: NOTION_STATUS_NEW } }
  }
}

/** The properties a synced task row sets, as the Tasks database must have them. */
export const TASK_SCHEMA: Record<string, string> = { Name: 'title', 'Task ID': 'rich_text', Project: 'select', State: 'select', Owner: 'rich_text', Result: 'rich_text', Reason: 'rich_text', Updated: 'date' }

/** The properties a release-notes row sets, as the Updates database must have them. */
export const UPDATE_SCHEMA: Record<string, string> = { Name: 'title', Date: 'date', Highlights: 'rich_text' }

/** A select option name: no commas, at most 100 characters. */
const selectName = (s: string, fallback: string): string => s.replace(/,/g, ' ').trim().slice(0, 100) || fallback

/** What a Tasks row says about one ledger task; `owner` is the claiming card's title, already resolved. */
export interface TaskRow {
  id: string
  title: string
  state: string
  owner?: string
  result?: string
  reason?: string
  updatedAt: number
}

/** The Tasks database properties for one task. */
export function taskProperties(task: TaskRow, project: string): Record<string, unknown> {
  const text = (s: string | undefined): NotionRichText[] => (s ? richText(s.slice(0, NOTION_TEXT_MAX)) : [])
  return {
    Name: { title: richText(task.title.slice(0, NOTION_TEXT_MAX)) },
    'Task ID': { rich_text: text(task.id) },
    Project: { select: { name: selectName(project, 'no-project') } },
    State: { select: { name: selectName(task.state, 'todo') } },
    Owner: { rich_text: text(task.owner) },
    Result: { rich_text: text(task.result) },
    Reason: { rich_text: text(task.reason) },
    Updated: { date: { start: new Date(task.updatedAt).toISOString() } }
  }
}

/** The query that finds a task's row: same Task ID in the same Project. */
export function taskQuery(taskId: string, project: string): Record<string, unknown> {
  return {
    filter: { and: [{ property: 'Task ID', rich_text: { equals: taskId } }, { property: 'Project', select: { equals: selectName(project, 'no-project') } }] },
    page_size: 1
  }
}

/** The Updates database properties for one version. */
export function updateProperties(version: string, date: string | undefined, highlights: string, now = Date.now()): Record<string, unknown> {
  const start = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(now).toISOString().slice(0, 10)
  return {
    Name: { title: richText(version.slice(0, 100)) },
    Date: { date: { start } },
    Highlights: { rich_text: highlights ? richText(highlights.slice(0, NOTION_TEXT_MAX)) : [] }
  }
}
