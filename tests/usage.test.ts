import { describe, expect, it } from 'vitest'
import { agoText, codexWindowId, codexWindowLabel, hottestWindow, parseClaudeOauthUsage, parseClaudeStatusLine, parseCodexRollout, parseGeminiSession, resetsIn, settleWindows, toEpochMs, windowLabel } from '../src/shared/usage'

const line = (o: unknown): string => JSON.stringify(o)

describe('usage parsers', () => {
  it('reads the plan windows out of the Claude status-line JSON (seconds), including per-model buckets', () => {
    const s = parseClaudeStatusLine({
      model: { id: 'claude-opus-5-5', display_name: 'Opus' },
      cost: { total_cost_usd: 1.2345 },
      context_window: { used_percentage: 42.5 },
      rate_limits: {
        five_hour: { used_percentage: 37, resets_at: 1_800_000_000 },
        seven_day: { used_percentage: 61.4, resets_at: 1_800_400_000 },
        seven_day_sonnet: { used_percentage: 12, resets_at: 1_800_400_000 },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 80, resets_at: '2027-01-15T10:00:00Z' }]
      }
    })
    expect(s?.costUsd).toBe(1.2345)
    expect(s?.model).toBe('Opus')
    expect(s?.contextPct).toBe(42.5)
    expect(s?.windows.map((w) => [w.id, w.usedPct, w.resetsAt])).toEqual([
      ['five_hour', 37, 1_800_000_000_000],
      ['seven_day', 61.4, 1_800_400_000_000],
      ['seven_day_sonnet', 12, 1_800_400_000_000],
      ['model:Fable', 80, Date.parse('2027-01-15T10:00:00Z')]
    ])
    expect(s?.windows[3].label).toBe('This week (Fable)')
  })

  it('tolerates a status line without rate limits (API key) and rejects foreign JSON', () => {
    expect(parseClaudeStatusLine({ model: { display_name: 'Sonnet' }, cost: { total_cost_usd: 0.1 } })).toMatchObject({ windows: [], costUsd: 0.1 })
    expect(parseClaudeStatusLine({ hook_event_name: 'Stop' })).toBeNull()
    expect(parseClaudeStatusLine('x')).toBeNull()
    expect(parseClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 250 } } })?.windows[0].usedPct).toBe(100)
  })

  it('reads the OAuth usage body (utilization + ISO resets_at) and extra usage only when enabled', () => {
    const u = parseClaudeOauthUsage({
      five_hour: { utilization: 10.5, resets_at: '2026-10-25T12:00:00.000Z' },
      seven_day: { utilization: 70, resets_at: '2026-10-28T00:00:00Z' },
      seven_day_opus: { utilization: 5, resets_at: null },
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'USD' }
    })
    expect(u?.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day_opus'])
    expect(u?.windows[0].resetsAt).toBe(Date.parse('2026-10-25T12:00:00.000Z'))
    expect(u?.windows[2].resetsAt).toBeUndefined()
    expect(u?.extra).toEqual({ usedPct: 25, used: 12.5, limit: 50, currency: 'USD' })
    expect(parseClaudeOauthUsage({ five_hour: { utilization: 1 }, extra_usage: { is_enabled: false } })?.extra).toBeUndefined()
    expect(parseClaudeOauthUsage({ error: { type: 'rate_limit_error' } })).toBeNull()
  })

  it('takes the last Codex token_count that has rate limits and classifies windows by length', () => {
    const text = [
      line({ timestamp: '2026-10-25T01:00:00Z', type: 'session_meta', payload: {} }),
      line({ timestamp: '2026-10-25T01:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }, rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1_800_000_000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1_800_400_000 }, plan_type: 'plus' } } }),
      line({ timestamp: '2026-10-25T01:02:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 } }, rate_limits: null } }),
      '{"type":"event_msg","payload":{"type":"token_count"' // cut tail
    ].join('\n')
    const r = parseCodexRollout(text)
    expect(r?.plan).toBe('plus')
    expect(r?.at).toBe(Date.parse('2026-10-25T01:00:05Z'))
    expect(r?.windows.map((w) => [w.id, w.usedPct, w.label])).toEqual([
      ['five_hour', 10, 'Current session (5 h)'],
      ['seven_day', 40, 'This week (all models)']
    ])
    expect(r?.tokens).toEqual({ total: 350, input: 300, output: 50 })
    expect(parseCodexRollout('')).toBeNull()
    expect(parseCodexRollout(line({ type: 'event_msg', payload: { type: 'agent_message' } }))).toBeNull()
  })

  it('names Codex windows by their length when it is not 5 h or a week, and by slot without one', () => {
    expect(codexWindowId(300, 'primary')).toBe('five_hour')
    expect(codexWindowId(10080, 'primary')).toBe('seven_day')
    expect(codexWindowLabel(codexWindowId(1440, 'secondary'))).toBe('1-day limit')
    expect(codexWindowLabel(codexWindowId(120, 'secondary'))).toBe('2-hour limit')
    expect(codexWindowLabel(codexWindowId(undefined, 'secondary'))).toBe('Secondary limit')
    // the camelCase shape the app-server uses parses too
    const r = parseCodexRollout(line({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_800_000_000 } } } }))
    expect(r?.windows[0]).toMatchObject({ id: 'five_hour', usedPct: 5, resetsAt: 1_800_000_000_000 })
  })

  it('sums the tokens of a Gemini session (json record or jsonl), keeping per-message times', () => {
    const rec = { sessionId: 's', lastUpdated: '2026-10-25T03:00:00Z', messages: [{ type: 'user', content: 'hi' }, { type: 'gemini', timestamp: '2026-10-25T02:00:00Z', tokens: { input: 100, output: 30, cached: 50, thoughts: 10, total: 140 } }, { type: 'gemini', tokens: { input: 10, output: 5 } }] }
    const t = parseGeminiSession(JSON.stringify(rec))
    expect(t).toMatchObject({ total: 155, input: 110, output: 35 })
    expect(t?.messages.map((m) => m.at)).toEqual([Date.parse('2026-10-25T02:00:00Z'), Date.parse('2026-10-25T03:00:00Z')])
    const jsonl = [line({ type: 'gemini', timestamp: '2026-10-25T02:00:00Z', tokens: { total: 7, input: 5, output: 2 } }), line({ type: 'user', content: 'x' }), '{"cut'].join('\n')
    expect(parseGeminiSession(jsonl)?.total).toBe(7)
    expect(parseGeminiSession('')).toBeNull()
    expect(parseGeminiSession(JSON.stringify({ messages: [{ type: 'user' }] }))).toBeNull()
  })

  it('formats resets, ages and epochs', () => {
    const now = Date.parse('2026-10-25T10:00:00Z')
    expect(resetsIn(now + 25 * 60_000, now)).toBe('resets in 25m')
    expect(resetsIn(now + (2 * 60 + 10) * 60_000, now)).toBe('resets in 2h 10m')
    expect(resetsIn(now + (3 * 24 + 4) * 3_600_000, now)).toBe('resets in 3d 4h')
    expect(resetsIn(now - 1, now)).toBe('reset')
    expect(resetsIn(undefined, now)).toBe('')
    expect(agoText(now - 10_000, now)).toBe('just now')
    expect(agoText(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(agoText(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(toEpochMs(1_800_000_000)).toBe(1_800_000_000_000)
    expect(toEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(toEpochMs('1800000000')).toBe(1_800_000_000_000)
    expect(toEpochMs('nope')).toBeUndefined()
    expect(windowLabel('seven_day_opus')).toBe('This week (Opus)')
  })

  it('settles windows whose reset time has passed to 0%', () => {
    const now = 1_000_000
    expect(settleWindows([{ id: 'five_hour', label: '', usedPct: 98, resetsAt: now - 1 }, { id: 'seven_day', label: '', usedPct: 40, resetsAt: now + 1 }, { id: 'x', label: '', usedPct: 70 }], now).map((w) => w.usedPct)).toEqual([0, 40, 70])
  })

  it('picks the fullest plan window for the chip', () => {
    expect(hottestWindow([{ id: 'model:Fable', label: '', usedPct: 99 }, { id: 'five_hour', label: '', usedPct: 20 }, { id: 'seven_day', label: '', usedPct: 70 }])?.id).toBe('seven_day')
    expect(hottestWindow([{ id: 'model:Fable', label: '', usedPct: 99 }])?.id).toBe('model:Fable')
    expect(hottestWindow([])).toBeUndefined()
  })
})
