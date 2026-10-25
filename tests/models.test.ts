import { describe, expect, it } from 'vitest'
import { MODEL_PRESETS, modelChoice } from '../src/shared/models'

describe('model presets', () => {
  it('maps a stored model to the select: default, a preset, or custom', () => {
    expect(modelChoice('claude', undefined)).toBe('')
    expect(modelChoice('claude', 'sonnet')).toBe('sonnet')
    expect(modelChoice('claude', 'claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(modelChoice('claude', 'claude-opus-4-1')).toBe('custom')
    expect(modelChoice('codex', 'opus')).toBe('custom')
  })
  it('has unique values and no presets that guess at Codex or Gemini names', () => {
    const v = MODEL_PRESETS.claude.map((p) => p.value)
    expect(new Set(v).size).toBe(v.length)
    expect(MODEL_PRESETS.codex).toEqual([])
    expect(MODEL_PRESETS.gemini).toEqual([])
  })
})
