import { describe, expect, it } from 'vitest'
import { ENGINE_META, claudeConfigDirOf, claudeEnvKeysToStrip, claudeLoginFromFiles, credentialEnvKeys, parseVersion, signedInFromFiles } from '../src/main/engines'

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

describe('credentialEnvKeys', () => {
  const env = { PATH: 'x', GITHUB_TOKEN: 'g', gh_token: 'g2', SUPABASE_ACCESS_TOKEN: 's', GITHUB_PAT_CI: 'p', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'm', ANTHROPIC_API_KEY: 'a', AWS_SECRET_ACCESS_KEY: 'w', EMPTY_TOKEN: '', NPM_TOKEN: '' }
  it('drops deploy tokens and the other engines keys, keeps the engine own key and plain vars', () => {
    expect(credentialEnvKeys(env, 'claude', false).sort()).toEqual(['AWS_SECRET_ACCESS_KEY', 'GEMINI_API_KEY', 'GITHUB_PAT_CI', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'SUPABASE_ACCESS_TOKEN', 'gh_token'])
    expect(credentialEnvKeys(env, 'codex', false)).toContain('ANTHROPIC_API_KEY')
    expect(credentialEnvKeys(env, 'codex', false)).not.toContain('OPENAI_API_KEY')
    expect(credentialEnvKeys(env, 'gemini', false)).not.toContain('GEMINI_API_KEY')
    expect(credentialEnvKeys(env, 'gemini', false)).toContain('OPENAI_API_KEY')
  })
  it('drops other secret-looking names but keeps the app, Claude Code and cloud sign-in variables', () => {
    const e = { HF_TOKEN: 'h', SENTRY_AUTH_TOKEN: 's', OUROBOROS_HOOK_TOKEN: 'o', CLAUDE_CODE_OAUTH_TOKEN: 'c', SSH_AUTH_SOCK: 'x', CODEX_API_KEY: 'k' }
    expect(credentialEnvKeys(e, 'claude', false).sort()).toEqual(['CODEX_API_KEY', 'HF_TOKEN', 'SENTRY_AUTH_TOKEN'])
    expect(credentialEnvKeys(e, 'codex', false)).not.toContain('CODEX_API_KEY')
    const bedrock = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', GITHUB_TOKEN: 'g' }
    expect(credentialEnvKeys(bedrock, 'claude', false)).toEqual(['GITHUB_TOKEN'])
    expect(credentialEnvKeys(bedrock, 'codex', false).sort()).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN'])
    expect(credentialEnvKeys({ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_APPLICATION_CREDENTIALS: 'f' }, 'gemini', false)).toEqual([])
  })
  it('leaves empty values and everything when the owner passes them', () => {
    expect(credentialEnvKeys(env, 'claude', false)).not.toContain('NPM_TOKEN')
    expect(credentialEnvKeys(env, 'claude', true)).toEqual([])
  })
})
