import { describe, expect, it } from 'vitest'
import { EMPTY_ATTENTION, SILENT_MS, nextAttention, onStatus, onViewed, silentMinutes, type Attention } from '@shared/attention'

describe('attention: a finished turn is done until looked at', () => {
  it('marks a turn that ends while the owner is elsewhere unread and done', () => {
    const r = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, false)
    expect(r.shown).toBe('done')
    expect(r.attention.unread).toEqual({ a: 1000 })
  })
  it('needs no mark when the owner is looking at the card: it reads idle at once', () => {
    const r = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, true)
    expect(r.shown).toBe('idle')
    expect(r.attention.unread).toEqual({})
    expect(r.attention.reviewed).toEqual({ a: true })
  })
  it('looking at a done card clears the mark and turns it idle; the idle_prompt echo of that turn stays idle', () => {
    const a = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, false).attention
    const v = onViewed(a, 'a', 'done')
    expect(v.shown).toBe('idle')
    expect(v.attention.unread).toEqual({})
    const echo = onStatus(v.attention, 'a', 'idle', 'done', 2000, false, true)
    expect(echo.shown).toBe('idle')
    expect(echo.attention.unread).toEqual({})
  })
  it('a repeated done of an unread turn is not a second turn', () => {
    const a = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, false).attention
    const again = onStatus(a, 'a', 'done', 'done', 5000, false, true)
    expect(again.attention).toBe(a)
    expect(again.shown).toBe('done')
  })
  it('a done that is not an echo is a new turn even without a working in between (a prompt typed into Codex)', () => {
    const reviewed = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, true).attention
    const r = onStatus(reviewed, 'a', 'idle', 'done', 2000, false)
    expect(r.shown).toBe('done')
    expect(r.attention.unread).toEqual({ a: 2000 })
    expect(r.attention.reviewed).toEqual({})
  })
  it('a new turn after a reviewed one is marked again', () => {
    let a: Attention = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, true).attention
    a = onStatus(a, 'a', 'idle', 'working', 2000, false).attention
    expect(a.reviewed).toEqual({})
    const r = onStatus(a, 'a', 'working', 'done', 3000, false)
    expect(r.shown).toBe('done')
    expect(r.attention.unread).toEqual({ a: 3000 })
  })
  it('a question marks the card once, from its first ask, and viewing clears it without changing the state', () => {
    const first = onStatus(EMPTY_ATTENTION, 'a', 'working', 'needs-you', 1000, false)
    const second = onStatus(first.attention, 'a', 'needs-you', 'needs-you', 2000, false)
    expect(second.attention.unread).toEqual({ a: 1000 })
    const v = onViewed(second.attention, 'a', 'needs-you')
    expect(v.shown).toBe('needs-you')
    expect(v.attention.unread).toEqual({})
    expect(onStatus(EMPTY_ATTENTION, 'a', 'working', 'needs-you', 1000, true).attention.unread).toEqual({})
  })
  it('working, a restart or an exit supersedes an unread result', () => {
    const a = onStatus(EMPTY_ATTENTION, 'a', 'working', 'done', 1000, false).attention
    for (const s of ['working', 'starting', 'ended', 'idle'] as const) expect(onStatus(a, 'a', 'done', s, 2000, false).attention.unread).toEqual({})
  })
  it('viewing a card with nothing to clear returns the same attention', () => {
    const a = onStatus(EMPTY_ATTENTION, 'b', 'working', 'done', 1000, false).attention
    expect(onViewed(a, 'a', 'working').attention).toBe(a)
  })
})

describe('nextAttention (Ctrl+Shift+N)', () => {
  const order = [
    { id: 'a', status: 'needs-you' },
    { id: 'b', status: 'done' },
    { id: 'c', status: 'needs-you' },
    { id: 'd', status: 'working' }
  ]
  it('goes to the next card that needs you after the selected one, around the end', () => {
    expect(nextAttention(order, {}, null)).toBe('a')
    expect(nextAttention(order, {}, 'a')).toBe('c')
    expect(nextAttention(order, {}, 'c')).toBe('a')
    expect(nextAttention(order, {}, 'zzz')).toBe('a') // selected card not an agent (a note): from the top
  })
  it('falls back to an unread finished turn, and to nothing', () => {
    const calm = order.map((n) => (n.status === 'needs-you' ? { ...n, status: 'idle' } : n))
    expect(nextAttention(calm, { b: 1 }, null)).toBe('b')
    expect(nextAttention(calm, {}, null)).toBeUndefined()
  })
})

describe('silentMinutes', () => {
  it('counts whole minutes once a working card has been quiet for SILENT_MS, 0 otherwise', () => {
    const now = 10 * 60_000
    expect(silentMinutes('working', now - SILENT_MS + 1, now)).toBe(0)
    expect(silentMinutes('working', now - SILENT_MS, now)).toBe(2)
    expect(silentMinutes('working', now - 7.5 * 60_000, now)).toBe(7)
    expect(silentMinutes('idle', now - 60 * 60_000, now)).toBe(0)
    expect(silentMinutes('working', undefined, now)).toBe(0)
  })
})
