/**
 * Notion step 2: the ledger's tasks mirrored as rows of the owner's Tasks database. One TaskSync per window
 * (its project), one NotionMap per app (task → page id, in userData). Driven by the ledger's 'change' event,
 * debounced; only tasks whose updatedAt moved since their last sync are sent, one request at a time.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Task } from '@shared/ledger'
import type { TaskRow } from '@shared/notion'
import { upsertTask, type NotionTarget, type UpsertResult } from './notion'

interface MapEntry {
  pageId: string
  /** the task's updatedAt when it was last sent */
  synced: number
}

/** Task → Notion page, keyed by database, project and task id; written atomically after every round. */
export class NotionMap {
  private entries: Record<string, MapEntry> = {}
  constructor(private file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries?: Record<string, MapEntry> }
      // a page id goes into a request path: only the shape Notion hands out (an edited file cannot point elsewhere)
      for (const [k, v] of Object.entries(raw.entries ?? {})) if (v && typeof v.pageId === 'string' && /^(?:[0-9a-f-]{32,36})?$/i.test(v.pageId) && typeof v.synced === 'number') this.entries[k] = v
    } catch {
      /* no file yet, or unreadable: rows are found again by Task ID + Project, so nothing is duplicated */
    }
  }
  static key(databaseId: string, project: string, taskId: string): string {
    return `${databaseId}|${project}|${taskId}`
  }
  get(key: string): MapEntry | undefined {
    return this.entries[key]
  }
  set(key: string, entry: MapEntry): void {
    this.entries[key] = entry
  }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ entries: this.entries }))
    renameSync(tmp, this.file)
  }
}

export interface TaskSyncDeps {
  /** undefined: sync is off (switch off or no Tasks database); `{ error }`: on but cannot run (no token) */
  target(): NotionTarget | { error: string } | undefined
  project(): string
  /** the claiming card's title, for the Owner column */
  ownerTitle(cardId: string): string | undefined
  map: NotionMap
  log(line: string): void
  /** a failed round, for the owner (the caller keeps it to one toast per session) */
  failed(error: string): void
  debounceMs?: number
  /** pause between requests: Notion allows about 3 a second */
  spacingMs?: number
  retryMs?: number
  maxWaitMs?: number
  upsert?: (target: NotionTarget, task: TaskRow, project: string, cached?: string) => Promise<UpsertResult>
}

export class TaskSync {
  private latest: Task[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private again = false
  private disposed = false
  /** when the oldest unsent change came in: a busy ledger still syncs at least this often */
  private pendingSince: number | undefined
  /** no request before this (a rate limit asked for a pause) */
  private notBefore = 0
  /** task id → updatedAt as loaded from a board file the owner has not vouched for: not sent until it changes */
  private held = new Map<string, number>()

  constructor(private deps: TaskSyncDeps) {}

  /** The ledger changed: sync after a quiet moment, but never later than maxWaitMs after the first change. */
  schedule(tasks: Task[], delay = this.deps.debounceMs ?? 5000): void {
    if (this.disposed) return
    this.latest = tasks
    const now = Date.now()
    this.pendingSince ??= now
    const maxWait = this.deps.maxWaitMs ?? 30_000
    const wait = Math.max(Math.min(delay, this.pendingSince + maxWait - now), this.notBefore - now, 0)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, wait)
  }

  /**
   * The tasks just loaded from a board file the owner never opened in the app (a cloned repo) or one changed
   * outside it: they stay out of Notion until they change here. Rows already in Notion keep syncing.
   */
  hold(tasks: Task[]): void {
    this.held = new Map(tasks.map((t) => [t.id, t.updatedAt]))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** One round (over `tasks` when given); a change during the round runs another right after. */
  async run(tasks?: Task[]): Promise<void> {
    if (tasks) this.latest = tasks
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    this.pendingSince = undefined
    try {
      await this.round()
    } catch (err) {
      this.deps.log(`[notion] tasks: ${(err as Error).message}`)
    } finally {
      this.running = false
      if (this.again && !this.disposed) {
        this.again = false
        void this.run()
      }
    }
  }

  private async round(): Promise<void> {
    const target = this.deps.target()
    if (!target) return
    if ('error' in target) return this.deps.failed(target.error)
    const project = this.deps.project()
    const { map } = this.deps
    const upsert = this.deps.upsert ?? upsertTask
    const due = this.latest.filter((t) => {
      const known = map.get(NotionMap.key(target.databaseId, project, t.id))
      if (known?.synced === t.updatedAt) return false
      return Boolean(known?.pageId) || this.held.get(t.id) !== t.updatedAt
    })
    let sent = 0
    try {
      for (const task of due) {
        if (this.disposed) return
        if (sent++ && this.deps.spacingMs !== 0) await new Promise((r) => setTimeout(r, this.deps.spacingMs ?? 350))
        const key = NotionMap.key(target.databaseId, project, task.id)
        const row: TaskRow = { id: task.id, title: task.title, state: task.state, owner: task.owner ? (this.deps.ownerTitle(task.owner) ?? task.owner) : undefined, result: task.result, reason: task.reason, updatedAt: task.updatedAt }
        let r: UpsertResult
        try {
          r = await upsert(target, row, project, map.get(key)?.pageId)
        } catch (err) {
          r = { ok: false, error: (err as Error).message, status: 400 }
        }
        if (r.ok) {
          map.set(key, { pageId: r.pageId, synced: task.updatedAt })
          continue
        }
        const retry = this.deps.retryMs ?? 60_000
        if (r.status === 429) {
          this.deps.log(`[notion] tasks: rate limited; retrying in a minute`)
          this.notBefore = Date.now() + retry
          this.schedule(this.latest, retry)
          return
        }
        // a 400 about the database itself (a renamed or missing column, an archived database) is not this task's fault
        const databaseWide = r.status === 400 && (r.stage === 'query' || /not a property|could not find|archived|database/i.test(r.error))
        if (r.status === 400 && !databaseWide) {
          // this task's row was refused (a property Notion would not take): skip it until it changes, keep the rest going
          this.deps.log(`[notion] tasks: ${task.id} refused: ${r.error}`)
          this.deps.failed(`task ${task.id} was refused: ${r.error}`)
          const prev = map.get(key)
          if (prev) map.set(key, { ...prev, synced: task.updatedAt })
          else map.set(key, { pageId: '', synced: task.updatedAt })
          continue
        }
        // the token, the database or the network: the rest would fail the same way
        this.deps.log(`[notion] tasks: ${r.error}`)
        this.deps.failed(r.error)
        // a conflict, a Notion outage or the network is tried again; a refused token or a broken database waits for the next change
        if (r.status === undefined || r.status === 409 || r.status >= 500) this.schedule(this.latest, retry)
        return
      }
    } finally {
      try {
        map.save()
      } catch (err) {
        this.deps.log(`[notion] tasks: the page map could not be saved (${(err as Error).message}); rows are found again by Task ID`)
      }
    }
  }
}
