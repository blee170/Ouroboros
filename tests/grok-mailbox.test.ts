import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { issueInstructions, issueRef, replyFromComment } from '../src/shared/grokreply'
import { GitHubMailbox, checkIssue } from '../src/main/grok-mailbox'
import { ReplyStore, type ReplyHandler } from '../src/main/grok-reply'

const dir = mkdtempSync(join(tmpdir(), 'grok-mail-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const ID = '0123456789abcdef0123456789abcdef'
const ISSUE = { owner: 'me', repo: 'mail', number: 1 }
const block = (o: unknown): string => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`

describe('issueRef and replyFromComment', () => {
  it('takes a github.com issue address only', () => {
    expect(issueRef('https://github.com/me/mail/issues/1')).toEqual(ISSUE)
    expect(issueRef(' https://github.com/me/mail/issues/12/ ')).toEqual({ ...ISSUE, number: 12 })
    expect(issueRef('https://github.com/me/mail/pull/1')).toBeUndefined()
    expect(issueRef('http://github.com/me/mail/issues/1')).toBeUndefined()
    expect(issueRef('https://evil.com/me/mail/issues/1')).toBeUndefined()
    expect(issueRef('https://github.com/me/../issues/1')).toBeUndefined()
    expect(issueRef('not a url')).toBeUndefined()
  })
  it('finds the JSON block with a kind, and nothing in a plain note', () => {
    expect(replyFromComment(block({ kind: 'result', correlation_id: ID, text: 'ok' }))).toEqual({ kind: 'result', correlation_id: ID, text: 'ok' })
    expect(replyFromComment('```\n{"kind":"test"}\n```')).toEqual({ kind: 'test' })
    expect(replyFromComment('Looks good, thanks!')).toBeUndefined()
    expect(replyFromComment('```json\n{"other":1}\n```')).toBeUndefined()
    expect(replyFromComment('```json\n{not json\n```')).toBeUndefined()
  })
  it('gives the routine the issue and no secret', () => {
    const s = issueInstructions('https://github.com/me/mail/issues/1')
    expect(s).toContain('https://github.com/me/mail/issues/1')
    expect(s).toContain('"correlation_id"')
    expect(s).not.toContain('OUROBOROS_REPLY_KEY')
  })
})

/** A fake gh: the repository, the issue and its comments; deletes are recorded and can be made to fail. */
function fakeGh(o: { private?: boolean; visibility?: string; comments: { id: number; body: string }[]; failDelete?: string; failList?: string; failRepo?: string }) {
  const deleted: number[] = []
  const calls: string[][] = []
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args)
    const path = args[args.length - 1]
    if (args.includes('DELETE')) {
      if (o.failDelete) throw new Error(o.failDelete)
      const id = Number(path.split('/').pop())
      deleted.push(id)
      o.comments = o.comments.filter((c) => c.id !== id)
      return ''
    }
    if (path === 'repos/me/mail') {
      if (o.failRepo) throw new Error(o.failRepo)
      return JSON.stringify({ private: o.private !== false, visibility: o.visibility ?? (o.private === false ? 'public' : 'private') })
    }
    if (path === 'repos/me/mail/issues/1') return JSON.stringify({ number: 1 })
    if (path.startsWith('repos/me/mail/issues/1/comments')) {
      if (o.failList) throw new Error(o.failList)
      // --paginate --slurp: one array per page of 2
      const pages: unknown[] = []
      for (let i = 0; i < o.comments.length; i += 2) pages.push(o.comments.slice(i, i + 2))
      return JSON.stringify(pages)
    }
    throw new Error(`HTTP 404: Not Found (${path})`)
  }
  return { gh, deleted, calls }
}

const setup = async (comments: { id: number; body: string }[], extra: { private?: boolean; failDelete?: string } = {}, handler?: ReplyHandler, now: () => number = Date.now) => {
  const store = new ReplyStore(join(dir, `${Math.random().toString(36).slice(2)}.json`))
  const got: unknown[] = []
  const f = fakeGh({ comments, ...extra })
  const lines: string[] = []
  const box = new GitHubMailbox(f.gh, store, handler ?? ((r) => (got.push(r), { status: 200, body: { ok: true } })), (l) => lines.push(l), now)
  const err = await box.use(ISSUE)
  return { box, store, got, f, lines, err }
}

describe('GitHubMailbox', () => {
  it('refuses a public or organisation-internal repository, and is not ready then', async () => {
    const s = await setup([], { private: false })
    expect(s.err).toContain('not private')
    expect(await checkIssue(fakeGh({ comments: [], visibility: 'internal' }).gh, ISSUE)).toContain('not private')
    expect(s.box.ready).toBe(false)
    await s.box.poll()
    expect(s.f.calls.some((a) => a.join(' ').includes('/comments'))).toBe(false)
  })
  it('mails each reply in order and deletes its comment; a person’s note stays', async () => {
    const s = await setup([
      { id: 30, body: block({ kind: 'result', correlation_id: ID, text: 'second' }) },
      { id: 10, body: block({ kind: 'question', correlation_id: ID, text: 'first' }) },
      { id: 20, body: 'A note from the owner' }
    ])
    expect(s.err).toBeUndefined()
    await s.box.poll()
    expect(s.got.map((r) => (r as { text: string }).text)).toEqual(['first', 'second'])
    expect(s.f.deleted).toEqual([10, 30])
    await s.box.poll()
    expect(s.got).toHaveLength(2)
  })
  it('leaves a reply the handler refuses (unknown handoff) on the issue, and does not try it again', async () => {
    let n = 0
    const s = await setup([{ id: 5, body: block({ kind: 'result', correlation_id: ID, text: 'x' }) }], {}, () => (n++, { status: 404, body: { ok: false, error: 'unknown or expired correlation_id' } }))
    await s.box.poll()
    await s.box.poll()
    expect(n).toBe(1)
    expect(s.f.deleted).toEqual([])
    expect(s.lines.join('\n')).toContain('unknown or expired')
  })
  it('a delete that fails does not mail the reply twice, after a restart either', async () => {
    const s = await setup([{ id: 7, body: block({ kind: 'result', correlation_id: ID, text: 'once' }) }], { failDelete: 'HTTP 403: Resource not accessible' })
    await s.box.poll()
    await s.box.poll()
    expect(s.got).toHaveLength(1)
    expect(s.store.commentDone(7)).toBe(true)
    expect(s.lines.filter((l) => l.includes('not deleted'))).toHaveLength(1)
  })
  it('reads every page: notes a person left never hide a newer reply', async () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, body: 'note' }))
    const s = await setup([...notes, { id: 99, body: block({ kind: 'result', correlation_id: ID, text: 'late' }) }])
    await s.box.poll()
    expect(s.got.map((r) => (r as { text: string }).text)).toEqual(['late'])
    expect(s.f.deleted).toEqual([99])
  })
  it('a comment someone already deleted counts as deleted; a failing delete is retried later, not every poll', async () => {
    let t = 1_000_000
    const s = await setup([{ id: 8, body: block({ kind: 'result', correlation_id: ID, text: 'x' }) }], { failDelete: 'HTTP 403: nope' }, undefined, () => t)
    await s.box.poll()
    await s.box.poll()
    const deletes = () => s.f.calls.filter((a) => a.includes('DELETE')).length
    expect(deletes()).toBe(1)
    t += 11 * 60_000
    await s.box.poll()
    expect(deletes()).toBe(2)
    const g = await setup([{ id: 9, body: block({ kind: 'result', correlation_id: ID, text: 'y' }) }], { failDelete: 'HTTP 404: Not Found' })
    await g.box.poll()
    expect(g.store.commentDone(9)).toBe(false)
  })
  it('checks the repository again every few minutes: a failed start is retried, made public stops it', async () => {
    let t = 1_000_000
    let answer: 'signed out' | 'private' | 'public' = 'signed out'
    const fakes = { private: fakeGh({ comments: [] }), public: fakeGh({ comments: [], private: false }), 'signed out': fakeGh({ comments: [], failRepo: 'gh is not signed in: run gh auth login' }) }
    const box = new GitHubMailbox((a) => fakes[answer].gh(a), new ReplyStore(join(dir, 'recheck.json')), () => ({ status: 200, body: {} }), () => {}, () => t)
    expect(await box.use(ISSUE)).toContain('signed in')
    answer = 'private'
    await box.poll()
    expect(box.ready).toBe(false)
    t += 6 * 60_000
    await box.poll()
    expect(box.ready).toBe(true)
    answer = 'public'
    t += 6 * 60_000
    await box.poll()
    expect(box.ready).toBe(false)
    expect(box.error).toContain('not private')
  })
  it('finds a reply that follows another code block, with any fence label', () => {
    expect(replyFromComment(['```text', 'foo', '```', 'Result:', '```JSON', '{"kind":"result"}', '```'].join('\n'))).toEqual({ kind: 'result' })
  })
  it('says a read failure once, and carries on when it reads again', async () => {
    const s = await setup([])
    const f = fakeGh({ comments: [], failList: 'HTTP 502: Bad Gateway' })
    const box = new GitHubMailbox(f.gh, s.store, () => ({ status: 200, body: {} }), (l) => s.lines.push(l))
    await box.use(ISSUE)
    await box.poll()
    await box.poll()
    expect(box.error).toContain('502')
    expect(s.lines.filter((l) => l.includes('502'))).toHaveLength(1)
  })
})
