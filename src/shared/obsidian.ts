/**
 * Obsidian vault export: the open project's tasks, morning reports and board written as plain files into
 * `<vault>/Ouroboros/<project>/`, so Obsidian's own graph, Bases tables and Canvas show them. One-way: nothing is
 * read back. Pure builders here (path → contents); main/obsidian-export.ts decides what to write.
 */
import type { Task } from './ledger'
import type { AgentStatus, NodeKind } from './types'

/** The folder inside the vault every export goes under. */
export const VAULT_ROOT = 'Ouroboros'

/** A project's folder name: its own name with anything a file system or a wikilink would choke on replaced. */
export function vaultProjectName(project: string): string {
  const s = project
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .replace(/^\s+|[.\s]+$/g, '') // Windows drops trailing dots and spaces from a folder name; links would miss it
  // names Windows reserves in any folder
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) return `${s}_`
  return s || 'no-project'
}

/**
 * YAML scalar: a JSON string is a valid YAML double-quoted scalar, once the characters strict YAML refuses in one
 * (DEL, the C1 controls, a lone surrogate) are escaped too.
 */
const y = (s: string): string =>
  JSON.stringify(s).replace(/[\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** Local date-time as Obsidian's date-time property reads it (YYYY-MM-DDTHH:mm:ss); undefined for no time. */
export function localDateTime(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * Text written by agents (task detail, result, reason, replies, reports), made inert for Obsidian plugins that run
 * code from note text: Templater's `<% %>` (it can run when a file is created, before anyone opens the note),
 * Dataview's query fences and inline `$=` / `=` queries. Ordinary markdown is left as it is.
 */
export function inertText(s: string): string {
  return s
    .replace(/<%/g, '<\\%')
    .replace(/^(\s*(?:`{3,}|~{3,})\s*)(dataviewjs|dataview|js-engine|tasks)\b/gim, '$1text-$2')
    .replace(/`(\$?=)/g, '`‍$1')
}

/** A wikilink to another task of the same export, by vault path (two projects can both have a T1). */
const taskLink = (base: string, id: string): string => `[[${base}/Tasks/${id}|${id}]]`

/** Task ids are `T<number>`; anything else never becomes a file name. */
export const isTaskId = (id: string): boolean => /^T\d{1,9}$/.test(id)

export function taskNote(t: Task, o: { base: string; project: string; ownerTitle?: string }): string {
  const created = localDateTime(t.createdAt)
  const updated = localDateTime(t.updatedAt)
  const fm = [
    '---',
    'type: ouroboros-task',
    `id: ${y(t.id)}`,
    `title: ${y(t.title)}`,
    `state: ${y(t.state)}`,
    ...(o.ownerTitle || t.owner ? [`owner: ${y(o.ownerTitle || t.owner || '')}`] : []),
    ...(t.parent && isTaskId(t.parent) ? [`parent: ${y(taskLink(o.base, t.parent))}`] : []),
    ...(t.deps.some(isTaskId) ? ['deps:', ...t.deps.filter(isTaskId).map((d) => `  - ${y(taskLink(o.base, d))}`)] : []),
    `project: ${y(o.project)}`,
    ...(created ? [`created: ${created}`] : []),
    ...(updated ? [`updated: ${updated}`] : []),
    'tags:',
    '  - ouroboros/task',
    `  - ouroboros/${t.state}`,
    '---'
  ]
  const body = [`# ${t.id} · ${inertText(t.title.replace(/\s+/g, ' '))}`, '']
  if (t.detail?.trim()) body.push(inertText(t.detail.trim()), '')
  if (t.result?.trim()) body.push('## Result', '', inertText(t.result.trim()), '')
  if (t.reason?.trim()) body.push('## Reason', '', inertText(t.reason.trim()), '')
  return [...fm, ...body].join('\n')
}

/** `run-2026-10-26_08-30.md` → its local date-time, or undefined for any other name. */
export function reportDate(file: string): string | undefined {
  const m = /^run-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})\.md$/.exec(file)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00` : undefined
}

export function reportNote(markdown: string, o: { project: string; date: string }): string {
  return ['---', 'type: ouroboros-report', `project: ${y(o.project)}`, `date: ${o.date}`, 'tags:', '  - ouroboros/report', '---', '', inertText(markdown.trim()), ''].join('\n')
}

export interface CanvasCard {
  id: string
  kind: NodeKind
  title: string
  engine?: string
  status?: AgentStatus
  statusDetail?: string
  lastReply?: string
  url?: string
  x: number
  y: number
  width: number
  height: number
}

/** JSON Canvas preset colours: red, orange, yellow, green, cyan, purple. */
const STATUS_COLOR: Partial<Record<AgentStatus, string>> = { 'needs-you': '1', working: '3', done: '4', ended: '6' }

/** The board as a JSON Canvas (jsoncanvas.org 1.0): one text node per card, a browser card as a link, lines as edges. */
export function boardCanvas(cards: CanvasCard[], edges: Array<{ id: string; source: string; target: string; label?: string }>): string {
  const ids = new Set(cards.map((c) => c.id))
  const int = (n: number, min: number): number => (Number.isFinite(n) ? Math.max(min, Math.round(n)) : min)
  const nodes = cards.map((c) => {
    const geo = { id: c.id, x: Number.isFinite(c.x) ? Math.round(c.x) : 0, y: Number.isFinite(c.y) ? Math.round(c.y) : 0, width: int(c.width, 160), height: int(c.height, 80) }
    const color = c.status ? STATUS_COLOR[c.status] : undefined
    if (c.kind === 'browser' && c.url && /^https?:\/\//.test(c.url)) return { ...geo, type: 'link', url: c.url }
    const head = [`**${c.title.replace(/\*/g, '')}**`, [c.engine, c.status, c.statusDetail].filter(Boolean).join(' · ')].filter(Boolean)
    const reply = (c.lastReply ?? '').trim()
    const text = inertText([...head, ...(reply ? ['', reply.length > 1200 ? `${reply.slice(0, 1200)}…` : reply] : [])].join('\n'))
    return { ...geo, type: 'text', text, ...(color ? { color } : {}) }
  })
  const lines = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ id: e.id, fromNode: e.source, toNode: e.target, ...(e.label ? { label: e.label } : {}) }))
  return JSON.stringify({ nodes, edges: lines }, null, 2)
}

/** A Bases file over the export's tasks: a table grouped by state, and cards. */
export function tasksBase(base: string): string {
  return [
    'filters:',
    '  and:',
    `    - ${y(`file.inFolder("${base}/Tasks")`)}`,
    'properties:',
    '  note.state:',
    '    displayName: State',
    '  note.owner:',
    '    displayName: Owner',
    'views:',
    '  - type: table',
    '    name: By state',
    '    groupBy:',
    '      property: note.state',
    '      direction: ASC',
    '    order:',
    '      - note.id',
    '      - note.title',
    '      - note.state',
    '      - note.owner',
    '      - note.updated',
    '  - type: cards',
    '    name: Cards',
    '    order:',
    '      - note.title',
    '      - note.state',
    '      - note.owner',
    ''
  ].join('\n')
}

/** The project's home note: counts by state, the Bases table embedded, the newest reports, the board canvas. */
export function homeNote(o: { base: string; project: string; tasks: Task[]; reports: string[] }): string {
  const count = (s: string): number => o.tasks.filter((t) => t.state === s).length
  const lines = [
    '---',
    'type: ouroboros-project',
    `project: ${y(o.project)}`,
    'tags:',
    '  - ouroboros/project',
    '---',
    '',
    `# ${o.project}`,
    '',
    'Written by Ouroboros; edits here are kept (the file is then no longer updated).',
    '',
    `**Tasks:** ${o.tasks.length} · todo ${count('todo')} · doing ${count('doing')} · blocked ${count('blocked')} · done ${count('done')} · dropped ${count('dropped')}`,
    '',
    `![[${o.base}/Tasks.base]]`,
    '',
    '## Board',
    '',
    `[[${o.base}/Board.canvas|Board]]`,
    ''
  ]
  if (o.reports.length) {
    lines.push('## Morning reports', '')
    for (const r of o.reports.slice(0, 20)) {
      const name = r.replace(/\.md$/, '')
      lines.push(`- [[${o.base}/Reports/${name}|${name}]]`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
