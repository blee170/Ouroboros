/**
 * Grok Bot replies through a GitHub issue: for routines whose network cannot reach the Funnel address. The routine
 * comments on an issue in a private repository; this reads the issue with the owner's gh (its keyring sign-in),
 * hands each reply comment to the same handler the reply server uses, and deletes the comment once the reply is
 * mailed. Comments that hold no reply block (a person's note) are left alone.
 */
import { issueUrl, parseReply, replyFromComment, type IssueRef } from '@shared/grokreply'
import { plainGhError, type GhRunner } from './rulesets'
import type { ReplyHandler, ReplyStore } from './grok-reply'

export const MAILBOX_POLL_MS = 30_000
/** how often the repository is checked again (still private, still readable), and a failed check retried */
const RECHECK_MS = 5 * 60_000
/** a comment whose delete failed is tried again this long after */
const DELETE_RETRY_MS = 10 * 60_000

interface Comment {
  id: number
  body: string
}

/** An error that will not pass by itself (sign-in, access, a missing repository or gh): stop promising replies. */
const lasting = (msg: string): boolean => /signed in|not installed|HTTP 40[134]\b|not private|pull request/i.test(msg)

/** The issue is readable and its repository private (not public, not internal to an organisation): undefined, or why not. */
export async function checkIssue(gh: GhRunner, issue: IssueRef): Promise<string | undefined> {
  try {
    const repo = JSON.parse(await gh(['api', `repos/${issue.owner}/${issue.repo}`])) as { private?: unknown; visibility?: unknown }
    // a public repository would show every result to the world and let anyone comment; an internal one, the whole organisation
    if (repo.private !== true || (repo.visibility !== undefined && repo.visibility !== 'private')) return `${issue.owner}/${issue.repo} is not private: use a private repository`
    const it = JSON.parse(await gh(['api', `repos/${issue.owner}/${issue.repo}/issues/${issue.number}`])) as { pull_request?: unknown }
    if (it.pull_request) return `#${issue.number} is a pull request: use an issue`
  } catch (e) {
    return plainGhError(e)
  }
  return undefined
}

export class GitHubMailbox {
  issue?: IssueRef
  /** checked private and readable: handoffs are told a reply can come */
  ready = false
  error?: string
  lastCheckAt?: number
  private checkedAt = 0
  /** comments this run will not read again: no reply block, or a reply the handler refused */
  private skip = new Set<number>()
  /** mailed comments whose delete failed: when it was last tried */
  private undeleted = new Map<number, number>()
  private busy = false

  constructor(
    private gh: GhRunner,
    private store: Pick<ReplyStore, 'commentDone' | 'markComment'>,
    private onReply: ReplyHandler,
    private log: (line: string) => void = () => {},
    private now: () => number = Date.now
  ) {}

  /** Point at an issue (undefined: off) and check it. */
  async use(issue: IssueRef | undefined): Promise<string | undefined> {
    this.issue = issue
    this.ready = false
    this.error = undefined
    this.skip.clear()
    this.undeleted.clear()
    if (!issue) return undefined
    return this.check(issue)
  }

  /** Read the issue once: mail every new reply in order, then delete its comment. Rechecks the repository every few minutes. */
  async poll(): Promise<void> {
    const issue = this.issue
    if (!issue || this.busy) return
    this.busy = true
    try {
      if (this.now() - this.checkedAt >= RECHECK_MS && (await this.check(issue))) return
      if (!this.ready || this.issue !== issue) return
      let comments: Comment[]
      try {
        // all pages: notes a person left on the issue never hide a newer reply
        const pages = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments?per_page=100`])) as unknown
        comments = (Array.isArray(pages) ? pages.flat() : []).filter((c): c is Comment => !!c && Number.isSafeInteger(c.id) && typeof c.body === 'string')
      } catch (e) {
        this.setError(issue, plainGhError(e))
        return
      }
      if (this.issue !== issue) return
      this.setError(issue, undefined)
      this.lastCheckAt = this.now()
      for (const c of comments.sort((a, b) => a.id - b.id)) {
        if (this.issue !== issue) return
        if (this.skip.has(c.id)) continue
        if (!this.store.commentDone(c.id)) {
          const obj = replyFromComment(c.body)
          if (obj === undefined) {
            this.skip.add(c.id)
            // a block that looks like a reply but is not readable JSON: said, not dropped in silence
            if (/```[\s\S]*"kind"/.test(c.body)) this.log(`[grok-mail] comment ${c.id} left on the issue: its reply block is not readable JSON`)
            continue
          }
          const r = parseReply(obj)
          if (!r.ok) {
            this.skip.add(c.id)
            this.log(`[grok-mail] comment ${c.id} left on the issue: ${r.error}`)
            continue
          }
          const res = this.onReply(r)
          if (res.status !== 200) {
            // an unknown handoff, or one that already had its replies: left for the owner to see
            this.skip.add(c.id)
            this.log(`[grok-mail] comment ${c.id} left on the issue: ${String(res.body.error ?? res.status)}`)
            continue
          }
          // remembered before the delete: a delete that fails does not mail the reply twice
          this.store.markComment(c.id, true)
        }
        const tried = this.undeleted.get(c.id)
        if (tried !== undefined && this.now() - tried < DELETE_RETRY_MS) continue
        try {
          await this.gh(['api', '-X', 'DELETE', `repos/${issue.owner}/${issue.repo}/issues/comments/${c.id}`])
          this.store.markComment(c.id, false)
          this.undeleted.delete(c.id)
        } catch (e) {
          const msg = plainGhError(e)
          // someone deleted it already: done
          if (/HTTP 404\b/.test(msg)) {
            this.store.markComment(c.id, false)
            continue
          }
          if (tried === undefined) this.log(`[grok-mail] comment ${c.id} mailed but not deleted: ${msg}`)
          this.undeleted.set(c.id, this.now())
        }
      }
    } finally {
      this.busy = false
    }
  }

  /** Check the repository again; the error (or undefined). Ready follows it. */
  private async check(issue: IssueRef): Promise<string | undefined> {
    const err = await checkIssue(this.gh, issue)
    if (this.issue !== issue) return err
    this.checkedAt = this.now()
    this.ready = !err
    this.setError(issue, err)
    return err
  }

  /** Logged when it changes, not every 30 s; a lasting one stops handoffs being told a reply can come. */
  private setError(issue: IssueRef, err: string | undefined): void {
    if (err && lasting(err)) this.ready = false
    if (err !== this.error) this.log(err ? `[grok-mail] ${issueUrl(issue)}: ${err}` : `[grok-mail] ${issueUrl(issue)} readable`)
    this.error = err
  }
}
