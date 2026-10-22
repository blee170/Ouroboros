import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contextWindowFor, parseUsageTail, readSessionUsage } from '../src/main/claude-history'

const line = (o: unknown): string => JSON.stringify(o)

describe('session usage from transcripts', () => {
  it('takes the last assistant usage', () => {
    const text = [
      line({ type: 'user', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', timestamp: '2026-10-22T01:00:00Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 } } }),
      line({ type: 'assistant', timestamp: '2026-10-22T01:01:00Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 70 } } }),
      '{"type":"assistant","message":{"usage":{"input_tokens":1' // truncated tail
    ].join('\n')
    const u = parseUsageTail(text)
    expect(u).toMatchObject({ contextTokens: 5020, outputTokens: 70, model: 'claude-opus-5-5', contextWindow: 1_000_000 })
    expect(parseUsageTail('')).toBeNull()
  })

  it('assumes 1M for Claude 5 / [1m] models and 200k otherwise', () => {
    expect(contextWindowFor('claude-sonnet-5-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-4-5-20250929[1m]')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(contextWindowFor(undefined)).toBe(200_000)
  })

  it('finds the transcript by session id in any project folder', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'ouro-usage-'))
    try {
      mkdirSync(join(cfg, 'projects', 'enc-x'), { recursive: true })
      writeFileSync(join(cfg, 'projects', 'enc-x', 'sess-9.jsonl'), line({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 7, output_tokens: 1 } } }) + '\n')
      expect(readSessionUsage('sess-9', cfg)?.contextTokens).toBe(7)
      expect(readSessionUsage('nope', cfg)).toBeNull()
      expect(readSessionUsage('../etc', cfg)).toBeNull()
    } finally {
      rmSync(cfg, { recursive: true, force: true })
    }
  })
})
