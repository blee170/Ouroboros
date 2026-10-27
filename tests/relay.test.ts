import { describe, expect, it } from 'vitest'
import { noteUsable, relayDecision, relaySettings, relayThreshold, resumePrompt, RELAY_CHAIN_MS, type RelayCard } from '@shared/relay'

const NOW = 10_000_000_000
const settings = relaySettings({})
const card = (over: Partial<RelayCard> = {}): RelayCard => ({
  id: 'c1',
  kind: 'claude',
  status: 'idle',
  lastStopAt: NOW - 5 * 60_000,
  contextTokens: 300_000,
  contextWindow: 1_000_000,
  pending: false,
  ...over
})

describe('relaySettings', () => {
  it('defaults and rejects bad values', () => {
    expect(settings).toEqual({ tokens: 250_000, conductor: 'ask', workers: 'auto' })
    expect(relaySettings({ relayTokens: 10, relayConductor: 'x' as never, relayWorkers: 'off' })).toEqual({ tokens: 250_000, conductor: 'ask', workers: 'off' })
    expect(relaySettings({ relayTokens: 400_000, relayConductor: 'auto' }).tokens).toBe(400_000)
  })
})

describe('relayThreshold', () => {
  it('caps at 60% of the window', () => {
    expect(relayThreshold(250_000, 1_000_000)).toBe(250_000)
    expect(relayThreshold(250_000, 200_000)).toBe(120_000)
    expect(relayThreshold(250_000, undefined)).toBe(120_000)
  })
})

describe('relayDecision', () => {
  it('relays an idle worker past the threshold, asks for a Conductor', () => {
    expect(relayDecision(card(), settings, [], NOW)).toBe('auto')
    expect(relayDecision(card({ kind: 'conductor', status: 'done' }), settings, [], NOW)).toBe('ask')
  })
  it('leaves busy, waiting, fresh, small, other-engine and off cards alone', () => {
    expect(relayDecision(card({ status: 'working' }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ status: 'needs-you' }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ pending: true }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ lastStopAt: NOW - 30_000 }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ lastStopAt: undefined }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ contextTokens: 200_000 }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ contextTokens: undefined }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ engine: 'codex' }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card({ kind: 'terminal' }), settings, [], NOW)).toBeNull()
    expect(relayDecision(card(), { ...settings, workers: 'off' }, [], NOW)).toBeNull()
  })
  it('uses 60% of a 200k window', () => {
    expect(relayDecision(card({ contextTokens: 130_000, contextWindow: 200_000 }), settings, [], NOW)).toBe('auto')
  })
  it('stops after three fresh starts in 12 h', () => {
    expect(relayDecision(card(), settings, [NOW - 1000, NOW - 2000, NOW - 3000], NOW)).toBeNull()
    expect(relayDecision(card(), settings, [NOW - RELAY_CHAIN_MS - 1, NOW - 2000, NOW - 3000], NOW)).toBe('auto')
  })
})

describe('notes', () => {
  it('needs a real note', () => {
    expect(noteUsable(undefined)).toBe(false)
    expect(noteUsable('ok')).toBe(false)
    expect(noteUsable('x'.repeat(400))).toBe(true)
  })
  it('puts the note into the resume prompt', () => {
    const p = resumePrompt('  NOTE BODY  ', 'Conductor · chief')
    expect(p).toContain('NOTE BODY\n--- end of note ---')
    expect(p).toContain('"Conductor · chief"')
    expect(p).toContain('task_list')
  })
})
