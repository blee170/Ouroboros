import { describe, expect, it } from 'vitest'
import { BoardDone, Burst, MIN_TURN_MS, announceSettings, announcesStop, firstLine, langFor, phrase } from '@shared/announce'

describe('announce settings', () => {
  it('defaults to conductor replies, toast and voice on', () => {
    expect(announceSettings({})).toEqual({ target: 'conductor', toast: true, voice: true })
    expect(announceSettings({ announce: 'all', announceToast: false, announceVoice: false })).toEqual({ target: 'all', toast: false, voice: false })
  })
})

describe('phrase and language', () => {
  it('speaks Korean when the title or the reply is Korean, else English', () => {
    expect(langFor('Conductor', 'RESULT: done')).toBe('en')
    expect(langFor('개발팀 · 구현', 'done')).toBe('ko')
    expect(langFor('Conductor', '보고서를 썼습니다')).toBe('ko')
    expect(langFor(undefined, undefined)).toBe('en')
  })

  it('is a fixed sentence per kind, never the reply', () => {
    expect(phrase({ kind: 'finished', title: 'Conductor ', lang: 'en' })).toBe('Conductor finished. Please check the report.')
    expect(phrase({ kind: 'finished', title: '총괄', lang: 'ko' })).toBe('총괄 작업이 끝났습니다. 보고를 확인해 주세요.')
    expect(phrase({ kind: 'needs-you', title: 'Reviewer', lang: 'en' })).toBe('Reviewer needs you.')
    expect(phrase({ kind: 'all-done', title: '', lang: 'ko' })).toBe('모든 카드 작업이 끝났습니다.')
    // the renderer re-renders in English when no Korean voice is installed
    expect(phrase({ kind: 'all-done', title: '', lang: 'ko' }, 'en')).toBe('All cards have finished.')
  })
})

describe('announcesStop', () => {
  const on = announceSettings({})
  it('announces conductor turns of 10 s or more by default, not workers', () => {
    expect(announcesStop('conductor', MIN_TURN_MS, on)).toBe(true)
    expect(announcesStop('conductor', MIN_TURN_MS - 1, on)).toBe(false)
    expect(announcesStop('conductor', undefined, on)).toBe(true)
    expect(announcesStop('claude', 60_000, on)).toBe(false)
  })
  it('target=all covers every agent card but never notes, browsers or external sessions', () => {
    const all = announceSettings({ announce: 'all' })
    for (const k of ['claude', 'terminal', 'command', 'conductor'] as const) expect(announcesStop(k, 60_000, all)).toBe(true)
    for (const k of ['note', 'browser', 'external'] as const) expect(announcesStop(k, 60_000, all)).toBe(false)
  })
  it('is silent when off or when both channels are off', () => {
    expect(announcesStop('conductor', 60_000, announceSettings({ announce: 'off' }))).toBe(false)
    expect(announcesStop('conductor', 60_000, announceSettings({ announceToast: false, announceVoice: false }))).toBe(false)
  })
})

describe('firstLine', () => {
  it('takes the first non-empty line without markdown and caps it', () => {
    expect(firstLine('\n\n## **RESULT:** fixed the `date` · SCORE: 9/10\nmore')).toBe('RESULT: fixed the date · SCORE: 9/10')
    expect(firstLine('- item one\n- item two')).toBe('item one')
    expect(firstLine('x'.repeat(200))).toHaveLength(140)
    expect(firstLine('')).toBe('')
  })
})

describe('BoardDone', () => {
  it('fires once after a run of several unannounced turns settles', () => {
    const b = new BoardDone()
    expect(b.settle(false)).toBe(false) // nothing ran
    b.working()
    b.stopped(false)
    expect(b.settle(true)).toBe(false) // another card still working
    b.working()
    b.stopped(false)
    expect(b.settle(false)).toBe(true)
    expect(b.settle(false)).toBe(false) // not twice
  })
  it('stays quiet for a single turn and when the last turn was announced itself', () => {
    const single = new BoardDone()
    single.working()
    single.stopped(false)
    expect(single.settle(false)).toBe(false)
    const announced = new BoardDone()
    announced.working()
    announced.stopped(false)
    announced.stopped(true)
    expect(announced.settle(false)).toBe(false)
  })
})

describe('Burst', () => {
  it('lets one toast through per card per window, cards apart', () => {
    const b = new Burst(5000)
    expect(b.allow('a', 1000)).toBe(true)
    expect(b.allow('a', 4000)).toBe(false)
    expect(b.allow('b', 4000)).toBe(true)
    expect(b.allow('a', 6000)).toBe(true)
    b.forget('a')
    expect(b.allow('a', 6001)).toBe(true)
  })
  it('has a "failed" sentence in both languages', () => {
    expect(phrase({ kind: 'failed', title: 'Reviewer', lang: 'en' })).toBe('Reviewer failed. Please take a look.')
    expect(phrase({ kind: 'failed', title: '리뷰어', lang: 'ko' })).toBe('리뷰어 작업이 실패했습니다. 확인해 주세요.')
  })
})
