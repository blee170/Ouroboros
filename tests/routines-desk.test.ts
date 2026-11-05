import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoutineDesk, routinesFile } from '../src/main/routines'
import { resolveRoutineCard, routineRefusal, type Routine } from '../src/shared/routines'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'routines-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime()
const input = { name: 'Morning', prompt: 'Brief me', cardId: 'c1', cardTitle: 'Conductor', schedule: 'daily' as const, at: '09:00' }

function desk(file: string | undefined, run: (r: Routine) => { ok: boolean; text: string } = () => ({ ok: true, text: 'sent' })) {
  const runs: string[] = []
  const d = new RoutineDesk((r) => {
    runs.push(r.id)
    return run(r)
  }, () => {}, 0)
  d.load(file, at(4, 8))
  return { d, runs }
}

describe('routinesFile', () => {
  it('lives in the app data folder, one file per project, case-insensitive on the path', () => {
    expect(routinesFile('C:/data', 'C:/Proj')).toBe(routinesFile('C:/data', 'c:/proj'))
    expect(routinesFile('C:/data', 'C:/Proj')).toMatch(/[\\/]routines[\\/][0-9a-f]{16}\.json$/)
  })
})

describe('RoutineDesk', () => {
  it('saves a routine with its next time and writes it to disk', () => {
    const file = join(tmp(), 'r.json')
    const { d } = desk(file)
    const r = d.save(input, at(4, 8))
    expect(r.ok).toBe(true)
    expect(d.list()[0].nextAt).toBe(at(4, 9))
    d.flush()
    expect(JSON.parse(readFileSync(file, 'utf8')).routines[0]).toMatchObject({ name: 'Morning', nextAt: at(4, 9) })
  })

  it('edits a routine in place and recomputes its next time', () => {
    const { d } = desk(join(tmp(), 'r.json'))
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    d.save({ ...input, id: r.routine.id, at: '10:30' }, at(4, 8))
    expect(d.list()).toHaveLength(1)
    expect(d.list()[0].nextAt).toBe(at(4, 10, 30))
  })

  it('keeps the last run across an edit', () => {
    const { d } = desk(join(tmp(), 'r.json'))
    const r = d.save({ ...input, schedule: 'manual', at: undefined }, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    d.runNow(r.routine.id, at(4, 8))
    d.save({ ...input, id: r.routine.id, schedule: 'manual', at: undefined, prompt: 'new' }, at(4, 8, 5))
    expect(d.list()[0].lastRun).toMatchObject({ ok: true, text: 'sent' })
  })

  it('refuses a routine past the count and without a project', () => {
    const { d } = desk(undefined)
    expect(d.save(input, at(4, 8))).toEqual({ ok: false, error: expect.stringMatching(/project/) })
  })

  it('runs a routine now and records the result', () => {
    const { d, runs } = desk(join(tmp(), 'r.json'), () => ({ ok: false, text: 'card not running' }))
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    expect(d.runNow(r.routine.id, at(4, 8, 1))).toEqual({ ok: false, error: 'card not running' })
    expect(runs).toEqual([r.routine.id])
    expect(d.list()[0].lastRun).toEqual({ at: at(4, 8, 1), ok: false, text: 'card not running' })
    expect(d.runNow('nope', at(4, 8))).toEqual({ ok: false, error: expect.stringMatching(/no routine/) })
  })

  it('a run that throws is recorded as failed, not crashed', () => {
    const { d } = desk(join(tmp(), 'r.json'), () => {
      throw new Error('boom')
    })
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    expect(d.runNow(r.routine.id, at(4, 8))).toEqual({ ok: false, error: 'boom' })
  })

  it('tick fires due routines and records missed ones without running them', () => {
    const { d, runs } = desk(join(tmp(), 'r.json'))
    const a = d.save(input, at(4, 8))
    const b = d.save({ ...input, name: 'Noon', at: '12:00' }, at(4, 8))
    if (!a.ok || !b.ok) throw new Error('save')
    d.tick(at(4, 9, 0) + 5_000)
    expect(runs).toEqual([a.routine.id])
    d.tick(at(4, 16)) // the app slept through noon
    expect(runs).toEqual([a.routine.id])
    const noon = d.list().find((r) => r.id === b.routine.id)
    expect(noon?.lastRun).toMatchObject({ ok: false, text: expect.stringMatching(/missed/) })
    expect(noon?.nextAt).toBe(at(5, 12))
  })

  it('removes a routine', () => {
    const { d } = desk(join(tmp(), 'r.json'))
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    expect(d.remove(r.routine.id)).toBe(true)
    expect(d.list()).toEqual([])
    expect(d.remove(r.routine.id)).toBe(false)
  })

  it('sets an unreadable file aside instead of overwriting it', () => {
    const dir = tmp()
    const file = join(dir, 'r.json')
    writeFileSync(file, '{not json')
    const { d } = desk(file)
    expect(d.list()).toEqual([])
    expect(readdirSync(dir).some((f) => f.startsWith('r.json.unreadable-'))).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('emits the list on every change', () => {
    const { d } = desk(join(tmp(), 'r.json'))
    const seen: number[] = []
    d.on('change', (list: Routine[]) => seen.push(list.length))
    d.save(input, at(4, 8))
    expect(seen).toEqual([1])
  })
})

describe('resolveRoutineCard', () => {
  const nodes = [
    { id: 'c1', title: 'Conductor', kind: 'conductor' },
    { id: 'c2', title: 'Reviewer', kind: 'claude' },
    { id: 'c3', title: 'Reviewer', kind: 'claude' },
    { id: 'n1', title: 'Plan', kind: 'note' }
  ]
  const r = (cardId: string, cardTitle?: string): Routine => ({ id: 'r', name: 'n', prompt: 'p', cardId, cardTitle, schedule: 'manual', enabled: true })

  it('finds the card by id first', () => {
    expect(resolveRoutineCard(r('c2', 'Reviewer'), nodes)).toBe('c2')
  })

  it('falls back to a card with the same title when the id is gone (a replaced card), only when it is unique', () => {
    expect(resolveRoutineCard(r('old', 'Conductor'), nodes)).toBe('c1')
    expect(resolveRoutineCard(r('old', 'Reviewer'), nodes)).toBeUndefined()
    expect(resolveRoutineCard(r('old'), nodes)).toBeUndefined()
  })

  it('never resolves to a note or browser card', () => {
    expect(resolveRoutineCard(r('n1', 'Plan'), nodes)).toBeUndefined()
  })
})

describe('hunt fixes (desk)', () => {
  it('opening a project never runs a routine due a few minutes ago: it is missed', () => {
    const file = join(tmp(), 'r.json')
    writeFileSync(file, JSON.stringify({ routines: [{ id: 'r1', ...input, enabled: true, nextAt: at(4, 9) }] }))
    const runs: string[] = []
    const d = new RoutineDesk((r) => (runs.push(r.id), { ok: true, text: 'sent' }), () => {}, 0)
    d.load(file, at(4, 9, 5))
    expect(runs).toEqual([])
    expect(d.list()[0].lastRun).toMatchObject({ ok: false, text: expect.stringMatching(/missed/) })
  })

  it('an edit while the routine is due runs it first instead of skipping it', () => {
    const { d, runs } = desk(join(tmp(), 'r.json'))
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    d.save({ ...input, id: r.routine.id, name: 'Renamed' }, at(4, 9, 0) + 10_000)
    expect(runs).toEqual([r.routine.id])
    expect(d.list()[0].nextAt).toBe(at(5, 9))
  })

  it('saving an edit of a deleted routine does not bring it back', () => {
    const { d } = desk(join(tmp(), 'r.json'))
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    d.remove(r.routine.id)
    expect(d.save({ ...input, id: r.routine.id }, at(4, 8))).toEqual({ ok: false, error: expect.stringMatching(/deleted/) })
    expect(d.list()).toEqual([])
  })

  it('an edit without an on/off value keeps the stored one', () => {
    const { d } = desk(join(tmp(), 'r.json'))
    const r = d.save({ ...input, enabled: false }, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    d.save({ ...input, id: r.routine.id, enabled: undefined, name: 'x' }, at(4, 8))
    expect(d.list()[0].enabled).toBe(false)
  })
})

describe('hunt fixes (safety)', () => {
  const r = (cardId: string, cardTitle?: string): Routine => ({ id: 'r', name: 'n', prompt: 'p', cardId, cardTitle, schedule: 'manual', enabled: true })
  it('the title fallback never picks a command card (its template is whatever its maker chose)', () => {
    expect(resolveRoutineCard(r('old', 'Exporter'), [{ id: 'k1', title: 'Exporter', kind: 'command' }])).toBeUndefined()
    expect(resolveRoutineCard(r('k1', 'Exporter'), [{ id: 'k1', title: 'Exporter', kind: 'command' }])).toBe('k1')
  })

  it('a card on a prompt or still starting is not typed into', () => {
    expect(routineRefusal('needs-you')).toMatch(/waiting on a prompt/)
    expect(routineRefusal('starting')).toMatch(/starting/)
    expect(routineRefusal('idle')).toBeUndefined()
    expect(routineRefusal('working')).toBeUndefined()
    expect(routineRefusal('done')).toBeUndefined()
  })

  it('a save that cannot be written is reported, not only logged', () => {
    const problems: string[] = []
    const dir = tmp()
    // the target is a folder, so the rename over it fails
    const file = join(dir, 'r.json')
    mkdirSync(file)
    const d = new RoutineDesk(() => ({ ok: true, text: 'sent' }), () => {}, 0, (p) => problems.push(p))
    d.load(file, at(4, 8))
    d.save(input, at(4, 8))
    expect(problems.some((p) => /could not|save failed/.test(p))).toBe(true)
  })
})

describe('note', () => {
  it('records what became of a run that finished later, and saves it', () => {
    const file = join(tmp(), 'r.json')
    const { d } = desk(file, () => ({ ok: true, text: 'collecting CLI updates…' }))
    const r = d.save(input, at(4, 8))
    if (!r.ok) throw new Error(r.error)
    d.runNow(r.routine.id, at(4, 8, 1))
    d.note(r.routine.id, true, 'no CLI updates since the last run', at(4, 8, 2))
    expect(d.list()[0].lastRun).toEqual({ at: at(4, 8, 2), ok: true, text: 'no CLI updates since the last run' })
    expect(JSON.parse(readFileSync(file, 'utf8')).routines[0].lastRun.text).toBe('no CLI updates since the last run')
    // a routine deleted while its run was collecting is not brought back
    d.remove(r.routine.id)
    d.note(r.routine.id, false, 'late', at(4, 8, 3))
    expect(d.list()).toEqual([])
  })
})
