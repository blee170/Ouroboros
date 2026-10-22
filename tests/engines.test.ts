import { describe, expect, it } from 'vitest'
import { ENGINE_META, parseVersion, signedInFromFiles } from '../src/main/engines'

describe('engines', () => {
  it('parses a version out of --version output', () => {
    expect(parseVersion('2.1.5 (Claude Code)')).toBe('2.1.5')
    expect(parseVersion('codex-cli 0.151.0')).toBe('0.151.0')
    expect(parseVersion('nope')).toBeUndefined()
  })

  it('reads sign-in state from each CLI\'s files or API key env', () => {
    const files = new Set<string>()
    const exists = (p: string): boolean => files.has(p.replace(/\\/g, '/'))
    const read = (): string => '{"oauthAccount":{"email":"x"}}'
    const home = '/h'
    expect(signedInFromFiles('claude', home, {}, exists, read)).toBe(false)
    files.add('/h/.claude/.credentials.json')
    expect(signedInFromFiles('claude', home, {}, exists, read)).toBe(true)
    expect(signedInFromFiles('codex', home, {}, exists, read)).toBe(false)
    expect(signedInFromFiles('codex', home, { OPENAI_API_KEY: 'k' }, exists, read)).toBe(true)
    files.add('/h/.codex/auth.json')
    expect(signedInFromFiles('codex', home, {}, exists, read)).toBe(true)
    expect(signedInFromFiles('gemini', home, {}, exists, read)).toBe(false)
    files.add('/h/.gemini/oauth_creds.json')
    expect(signedInFromFiles('gemini', home, {}, exists, read)).toBe(true)
  })

  it('has install and login commands for every engine', () => {
    for (const e of ['claude', 'codex', 'gemini'] as const) {
      expect(ENGINE_META[e].install.length).toBeGreaterThan(5)
      expect(ENGINE_META[e].login.length).toBeGreaterThan(3)
    }
  })
})
