/**
 * Action gates (RESEARCH §11 step 3): during an Autonomous run, a card's shell command that pushes, opens a PR or
 * merges one is decided here instead of by a blanket deny rule. The owner's policy (2026-10-25):
 * - auto: a push whose every destination is a `claude/*` or `card/*` branch (no force, delete, mirror, all, tags);
 *   `gh pr create --draft`
 * - ask: `gh pr merge` (the owner approves once, for that card and that exact command)
 * - never: any other push, `git send-pack`, a PR that is not a draft
 * Pure: the command text in, a decision out. The text is parsed the way a shell would split it, not executed:
 * aliases, scripts that push, `bash -c "…"` and `curl` to the GitHub API are not seen (a second rail, not a sandbox).
 */

export type GateDecision = 'auto' | 'ask' | 'never'

export interface GateAction {
  kind: 'push' | 'send-pack' | 'pr-create' | 'pr-merge'
  decision: GateDecision
  reason: string
  /** the segment of the command it came from */
  text: string
}

export interface GateVerdict {
  /** undefined: nothing gated in the command, the normal permission flow applies */
  decision?: GateDecision
  reason: string
  actions: GateAction[]
  /** true when every segment of the command is a gated action (an auto allow covers nothing else) */
  onlyGated: boolean
}

const OWN_BRANCH = /^(claude|card)\/[A-Za-z0-9._\/-]+$/

/** Split a command line into its simple commands (`&&`, `||`, `;`, `|`, newlines), outside quotes. */
export function splitCommands(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    // `2>&1` and `&>` are redirections, not a background `&`
    const redirect = c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && !redirect)) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Words of one simple command, quotes removed. */
export function words(segment: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: string | null = null
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (c === ' ' || c === '\t') {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
  }
  if (has || cur) out.push(cur)
  return out
}

/** `2>&1`, `>out.txt`, `> out.txt`, `2>/dev/null`, `*>&1`: not arguments. */
function dropRedirections(ws: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < ws.length; i++) {
    const m = /^(\d|\*|&)?>{1,2}(&?)(.*)$/.exec(ws[i]) ?? /^<(.*)$/.exec(ws[i])
    if (!m) out.push(ws[i])
    else if (m[m.length - 1] === '') i++ // the target is the next word
  }
  return out
}

const WRAPPERS =new Set(['env', 'command', 'nice', 'nohup', 'time', 'exec', 'sudo', 'builtin', '&'])

/** Drop env assignments (`A=b`), wrappers (`env`, `timeout 30`, `nice -n 5`) and the PowerShell call operator. */
function strip(ws: string[]): string[] {
  let i = 0
  while (i < ws.length) {
    const w = ws[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++
    else if (w === 'timeout') {
      i++
      while (i < ws.length && (ws[i].startsWith('-') || /^\d/.test(ws[i]))) i++
    } else if (WRAPPERS.has(w)) {
      i++
      while (i < ws.length && ws[i].startsWith('-')) i += ws[i] === '-n' ? 2 : 1
    } else break
  }
  return ws.slice(i)
}

const prog = (w: string | undefined): string => (w ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

/**
 * True when the shell would run or rewrite something the parser cannot see: `$` (variables, `$(…)`, `$'…'`),
 * backticks (Bash substitution, PowerShell escapes) and backslashes anywhere outside single quotes, and parentheses
 * or braces outside any quotes (subshells, brace blocks, PowerShell script blocks). Single-quoted text is literal in
 * Bash and PowerShell alike. A push or PR command written like that is refused, so the text judged is the text run.
 */
function hasShellMagic(segment: string): boolean {
  let quote: string | null = null
  for (const c of segment) {
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    if (c === '$' || c === '`' || c === '\\') return true
    if (quote === '"') {
      if (c === '"') quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if ('(){}'.includes(c)) return true
  }
  return quote !== null
}

/** Programs that run their argument as another command line. */
const INDIRECT = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd', 'eval', 'xargs', 'iex', 'invoke-expression', 'start-process', 'su', 'wsl', 'source', '.'])

/** git's options before the subcommand: for a push only `-C <dir>` is taken; any other (`-c`, `--git-dir`, `--exec-path` …) refuses it. */
function gitSub(ws: string[]): { sub: string; rest: string[]; otherGlobals: boolean; dirChange: boolean } {
  let i = 1
  let otherGlobals = false
  let dirChange = false
  while (i < ws.length && ws[i].startsWith('-')) {
    const w = ws[i]
    if (w === '-C') {
      dirChange = true
      i += 2
      continue
    }
    if (w !== '--no-pager' && w !== '-P') otherGlobals = true
    i += w === '-c' || ((w === '--git-dir' || w === '--work-tree' || w === '--namespace' || w === '--exec-path' || w === '--config-env') && !w.includes('=')) ? 2 : 1
  }
  return { sub: ws[i] ?? '', rest: ws.slice(i + 1), otherGlobals, dirChange }
}

/** The push flags a run may use; anything else (force, delete, mirror, tags, --receive-pack, --repo, -o …) refuses the push. */
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '-n', '--dry-run', '--porcelain', '--progress', '--no-progress', '--no-verify', '--atomic'])
const PUSH_NAMED: Record<string, string> = {
  '-f': 'force push',
  '--force': 'force push',
  '--force-with-lease': 'force push',
  '--force-if-includes': 'force push',
  '--mirror': 'mirror push',
  '--all': 'push of every branch',
  '--branches': 'push of every branch',
  '--tags': 'push of tags',
  '--follow-tags': 'push of tags',
  '-d': 'branch delete',
  '--delete': 'branch delete',
  '--prune': 'push with --prune (deletes remote branches)'
}
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * A push is allowed only as `git [-C dir] push [flags] <remote> <refspec>…` with a plain remote name and every
 * destination a `claude/*` or `card/*` branch named in the command. A bare `git push`, `git push origin`, or a
 * destination of `HEAD` would let the repo's config (push.default, upstream, remote.*.push) pick the target, which
 * the command does not show, so they are refused with the form to use instead.
 */
function classifyPush(rest: string[], text: string): GateAction {
  const never = (reason: string): GateAction => ({ kind: 'push', decision: 'never', reason, text })
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]
    if (w === '--') {
      positional.push(...rest.slice(i + 1))
      break
    }
    if (!w.startsWith('-')) {
      positional.push(w)
      continue
    }
    const name = w.split('=')[0]
    if (PUSH_NAMED[name] || name.startsWith('--force')) return never(`${PUSH_NAMED[name] ?? 'force push'} is never allowed during a run`)
    if (/^-[a-zA-Z]{2,}$/.test(w)) {
      // bundled short flags (-uq): each must be allowed on its own
      const bad = [...w.slice(1)].find((c) => !PUSH_FLAGS.has(`-${c}`))
      if (bad) return never(`git push -${bad} is not allowed during a run`)
      continue
    }
    if (!PUSH_FLAGS.has(w)) return never(`git push ${name} is not allowed during a run`)
  }
  const [remote, ...refspecs] = positional
  const form = 'name the remote and the branch: git push origin claude/<name> (or HEAD:claude/<name>)'
  if (!remote || refspecs.length === 0) return never(`a git push without a remote and a branch goes where the repo's config says; ${form}`)
  if (!REMOTE_NAME.test(remote)) return never(`push to "${remote}": only a configured remote name (like origin) is allowed during a run, not a URL or a path`)
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return never(`force push (${spec}) is never allowed during a run`)
    const colon = spec.indexOf(':')
    const src = colon < 0 ? spec : spec.slice(0, colon)
    let dst = colon < 0 ? spec : spec.slice(colon + 1)
    if (colon >= 0 && src === '') return never(`deleting ${dst} is never allowed during a run`)
    if (dst === 'HEAD' || dst === '@' || dst === '') return never(`push to ${spec}: ${form}`)
    if (dst.startsWith('refs/')) {
      if (!dst.startsWith('refs/heads/')) return never(`push to ${dst}: only branches are pushed during a run`)
      dst = dst.slice('refs/heads/'.length)
    }
    if (!OWN_BRANCH.test(dst) || dst.split('/').some((p) => p === '..' || p === '.' || p === '') || dst.endsWith('.lock')) return never(`push to ${dst}: only claude/* and card/* branches are pushed during a run`)
  }
  return { kind: 'push', decision: 'auto', reason: `push to ${refspecs.map((s) => s.split(':').pop()).join(', ')}`, text }
}

/** gh's -R/--repo before or after the subcommand words. */
function ghSub(ws: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < ws.length; i++) {
    if (ws[i] === '-R' || ws[i] === '--repo') {
      i++
      continue
    }
    if (ws[i].startsWith('--repo=')) continue
    out.push(ws[i])
  }
  return out
}

/** `gh pr create` flags that take a value: a "--draft" there is text, not the flag. */
const PR_CREATE_VALUE = new Set(['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template', '--recover'])

function isDraft(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (w === '--draft' || w === '-d' || w === '--draft=true') return true
    if (PR_CREATE_VALUE.has(w)) i++
  }
  return false
}

/** The gated actions in one command line. */
export function classify(command: string): { actions: GateAction[]; segments: number } {
  const segments = splitCommands(command)
  const actions: GateAction[] = []
  for (const seg of segments) {
    const ws = strip(dropRedirections(words(seg)))
    const p = prog(ws[0])
    const refuse = (kind: GateAction['kind'], reason: string): void => {
      actions.push({ kind, decision: 'never', reason, text: seg })
    }
    if (INDIRECT.has(p) && mayBeGated(seg)) {
      refuse('push', 'git or gh inside another command line (bash -c, pwsh -Command, eval, xargs …) cannot be checked during a run: run it directly')
      continue
    }
    if (p !== 'git' && p !== 'gh') {
      // a push hidden in a substitution: `echo $(git push …)`
      if (mayBeGated(seg) && /\$\(|`|<\(/.test(seg)) refuse('push', 'git or gh inside a command substitution cannot be checked during a run: run it directly')
      continue
    }
    if (p === 'git') {
      const { sub, rest, otherGlobals } = gitSub(ws)
      if (sub === 'push') {
        if (hasShellMagic(seg)) refuse('push', 'a push written with shell expansion, escapes or substitution cannot be checked during a run: write it plainly')
        else if (otherGlobals) refuse('push', 'git options before push other than -C (-c, --git-dir, --exec-path …) are not allowed during a run')
        else actions.push(classifyPush(rest, seg))
      } else if (sub === 'send-pack' || sub === 'receive-pack') refuse('send-pack', `git ${sub} is never allowed during a run`)
    } else {
      const sub = ghSub(ws)
      if (sub[0] !== 'pr' || (sub[1] !== 'create' && sub[1] !== 'merge')) continue
      if (hasShellMagic(seg)) {
        refuse(sub[1] === 'create' ? 'pr-create' : 'pr-merge', 'a gh pr command written with shell expansion, escapes or substitution cannot be checked during a run: write it plainly')
        continue
      }
      if (sub[1] === 'create') {
        if (isDraft(sub.slice(2))) actions.push({ kind: 'pr-create', decision: 'auto', reason: 'draft pull request', text: seg })
        else refuse('pr-create', 'pull requests are opened as drafts during a run: add --draft')
      } else actions.push({ kind: 'pr-merge', decision: 'ask', reason: 'merging a pull request needs the owner', text: seg })
    }
  }
  return { actions, segments: segments.length }
}

const RANK: Record<GateDecision, number> = { auto: 0, ask: 1, never: 2 }

/** The command's verdict: the strictest of its actions. */
export function decide(command: string): GateVerdict {
  const { actions, segments } = classify(command)
  if (!actions.length) return { reason: '', actions, onlyGated: false }
  const worst = actions.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a))
  return { decision: worst.decision, reason: worst.reason, actions, onlyGated: actions.length === segments }
}

/** True when the command could hold a gated action at all (the hook helper's fast path). */
export function mayBeGated(command: string): boolean {
  return /\b(git|gh)(\.exe)?\b/i.test(command)
}

// ---- approvals ("ask") ----

export interface Approval {
  id: string
  card: string
  title: string
  command: string
  cwd?: string
  createdAt: number
  state: 'pending' | 'approved' | 'denied' | 'used' | 'expired'
  decidedAt?: number
}

export const APPROVAL_TTL_MS = 30 * 60_000

const norm = (c: string): string => c.trim().replace(/\s+/g, ' ')

/** An approved, unused, unexpired approval for exactly this card and command. */
export function findApproval(list: readonly Approval[], card: string, command: string, now: number): Approval | undefined {
  return list.find((a) => a.state === 'approved' && a.card === card && norm(a.command) === norm(command) && now - (a.decidedAt ?? 0) < APPROVAL_TTL_MS)
}

/** A pending request for this card and command already waiting on the owner. */
export function findPending(list: readonly Approval[], card: string, command: string): Approval | undefined {
  return list.find((a) => a.state === 'pending' && a.card === card && norm(a.command) === norm(command))
}

/** Approved requests not used within the window. */
export function expireApprovals(list: readonly Approval[], now: number): Approval[] {
  return list.map((a) => (a.state === 'approved' && now - (a.decidedAt ?? 0) >= APPROVAL_TTL_MS ? { ...a, state: 'expired' as const } : a))
}

/** The reason a card is given when the owner was asked. */
export function approvalNeeded(command: string): string {
  return `APPROVAL NEEDED: ${norm(command).slice(0, 300)} — the owner was asked; carry on with other work, you will get a board message when it is decided.`
}
