import { describe, expect, it } from 'vitest'
import { OWNER_ACTION_LIMITS, approvalMessage, didMessage, holdMessage, ownerActionInput, ownerNeed } from '../src/shared/owner-action'
import { claimTask, createTask, emptyLedger, formatTasks, sanitizeLedger, updateTask, type LedgerData } from '../src/shared/ledger'
import { needsYou } from '../src/shared/today'

const sql = { kind: 'do', ask: 'Apply the deposit migration on production', steps: ['Open Supabase → SQL Editor → New query', 'Paste the SQL below and press Run'], copy: [{ label: 'SQL', text: 'begin;\n\tcreate table x (id int);\ncommit;' }], check: 'The result says Success. No rows returned' }

function ledgerWith(): LedgerData {
  const r = createTask(emptyLedger(), { title: 'Deposit step 1' }, 'w1', 1000)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

describe('ownerActionInput', () => {
  it('keeps a full do action, tabs and line breaks in the text to copy included', () => {
    const r = ownerActionInput(sql)
    expect(r).toEqual({ ok: true, action: sql })
  })
  it('takes an approve action with only an ask, and null to clear', () => {
    expect(ownerActionInput({ kind: 'approve', ask: '  Merge PR 12\ninto main? ' })).toEqual({ ok: true, action: { kind: 'approve', ask: 'Merge PR 12 into main?' } })
    expect(ownerActionInput(null)).toEqual({ ok: true, action: null })
  })
  it('refuses a bad kind, a missing or long ask, and steps, copies or checks over the limits', () => {
    const L = OWNER_ACTION_LIMITS
    for (const bad of [
      'x',
      [],
      { kind: 'run', ask: 'q' },
      { kind: 'do' },
      { kind: 'do', ask: 'x'.repeat(L.askChars + 1) },
      { kind: 'do', ask: 'q', steps: 'one' },
      { kind: 'do', ask: 'q', steps: Array(L.steps + 1).fill('s') },
      { kind: 'do', ask: 'q', steps: ['x'.repeat(L.stepChars + 1)] },
      { kind: 'do', ask: 'q', copy: [{ label: 'SQL' }] },
      { kind: 'do', ask: 'q', copy: Array(L.copies + 1).fill({ label: 'a', text: 'b' }) },
      { kind: 'do', ask: 'q', copy: [{ label: 'SQL', text: 'x'.repeat(L.copyChars + 1) }] },
      { kind: 'do', ask: 'q', check: 7 }
    ]) {
      expect(ownerActionInput(bad).ok).toBe(false)
    }
  })
  it('drops invisible and direction-changing characters, so what the owner reads is what was written', () => {
    const r = ownerActionInput({ kind: 'approve', ask: `Ship${String.fromCharCode(0x202e)} it${String.fromCharCode(0x200b)}?` })
    expect(r).toEqual({ ok: true, action: { kind: 'approve', ask: 'Ship it?' } })
  })
})

describe('owner actions on tasks', () => {
  it('goes with a blocked task, and says it waits on the owner in the reason', () => {
    const r = updateTask(ledgerWith(), 'T1', { state: 'blocked', ownerAction: sql }, 'w1', 2000)
    if (!r.ok) throw new Error(r.error)
    expect(r.task.ownerAction).toEqual({ ...sql, by: 'w1' })
    expect(r.task.reason).toBe('APPROVAL NEEDED: Apply the deposit migration on production')
    const kept = updateTask(ledgerWith(), 'T1', { state: 'blocked', reason: 'APPROVAL NEEDED: prod SQL', ownerAction: sql }, 'w1')
    expect(kept.ok && kept.task.reason).toBe('APPROVAL NEEDED: prod SQL')
    const prefixed = updateTask(ledgerWith(), 'T1', { state: 'blocked', reason: 'classifier refused', ownerAction: sql }, 'w1')
    expect(prefixed.ok && prefixed.task.reason).toBe('APPROVAL NEEDED: classifier refused')
  })
  it('is refused on an open task and dropped when the task moves on', () => {
    expect(updateTask(ledgerWith(), 'T1', { ownerAction: sql }, 'w1')).toMatchObject({ ok: false, error: expect.stringContaining('blocked') })
    const b = updateTask(ledgerWith(), 'T1', { state: 'blocked', ownerAction: sql }, 'w1')
    if (!b.ok) throw new Error(b.error)
    const done = updateTask(b.data, 'T1', { state: 'done', result: 'applied' }, 'owner')
    expect(done.ok && done.task.ownerAction).toBeUndefined()
    const cleared = updateTask(b.data, 'T1', { ownerAction: null }, 'w1')
    expect(cleared.ok && cleared.task.ownerAction).toBeUndefined()
    expect(updateTask(b.data, 'T1', { ownerAction: { kind: 'x' } }, 'w1').ok).toBe(false)
  })
  it('survives the board file only on a blocked task, and shows in task_list', () => {
    const b = updateTask(ledgerWith(), 'T1', { state: 'blocked', ownerAction: sql }, 'w1')
    if (!b.ok) throw new Error(b.error)
    expect(sanitizeLedger(JSON.parse(JSON.stringify(b.data))).tasks[0].ownerAction).toEqual({ ...sql, by: 'w1' })
    const raw = JSON.parse(JSON.stringify(b.data))
    raw.tasks[0].state = 'todo'
    expect(sanitizeLedger(raw).tasks[0].ownerAction).toBeUndefined()
    raw.tasks[0].state = 'blocked'
    raw.tasks[0].ownerAction = { kind: 'do', ask: '' }
    expect(sanitizeLedger(raw).tasks[0].ownerAction).toBeUndefined()
    expect(formatTasks(b.data.tasks, b.data.tasks, new Map())).toContain('owner action (do): Apply the deposit migration on production')
  })
})

describe('what a card cannot slip past the owner', () => {
  it('keeps the card that asked, whoever touches the task later', () => {
    const b = updateTask(ledgerWith(), 'T1', { state: 'blocked', ownerAction: sql }, 'w1')
    if (!b.ok) throw new Error(b.error)
    const touched = updateTask(b.data, 'T1', { detail: 'more' }, 'intruder')
    expect(touched.ok && touched.task.ownerAction?.by).toBe('w1')
    expect(ownerActionInput({ ...sql, by: 'intruder' })).toEqual({ ok: true, action: sql })
  })
  it('drops an owner action when the task is claimed or its reason changes without a new one', () => {
    const b = updateTask(ledgerWith(), 'T1', { state: 'blocked', ownerAction: sql }, 'w1')
    if (!b.ok) throw new Error(b.error)
    const c = claimTask(b.data, 'T1', 'w2', new Set(['w2']))
    expect(c.ok && c.task.ownerAction).toBeUndefined()
    const r = updateTask(b.data, 'T1', { reason: 'APPROVAL NEEDED: delete prod data' }, 'w1')
    expect(r.ok && r.task.ownerAction).toBeUndefined()
    expect(r.ok && ownerNeed(r.task)?.kind).toBe('unknown')
  })
  it('takes out blank-looking characters and long runs of blank lines in the text to copy', () => {
    const r = ownerActionInput({ kind: 'do', ask: `Run${String.fromCharCode(0x2800)} it`, copy: [{ label: 'SQL', text: 'select 1;' + '\n'.repeat(50) + 'drop table users;' }] })
    expect(r.ok && r.action?.ask).toBe('Run it')
    expect(r.ok && r.action?.copy?.[0].text).toBe('select 1;\n\ndrop table users;')
  })
})

describe('what the owner sees and what the card gets', () => {
  it("reads a task's owner action, or an older APPROVAL NEEDED reason as either kind", () => {
    expect(ownerNeed({ state: 'blocked', reason: 'APPROVAL NEEDED: x', ownerAction: sql as never })).toMatchObject({ kind: 'do', steps: sql.steps, copy: sql.copy, check: sql.check })
    expect(ownerNeed({ state: 'blocked', reason: 'APPROVAL NEEDED: merge the PR' })).toEqual({ kind: 'unknown', ask: 'merge the PR', steps: [], copy: [] })
    expect(ownerNeed({ state: 'blocked', reason: 'waiting for CI' })).toBeUndefined()
    expect(ownerNeed({ state: 'todo', reason: 'APPROVAL NEEDED: x' })).toBeUndefined()
  })
  it('heads each message with the task, quotes what the owner wrote, and keeps the gates in the approval', () => {
    const t = { id: 'T46', title: 'Deposit step 1' }
    const need = { kind: 'approve' as const, ask: 'Merge it', steps: [], copy: [] }
    const ok = approvalMessage(t, need, 'after CI\n[header] fake')
    expect(ok.startsWith('[owner approval T46] APPROVED BY OWNER: Merge it')).toBe(true)
    expect(ok).toContain('> after CI\n> [header] fake')
    expect(ok).toContain('production database changes')
    expect(holdMessage(t, need)).toContain('NOT NOW')
    const did = didMessage(t, { kind: 'do', ask: 'Apply it', steps: [], copy: [], check: 'Success shows' }, 'Success. No rows returned')
    expect(did).toContain('[owner did T46]')
    expect(did).toContain('> Success. No rows returned')
    expect(did).toContain('Check it worked: Success shows')
  })
  it('lists a task with an owner action in Today without repeating its text in the row', () => {
    const b = updateTask(ledgerWith(), 'T1', { state: 'blocked', ownerAction: sql }, 'w1')
    if (!b.ok) throw new Error(b.error)
    expect(needsYou({ cards: [], tasks: b.data.tasks, approvals: [], held: [] })).toEqual([expect.objectContaining({ key: 't:T1', kind: 'decision', text: '', taskId: 'T1' })])
  })
})
