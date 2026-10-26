import { describe, expect, it, vi } from 'vitest'
import { RULESET_NAME, activeRules, parseGitHubRemote, protectedFully, rulesetBody } from '@shared/rulesets'
import { CARD_GIT_HELPER, cardGitHubEnv } from '../src/main/engines'

vi.mock('../src/main/git', () => ({ git: vi.fn(async () => 'https://github.com/blee170/Ouroboros.git\n') }))
const { applyProtection, checkCardToken, readProtection } = await import('../src/main/rulesets')

describe('parseGitHubRemote', () => {
  it('reads https, ssh and scp remotes on github.com only', () => {
    expect(parseGitHubRemote('https://github.com/blee170/Ouroboros.git')).toEqual({ owner: 'blee170', repo: 'Ouroboros' })
    expect(parseGitHubRemote('https://x-access-token:abc@github.com/a/b')).toEqual({ owner: 'a', repo: 'b' })
    expect(parseGitHubRemote('git@github.com:a/my.repo.git')).toEqual({ owner: 'a', repo: 'my.repo' })
    expect(parseGitHubRemote('ssh://git@github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' })
    for (const bad of ['https://gitlab.com/a/b', 'https://github.com.evil/a/b', 'https://github.com/a', 'https://github.com/a/..', '', undefined])
      expect(parseGitHubRemote(bad)).toBeUndefined()
  })
})

describe('ruleset body and status', () => {
  it('protects the default branch with no bypass', () => {
    const b = rulesetBody() as { name: string; enforcement: string; bypass_actors: unknown[]; conditions: unknown; rules: { type: string; parameters?: Record<string, unknown> }[] }
    expect(b.name).toBe(RULESET_NAME)
    expect(b.enforcement).toBe('active')
    expect(b.bypass_actors).toEqual([])
    expect(b.conditions).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } })
    expect(b.rules.map((r) => r.type).sort()).toEqual(['deletion', 'non_fast_forward', 'pull_request'])
    expect(b.rules.find((r) => r.type === 'pull_request')?.parameters).toMatchObject({ required_approving_review_count: 0, allowed_merge_methods: ['merge', 'squash', 'rebase'] })
  })
  it('reads active rules from any source', () => {
    const r = activeRules([{ type: 'deletion', ruleset_id: 1 }, { type: 'non_fast_forward' }, { type: 'required_signatures' }, null, 'x'])
    expect(r).toEqual({ pull_request: false, non_fast_forward: true, deletion: true })
    expect(protectedFully({ rules: r })).toBe(false)
    expect(activeRules('nope')).toEqual({ pull_request: false, non_fast_forward: false, deletion: false })
  })
})

type Call = { args: string[]; input?: string }
const fakeGh = (state: { rules: unknown[]; sets: { name: string }[]; postError?: string }) => {
  const calls: Call[] = []
  const gh = async (args: string[], input?: string): Promise<string> => {
    calls.push({ args, input })
    const path = args.find((a) => a.startsWith('repos/')) ?? ''
    if (args.includes('POST')) {
      if (state.postError) throw new Error(state.postError)
      state.rules = [{ type: 'pull_request' }, { type: 'non_fast_forward' }, { type: 'deletion' }]
      state.sets.push({ name: RULESET_NAME })
      return '{}'
    }
    if (path.includes('/rules/branches/')) return JSON.stringify(state.rules)
    if (path.includes('/rulesets')) return JSON.stringify(state.sets)
    return JSON.stringify({ default_branch: 'main', private: false })
  }
  return { gh, calls }
}

describe('readProtection / applyProtection', () => {
  it('reads the repo, branch and rules', async () => {
    const { gh } = fakeGh({ rules: [{ type: 'deletion' }], sets: [] })
    expect(await readProtection('C:/p', gh)).toEqual({ ok: true, repo: 'blee170/Ouroboros', branch: 'main', private: false, rules: { pull_request: false, non_fast_forward: false, deletion: true }, ours: false })
  })
  it('adds the ruleset once, and sends nothing when already protected', async () => {
    const state = { rules: [] as unknown[], sets: [] as { name: string }[] }
    const { gh, calls } = fakeGh(state)
    const r = await applyProtection('C:/p', gh)
    expect(r).toMatchObject({ ok: true, added: true, rules: { pull_request: true, non_fast_forward: true, deletion: true } })
    const post = calls.filter((c) => c.args.includes('POST'))
    expect(post).toHaveLength(1)
    expect(post[0].args).toEqual(['api', '--method', 'POST', 'repos/blee170/Ouroboros/rulesets', '--input', '-'])
    expect(JSON.parse(post[0].input ?? '')).toEqual(rulesetBody())
    expect(await applyProtection('C:/p', gh)).toMatchObject({ ok: true, added: false })
    expect(calls.filter((c) => c.args.includes('POST'))).toHaveLength(1)
  })
  it('leaves our own ruleset alone when it was switched off, and says why GitHub refused', async () => {
    const off = fakeGh({ rules: [], sets: [{ name: RULESET_NAME }] })
    expect(await applyProtection('C:/p', off.gh)).toMatchObject({ ok: false, error: expect.stringMatching(/already on .* not fully active/) })
    expect(off.calls.some((c) => c.args.includes('POST'))).toBe(false)
    const pro = fakeGh({ rules: [], sets: [], postError: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' })
    expect(await applyProtection('C:/p', pro.gh)).toEqual({ ok: false, error: 'rulesets on a private repository need GitHub Pro (or a public repository)' })
  })
})

describe('card GitHub token', () => {
  it('gives gh the token and points git at it for github.com only, after any earlier runtime config', () => {
    const r = cardGitHubEnv('tok', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y', gh_token: 'owner', Path: 'x' })
    expect(r.env).toEqual({
      GH_TOKEN: 'tok',
      GITHUB_TOKEN: 'tok',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: CARD_GIT_HELPER
    })
    // another spelling of a name we set is dropped (Windows names are case-insensitive)
    expect(r.omit).toEqual(['gh_token'])
    expect(cardGitHubEnv('t', { GIT_CONFIG_COUNT: 'junk' }).env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper')
    expect(Object.values(cardGitHubEnv('SECRETVAL', {}).env).filter((v) => v.includes('SECRETVAL'))).toEqual(['SECRETVAL', 'SECRETVAL'])
  })
  it('checks whose the token is and its expiry, without echoing it', async () => {
    const ok = (async () => new Response(JSON.stringify({ login: 'blee170' }), { status: 200, headers: { 'github-authentication-token-expiration': '2027-01-01 00:00:00 UTC' } })) as unknown as typeof fetch
    expect(await checkCardToken('tok', ok)).toEqual({ ok: true, login: 'blee170', expiresAt: '2027-01-01 00:00:00 UTC' })
    const bad = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect(await checkCardToken('tok', bad)).toMatchObject({ ok: false, error: expect.stringMatching(/401/) })
    const down = (async () => {
      throw new Error('boom tok')
    }) as unknown as typeof fetch
    expect(await checkCardToken('tok', down)).toEqual({ ok: false, error: 'GitHub unreachable: boom [token]' })
  })
})
