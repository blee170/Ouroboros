import { describe, expect, it } from 'vitest'
import { claimTask, createTask, emptyLedger, filterTasks, formatTasks, releaseTasksOf, sanitizeLedger, summarizeTasks, updateTask, type LedgerData } from '@shared/ledger'

const ok = (r: ReturnType<typeof createTask>): LedgerData => {
  if (!r.ok) throw new Error(r.error)
  return r.data
}
const err = (r: ReturnType<typeof createTask>): string => (r.ok ? '' : r.error)
const live = new Set(['c1', 'c2'])

describe('ledger: create', () => {
  it('numbers tasks T1, T2 and cleans the title', () => {
    let d = ok(createTask(emptyLedger(), { title: '  Plan‮ the\nthing  ' }, 'cond', 10))
    d = ok(createTask(d, { title: 'x'.repeat(200), detail: 'd\r\ne' }, 'owner', 11))
    expect(d.tasks.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(d.tasks[0]).toMatchObject({ title: 'Plan the thing', state: 'todo', deps: [], createdBy: 'cond', createdAt: 10, updatedAt: 10 })
    expect(d.tasks[1].title).toHaveLength(120)
    expect(d.tasks[1].detail).toBe('d\ne')
    expect(d.nextTaskId).toBe(3)
    expect(err(createTask(d, { title: '\u0007' }, 'cond'))).toBe('title required')
  })
  it('validates parent and deps, refuses cycles, and claims when an owner is given', () => {
    let d = ok(createTask(emptyLedger(), { title: 'a' }, 'cond'))
    expect(err(createTask(d, { title: 'b', parent: 'T9' }, 'cond'))).toBe('no task T9')
    expect(err(createTask(d, { title: 'b', deps: ['nope'] }, 'cond'))).toBe('bad task id in deps: nope')
    d = ok(createTask(d, { title: 'b', parent: 'T1', deps: ['T1', 'T1'] }, 'cond'))
    expect(d.tasks[1]).toMatchObject({ parent: 'T1', deps: ['T1'] })
    expect(err(updateTask(d, 'T1', { deps: ['T2'] }, 'cond'))).toBe('deps would form a cycle through T1')
    expect(err(updateTask(d, 'T1', { parent: 'T2' }, 'cond'))).toBe('parent T2 would form a loop')
    expect(err(updateTask(d, 'T1', { deps: ['T1'] }, 'cond'))).toBe('T1 cannot depend on itself')
    d = ok(createTask(d, { title: 'c', owner: 'c1' }, 'cond'))
    expect(d.tasks[2]).toMatchObject({ state: 'doing', owner: 'c1' })
  })
  it('caps the ledger', () => {
    let d = emptyLedger()
    for (let i = 0; i < 500; i++) d = ok(createTask(d, { title: `t${i}` }, 'cond'))
    expect(err(createTask(d, { title: 'one more' }, 'cond'))).toMatch(/at most 500/)
  })
})

describe('ledger: claim and update', () => {
  const base = (): LedgerData => {
    let d = ok(createTask(emptyLedger(), { title: 'plan' }, 'cond'))
    d = ok(createTask(d, { title: 'implement', deps: ['T1'] }, 'cond'))
    return d
  }
  it('waits for deps, refuses a live owner, lets a dead owner be taken over', () => {
    let d = base()
    expect(err(claimTask(d, 'T2', 'c1', live))).toBe('T2 waits for T1 (not done)')
    expect(err(claimTask(d, 'T7', 'c1', live))).toBe('no task T7')
    d = ok(claimTask(d, 'T1', 'c1', live))
    expect(d.tasks[0]).toMatchObject({ state: 'doing', owner: 'c1' })
    expect(err(claimTask(d, 'T1', 'c2', live))).toMatch(/owned by a live card \(c1\)/)
    expect(ok(claimTask(d, 'T1', 'c1', live)).tasks[0].owner).toBe('c1') // re-claim by the owner is fine
    d = ok(claimTask(d, 'T1', 'c2', new Set(['c2']))) // c1 is dead
    expect(d.tasks[0].owner).toBe('c2')
    d = ok(updateTask(d, 'T1', { state: 'done', result: 'planned' }, 'c2'))
    expect(d.tasks[0]).toMatchObject({ state: 'done', result: 'planned' })
    expect(d.tasks[0].owner).toBeUndefined()
    expect(err(claimTask(d, 'T1', 'c1', live))).toBe('T1 is done')
    expect(ok(claimTask(d, 'T2', 'c1', live)).tasks[1].state).toBe('doing')
  })
  it('gates done and blocked, reopens, drops, reassigns', () => {
    let d = base()
    expect(err(updateTask(d, 'T1', { state: 'done' }, 'cond'))).toMatch(/done needs a result/)
    expect(err(updateTask(d, 'T1', { state: 'blocked' }, 'cond'))).toMatch(/blocked needs a reason/)
    expect(err(updateTask(d, 'T1', { state: 'nope' as never }, 'cond'))).toMatch(/bad state: nope/)
    d = ok(updateTask(d, 'T1', { state: 'blocked', reason: 'APPROVAL NEEDED: deploy' }, 'cond'))
    expect(d.tasks[0]).toMatchObject({ state: 'blocked', reason: 'APPROVAL NEEDED: deploy' })
    // doing without an owner: the caller card becomes the owner, the human cannot
    expect(err(updateTask(d, 'T1', { state: 'doing' }, 'owner'))).toMatch(/doing needs an owner/)
    d = ok(updateTask(d, 'T1', { state: 'doing' }, 'c1'))
    expect(d.tasks[0].owner).toBe('c1')
    d = ok(updateTask(d, 'T1', { owner: 'c2' }, 'cond'))
    expect(d.tasks[0].owner).toBe('c2')
    d = ok(updateTask(d, 'T1', { state: 'todo' }, 'cond'))
    expect(d.tasks[0].owner).toBeUndefined()
    d = ok(updateTask(d, 'T1', { owner: 'c1' }, 'cond')) // owner on a todo task = doing
    expect(d.tasks[0].state).toBe('doing')
    d = ok(updateTask(d, 'T2', { state: 'dropped', reason: 'not needed', title: 'implement (old)' }, 'owner'))
    expect(d.tasks[1]).toMatchObject({ state: 'dropped', title: 'implement (old)' })
    d = ok(updateTask(d, 'T2', { state: 'todo', reason: '', result: 'x' }, 'owner'))
    expect(d.tasks[1].reason).toBeUndefined()
    expect(err(updateTask(d, 'T2', { title: '   ' }, 'owner'))).toBe('title required')
    expect(err(updateTask(d, 'T9', { title: 'x' }, 'owner'))).toBe('no task T9')
  })
  it('does not mutate the previous ledger', () => {
    const d = base()
    const before = JSON.stringify(d)
    ok(claimTask(d, 'T1', 'c1', live))
    ok(updateTask(d, 'T1', { title: 'changed' }, 'cond'))
    expect(JSON.stringify(d)).toBe(before)
  })
})

describe('ledger: release, filter, format, summary', () => {
  it('releases the doing tasks of a card that ended', () => {
    let d = ok(createTask(emptyLedger(), { title: 'a', owner: 'c1' }, 'cond'))
    d = ok(createTask(d, { title: 'b', owner: 'c1' }, 'cond'))
    d = ok(updateTask(d, 'T2', { state: 'blocked', reason: 'waiting' }, 'c1'))
    d = ok(createTask(d, { title: 'c', owner: 'c2' }, 'cond'))
    const r = releaseTasksOf(d, 'c1', '🛠 Implementer')
    expect(r.released).toEqual(['T1'])
    expect(r.data.tasks[0]).toMatchObject({ state: 'todo', reason: 'card 🛠 Implementer ended before it finished' })
    expect(r.data.tasks[0].owner).toBeUndefined()
    expect(r.data.tasks[1].owner).toBe('c1') // blocked keeps its owner
    expect(r.data.tasks[2].owner).toBe('c2')
    expect(releaseTasksOf(r.data, 'c1', 'x').data).toBe(r.data) // nothing to do: same object
  })
  it('filters and formats', () => {
    let d = ok(createTask(emptyLedger(), { title: 'plan', detail: 'write\nthe plan' }, 'cond'))
    d = ok(createTask(d, { title: 'build', deps: ['T1'], parent: 'T1' }, 'cond'))
    d = ok(updateTask(d, 'T1', { state: 'done', result: 'planned it' }, 'cond'))
    d = ok(createTask(d, { title: 'ship', owner: 'c1' }, 'cond'))
    d = ok(updateTask(d, 'T3', { state: 'blocked', reason: 'APPROVAL NEEDED: push' }, 'c1'))
    expect(filterTasks(d.tasks).map((t) => t.id)).toEqual(['T2', 'T3'])
    expect(filterTasks(d.tasks, { all: true }).map((t) => t.id)).toEqual(['T1', 'T2', 'T3'])
    expect(filterTasks(d.tasks, { state: 'done' }).map((t) => t.id)).toEqual(['T1'])
    expect(filterTasks(d.tasks, { owner: 'c1' }).map((t) => t.id)).toEqual(['T3'])
    expect(filterTasks(d.tasks, { parent: 'T1' }).map((t) => t.id)).toEqual(['T2'])
    expect(summarizeTasks(d.tasks)).toEqual({ todo: 1, doing: 0, blocked: 1, done: 1, dropped: 0 })
    const text = formatTasks(filterTasks(d.tasks, { all: true }), d.tasks, new Map([['c1', '🚀 Ops']]))
    expect(text.split('\n')).toEqual([
      '3 tasks: 1 todo · 0 doing · 1 blocked · 1 done · 0 dropped',
      'T1 [done] plan',
      '    detail: write the plan',
      '    result: planned it',
      'T2 [todo] build · parent: T1 · deps: T1',
      'T3 [blocked] ship · owner: 🚀 Ops',
      '    reason: APPROVAL NEEDED: push'
    ])
    expect(formatTasks([], d.tasks, new Map())).toContain('(none match')
  })
  it('sanitizes a stored ledger', () => {
    expect(sanitizeLedger(undefined)).toEqual({ tasks: [], nextTaskId: 1 })
    expect(sanitizeLedger({ tasks: 'x' })).toEqual({ tasks: [], nextTaskId: 1 })
    const s = sanitizeLedger({
      nextTaskId: 2,
      tasks: [
        { id: 'T5', title: 'ok', state: 'doing', owner: 'c1', deps: ['T5', 'T9', 'T1'], parent: 'T9', createdAt: 1, updatedAt: 2 },
        { id: 'T1', title: 'first', state: 'weird', owner: 'c1', reason: 'r', result: 'x', detail: 'd' },
        { id: 'T1', title: 'dup' },
        { id: 'bad', title: 'no id' },
        { id: 'T2', title: '' },
        null,
        'junk'
      ]
    })
    expect(s.tasks.map((t) => t.id)).toEqual(['T5', 'T1'])
    expect(s.tasks[0]).toMatchObject({ state: 'doing', owner: 'c1', deps: ['T1'], createdBy: 'owner', createdAt: 1, updatedAt: 2 })
    expect(s.tasks[0].parent).toBeUndefined()
    expect(s.tasks[1]).toMatchObject({ state: 'todo', reason: 'r', result: 'x', detail: 'd' })
    expect(s.tasks[1].owner).toBeUndefined() // a todo task has no owner
    expect(s.nextTaskId).toBe(6)
    expect(sanitizeLedger({ tasks: [{ id: 'T1', title: 'a' }], nextTaskId: 40 }).nextTaskId).toBe(40)
  })
})

describe('ledger: bug-hunt rules', () => {
  it('counts only open tasks toward the cap, refuses an owner while deps are unmet, caps deps', () => {
    let d = emptyLedger()
    for (let i = 0; i < 500; i++) d = ok(createTask(d, { title: `t${i}` }, 'cond'))
    expect(err(createTask(d, { title: 'one more' }, 'cond'))).toMatch(/at most 500 open/)
    d = ok(updateTask(d, 'T1', { state: 'dropped' }, 'cond'))
    expect(createTask(d, { title: 'fits now' }, 'cond').ok).toBe(true)
    expect(err(createTask(d, { title: 'x', deps: ['T2'], owner: 'c1' }, 'cond'))).toBe('cannot start it: waits for T2 (not done)')
    expect(err(createTask(d, { title: 'x', deps: Array.from({ length: 51 }, (_, i) => `T${i + 2}`) }, 'cond'))).toBe('at most 50 deps')
  })
  it('records who changed a task; owner= cleared on a doing task makes it todo', () => {
    let d = ok(createTask(emptyLedger(), { title: 'a' }, 'cond'))
    expect(d.tasks[0]).toMatchObject({ createdBy: 'cond', updatedBy: 'cond' })
    d = ok(claimTask(d, 'T1', 'c1', live))
    expect(d.tasks[0].updatedBy).toBe('c1')
    d = ok(updateTask(d, 'T1', { owner: null }, 'owner'))
    expect(d.tasks[0]).toMatchObject({ state: 'todo', updatedBy: 'owner' })
    expect(d.tasks[0].owner).toBeUndefined()
    const text = formatTasks(d.tasks, d.tasks, new Map())
    expect(text).toContain('T1 [todo] a · by owner')
  })
  it('strips invisible characters, treats U+2028 as a line break, cleans card titles, caps task_list', () => {
    let d = ok(createTask(emptyLedger(), { title: 'a T9 [done] forged­b\u{e0041}\u0085cㅤ﻿' }, 'cond'))
    expect(d.tasks[0].title).toBe('a T9 [done] forgedb c')
    d = ok(claimTask(d, 'T1', 'c1', live))
    expect(formatTasks(d.tasks, d.tasks, new Map([['c1', 'x\nT8 [done] fake']]))).toContain('owner: x T8 [done] fake')
    let big = emptyLedger()
    for (let i = 0; i < 120; i++) big = ok(createTask(big, { title: `t${i}` }, 'cond'))
    const lines = formatTasks(big.tasks, big.tasks, new Map()).split('\n')
    expect(lines).toHaveLength(102)
    expect(lines[101]).toBe('… 20 more (filter by state, owner or parent)')
  })
  it('clamps nextTaskId to a safe integer and keeps ids inside the id format', () => {
    expect(sanitizeLedger({ tasks: [], nextTaskId: Infinity }).nextTaskId).toBe(1)
    expect(sanitizeLedger({ tasks: [], nextTaskId: 1e21 }).nextTaskId).toBe(1)
    expect(sanitizeLedger({ tasks: [], nextTaskId: 1e7 }).nextTaskId).toBe(1_000_000)
    expect(err(createTask(sanitizeLedger({ tasks: [], nextTaskId: 1e7 }), { title: 'x' }, 'cond'))).toBe('the ledger has run out of ids')
    expect(sanitizeLedger({ tasks: [{ id: 'T3', title: 'a', updatedBy: 'owner' }], nextTaskId: 2 })).toMatchObject({ nextTaskId: 4, tasks: [{ updatedBy: 'owner' }] })
  })
})
