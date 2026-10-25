import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineInfo } from '../src/shared/protocol'
import { FILE_SCAN_TTL_MS, OAUTH_BACKOFF_MS, OAUTH_MIN_INTERVAL_MS, STATUSLINE_FRESH_MS, UsageMonitor, claudeAccessToken, listCodexRollouts, listGeminiSessions, type UsageDeps } from '../src/main/usage'
import { buildHookSettings, buildStatusLineCommand } from '../src/main/claude-launcher'
import { HookServer } from '../src/main/hook-server'

const line = (o: unknown): string => JSON.stringify(o)
const engineInfo = (engine: EngineInfo['engine'], installed = true): EngineInfo => ({ engine, label: engine, installed, version: '2.1.310', installCommand: '', loginCommand: '', signupUrl: '', needsNode: false, nodeAvailable: true })

const STATUS_LINE = {
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  cost: { total_cost_usd: 0.5 },
  rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_900_000_000 }, seven_day: { used_percentage: 61, resets_at: 1_900_400_000 }, seven_day_sonnet: { used_percentage: 7, resets_at: 1_900_400_000 } }
}

describe('UsageMonitor', () => {
  let home: string
  let now: number
  let fetches: Array<{ url: string; headers: Record<string, string> }>
  let respond: () => { status: number; body: unknown }
  let deps: UsageDeps
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ouro-usage-home-'))
    now = Date.parse('2026-10-25T10:00:00Z')
    fetches = []
    respond = () => ({ status: 200, body: { five_hour: { utilization: 12.5, resets_at: '2026-10-25T14:00:00Z' }, seven_day: { utilization: 55, resets_at: '2026-10-28T00:00:00Z' } } })
    deps = {
      home,
      env: {},
      now: () => now,
      fetch: async (url, init) => {
        fetches.push({ url, headers: init.headers })
        const r = respond()
        return { status: r.status, json: async () => r.body }
      },
      detect: async () => [engineInfo('claude'), engineInfo('codex'), engineInfo('gemini')]
    }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const signInClaude = (expiresAt = now + 3_600_000): void => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), line({ claudeAiOauth: { accessToken: 'sk-ant-oat01-TEST', refreshToken: 'r', expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } }))
  }

  it('says not signed in / API key / not installed in words, and touches no endpoint', async () => {
    const m = new UsageMonitor(deps)
    let snap = await m.snapshot()
    expect(snap.engines.map((e) => [e.engine, e.state])).toEqual([
      ['claude', 'not-signed-in'],
      ['codex', 'not-signed-in'],
      ['gemini', 'not-signed-in']
    ])
    expect(fetches).toHaveLength(0)
    const keyed = new UsageMonitor({ ...deps, env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k' } })
    snap = await keyed.snapshot()
    expect(snap.engines.map((e) => e.state)).toEqual(['api-key', 'api-key', 'api-key'])
    const none = new UsageMonitor({ ...deps, detect: async () => [engineInfo('claude', false), engineInfo('codex', false), engineInfo('gemini', false)] })
    snap = await none.snapshot()
    expect(snap.engines.every((e) => e.state === 'not-installed')).toBe(true)
  })

  it('prefers a fresh status line from a card: exact windows, no token, cost summed over cards', async () => {
    signInClaude()
    const m = new UsageMonitor(deps)
    expect(m.onStatusLine('card-1', STATUS_LINE)).toBe(true)
    expect(m.onStatusLine('card-2', { ...STATUS_LINE, cost: { total_cost_usd: 0.25 }, rate_limits: {} })).toBe(true)
    expect(m.onStatusLine('card-3', { hook_event_name: 'Stop' })).toBe(false)
    const claude = (await m.snapshot({ refresh: true })).engines[0]
    expect(claude.state).toBe('ok')
    expect(claude.source).toEqual({ kind: 'statusline', detail: 'card-1', at: now })
    expect(claude.windows.map((w) => [w.id, w.usedPct])).toEqual([
      ['five_hour', 42],
      ['seven_day', 61],
      ['seven_day_sonnet', 7]
    ])
    expect(claude.costUsd).toBe(0.75)
    expect(fetches).toHaveLength(0)
    m.forgetCard('card-2')
    expect((await m.snapshot()).engines[0].costUsd).toBe(0.5)
    // a status line without windows while not signed in = an API key card (a fresh home: no credentials file)
    const keyed = new UsageMonitor({ ...deps, home: mkdtempSync(join(tmpdir(), 'ouro-usage-home2-')), env: { ANTHROPIC_API_KEY: 'k' } })
    keyed.onStatusLine('c', { ...STATUS_LINE, rate_limits: {} })
    expect((await keyed.snapshot()).engines[0].state).toBe('api-key')
  })

  it('falls back to the OAuth usage endpoint with Claude Code\'s own headers, at most every 5 min, never logging the token', async () => {
    signInClaude()
    const m = new UsageMonitor(deps)
    let claude = (await m.snapshot()).engines[0]
    expect(fetches).toHaveLength(1)
    expect(fetches[0].url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(fetches[0].headers.Authorization).toBe('Bearer sk-ant-oat01-TEST')
    expect(fetches[0].headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(fetches[0].headers['User-Agent']).toBe('claude-code/2.1.310')
    expect(claude.state).toBe('ok')
    expect(claude.source.kind).toBe('oauth')
    expect(claude.windows.map((w) => [w.id, w.usedPct, w.resetsAt])).toEqual([
      ['five_hour', 12.5, Date.parse('2026-10-25T14:00:00Z')],
      ['seven_day', 55, Date.parse('2026-10-28T00:00:00Z')]
    ])
    expect(JSON.stringify(claude)).not.toContain('sk-ant')
    // within the interval nothing is asked again, not even on refresh (a forced refresh waits a minute)
    now += 30_000
    await m.snapshot({ refresh: true })
    await m.snapshot()
    expect(fetches).toHaveLength(1)
    now += 60_000
    await m.snapshot({ refresh: true })
    expect(fetches).toHaveLength(2)
    now += OAUTH_MIN_INTERVAL_MS
    await m.snapshot()
    expect(fetches).toHaveLength(3)
    // a fresh status line stops the polling
    m.onStatusLine('card', STATUS_LINE)
    now += OAUTH_MIN_INTERVAL_MS
    claude = (await m.snapshot({ refresh: true })).engines[0]
    expect(fetches).toHaveLength(3)
    expect(claude.source.kind).toBe('statusline')
    now += STATUSLINE_FRESH_MS
    claude = (await m.snapshot()).engines[0]
    expect(claude.source.kind).toBe('oauth')
  })

  it('backs off 30 min on 429 and keeps the last values; says why on 401, expiry and network errors', async () => {
    signInClaude()
    const m = new UsageMonitor(deps)
    await m.snapshot()
    respond = () => ({ status: 429, body: { error: { type: 'rate_limit_error' } } })
    now += OAUTH_MIN_INTERVAL_MS
    let claude = (await m.snapshot()).engines[0]
    expect(claude.state).toBe('ok')
    expect(claude.windows).toHaveLength(2)
    expect(claude.message).toMatch(/rate limited until \d\d:\d\d/)
    now += OAUTH_MIN_INTERVAL_MS
    await m.snapshot({ refresh: true })
    expect(fetches).toHaveLength(2)
    now += OAUTH_BACKOFF_MS
    respond = () => ({ status: 401, body: {} })
    claude = (await m.snapshot()).engines[0]
    expect(fetches).toHaveLength(3)
    expect(claude.state).toBe('unavailable')
    expect(claude.windows).toHaveLength(2) // last known stays on screen
    expect(claude.message).toMatch(/not accepted/)
    // an expired token is not sent at all
    const expired = new UsageMonitor(deps)
    signInClaude(now - 1)
    claude = (await expired.snapshot()).engines[0]
    expect(fetches).toHaveLength(3)
    expect(claude.state).toBe('unavailable')
    expect(claude.message).toMatch(/expired/)
    // a network failure
    signInClaude()
    const broken = new UsageMonitor({ ...deps, fetch: async () => Promise.reject(new Error('ECONNREFUSED')) })
    claude = (await broken.snapshot()).engines[0]
    expect(claude.state).toBe('unavailable')
    expect(claude.message).toMatch(/network error/)
  })

  it('reads the Claude token from the config dir or CLAUDE_CODE_OAUTH_TOKEN, and reports expiry', () => {
    signInClaude(now + 1000)
    expect(claudeAccessToken(join(home, '.claude'), {}, now)).toEqual({ token: 'sk-ant-oat01-TEST', expired: false, subscription: 'max' })
    expect(claudeAccessToken(join(home, '.claude'), {}, now + 5000)?.expired).toBe(true)
    expect(claudeAccessToken(join(home, '.claude'), { CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' }, now)).toEqual({ token: 'env-tok' })
    expect(claudeAccessToken(join(home, 'nowhere'), {}, now)).toBeUndefined()
    writeFileSync(join(home, '.claude', '.credentials.json'), '{not json')
    expect(claudeAccessToken(join(home, '.claude'), {}, now)).toBeUndefined()
  })

  it('takes Codex limits from the newest rollout with a snapshot and sums today\'s tokens', async () => {
    const sessions = join(home, '.codex', 'sessions')
    mkdirSync(join(sessions, '2026', '10', '24'), { recursive: true })
    mkdirSync(join(sessions, '2026', '10', '25'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    const tc = (info: unknown, rl: unknown, ts: string): string => line({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info, rate_limits: rl } })
    const old = join(sessions, '2026', '10', '24', 'rollout-old.jsonl')
    writeFileSync(old, tc({ total_token_usage: { total_tokens: 1000 } }, { primary: { used_percent: 90, window_minutes: 300, resets_at: 1_800_000_000 } }, '2026-10-24T09:00:00Z') + '\n')
    utimesSync(old, new Date(now - 26 * 3_600_000), new Date(now - 26 * 3_600_000))
    const exec = join(sessions, '2026', '10', '25', 'rollout-exec.jsonl')
    writeFileSync(exec, tc({ total_token_usage: { total_tokens: 400, input_tokens: 300, output_tokens: 100 } }, null, '2026-10-25T09:30:00Z') + '\n')
    const tui = join(sessions, '2026', '10', '25', 'rollout-tui.jsonl')
    writeFileSync(tui, tc({ total_token_usage: { total_tokens: 2500 } }, { primary: { used_percent: 15, window_minutes: 300, resets_at: 1_900_000_000 }, secondary: { used_percent: 48, window_minutes: 10080, resets_at: 1_900_400_000 }, plan_type: 'pro' }, '2026-10-25T09:40:00Z') + '\n')
    utimesSync(exec, new Date(now - 600_000), new Date(now - 600_000))
    utimesSync(tui, new Date(now - 300_000), new Date(now - 300_000))
    expect(listCodexRollouts(sessions)).toEqual([tui, exec, old])
    expect(listCodexRollouts(sessions, 1)).toEqual([tui])
    expect(listCodexRollouts(join(home, 'nope'))).toEqual([])
    const codex = (await new UsageMonitor(deps).snapshot()).engines[1]
    expect(codex.state).toBe('ok')
    expect(codex.plan).toBe('pro')
    expect(codex.windows.map((w) => [w.id, w.usedPct])).toEqual([
      ['five_hour', 15],
      ['seven_day', 48]
    ])
    expect(codex.source).toEqual({ kind: 'rollout', at: Date.parse('2026-10-25T09:40:00Z') })
    expect(codex.tokens?.total).toBe(2900) // today's two rollouts, not yesterday's
    // signed in but no rollout yet
    rmSync(sessions, { recursive: true, force: true })
    const empty = (await new UsageMonitor(deps).snapshot()).engines[1]
    expect(empty.state).toBe('no-data')
    expect(empty.message).toMatch(/Start a Codex card/)
  })

  it('sums Gemini session tokens of the last 7 days on this machine (json and jsonl)', async () => {
    const chats = join(home, '.gemini', 'tmp', 'hash1', 'chats')
    mkdirSync(chats, { recursive: true })
    writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{}')
    const recent = join(chats, 'session-2026-10-25T09-00-abcd1234.json')
    writeFileSync(recent, line({ sessionId: 'a', lastUpdated: '2026-10-25T09:00:00Z', messages: [{ type: 'gemini', timestamp: '2026-10-25T09:00:00Z', tokens: { input: 100, output: 50, total: 150 } }, { type: 'gemini', timestamp: '2026-10-10T09:00:00Z', tokens: { total: 999 } }] })) // older than 7 days: not counted
    const jsonl = join(chats, 'session-2026-10-23T09-00-efgh5678.jsonl')
    writeFileSync(jsonl, line({ type: 'gemini', timestamp: '2026-10-23T09:00:00Z', tokens: { total: 20 } }) + '\n')
    const stale = join(chats, 'session-2026-09-01T09-00-stale0000.json')
    writeFileSync(stale, line({ messages: [{ tokens: { total: 5000 } }] }))
    utimesSync(stale, new Date(now - 30 * 24 * 3_600_000), new Date(now - 30 * 24 * 3_600_000))
    expect(listGeminiSessions(join(home, '.gemini', 'tmp'), now - 7 * 24 * 3_600_000).sort()).toEqual([jsonl, recent].sort())
    const gemini = (await new UsageMonitor(deps).snapshot()).engines[2]
    expect(gemini.state).toBe('ok')
    expect(gemini.windows).toEqual([])
    expect(gemini.tokens).toEqual({ label: 'Tokens, 7 days (this machine)', total: 170, today: 150 })
    expect(gemini.message).toMatch(/\/stats/)
  })

  it('shows a window whose reset has passed as empty, and keeps the file scans for two minutes', async () => {
    signInClaude()
    const day = join(home, '.codex', 'sessions', '2026', '10', '25')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    const m = new UsageMonitor(deps)
    m.onStatusLine('c', { rate_limits: { five_hour: { used_percentage: 98, resets_at: Math.floor(now / 1000) - 60 }, seven_day: { used_percentage: 50, resets_at: Math.floor(now / 1000) + 3600 } } })
    const first = await m.snapshot()
    expect(first.engines[0].windows.map((w) => w.usedPct)).toEqual([0, 50])
    expect(first.engines[1].state).toBe('no-data')
    // Codex rollouts written after the first scan are not seen until the TTL passes or a refresh is asked for
    writeFileSync(join(day, 'rollout-a.jsonl'), line({ timestamp: '2026-10-25T09:40:00Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 15, window_minutes: 300, resets_at: 1_900_000_000 } } } }) + '\n')
    expect((await m.snapshot()).engines[1].state).toBe('no-data')
    expect((await m.snapshot({ refresh: true })).engines[1].state).toBe('ok')
    now += FILE_SCAN_TTL_MS + 1
    expect((await m.snapshot()).engines[1].windows[0].usedPct).toBe(15)
  })

  it('notifies once per burst of status lines', async () => {
    const m = new UsageMonitor(deps)
    let calls = 0
    m.onChange(() => calls++)
    m.onStatusLine('a', STATUS_LINE)
    m.onStatusLine('b', STATUS_LINE)
    await new Promise((r) => setTimeout(r, 1700))
    expect(calls).toBe(1)
  })
})

describe('status line plumbing', () => {
  it('puts a curl status-line command next to the hooks in the card settings', () => {
    const s = buildHookSettings('http://127.0.0.1:1234', 'node-1') as { statusLine: { type: string; command: string } }
    expect(s.statusLine.type).toBe('command')
    expect(s.statusLine.command).toContain('http://127.0.0.1:1234/hook/node-1/statusline')
    expect(s.statusLine.command).toContain('--data-binary @-')
    expect(s.statusLine.command).not.toContain('/dev/null')
    expect(buildStatusLineCommand('http://h', 'n', 'win32').startsWith('curl.exe ')).toBe(true)
    expect(buildStatusLineCommand('http://h', 'n', 'darwin').startsWith('curl ')).toBe(true)
  })

  it('gives no status line to a card whose id could not go into a shell command (a board file can carry any id)', () => {
    for (const bad of ["x(iex(gc('p.txt')))", 'a b', '../x', 'a;b', '$(id)', 'x'.repeat(65), '']) {
      const s = buildHookSettings('http://127.0.0.1:1', bad) as { hooks: unknown; statusLine?: unknown }
      expect(s.hooks).toBeTruthy()
      expect(s.statusLine).toBeUndefined()
    }
    expect((buildHookSettings('http://127.0.0.1:1', 'V1StGXR8_Z5jdHi6B-myT') as { statusLine?: unknown }).statusLine).toBeTruthy()
  })

  it('routes POST /hook/<id>/statusline to onStatusLine and never to the hook handler', async () => {
    const hooks: string[] = []
    const lines: Array<[string, unknown]> = []
    const server = new HookServer({ onHook: (id) => hooks.push(id), onExternalHook: () => undefined, onStatusLine: (id, body) => lines.push([id, body]), resolveApi: () => undefined })
    const port = await server.start(0)
    try {
      const post = (path: string, body: string, token = ''): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-ouroboros-token': token } }, (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          })
          req.on('error', reject)
          req.end(body)
        })
      expect(await post('/hook/card%201/statusline', line(STATUS_LINE))).toBe(204)
      expect(await post('/hook/card%201/statusline', 'not json')).toBe(500)
      expect(await post('/hook/card%201', line({ hook_event_name: 'Stop' }), server.hookToken('card 1'))).toBe(200)
      expect(lines).toEqual([['card 1', STATUS_LINE]])
      expect(hooks).toEqual(['card 1'])
    } finally {
      server.stop()
    }
  })
})
