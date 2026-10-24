import { describe, expect, it } from 'vitest'
import { ENGINE_META, claudeConfigDirOf, claudeEnvKeysToStrip, claudeLoginFromFiles, parseVersion, signedInFromFiles } from '../src/main/engines'

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
    // a key in the environment is not a Claude sign-in: a stale one breaks every turn, so the app drops it instead
    expect(signedInFromFiles('claude', home, { ANTHROPIC_API_KEY: 'ollama' }, exists, read)).toBe(false)
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

  it('reads the Claude sign-in from ~/.claude.json too, honours CLAUDE_CONFIG_DIR, and says undefined when it cannot read', () => {
    const dir = '/h/.claude'
    const only = (p: string): ((q: string) => boolean) => (q) => q.replace(/\\/g, '/') === p
    expect(claudeLoginFromFiles(dir, only('/h/.claude.json'), () => '{"oauthAccount":{"email":"x"}}')).toBe(true)
    expect(claudeLoginFromFiles(dir, only('/h/.claude.json'), () => '{"primaryApiKey":"sk"}')).toBe(true)
    expect(claudeLoginFromFiles(dir, only('/h/.claude.json'), () => '{}')).toBe(false)
    expect(claudeLoginFromFiles(dir, only('/h/.claude.json'), () => 'not json')).toBeUndefined()
    expect(claudeLoginFromFiles(dir, () => false, () => '')).toBe(false)
    // a custom config folder keeps both files inside it
    expect(claudeLoginFromFiles('/d/cc', only('/d/cc/.credentials.json'), () => '')).toBe(true)
    expect(claudeLoginFromFiles('/d/cc', only('/d/cc/.claude.json'), () => '{"oauthAccount":{}}')).toBe(true)
    expect(claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '/d/cc' }, '/h')).toBe('/d/cc')
    expect(claudeConfigDirOf({}, '/h').replace(/\\/g, '/')).toBe('/h/.claude')
    expect(signedInFromFiles('claude', '/h', { CLAUDE_CONFIG_DIR: '/d/cc' }, only('/d/cc/.credentials.json'), () => '')).toBe(true)
  })

  it('drops an environment API key from Claude cards only when the owner is signed in and did not opt to keep it', () => {
    const env = { ANTHROPIC_API_KEY: 'ollama-x', PATH: 'p' }
    expect(claudeEnvKeysToStrip(env, true, false)).toEqual(['ANTHROPIC_API_KEY'])
    expect(claudeEnvKeysToStrip({ ...env, ANTHROPIC_AUTH_TOKEN: 't' }, true, false).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
    // Windows keeps whatever spelling the variable was set with
    expect(claudeEnvKeysToStrip({ Anthropic_Api_Key: 'k' }, true, false)).toEqual(['Anthropic_Api_Key'])
    // the setting keeps it; no sign-in means the key is all there is; an empty value is nothing to drop
    expect(claudeEnvKeysToStrip(env, true, true)).toEqual([])
    expect(claudeEnvKeysToStrip(env, false, false)).toEqual([])
    expect(claudeEnvKeysToStrip(env, undefined, false)).toEqual([])
    expect(claudeEnvKeysToStrip({ ANTHROPIC_API_KEY: '' }, true, false)).toEqual([])
    expect(claudeEnvKeysToStrip({ PATH: 'p' }, true, false)).toEqual([])
    // a key for a gateway is the only way to reach that gateway: left alone; Anthropic's own URL changes nothing
    expect(claudeEnvKeysToStrip({ ...env, ANTHROPIC_BASE_URL: 'https://llm-gw.corp.example/v1' }, true, false)).toEqual([])
    expect(claudeEnvKeysToStrip({ ...env, anthropic_base_url: 'http://localhost:11434' }, true, false)).toEqual([])
    expect(claudeEnvKeysToStrip({ ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, true, false)).toEqual(['ANTHROPIC_API_KEY'])
    expect(claudeEnvKeysToStrip({ ...env, ANTHROPIC_BASE_URL: ' ' }, true, false)).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('has install and login commands for every engine', () => {
    for (const e of ['claude', 'codex', 'gemini'] as const) {
      expect(ENGINE_META[e].install.length).toBeGreaterThan(5)
      expect(ENGINE_META[e].login.length).toBeGreaterThan(3)
    }
  })
})
