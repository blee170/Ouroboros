import { describe, expect, it } from 'vitest'
import { BASE_FONT_SIZE, FAR_ZOOM, MAX_RENDER_SCALE, fontFor, renderScale, tailText } from '../src/shared/terminal-scale'

describe('terminal render scale', () => {
  it('follows the zoom between the far threshold and the maximum', () => {
    expect(renderScale(1)).toBe(1)
    expect(renderScale(1.3)).toBe(1.3)
    expect(renderScale(0.2)).toBe(FAR_ZOOM)
    expect(renderScale(9)).toBe(MAX_RENDER_SCALE)
    expect(renderScale(0)).toBe(1)
    expect(renderScale(Number.NaN)).toBe(1)
  })

  it('scales the font down to a tenth of a pixel, never above proportional', () => {
    expect(fontFor(1)).toBe(BASE_FONT_SIZE)
    expect(fontFor(0.75)).toBe(9.7)
    expect(fontFor(1.3)).toBeLessThanOrEqual(BASE_FONT_SIZE * 1.3)
    for (const s of [0.55, 0.61, 0.83, 1.17, 2.5]) expect(fontFor(s)).toBeLessThanOrEqual(BASE_FONT_SIZE * s)
  })
})

describe('tailText', () => {
  const fake = (rows: string[]): Parameters<typeof tailText>[0] =>
    ({ buffer: { active: { length: rows.length, getLine: (y: number) => ({ translateToString: () => rows[y] }) } } }) as unknown as Parameters<typeof tailText>[0]

  it('returns the last non-empty lines in order, trimmed', () => {
    expect(tailText(fake(['a', '  b  ', '', 'c', '   ', '']), 2)).toBe('b\nc')
    expect(tailText(fake(['only']), 5)).toBe('only')
    expect(tailText(fake(['', '']), 3)).toBe('')
  })
})
