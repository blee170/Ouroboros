/**
 * The task ledger: a per-project list of work items that the Conductor (and team leads) keep through the
 * task_* tools and the owner sees in the Tasks tab. Pure functions on an immutable LedgerData; the main
 * process (main/ledger.ts) owns the live copy, saves it into the board file and pushes changes to the renderer.
 *
 * Rules kept here, not in prompts: done needs a result, blocked needs a reason, a claim waits for its
 * dependencies, two live cards cannot own one task, dependency graphs have no cycles.
 */

export type TaskState = 'todo' | 'doing' | 'blocked' | 'done' | 'dropped'
export const TASK_STATES: readonly TaskState[] = ['todo', 'doing', 'blocked', 'done', 'dropped']

export interface Task {
  /** T1, T2, … per project. */
  id: string
  /** One line; goes into prompts, the sidebar and the morning report. */
  title: string
  /** What to do, for the card that claims it. */
  detail?: string
  state: TaskState
  /** Card id of the card working on it (claimed). */
  owner?: string
  /** Parent task id. */
  parent?: string
  /** Task ids that must be done before this one can be claimed. */
  deps: string[]
  /** Why blocked / dropped / released. */
  reason?: string
  /** What was done, required for done. */
  result?: string
  /** Card id, or `owner` for the human. */
  createdBy: string
  /** who last changed it: a card id, or `owner` for the Tasks tab (the owner's own edits are the trust signal) */
  updatedBy?: string
  createdAt: number
  updatedAt: number
}

export interface LedgerData {
  tasks: Task[]
  nextTaskId: number
}

export interface TaskInput {
  title: string
  detail?: string
  parent?: string
  deps?: string[]
  owner?: string
}

export interface TaskPatch {
  state?: TaskState
  title?: string
  detail?: string
  parent?: string | null
  deps?: string[]
  owner?: string | null
  reason?: string
  result?: string
}

export interface TaskFilter {
  state?: TaskState
  owner?: string
  parent?: string
  /** Include done and dropped tasks (hidden by default). */
  all?: boolean
}

export type LedgerResult = { ok: true; task: Task; data: LedgerData } | { ok: false; error: string }
/** What the API and the renderer get back: the task, or the reason. */
export type LedgerApiResult = { ok: true; task: Task } | { ok: false; error: string }

export const toApiResult = (r: LedgerResult): LedgerApiResult => (r.ok ? { ok: true, task: r.task } : r)

export const MAX_TASKS = 500
/** at most this many tasks are read back from a board file */
export const MAX_STORED = 1000
export const MAX_DEPS = 50
const MAX_ID = 999_999
/** task_list shows at most this many tasks; the rest are a count */
export const LIST_MAX = 100
export const TITLE_MAX = 120
export const DETAIL_MAX = 2000
export const REASON_MAX = 300
export const RESULT_MAX = 2000
export const OWNER = 'owner'

// control, C1, bidi, zero-width, soft-hyphen, Hangul fillers, variation selectors and Unicode tag characters: a model reads
// them as text while the owner sees nothing, so they never reach prompts or the report
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu
/** Unicode line and paragraph separators and NEL: a line break like any other */
const ODD_BREAKS = /[\u0085\u2028\u2029]/g

export const emptyLedger = (): LedgerData => ({ tasks: [], nextTaskId: 1 })

/** One line, no control or bidi characters, bounded. */
export function cleanLine(s: unknown, max: number): string {
  return String(s ?? '').replace(ODD_BREAKS, '\n').replace(UNSAFE_TEXT, '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max)
}

/** Several lines allowed, no control or bidi characters, bounded. */
export function cleanText(s: unknown, max: number): string {
  return String(s ?? '').replace(ODD_BREAKS, '\n').replace(UNSAFE_TEXT, '').replace(/\r\n?/g, '\n').trim().slice(0, max)
}

const ID_RE = /^T\d{1,6}$/

function taskNumber(id: string): number {
  return ID_RE.test(id) ? Number(id.slice(1)) : 0
}

function findTask(data: LedgerData, id: string): Task | undefined {
  return data.tasks.find((t) => t.id === id)
}

/** Dependency ids checked for existence, duplicates, self-reference and cycles (through deps only). */
function checkDeps(data: LedgerData, id: string | undefined, deps: unknown): { ok: true; deps: string[] } | { ok: false; error: string } {
  if (deps === undefined) return { ok: true, deps: [] }
  if (!Array.isArray(deps)) return { ok: false, error: 'deps must be a list of task ids' }
  if (deps.length > MAX_DEPS) return { ok: false, error: `at most ${MAX_DEPS} deps` }
  const out: string[] = []
  for (const d of deps) {
    if (typeof d !== 'string' || !ID_RE.test(d)) return { ok: false, error: `bad task id in deps: ${cleanLine(d, 20)}` }
    if (d === id) return { ok: false, error: `${id} cannot depend on itself` }
    if (!findTask(data, d)) return { ok: false, error: `no task ${d}` }
    if (!out.includes(d)) out.push(d)
  }
  if (id) {
    // a cycle exists when some dep reaches back to id through the existing graph
    const seen = new Set<string>()
    const stack = [...out]
    while (stack.length) {
      const cur = stack.pop()!
      if (cur === id) return { ok: false, error: `deps would form a cycle through ${cur}` }
      if (seen.has(cur)) continue
      seen.add(cur)
      const t = findTask(data, cur)
      if (t) stack.push(...t.deps)
    }
  }
  return { ok: true, deps: out }
}

function checkParent(data: LedgerData, id: string | undefined, parent: unknown): { ok: true; parent?: string } | { ok: false; error: string } {
  if (parent === undefined || parent === null || parent === '') return { ok: true }
  if (typeof parent !== 'string' || !ID_RE.test(parent)) return { ok: false, error: `bad parent task id: ${cleanLine(parent, 20)}` }
  if (parent === id) return { ok: false, error: `${id} cannot be its own parent` }
  if (!findTask(data, parent)) return { ok: false, error: `no task ${parent}` }
  // no parent loops
  let cur: string | undefined = parent
  for (let i = 0; cur && i < MAX_TASKS; i++) {
    if (cur === id) return { ok: false, error: `parent ${parent} would form a loop` }
    cur = findTask(data, cur)?.parent
  }
  return { ok: true, parent }
}

function replace(data: LedgerData, task: Task): LedgerData {
  return { ...data, tasks: data.tasks.map((t) => (t.id === task.id ? task : t)) }
}

export function createTask(data: LedgerData, input: TaskInput, by: string, now = Date.now()): LedgerResult {
  const title = cleanLine(input?.title, TITLE_MAX)
  if (!title) return { ok: false, error: 'title required' }
  if (data.nextTaskId > MAX_ID) return { ok: false, error: 'the ledger has run out of ids' }
  if (openCount(data) >= MAX_TASKS) return { ok: false, error: `the ledger holds at most ${MAX_TASKS} open tasks; finish or drop some first` }
  const parent = checkParent(data, undefined, input.parent)
  if (!parent.ok) return parent
  const deps = checkDeps(data, undefined, input.deps)
  if (!deps.ok) return deps
  const id = `T${data.nextTaskId}`
  const actor = cleanLine(by, 80) || OWNER
  const task: Task = { id, title, state: 'todo', deps: deps.deps, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now }
  const detail = cleanText(input.detail, DETAIL_MAX)
  if (detail) task.detail = detail
  if (parent.parent) task.parent = parent.parent
  const owner = cleanLine(input.owner, 80)
  if (owner) {
    const unmet = task.deps.filter((d) => findTask(data, d)?.state !== 'done')
    if (unmet.length) return { ok: false, error: `cannot start it: waits for ${unmet.join(', ')} (not done)` }
    task.owner = owner
    task.state = 'doing'
  }
  return { ok: true, task, data: { tasks: [...data.tasks, task], nextTaskId: data.nextTaskId + 1 } }
}

/** Ids of dependencies that are not done. */
export function unmetDeps(data: LedgerData, task: Task): string[] {
  return task.deps.filter((d) => findTask(data, d)?.state !== 'done')
}

export function claimTask(data: LedgerData, id: string, cardId: string, liveCards: ReadonlySet<string>, now = Date.now()): LedgerResult {
  const task = findTask(data, id)
  if (!task) return { ok: false, error: `no task ${cleanLine(id, 20)}` }
  if (!cardId) return { ok: false, error: 'agent_id required' }
  if (task.state === 'done' || task.state === 'dropped') return { ok: false, error: `${id} is ${task.state}` }
  const unmet = unmetDeps(data, task)
  if (unmet.length) return { ok: false, error: `${id} waits for ${unmet.join(', ')} (not done)` }
  if (task.owner && task.owner !== cardId && liveCards.has(task.owner)) {
    return { ok: false, error: `${id} is owned by a live card (${task.owner}); task_update owner= reassigns it` }
  }
  const next: Task = { ...task, owner: cardId, state: 'doing', updatedBy: cardId, updatedAt: now }
  delete next.reason
  return { ok: true, task: next, data: replace(data, next) }
}

export function updateTask(data: LedgerData, id: string, patch: TaskPatch, by: string, now = Date.now()): LedgerResult {
  const task = findTask(data, id)
  if (!task) return { ok: false, error: `no task ${cleanLine(id, 20)}` }
  const next: Task = { ...task, deps: [...task.deps], updatedBy: cleanLine(by, 80) || OWNER, updatedAt: now }
  if (patch.title !== undefined) {
    const title = cleanLine(patch.title, TITLE_MAX)
    if (!title) return { ok: false, error: 'title required' }
    next.title = title
  }
  if (patch.detail !== undefined) {
    const detail = cleanText(patch.detail, DETAIL_MAX)
    if (detail) next.detail = detail
    else delete next.detail
  }
  if (patch.parent !== undefined) {
    const parent = checkParent(data, id, patch.parent)
    if (!parent.ok) return parent
    if (parent.parent) next.parent = parent.parent
    else delete next.parent
  }
  if (patch.deps !== undefined) {
    const deps = checkDeps(data, id, patch.deps)
    if (!deps.ok) return deps
    next.deps = deps.deps
  }
  if (patch.owner !== undefined) {
    const owner = cleanLine(patch.owner, 80)
    if (owner) next.owner = owner
    else delete next.owner
  }
  if (patch.reason !== undefined) {
    const reason = cleanLine(patch.reason, REASON_MAX)
    if (reason) next.reason = reason
    else delete next.reason
  }
  if (patch.result !== undefined) {
    const result = cleanText(patch.result, RESULT_MAX)
    if (result) next.result = result
    else delete next.result
  }
  if (patch.state !== undefined) {
    if (!TASK_STATES.includes(patch.state)) return { ok: false, error: `bad state: ${cleanLine(patch.state, 20)} (todo, doing, blocked, done, dropped)` }
    next.state = patch.state
    if (patch.state === 'done' && !next.result) return { ok: false, error: `done needs a result: what was done and how it was checked` }
    if (patch.state === 'blocked' && !next.reason) return { ok: false, error: `blocked needs a reason (start it with "APPROVAL NEEDED:" when the owner must decide)` }
    if (patch.state === 'doing' && !next.owner) {
      if (by && by !== OWNER) next.owner = by
      else return { ok: false, error: 'doing needs an owner card (task_claim, or owner=)' }
    }
    if (patch.state === 'todo') delete next.owner
  } else if (patch.owner !== undefined && next.owner && task.state === 'todo') {
    next.state = 'doing'
  }
  if (next.state === 'done' || next.state === 'dropped') delete next.owner
  if (next.state === 'doing' && !next.owner) next.state = 'todo' // owner= cleared on a doing task
  return { ok: true, task: next, data: replace(data, next) }
}

/** A card ended or was removed: its doing tasks go back to todo so nobody waits on a dead card. */
export function releaseTasksOf(data: LedgerData, cardId: string, cardTitle: string, now = Date.now()): { data: LedgerData; released: string[] } {
  const released: string[] = []
  const tasks = data.tasks.map((t) => {
    if (t.owner !== cardId || t.state !== 'doing') return t
    released.push(t.id)
    const next: Task = { ...t, state: 'todo', reason: cleanLine(`card ${cardTitle || cardId} ended before it finished`, REASON_MAX), updatedAt: now }
    delete next.owner
    return next
  })
  return { data: released.length ? { ...data, tasks } : data, released }
}

export function filterTasks(tasks: Task[], f: TaskFilter = {}): Task[] {
  return tasks.filter((t) => {
    if (f.state) return t.state === f.state && (!f.owner || t.owner === f.owner) && (!f.parent || t.parent === f.parent)
    if (!f.all && (t.state === 'done' || t.state === 'dropped')) return false
    if (f.owner && t.owner !== f.owner) return false
    if (f.parent && t.parent !== f.parent) return false
    return true
  })
}

export interface TaskCounts {
  todo: number
  doing: number
  blocked: number
  done: number
  dropped: number
}

function openCount(data: LedgerData): number {
  return data.tasks.filter((t) => t.state !== 'done' && t.state !== 'dropped').length
}

export function summarizeTasks(tasks: Task[]): TaskCounts {
  const c: TaskCounts = { todo: 0, doing: 0, blocked: 0, done: 0, dropped: 0 }
  for (const t of tasks) c[t.state]++
  return c
}

/** Compact text for task_list: a head line with counts, then one line per task (plus reason / result). */
export function formatTasks(tasks: Task[], all: Task[], titles: ReadonlyMap<string, string>): string {
  const c = summarizeTasks(all)
  const head = `${all.length} tasks: ${c.todo} todo · ${c.doing} doing · ${c.blocked} blocked · ${c.done} done · ${c.dropped} dropped`
  if (tasks.length === 0) return `${head}\n(none match; task_list all=true shows done and dropped ones)`
  const lines = [head]
  for (const t of tasks.slice(0, LIST_MAX)) {
    const bits = [`${t.id} [${t.state}] ${t.title}`]
    if (t.owner) bits.push(`owner: ${cleanLine(titles.get(t.owner) ?? t.owner, 80)}`)
    if (t.updatedBy === OWNER) bits.push('by owner')
    if (t.parent) bits.push(`parent: ${t.parent}`)
    if (t.deps.length) bits.push(`deps: ${t.deps.join(', ')}`)
    lines.push(bits.join(' · '))
    if (t.detail) lines.push(`    detail: ${cleanLine(t.detail, 200)}`)
    if (t.reason) lines.push(`    reason: ${t.reason}`)
    if (t.result) lines.push(`    result: ${cleanLine(t.result, 200)}`)
  }
  if (tasks.length > LIST_MAX) lines.push(`… ${tasks.length - LIST_MAX} more (filter by state, owner or parent)`)
  return lines.join('\n')
}

/** What loadWorkspace hands over: anything malformed is dropped, ids stay unique, the counter is ahead of every id. */
export function sanitizeLedger(raw: unknown): LedgerData {
  const out = emptyLedger()
  const r = raw as { tasks?: unknown; nextTaskId?: unknown } | undefined
  if (!r || !Array.isArray(r.tasks)) return out
  const seen = new Set<string>()
  let max = 0
  for (const x of r.tasks as Array<Record<string, unknown>>) {
    if (!x || typeof x !== 'object') continue
    const id = typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : ''
    const title = cleanLine(x.title, TITLE_MAX)
    if (!id || !title || seen.has(id)) continue
    const state = TASK_STATES.includes(x.state as TaskState) ? (x.state as TaskState) : 'todo'
    const t: Task = {
      id,
      title,
      state,
      deps: Array.isArray(x.deps) ? (x.deps as unknown[]).filter((d): d is string => typeof d === 'string' && ID_RE.test(d) && d !== id) : [],
      createdBy: cleanLine(x.createdBy, 80) || OWNER,
      updatedBy: cleanLine(x.updatedBy, 80) || undefined,
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
      updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : 0
    }
    const detail = cleanText(x.detail, DETAIL_MAX)
    if (detail) t.detail = detail
    const owner = cleanLine(x.owner, 80)
    if (owner && (state === 'doing' || state === 'blocked')) t.owner = owner
    if (typeof x.parent === 'string' && ID_RE.test(x.parent) && x.parent !== id) t.parent = x.parent
    const reason = cleanLine(x.reason, REASON_MAX)
    if (reason) t.reason = reason
    const result = cleanText(x.result, RESULT_MAX)
    if (result) t.result = result
    seen.add(id)
    max = Math.max(max, taskNumber(id))
    out.tasks.push(t)
    if (out.tasks.length >= MAX_STORED) break
  }
  // references to tasks that were dropped as malformed
  for (const t of out.tasks) {
    t.deps = t.deps.filter((d) => seen.has(d))
    if (t.parent && !seen.has(t.parent)) delete t.parent
  }
  const stored = typeof r.nextTaskId === 'number' && Number.isSafeInteger(r.nextTaskId) ? r.nextTaskId : 0
  out.nextTaskId = Math.min(Math.max(stored, max + 1), MAX_ID + 1)
  return out
}
