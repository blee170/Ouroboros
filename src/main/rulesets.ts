/**
 * Main-branch protection through the owner's own `gh` (its keyring sign-in, never a card's token): read the rules
 * active on the default branch, and add the recommended ruleset when the owner presses the button.
 */
import { execFile } from 'node:child_process'
import { RULESET_NAME, activeRules, parseGitHubRemote, protectedFully, rulesetBody, type ProtectionView, type RepoRef } from '@shared/rulesets'
import { git } from './git'

/** `gh api` runner: resolves stdout, rejects with gh's own message (tests pass a fake). */
export type GhRunner = (args: string[], input?: string) => Promise<string>

export const runGh: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile('gh', args, { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((err as { killed?: boolean }).killed ? 'gh did not answer within 20 s' : ((stderr || '').trim() || err.message).split('\n')[0]))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin?.end(input)
  })

export type ProtectionResult = ({ ok: true } & ProtectionView) | { ok: false; error: string }

/** The project's GitHub repository, from its `origin` remote. */
export async function repoOf(projectRoot: string): Promise<RepoRef | { error: string }> {
  if (!projectRoot) return { error: 'open a project first' }
  let url = ''
  try {
    url = (await git(projectRoot, ['remote', 'get-url', 'origin'], [0], { timeout: 10_000 })).trim()
  } catch {
    return { error: 'this project has no origin remote' }
  }
  return parseGitHubRemote(url) ?? { error: 'the origin remote is not a github.com repository' }
}

/** gh's message, made plain where GitHub's is cryptic. */
function plain(err: unknown): string {
  const m = (err as Error).message || String(err)
  if (/ENOENT|not recognized|not found/i.test(m) && !/HTTP/.test(m)) return 'the GitHub CLI (gh) is not installed or not on PATH'
  if (/gh auth login|authentication/i.test(m)) return 'gh is not signed in: run gh auth login'
  if (/HTTP 403/.test(m) && /upgrade|GitHub Pro|plan/i.test(m)) return 'rulesets on a private repository need GitHub Pro (or a public repository)'
  return m
}

export async function readProtection(projectRoot: string, gh: GhRunner = runGh): Promise<ProtectionResult> {
  const ref = await repoOf(projectRoot)
  if ('error' in ref) return { ok: false, error: ref.error }
  const slug = `${ref.owner}/${ref.repo}`
  try {
    const repo = JSON.parse(await gh(['api', `repos/${slug}`])) as { default_branch?: string; private?: boolean }
    const branch = repo.default_branch || 'main'
    const rules = activeRules(JSON.parse(await gh(['api', `repos/${slug}/rules/branches/${encodeURIComponent(branch)}?per_page=100`])))
    const sets = JSON.parse(await gh(['api', `repos/${slug}/rulesets?per_page=100`])) as { name?: string }[]
    return { ok: true, repo: slug, branch, private: repo.private === true, rules, ours: Array.isArray(sets) && sets.some((s) => s?.name === RULESET_NAME) }
  } catch (err) {
    return { ok: false, error: err instanceof SyntaxError ? 'gh answered with something that is not JSON' : plain(err) }
  }
}

/**
 * Add the recommended ruleset. Nothing is sent when the branch is already fully protected or a ruleset by this
 * name exists (it may have been switched off or edited on purpose: that is the owner's to change on GitHub).
 */
export async function applyProtection(projectRoot: string, gh: GhRunner = runGh): Promise<ProtectionResult & { added?: boolean }> {
  const before = await readProtection(projectRoot, gh)
  if (!before.ok) return before
  if (protectedFully(before)) return { ...before, added: false }
  if (before.ours) return { ok: false, error: `a ruleset named "${RULESET_NAME}" is already on ${before.repo} but not fully active: check it on GitHub (Settings → Rules)` }
  try {
    await gh(['api', '--method', 'POST', `repos/${before.repo}/rulesets`, '--input', '-'], JSON.stringify(rulesetBody()))
  } catch (err) {
    return { ok: false, error: plain(err) }
  }
  const after = await readProtection(projectRoot, gh)
  return after.ok ? { ...after, added: true } : after
}

/** Whose the card token is and when it expires (GET /user answers any valid token; GitHub sends the expiry in a header). */
export async function checkCardToken(token: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; login: string; expiresAt?: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Ouroboros', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 401) return { ok: false, error: 'GitHub refused the token (401): expired, revoked or mistyped' }
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}` }
    const body = (await res.json()) as { login?: unknown }
    const exp = res.headers.get('github-authentication-token-expiration')?.trim()
    return { ok: true, login: typeof body.login === 'string' ? body.login : '?', ...(exp ? { expiresAt: exp } : {}) }
  } catch (err) {
    return { ok: false, error: `GitHub unreachable: ${(err as Error).message}`.split(token).join('[token]') }
  }
}
