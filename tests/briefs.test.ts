import { describe, expect, it } from 'vitest'
import { findBriefUrl } from '../src/main/briefs'

const doc = 'https://claude.ai/artifact/0f4e1c2a-brief'

describe('findBriefUrl', () => {
  it('takes any URL from a conductor reply, trimmed of trailing punctuation', () => {
    expect(findBriefUrl({ message: `Report: https://example.com/report/7.`, output: '', anyUrl: true })).toEqual({ url: 'https://example.com/report/7', inMessage: true })
  })

  it('takes only claude.ai artifact links from other cards, falling back to the output', () => {
    expect(findBriefUrl({ message: 'see https://example.com/x', output: '', anyUrl: false })).toBeNull()
    expect(findBriefUrl({ message: 'READY 2: saved and waiting for go.', output: `turn 1\n${doc}\nturn 2 edits`, anyUrl: false })).toEqual({ url: doc, inMessage: false })
  })

  it('prefers the reply over the output and the newest output link over older ones', () => {
    expect(findBriefUrl({ message: `done: ${doc}`, output: 'https://claude.ai/artifact/old', anyUrl: false })).toEqual({ url: doc, inMessage: true })
    expect(findBriefUrl({ message: 'done', output: `https://claude.ai/artifact/old then https://claude.ai/code/artifact/new.`, anyUrl: false })).toEqual({ url: 'https://claude.ai/code/artifact/new', inMessage: false })
  })

  it('returns null when nothing was published', () => {
    expect(findBriefUrl({ message: 'all green', output: 'no links here', anyUrl: true })).toBeNull()
  })
})
