import { describe, expect, it } from 'vitest'
import { findBriefUrl, urlKey } from '../src/main/briefs'

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

describe('urlKey', () => {
  it('treats the /code/artifact and /artifact forms of a claude.ai artifact as one page, query and fragment aside', () => {
    const key = urlKey('https://claude.ai/artifact/0f4e1c2a-brief')
    expect(urlKey('https://claude.ai/code/artifact/0f4e1c2a-brief')).toBe(key)
    expect(urlKey('https://claude.ai/artifact/0f4e1c2a-brief?utm=x&v=2#top')).toBe(key)
    expect(urlKey('https://claude.ai/code/artifact/0F4E1C2A-BRIEF/')).toBe(key)
    expect(urlKey('https://claude.ai/artifact/other')).not.toBe(key)
  })

  it('keeps the query of any other page and only drops the fragment, trailing slash and case', () => {
    expect(urlKey('https://Example.com/report/7/#sec')).toBe('https://example.com/report/7')
    expect(urlKey('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(urlKey('https://example.com/a?b=2')).not.toBe(urlKey('https://example.com/a?b=1'))
  })

  it('is linear on a long run of slashes (agent output reaches it)', () => {
    const t = Date.now()
    expect(urlKey(`https://x.com/${'/'.repeat(200_000)}a`)).toBe(`https://x.com/${'/'.repeat(200_000)}a`)
    expect(urlKey(`https://x.com${'/'.repeat(200_000)}`)).toBe('https://x.com')
    expect(Date.now() - t).toBeLessThan(500)
  })
})
