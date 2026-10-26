/**
 * Main-branch protection on GitHub (RESEARCH §11 Type 1 (b)): the server-side rule a card cannot get around with
 * local credentials. The app reads which rules are active on the default branch and, when the owner presses the
 * button, adds one ruleset; it never edits or deletes a ruleset that is already there.
 */

export const RULESET_NAME = 'Ouroboros · protect main'

/** The rules the recommended ruleset holds, by GitHub's rule type. */
export const PROTECT_RULES = ['pull_request', 'non_fast_forward', 'deletion'] as const
export type ProtectRule = (typeof PROTECT_RULES)[number]

export interface RepoRef {
  owner: string
  repo: string
}

/** Pure: owner/repo from a github.com remote URL (https, ssh or scp form); undefined for any other host. */
export function parseGitHubRemote(url: string | undefined): RepoRef | undefined {
  const u = (url ?? '').trim()
  const m =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(u)
  if (!m || m[2] === '.' || m[2] === '..') return undefined
  return { owner: m[1], repo: m[2] }
}

/** The body for POST /repos/{owner}/{repo}/rulesets: the default branch needs a pull request, cannot be force-pushed or deleted, and nobody bypasses it. */
export function rulesetBody(): Record<string, unknown> {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          // a solo owner cannot approve their own pull request: 0 keeps the merge button usable
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          // "at least one option must be enabled"; all three keep the owner's merge button as it is
          allowed_merge_methods: ['merge', 'squash', 'rebase']
        }
      }
    ]
  }
}

export interface ProtectionView {
  repo: string
  branch: string
  private: boolean
  /** each recommended rule: active on the default branch through a ruleset (classic branch protection is not read) */
  rules: Record<ProtectRule, boolean>
  /** a ruleset by this app's name already exists (it may be disabled or changed by hand) */
  ours: boolean
}

/** Pure: which recommended rules the branch's active ruleset rules cover (GET /repos/{o}/{r}/rules/branches/{branch}; rulesets only). */
export function activeRules(list: unknown): Record<ProtectRule, boolean> {
  const types = new Set(Array.isArray(list) ? list.map((r) => (r && typeof r === 'object' ? (r as { type?: unknown }).type : undefined)).filter((t): t is string => typeof t === 'string') : [])
  return { pull_request: types.has('pull_request'), non_fast_forward: types.has('non_fast_forward'), deletion: types.has('deletion') }
}

export function protectedFully(v: Pick<ProtectionView, 'rules'>): boolean {
  return PROTECT_RULES.every((r) => v.rules[r])
}
