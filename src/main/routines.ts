import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checkRoutine, nextRunAt, ROUTINE_LIMITS, sanitizeRoutines, tickRoutines, type Routine, type RoutineInput } from '@shared/routines'

const SAVE_DELAY_MS = 300

/** Where a project's routines live: the app's data folder, not the project (a card cannot rewrite what runs on a timer). */
export function routinesFile(userData: string, projectRoot: string): string {
  const key = createHash('sha1').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16)
  return join(userData, 'routines', `${key}.json`)
}

export type RoutineRunner = (r: Routine) => { ok: boolean; text: string }

const hhmm = (t: number): string => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The routines of one window's project. `run` delivers a routine's prompt (main decides the card and whether it
 * may be sent); every change is pushed as 'change' and saved a moment later. The window's timer calls tick().
 */
export class RoutineDesk extends EventEmitter {
  private routines: Routine[] = []
  private file?: string
  private saveTimer?: NodeJS.Timeout

  constructor(
    private run: RoutineRunner,
    private log: (line: string) => void = () => {},
    private saveDelayMs = SAVE_DELAY_MS,
    /** a save or read that went wrong, for the owner to see (a toast), beyond the log line */
    private failed: (problem: string) => void = () => {}
  ) {
    super()
  }

  list(): Routine[] {
    return this.routines
  }

  /** Switch to a project's routines (the previous file is written first). */
  load(file: string | undefined, now = Date.now()): void {
    this.flush()
    this.file = file
    let raw: unknown
    if (file) {
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          // never overwrite a file we could not read: set it aside and say so
          const aside = `${file}.unreadable-${now}`
          try {
            renameSync(file, aside)
            this.problem(`could not read ${file} (${(e as Error).message}); kept it as ${aside} and started an empty list`)
          } catch (e2) {
            this.problem(`could not read ${file} (${(e as Error).message}) nor set it aside (${(e2 as Error).message}); routines are not saved this session`)
            this.file = undefined
          }
        }
      }
    }
    this.routines = sanitizeRoutines(raw)
    // times that passed while the app was closed are recorded as missed here, never run (the cards are not up yet)
    this.tick(now, 0)
    this.emit('change', this.routines)
  }

  save(input: RoutineInput, now = Date.now()): { ok: true; routine: Routine } | { ok: false; error: string } {
    if (!this.file) return { ok: false, error: 'open a project first' }
    // a run due now goes out before an edit moves its time, so an edit at 09:00:10 does not skip 09:00
    this.tick(now)
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const existing = id ? this.routines.find((x) => x.id === id) : undefined
    if (id && !existing) return { ok: false, error: 'that routine was deleted' }
    const r = checkRoutine(input.enabled === undefined && existing ? { ...input, enabled: existing.enabled } : input)
    if (!r.ok) return r
    const i = this.routines.findIndex((x) => x.id === r.routine.id)
    if (i < 0 && this.routines.length >= ROUTINE_LIMITS.count) return { ok: false, error: `a project keeps at most ${ROUTINE_LIMITS.count} routines` }
    const routine: Routine = { ...r.routine, nextAt: nextRunAt(r.routine, now) }
    if (routine.nextAt === undefined) delete routine.nextAt
    if (i >= 0 && this.routines[i].lastRun) routine.lastRun = this.routines[i].lastRun
    this.set(i >= 0 ? this.routines.map((x, j) => (j === i ? routine : x)) : [...this.routines, routine])
    return { ok: true, routine }
  }

  remove(id: string): boolean {
    if (!this.routines.some((r) => r.id === id)) return false
    this.set(this.routines.filter((r) => r.id !== id))
    return true
  }

  runNow(id: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
    const r = this.routines.find((x) => x.id === id)
    if (!r) return { ok: false, error: 'no routine with that id' }
    const res = this.fire(r, now)
    return res.ok ? { ok: true } : { ok: false, error: res.text }
  }

  /** What became of a run that finishes later than its fire (a routine that first collects what it sends). */
  note(id: string, ok: boolean, text: string, now = Date.now()): void {
    if (!this.routines.some((r) => r.id === id)) return
    this.log(`routines: "${this.routines.find((r) => r.id === id)?.name}" ${ok ? text : `not sent (${text})`}`)
    this.set(this.routines.map((r) => (r.id === id ? { ...r, lastRun: { at: now, ok, text: text.slice(0, 200) } } : r)))
  }

  /** One timer tick: due routines run, missed ones are recorded; saved only when something moved. */
  tick(now = Date.now(), graceMs?: number): void {
    const t = tickRoutines(this.routines, now, graceMs)
    if (!t.changed) return
    const missedAt = new Map(this.routines.filter((r) => t.missed.includes(r.id)).map((r) => [r.id, r.nextAt as number]))
    this.routines = t.routines.map((r) =>
      missedAt.has(r.id) ? { ...r, lastRun: { at: now, ok: false, text: `missed: Ouroboros was closed or the PC was asleep at ${hhmm(missedAt.get(r.id) as number)}` } } : r
    )
    for (const id of t.fire) {
      const r = this.routines.find((x) => x.id === id)
      if (r) this.fire(r, now, false)
    }
    this.set(this.routines)
  }

  /** Write now (the window is closing or the project changes). */
  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.write()
  }

  dispose(): void {
    this.flush()
    this.removeAllListeners()
  }

  private fire(r: Routine, now: number, commit = true): { ok: boolean; text: string } {
    let res: { ok: boolean; text: string }
    try {
      res = this.run(r)
    } catch (e) {
      res = { ok: false, text: (e as Error).message || 'failed' }
    }
    this.log(`routines: "${r.name}" ${res.ok ? 'sent' : `not sent (${res.text})`}`)
    const lastRun = { at: now, ok: res.ok, text: res.text.slice(0, 200) }
    this.routines = this.routines.map((x) => (x.id === r.id ? { ...x, lastRun } : x))
    if (commit) this.set(this.routines)
    return res
  }

  private problem(text: string): void {
    this.log(`routines: ${text}`)
    this.failed(text)
  }

  private set(list: Routine[]): void {
    this.routines = list
    this.emit('change', this.routines)
    if (!this.file) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.saveDelayMs <= 0) return this.write()
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.write()
    }, this.saveDelayMs)
  }

  private write(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ routines: this.routines }, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      this.problem(`save failed: ${(e as Error).message}`)
    }
  }
}
