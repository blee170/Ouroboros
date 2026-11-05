import { describe, expect, it } from 'vitest'
import { checkRoutine, nextRunAt, nextUp, ROUTINE_LIMITS, sanitizeRoutines, scheduleText, tickRoutines, type Routine } from '../src/shared/routines'

// local time, so the tests mean the same in any time zone: Wed 2026-11-04 08:00
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime()
const WED = 4
const base: Routine = { id: 'r1', name: 'Morning briefing', prompt: 'Brief me on today', cardId: 'c1', cardTitle: 'Conductor', schedule: 'daily', at: '09:00', enabled: true }

describe('checkRoutine', () => {
  it('accepts a daily routine and trims its text', () => {
    const r = checkRoutine({ name: '  Morning  ', prompt: ' Brief me ', cardId: 'c1', cardTitle: 'Conductor', schedule: 'daily', at: '9:05' })
    expect(r).toEqual({ ok: true, routine: expect.objectContaining({ name: 'Morning', prompt: 'Brief me', schedule: 'daily', at: '09:05', enabled: true }) })
  })

  it('accepts a manual routine with no time (a button)', () => {
    const r = checkRoutine({ name: 'Status', prompt: 'status?', cardId: 'c1', schedule: 'manual' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.routine.at).toBeUndefined()
  })

  it('refuses a missing name, prompt or card', () => {
    expect(checkRoutine({ name: '', prompt: 'x', cardId: 'c1', schedule: 'manual' })).toEqual({ ok: false, error: expect.stringMatching(/name/) })
    expect(checkRoutine({ name: 'a', prompt: '  ', cardId: 'c1', schedule: 'manual' })).toEqual({ ok: false, error: expect.stringMatching(/prompt/) })
    expect(checkRoutine({ name: 'a', prompt: 'x', cardId: '', schedule: 'manual' })).toEqual({ ok: false, error: expect.stringMatching(/card/) })
  })

  it('refuses a bad time, a bad interval and an unknown schedule', () => {
    expect(checkRoutine({ ...base, at: '25:00' }).ok).toBe(false)
    expect(checkRoutine({ ...base, at: '9' }).ok).toBe(false)
    expect(checkRoutine({ ...base, at: undefined }).ok).toBe(false)
    expect(checkRoutine({ ...base, schedule: 'hourly', at: undefined, everyHours: 0 }).ok).toBe(false)
    expect(checkRoutine({ ...base, schedule: 'hourly', at: undefined, everyHours: 25 }).ok).toBe(false)
    expect(checkRoutine({ ...base, schedule: 'hourly', at: undefined, everyHours: 1.5 }).ok).toBe(false)
    expect(checkRoutine({ ...base, schedule: 'cron' as never }).ok).toBe(false)
  })

  it('refuses text past the limits and invisible characters', () => {
    expect(checkRoutine({ ...base, name: 'x'.repeat(ROUTINE_LIMITS.name + 1) }).ok).toBe(false)
    expect(checkRoutine({ ...base, prompt: 'x'.repeat(ROUTINE_LIMITS.prompt + 1) }).ok).toBe(false)
    expect(checkRoutine({ ...base, prompt: 'ok‮hidden' }).ok).toBe(false)
    expect(checkRoutine({ ...base, name: 'a​b' }).ok).toBe(false)
  })

  it('keeps an existing id and drops the stored run state of the input', () => {
    const r = checkRoutine({ ...base, nextAt: 5, lastRun: { at: 1, ok: true, text: 'x' } } as never)
    expect(r.ok && r.routine.id).toBe('r1')
    expect(r.ok && r.routine.nextAt).toBeUndefined()
  })
})

describe('nextRunAt', () => {
  it('daily: today when the time is still ahead, else tomorrow', () => {
    expect(nextRunAt(base, at(WED, 8))).toBe(at(WED, 9))
    expect(nextRunAt(base, at(WED, 9))).toBe(at(WED + 1, 9))
    expect(nextRunAt(base, at(WED, 10))).toBe(at(WED + 1, 9))
  })

  it('weekdays: Friday evening goes to Monday', () => {
    const r: Routine = { ...base, schedule: 'weekdays' }
    expect(nextRunAt(r, at(6, 18))).toBe(at(9, 9)) // Fri 6th → Mon 9th
    expect(nextRunAt(r, at(7, 8))).toBe(at(9, 9)) // Sat
    expect(nextRunAt(r, at(WED, 8))).toBe(at(WED, 9))
  })

  it('hourly: every n hours from now', () => {
    expect(nextRunAt({ ...base, schedule: 'hourly', at: undefined, everyHours: 3 }, at(WED, 8))).toBe(at(WED, 11))
  })

  it('none for a manual or switched-off routine', () => {
    expect(nextRunAt({ ...base, schedule: 'manual' }, at(WED, 8))).toBeUndefined()
    expect(nextRunAt({ ...base, enabled: false }, at(WED, 8))).toBeUndefined()
  })
})

describe('tickRoutines', () => {
  it('fires a routine whose time came and schedules the next one', () => {
    const r = { ...base, nextAt: at(WED, 9) }
    const t = tickRoutines([r], at(WED, 9, 0) + 20_000)
    expect(t.fire).toEqual(['r1'])
    expect(t.missed).toEqual([])
    expect(t.routines[0].nextAt).toBe(at(WED + 1, 9))
  })

  it('does not fire a routine whose time is past the grace (the app was off): it is missed, not run late', () => {
    const r = { ...base, nextAt: at(WED, 9) }
    const t = tickRoutines([r], at(WED, 15))
    expect(t.fire).toEqual([])
    expect(t.missed).toEqual(['r1'])
    expect(t.routines[0].nextAt).toBe(at(WED + 1, 9))
  })

  it('gives a scheduled routine with no next time one, without firing it', () => {
    const t = tickRoutines([{ ...base }], at(WED, 9, 30))
    expect(t.fire).toEqual([])
    expect(t.routines[0].nextAt).toBe(at(WED + 1, 9))
  })

  it('leaves manual and switched-off routines alone and clears a stale next time', () => {
    const t = tickRoutines([{ ...base, schedule: 'manual', nextAt: at(WED, 9) }, { ...base, id: 'r2', enabled: false, nextAt: at(WED, 9) }], at(WED, 9, 1))
    expect(t.fire).toEqual([])
    expect(t.routines.map((r) => r.nextAt)).toEqual([undefined, undefined])
  })

  it('reports no change when nothing moved, so the caller does not save every tick', () => {
    const r = { ...base, nextAt: at(WED, 9) }
    expect(tickRoutines([r], at(WED, 8)).changed).toBe(false)
    expect(tickRoutines([r], at(WED, 9, 0)).changed).toBe(true)
  })
})

describe('sanitizeRoutines', () => {
  it('keeps valid routines with their run state and drops the rest', () => {
    const raw = { routines: [{ ...base, nextAt: 7, lastRun: { at: 3, ok: false, text: 'card not running' } }, { id: 'bad' }, null, 'x'] }
    const out = sanitizeRoutines(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'r1', nextAt: 7, lastRun: { at: 3, ok: false, text: 'card not running' } })
  })

  it('drops duplicate ids and caps the count', () => {
    const many = Array.from({ length: ROUTINE_LIMITS.count + 5 }, (_, i) => ({ ...base, id: `r${i}` }))
    expect(sanitizeRoutines({ routines: [...many, { ...base, id: 'r0' }] })).toHaveLength(ROUTINE_LIMITS.count)
  })

  it('returns an empty list for anything else', () => {
    expect(sanitizeRoutines(undefined)).toEqual([])
    expect(sanitizeRoutines({ routines: 'nope' })).toEqual([])
  })
})

describe('nextUp', () => {
  it('names the soonest scheduled routine', () => {
    const list = [
      { ...base, id: 'a', name: 'Late', nextAt: at(WED, 18) },
      { ...base, id: 'b', name: 'Soon', nextAt: at(WED, 9) },
      { ...base, id: 'c', name: 'Button', schedule: 'manual' as const }
    ]
    expect(nextUp(list)).toMatchObject({ id: 'b', name: 'Soon' })
    expect(nextUp([list[2]])).toBeUndefined()
  })
})

describe('scheduleText', () => {
  it('says when a routine runs in words', () => {
    expect(scheduleText(base)).toBe('every day at 09:00')
    expect(scheduleText({ ...base, schedule: 'weekdays' })).toBe('weekdays at 09:00')
    expect(scheduleText({ ...base, schedule: 'hourly', everyHours: 1 })).toBe('every hour')
    expect(scheduleText({ ...base, schedule: 'hourly', everyHours: 3 })).toBe('every 3 hours')
    expect(scheduleText({ ...base, schedule: 'manual' })).toBe('button only')
    expect(scheduleText({ ...base, enabled: false })).toBe('every day at 09:00 (off)')
  })
})

describe('hunt fixes (model)', () => {
  it('hourly keeps its cadence from the planned time, not the late tick', () => {
    const r: Routine = { ...base, schedule: 'hourly', at: undefined, everyHours: 1, nextAt: at(WED, 9) }
    const t = tickRoutines([r], at(WED, 9) + 25_000)
    expect(t.routines[0].nextAt).toBe(at(WED, 10))
  })

  it('a grace of 0 records every past time as missed (project open)', () => {
    const t = tickRoutines([{ ...base, nextAt: at(WED, 9) }], at(WED, 9, 5), 0)
    expect(t.fire).toEqual([])
    expect(t.missed).toEqual(['r1'])
  })

  it('refuses an over-long id or card id', () => {
    expect(checkRoutine({ ...base, id: 'x'.repeat(65) }).ok).toBe(false)
    expect(checkRoutine({ ...base, cardId: 'x'.repeat(201) }).ok).toBe(false)
  })
})

describe('weekly', () => {
  const monday: Routine = { ...base, schedule: 'weekly', weekday: 1 }
  it('runs on its day of the week: this week when still ahead, else next week', () => {
    expect(nextRunAt(monday, at(WED, 8))).toBe(at(9, 9)) // Wed 4th → Mon 9th
    expect(nextRunAt(monday, at(9, 8))).toBe(at(9, 9)) // Monday before the time
    expect(nextRunAt(monday, at(9, 9))).toBe(at(16, 9)) // at the time: next week
    expect(nextRunAt({ ...monday, weekday: 3 }, at(WED, 8))).toBe(at(WED, 9))
    expect(nextRunAt({ ...monday, weekday: undefined }, at(WED, 8))).toBeUndefined()
  })
  it('needs a time and a day, and says when it runs', () => {
    const ok = checkRoutine({ name: 'Watch', prompt: 'p', cardId: 'c', schedule: 'weekly', at: '9:00', weekday: 1 })
    expect(ok).toMatchObject({ ok: true, routine: { schedule: 'weekly', at: '09:00', weekday: 1 } })
    expect(checkRoutine({ name: 'Watch', prompt: 'p', cardId: 'c', schedule: 'weekly', at: '09:00' })).toEqual({ ok: false, error: 'pick the day of the week' })
    expect(checkRoutine({ name: 'Watch', prompt: 'p', cardId: 'c', schedule: 'weekly', at: '09:00', weekday: 7 }).ok).toBe(false)
    expect(checkRoutine({ name: 'Watch', prompt: 'p', cardId: 'c', schedule: 'weekly', weekday: 1 }).ok).toBe(false)
    // a day on a routine that is not weekly is dropped
    expect((checkRoutine({ name: 'Watch', prompt: 'p', cardId: 'c', schedule: 'daily', at: '09:00', weekday: 1 }) as { routine: Routine }).routine.weekday).toBeUndefined()
    expect(scheduleText(monday)).toBe('every Monday at 09:00')
    expect(sanitizeRoutines({ routines: [{ ...monday, nextAt: 5 }] })[0]).toMatchObject({ schedule: 'weekly', weekday: 1, nextAt: 5 })
  })
  it('fires within the grace on its day and waits a week', () => {
    const t = tickRoutines([{ ...monday, nextAt: at(9, 9) }], at(9, 9, 1))
    expect(t.fire).toEqual([monday.id])
    expect(t.routines[0].nextAt).toBe(at(16, 9))
  })
})
