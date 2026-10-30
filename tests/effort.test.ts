import { describe, expect, it } from 'vitest'
import { EFFORT_LEVELS, normalizeEffort } from '../src/shared/types'

describe('normalizeEffort', () => {
  it('keeps the five levels Claude Code takes and drops anything else', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const e of EFFORT_LEVELS) expect(normalizeEffort(e)).toBe(e)
    expect(normalizeEffort('')).toBeUndefined()
    expect(normalizeEffort(undefined)).toBeUndefined()
    expect(normalizeEffort(null)).toBeUndefined()
    expect(normalizeEffort('HIGH')).toBeUndefined()
    expect(normalizeEffort('ultra')).toBeUndefined()
    expect(normalizeEffort(3)).toBeUndefined()
  })
})
