import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputBatcher, OUTPUT_BATCH_MS } from '../src/main/pty-output'
import { createDataRouter } from '../src/shared/pty-routing'

describe('OutputBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = () => {
    const sent: [string, string, string][] = []
    const b = new OutputBatcher<string>((w, id, data) => sent.push([w, id, data]))
    return { b, sent }
  }

  it('sends one message per card per batch, in order', () => {
    const { b, sent } = setup()
    b.push('w1', 'a', 'he')
    b.push('w1', 'b', 'x')
    b.push('w1', 'a', 'llo')
    expect(sent).toEqual([])
    vi.advanceTimersByTime(OUTPUT_BATCH_MS)
    expect(sent).toEqual([
      ['w1', 'a', 'hello'],
      ['w1', 'b', 'x']
    ])
    b.push('w1', 'a', '!')
    vi.advanceTimersByTime(OUTPUT_BATCH_MS)
    expect(sent.at(-1)).toEqual(['w1', 'a', '!'])
  })

  it('flushes one card at once (before its exit), and nothing twice', () => {
    const { b, sent } = setup()
    b.push('w1', 'a', 'last words')
    b.push('w1', 'b', 'other')
    b.flush('a')
    expect(sent).toEqual([['w1', 'a', 'last words']])
    vi.advanceTimersByTime(OUTPUT_BATCH_MS)
    expect(sent).toEqual([
      ['w1', 'a', 'last words'],
      ['w1', 'b', 'other']
    ])
    b.flush('a')
    expect(sent).toHaveLength(2)
  })

  it('flushes a window before it goes, and keeps output with the window it was meant for', () => {
    const { b, sent } = setup()
    b.push('w1', 'a', '1')
    b.push('w2', 'c', '2')
    b.flushTarget('w1')
    expect(sent).toEqual([['w1', 'a', '1']])
    b.push('w1', 'c', '3') // card c moved to w1: w2 gets its earlier output first
    expect(sent.at(-1)).toEqual(['w2', 'c', '2'])
    vi.advanceTimersByTime(OUTPUT_BATCH_MS)
    expect(sent.at(-1)).toEqual(['w1', 'c', '3'])
  })
})

describe('createDataRouter', () => {
  it('calls a card only for its own output, and stops after unsubscribe', () => {
    const r = createDataRouter()
    const a: string[] = []
    const b: string[] = []
    const offA = r.on('a', (d) => a.push(d))
    r.on('b', (d) => b.push(d))
    r.dispatch('a', 'x')
    r.dispatch('b', 'y')
    r.dispatch('nobody', 'z')
    expect(a).toEqual(['x'])
    expect(b).toEqual(['y'])
    offA()
    offA()
    r.dispatch('a', 'again')
    expect(a).toEqual(['x'])
  })

  it('keeps a second listener of the same card when the first leaves (remount)', () => {
    const r = createDataRouter()
    const seen: string[] = []
    const off1 = r.on('a', () => seen.push('old'))
    r.on('a', (d) => seen.push(d))
    off1()
    r.dispatch('a', 'new')
    expect(seen).toEqual(['new'])
  })
})
