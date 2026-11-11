import { describe, expect, it } from 'vitest'
import { changesPollMs, hiddenAwarePoll, pollsChanges } from '../src/shared/changes-poll'
import { wantsWebgl } from '../src/shared/terminal-scale'

describe('card git polling', () => {
  it('polls only a card in a turn', () => {
    expect(pollsChanges('working')).toBe(true)
    expect(pollsChanges('needs-you')).toBe(true)
    for (const s of ['starting', 'idle', 'done', 'ended'] as const) expect(pollsChanges(s)).toBe(false)
  })

  it('still polls every other card, more slowly (a terminal card stays idle while files change in it)', () => {
    expect(changesPollMs('working')).toBe(30_000)
    expect(changesPollMs('needs-you')).toBe(30_000)
    for (const s of ['starting', 'idle', 'done', 'ended'] as const) expect(changesPollMs(s)).toBe(120_000)
  })

  it('skips ticks while the window is hidden and catches up once when it shows', () => {
    let hidden = false
    let loads = 0
    const poll = hiddenAwarePoll(() => loads++, () => hidden)
    poll.tick()
    expect(loads).toBe(1)
    poll.visible() // nothing was missed
    expect(loads).toBe(1)
    hidden = true
    poll.tick()
    poll.tick()
    poll.visible() // still hidden
    expect(loads).toBe(1)
    hidden = false
    poll.visible()
    expect(loads).toBe(2)
    poll.visible()
    expect(loads).toBe(2)
  })
})

describe('wantsWebgl', () => {
  it('gives the context back when a card ended or sleeps', () => {
    expect(wantsWebgl('working')).toBe(true)
    expect(wantsWebgl(undefined)).toBe(true)
    expect(wantsWebgl('ended')).toBe(false)
    expect(wantsWebgl('idle', true)).toBe(false)
  })
})
