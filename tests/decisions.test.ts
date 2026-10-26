import { describe, expect, it } from 'vitest'
import { APPROVE, DECISION_LIMITS, DENY, answersOf, askInput, decisionMessage, expireDecisions, pendingMessage, trimDecisions, type Decision } from '../src/shared/decisions'
import { DecisionDesk } from '../src/main/decisions'
import { needsYou } from '../src/shared/today'
import { newRunState, reportMarkdown } from '../src/shared/autonomy'

const card = { id: 'w1', title: 'Worker' }

describe('askInput', () => {
  it('takes a question with 2 to 4 distinct one-line choices, or none for Approve / Deny', () => {
    expect(askInput({ question: '  Ship it?  ' })).toEqual({ ok: true, question: 'Ship it?' })
    expect(askInput({ question: 'Which?', choices: ['A\n now', ' B '] })).toEqual({ ok: true, question: 'Which?', choices: ['A now', 'B'] })
    for (const bad of [{}, { question: '   ' }, { question: 'x'.repeat(2001) }, { question: 'q', choices: ['only'] }, { question: 'q', choices: ['a', 'b', 'c', 'd', 'e'] }, { question: 'q', choices: ['a', 'A'] }, { question: 'q', choices: ['a', ''] }, { question: 'q', choices: ['a', 7] }, { question: 'q', choices: 'a,b' }]) {
      expect(askInput(bad as never).ok).toBe(false)
    }
  })
  it('drops control, bidi and invisible characters, so two answers cannot look the same', () => {
    const zw = String.fromCharCode(0x200b)
    const rlo = String.fromCharCode(0x202e)
    expect(askInput({ question: 'q', choices: ['Deny', 'Deny' + zw] })).toMatchObject({ ok: false })
    expect(askInput({ question: `Ship${rlo} it?\nNow` })).toEqual({ ok: true, question: 'Ship  it?\nNow' })
  })
  it('offers the choices, else Approve and Deny', () => {
    expect(answersOf({ choices: ['A', 'B'] })).toEqual(['A', 'B'])
    expect(answersOf({})).toEqual([APPROVE, DENY])
  })
})

describe('DecisionDesk', () => {
  it('keeps one open question per card and hands an answer to the waiting call', async () => {
    const desk = new DecisionDesk()
    const asked: Decision[] = []
    desk.on('asked', (d) => asked.push(d))
    const r = desk.ask(card, 'Ship it?', undefined, 1000)
    if (!r.ok) throw new Error(r.error)
    expect(r.decision).toMatchObject({ id: 'D1', card: 'w1', state: 'pending' })
    expect(desk.ask(card, 'Again?', undefined, 1001)).toMatchObject({ ok: false, error: expect.stringContaining('D1') })
    expect(desk.ask({ id: 'w2', title: 'Other' }, 'Mine?', ['A', 'B'], 1002).ok).toBe(true)
    expect(asked.map((d) => d.id)).toEqual(['D1', 'D2'])
    const waiting = desk.wait('D1', 5000)
    expect(desk.answer('D1', 'Maybe', undefined, 'owner', 1500)).toMatchObject({ ok: false })
    const a = desk.answer('D1', APPROVE, '  go ahead ', 'owner', 2000)
    expect(a).toMatchObject({ ok: true, waited: true, decision: { state: 'answered', answer: APPROVE, note: 'go ahead', by: 'owner', decidedAt: 2000 } })
    expect(await waiting).toMatchObject({ id: 'D1', state: 'answered' })
    expect(desk.answer('D1', DENY, undefined, 'owner', 2500)).toMatchObject({ ok: false, error: 'D1 is already answered' })
    // answered: the card may ask again
    expect(desk.ask(card, 'Next?', undefined, 3000).ok).toBe(true)
  })
  it('gives up waiting after the wait, and a later answer is not handed to anyone', async () => {
    const desk = new DecisionDesk()
    desk.ask(card, 'Ship it?', undefined)
    expect(await desk.wait('D1', 20)).toBeUndefined()
    expect(desk.answer('D1', DENY, undefined, 'phone P')).toMatchObject({ ok: true, waited: false })
    expect(await desk.wait('D1', 20)).toMatchObject({ state: 'answered' })
    expect(await desk.wait('D9', 20)).toBeUndefined()
  })
  it('stops waiting when the caller hangs up, so a later answer goes by mail', async () => {
    const desk = new DecisionDesk()
    desk.ask(card, 'q', undefined)
    const gone = new AbortController()
    const waiting = desk.wait('D1', 60_000, gone.signal)
    gone.abort()
    expect(await waiting).toBeUndefined()
    expect(desk.answer('D1', APPROVE, undefined, 'owner')).toMatchObject({ ok: true, waited: false })
    const already = new AbortController()
    already.abort()
    desk.ask({ id: 'w2', title: 'Other' }, 'q2', undefined)
    expect(await desk.wait('D2', 60_000, already.signal)).toBeUndefined()
    expect(desk.answer('D2', APPROVE, undefined, 'owner')).toMatchObject({ ok: true, waited: false })
  })
  it('refuses a note over the limit', () => {
    const desk = new DecisionDesk()
    desk.ask(card, 'q', undefined)
    expect(desk.answer('D1', APPROVE, 'x'.repeat(DECISION_LIMITS.noteChars + 1), 'owner').ok).toBe(false)
  })
  it('expires a question after a day, and a card that leaves withdraws its question', async () => {
    const desk = new DecisionDesk()
    const expired: Decision[] = []
    desk.on('expired', (d) => expired.push(d))
    desk.ask(card, 'Old?', undefined, 0)
    const waiting = desk.wait('D1', 60_000)
    expect(desk.sweep(DECISION_LIMITS.expiryMs - 1)).toEqual([])
    expect(desk.sweep(DECISION_LIMITS.expiryMs).map((d) => d.id)).toEqual(['D1'])
    expect(expired.map((d) => d.state)).toEqual(['expired'])
    expect(await waiting).toMatchObject({ state: 'expired' })
    desk.ask({ id: 'w2', title: 'Other' }, 'Gone?', undefined)
    expect(desk.withdraw('w2').map((d) => d.id)).toEqual(['D2'])
    expect(desk.withdraw('w2')).toEqual([])
    expect(desk.pending()).toEqual([])
    expect(desk.decisions.find((d) => d.id === 'D2')?.state).toBe('withdrawn')
  })
  it('withdraws the questions when the project changes', async () => {
    const desk = new DecisionDesk()
    desk.ask(card, 'q', undefined)
    const waiting = desk.wait('D1', 60_000)
    expect(desk.load().map((d) => d.id)).toEqual(['D1'])
    // the waiting call is told the question was withdrawn, not to wait for an answer that cannot come
    expect(await waiting).toMatchObject({ id: 'D1', state: 'withdrawn' })
    expect(desk.decisions).toEqual([])
  })
})

describe('the texts and lists', () => {
  const d: Decision = { id: 'D3', card: 'w1', title: 'Worker', question: 'Ship\nit?', createdAt: 0, state: 'answered', answer: 'Not yet', note: 'after QA' }
  it('heads every answer with the decision id', () => {
    expect(decisionMessage(d)).toBe('[owner decision D3] Your question: Ship it?\nAnswer: Not yet\nNote from the owner: after QA')
    expect(decisionMessage({ ...d, state: 'expired' })).toContain('expired')
    expect(pendingMessage('D3', true)).toContain('morning report')
    expect(pendingMessage('D3', false)).toContain('[owner decision D3]')
  })
  it('expires only pending questions and keeps every pending one when trimming', () => {
    const p: Decision = { ...d, id: 'D1', state: 'pending' }
    expect(expireDecisions([p, d], DECISION_LIMITS.expiryMs)[0].state).toBe('expired')
    const list = [p, ...Array.from({ length: DECISION_LIMITS.keep + 5 }, (_, i) => ({ ...d, id: `D${i + 10}` }))]
    const kept = trimDecisions(list)
    expect(kept.length).toBe(DECISION_LIMITS.keep + 1)
    expect(kept[0]).toBe(p)
    expect(kept.at(-1)?.id).toBe(`D${DECISION_LIMITS.keep + 14}`)
  })
  it('lists a pending question in Today as a decision on its card', () => {
    const needs = needsYou({ cards: [], tasks: [], approvals: [], held: [], decisions: [{ ...d, state: 'pending' }, d] })
    expect(needs).toEqual([expect.objectContaining({ key: 'q:D3', kind: 'decision', cardId: 'w1', decisionId: 'D3', text: 'Ship it?' })])
  })
  it("puts an open question under Waiting on you and the answered ones under Decisions in the run's report", () => {
    const s = newRunState({ until: 10_000, maxDispatches: 5, stallMinutes: 10, maxRetriesPerTitle: 2 } as never, 0)
    s.stopped = { at: 5000, reason: 'deadline' }
    const md = reportMarkdown(s, [
      { at: 1000, kind: 'decision', card: 'w1', title: 'Worker', detail: 'asked (D1): Ship it?' },
      { at: 2000, kind: 'decision', card: 'w2', title: 'Other', detail: 'asked (D2): Which DB? [Postgres / SQLite]' },
      { at: 3000, kind: 'decision', card: 'w2', title: 'Other', detail: 'answered (D2) by owner: Postgres' }
    ], [])
    const waiting = md.slice(md.indexOf('## Waiting on you'), md.indexOf('## Decisions'))
    expect(waiting).toContain('Question from **Worker**')
    expect(waiting).not.toContain('Which DB')
    expect(md).toContain('## Decisions · 1 answered')
    expect(md).toContain('Other at')
  })
})
