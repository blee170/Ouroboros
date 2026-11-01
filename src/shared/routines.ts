/**
 * Routines: a saved prompt for one card, run with a button or on a schedule (every day or every weekday at a local
 * time, or every n hours). Pure: main keeps the list per project in the app's data folder and runs the timer.
 * A routine whose time passed while the app was off is missed, not run late.
 */

export const ROUTINE_LIMITS = { name: 80, prompt: 8000, count: 50, maxHours: 24 }
/** A scheduled routine still fires this long after its time (a tick that came late, a sleeping PC that woke). */
export const ROUTINE_GRACE_MS = 10 * 60_000

export type RoutineSchedule = 'manual' | 'daily' | 'weekdays' | 'hourly'
const SCHEDULES: readonly RoutineSchedule[] = ['manual', 'daily', 'weekdays', 'hourly']

export interface RoutineRun {
  at: number
  ok: boolean
  /** what happened, one line ("sent", "card not running", "missed: the app was off at 09:00") */
  text: string
}

export interface Routine {
  id: string
  name: string
  prompt: string
  /** the card it goes to; the title is kept so a card replaced under the same title is still found */
  cardId: string
  cardTitle?: string
  schedule: RoutineSchedule
  /** HH:MM, local time (daily / weekdays) */
  at?: string
  /** hourly */
  everyHours?: number
  enabled: boolean
  nextAt?: number
  lastRun?: RoutineRun
}

export type RoutineInput = Partial<Omit<Routine, 'nextAt' | 'lastRun'>>

const HIDDEN_CHARS = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]')
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function normTime(v: unknown): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v))
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${m[2]}` : undefined
}

let seq = 0
const newId = (): string => `rt${Date.now().toString(36)}${(seq++).toString(36)}`

/** Pure: a routine the owner saved, checked and cleaned; run state (next time, last run) is never taken from input. */
export function checkRoutine(input: RoutineInput): { ok: true; routine: Routine } | { ok: false; error: string } {
  const name = str(input.name)
  const prompt = str(input.prompt)
  const cardId = str(input.cardId)
  if (!name) return { ok: false, error: 'give the routine a name' }
  if (name.length > ROUTINE_LIMITS.name) return { ok: false, error: `the name is longer than ${ROUTINE_LIMITS.name} characters` }
  if (!prompt) return { ok: false, error: 'write the prompt the routine sends' }
  if (prompt.length > ROUTINE_LIMITS.prompt) return { ok: false, error: `the prompt is longer than ${ROUTINE_LIMITS.prompt} characters` }
  if (HIDDEN_CHARS.test(name) || HIDDEN_CHARS.test(prompt)) return { ok: false, error: 'the name or prompt has invisible characters' }
  if (!cardId) return { ok: false, error: 'pick the card the routine goes to' }
  if (cardId.length > 200 || str(input.id).length > 64 || HIDDEN_CHARS.test(cardId + str(input.id))) return { ok: false, error: 'not a routine id or card id' }
  const schedule = input.schedule as RoutineSchedule
  if (!SCHEDULES.includes(schedule)) return { ok: false, error: 'pick when it runs' }
  const routine: Routine = { id: str(input.id) || newId(), name, prompt, cardId, schedule, enabled: input.enabled !== false }
  const title = str(input.cardTitle)
  if (title) routine.cardTitle = title.slice(0, 200)
  if (schedule === 'daily' || schedule === 'weekdays') {
    const t = normTime(input.at)
    if (!t) return { ok: false, error: 'the time must be HH:MM (00:00 to 23:59)' }
    routine.at = t
  } else if (schedule === 'hourly') {
    const h = input.everyHours
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > ROUTINE_LIMITS.maxHours) return { ok: false, error: `every 1 to ${ROUTINE_LIMITS.maxHours} hours` }
    routine.everyHours = h
  }
  return { ok: true, routine }
}

/** Pure: when the routine runs next after `now`, or undefined (a button, or switched off). Local time. */
export function nextRunAt(r: Routine, now: number): number | undefined {
  if (!r.enabled || r.schedule === 'manual') return undefined
  if (r.schedule === 'hourly') {
    if (!r.everyHours) return undefined
    const step = r.everyHours * 3_600_000
    // keep the cadence of the planned time (a tick comes up to 30 s late); a time long past starts again from now
    if (r.nextAt === undefined || now - r.nextAt > step) return now + step
    return r.nextAt + Math.ceil((now - r.nextAt + 1) / step) * step
  }
  const t = normTime(r.at)
  if (!t) return undefined
  const [h, m] = t.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  if (r.schedule === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  // a day change can carry a DST shift from the first day (02:30 that did not exist became 03:30): set the time again
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

/**
 * Pure: one tick of the timer. Routines whose time came (within the grace) fire; ones whose time is long past are
 * missed; both get their next time. A scheduled routine with no next time gets one; others lose a stale one.
 */
export function tickRoutines(list: readonly Routine[], now: number, graceMs = ROUTINE_GRACE_MS): { routines: Routine[]; fire: string[]; missed: string[]; changed: boolean } {
  const fire: string[] = []
  const missed: string[] = []
  let changed = false
  const routines = list.map((r) => {
    const scheduled = r.enabled && r.schedule !== 'manual'
    if (!scheduled) {
      if (r.nextAt === undefined) return r
      changed = true
      const { nextAt: _drop, ...rest } = r
      return rest
    }
    if (r.nextAt !== undefined && now < r.nextAt) return r
    changed = true
    if (r.nextAt !== undefined) (now - r.nextAt <= graceMs ? fire : missed).push(r.id)
    return { ...r, nextAt: nextRunAt(r, now) }
  })
  return { routines, fire, missed, changed }
}

/** Pure: the soonest scheduled routine, for Today's one line. */
export function nextUp(list: readonly Routine[]): Routine | undefined {
  let best: Routine | undefined
  for (const r of list) if (r.enabled && r.schedule !== 'manual' && r.nextAt !== undefined && (!best || r.nextAt < (best.nextAt as number))) best = r
  return best
}

/** Pure: the routines file as read from disk (anything else is dropped, ids are unique, the count is capped). */
export function sanitizeRoutines(raw: unknown): Routine[] {
  const list = raw && typeof raw === 'object' ? (raw as { routines?: unknown }).routines : undefined
  if (!Array.isArray(list)) return []
  const out: Routine[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (out.length >= ROUTINE_LIMITS.count) break
    if (!item || typeof item !== 'object') continue
    const r = checkRoutine(item as RoutineInput)
    if (!r.ok || !str((item as Routine).id) || seen.has(r.routine.id)) continue
    seen.add(r.routine.id)
    const o = item as Partial<Routine>
    if (typeof o.nextAt === 'number' && Number.isFinite(o.nextAt)) r.routine.nextAt = o.nextAt
    const lr = o.lastRun
    if (lr && typeof lr.at === 'number' && Number.isFinite(lr.at) && typeof lr.ok === 'boolean' && typeof lr.text === 'string') r.routine.lastRun = { at: lr.at, ok: lr.ok, text: lr.text.slice(0, 200) }
    out.push(r.routine)
  }
  return out
}

const AGENT_KINDS = new Set(['claude', 'conductor', 'command'])

/**
 * Pure: the card a routine goes to — its card by id, else the one agent card with the same title (a card replaced
 * under the same name, as create_agent does for a role). Two cards with that title is ambiguous: none.
 */
export function resolveRoutineCard(r: Routine, nodes: ReadonlyArray<{ id: string; title: string; kind: string }>): string | undefined {
  const byId = nodes.find((n) => n.id === r.cardId)
  if (byId) return AGENT_KINDS.has(byId.kind) ? byId.id : undefined
  if (!r.cardTitle) return undefined
  // never a command card by title: its template is whatever the card that made it chose
  const same = nodes.filter((n) => (n.kind === 'claude' || n.kind === 'conductor') && n.title === r.cardTitle)
  return same.length === 1 ? same[0].id : undefined
}

/** Pure: when a routine runs, in words, for its row. */
export function scheduleText(r: Routine): string {
  const when =
    r.schedule === 'daily' ? `every day at ${r.at}` : r.schedule === 'weekdays' ? `weekdays at ${r.at}` : r.schedule === 'hourly' ? (r.everyHours === 1 ? 'every hour' : `every ${r.everyHours} hours`) : 'button only'
  return r.schedule !== 'manual' && !r.enabled ? `${when} (off)` : when
}

/**
 * Pure: why a routine must not be typed into a card in this state, or undefined. A card on a prompt (a permission
 * menu, the folder-trust question whose default is "No, exit") would take the routine's Enter as its answer; a
 * card still starting may not own its terminal yet. The phone's prompt path refuses the same.
 */
export function routineRefusal(status: string | undefined): string | undefined {
  if (status === 'needs-you') return 'the card is waiting on a prompt: answer it first'
  if (status === 'starting') return 'the card is still starting'
  return undefined
}
