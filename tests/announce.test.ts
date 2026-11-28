import { describe, expect, it } from 'vitest'
import { BoardDone, Burst, MIN_TURN_MS, announceSettings, firstLine, langFor, ownerMarker, phrase, stopAnnouncement, type AnnounceKind } from '@shared/announce'
import { SPEECH_PIECE_MAX, speechPieces } from '@shared/tts'

const KINDS: AnnounceKind[] = ['finished', 'decision', 'report', 'needs-you', 'failed', 'all-done']
const FAMILY = '👨‍👩‍👧‍👦'

describe('announce settings', () => {
  it('defaults to conductor replies, decisions and reports only, toast and voice on', () => {
    expect(announceSettings({})).toEqual({ target: 'conductor', toast: true, voice: true, mode: 'important', readAloud: true })
    expect(announceSettings({ announce: 'all', announceToast: false, announceVoice: false, announceMode: 'every', announceReadAloud: false })).toEqual({ target: 'all', toast: false, voice: false, mode: 'every', readAloud: false })
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
    expect(phrase({ kind: 'decision', title: '총괄', lang: 'ko' })).toBe('총괄: 결정이 필요합니다.')
    expect(phrase({ kind: 'report', title: 'Conductor', lang: 'en' })).toBe('Conductor: a report is ready.')
    expect(phrase({ kind: 'all-done', title: '', lang: 'ko' })).toBe('모든 카드 작업이 끝났습니다.')
    // the renderer re-renders in English when no Korean voice is installed
    expect(phrase({ kind: 'all-done', title: '', lang: 'ko' }, 'en')).toBe('All cards have finished.')
  })

  it('a card title of ordinary length is said whole, and every kind is one request', () => {
    const title = 'Marketing landing page copy reviewer (EN)'
    for (const kind of KINDS.filter((k) => k !== 'all-done'))
      for (const lang of ['en', 'ko'] as const) {
        const said = phrase({ kind, title, lang })
        expect(said, `${kind} ${lang}`).toContain(title)
        expect(speechPieces(said), `${kind} ${lang}`).toEqual([said])
      }
  })

  it('a runaway card title (5000 characters, no length limit on cards) gives one short announcement', () => {
    const words = 'Marketing landing page copy reviewer for the spring campaign '.repeat(90).trim()
    const titles = [words, 'x'.repeat(5000), FAMILY.repeat(500), '마케팅 랜딩 페이지 카피 검토 '.repeat(300).trim()]
    for (const title of titles) {
      expect(title.length).toBeGreaterThan(4000)
      for (const kind of KINDS)
        for (const lang of ['en', 'ko'] as const) {
          const said = phrase({ kind, title, lang })
          const what = `${kind} ${lang} ${title.slice(0, 12)}`
          expect(said.length, what).toBeLessThanOrEqual(SPEECH_PIECE_MAX)
          expect(speechPieces(said), what).toEqual([said])
          // the fixed sentence is all there; the title is cut, marked, and starts as it did
          expect(said.endsWith(phrase({ kind, title: '', lang }).trim().replace(/^:\s*/, '')), what).toBe(true)
          if (kind !== 'all-done') {
            expect(said.startsWith(title.slice(0, 10)), what).toBe(true)
            expect(said, what).toContain('…')
          }
        }
    }
    // never half an emoji: the title part is whole families
    const fam = phrase({ kind: 'decision', title: FAMILY.repeat(500), lang: 'en' })
    expect(fam.slice(0, fam.indexOf('…')).replaceAll(FAMILY, '')).toBe('')
  })
})

describe('ownerMarker', () => {
  it('reads the owner line at the end of a reply', () => {
    expect(ownerMarker('Plan done.\n\nOWNER: DECIDE — ship 0.9.1 now or wait for #23?')).toEqual({ kind: 'decision', line: 'ship 0.9.1 now or wait for #23?' })
    expect(ownerMarker('Summary…\r\n**OWNER: REPORT** - brief published\r\n')).toEqual({ kind: 'report', line: 'brief published' })
    expect(ownerMarker('- OWNER: decision: pick a name')).toEqual({ kind: 'decision', line: 'pick a name' })
    expect(ownerMarker('OWNER: DECIDE — x\n\n---\n\n이상입니다.')).toEqual({ kind: 'decision', line: 'x' })
    for (const l of ['**OWNER:** DECIDE — x', '**OWNER**: DECIDE — x', '1. OWNER: DECIDE — x', '• OWNER: DECIDE — x', '## OWNER: DECIDE — x', 'OWNER：DECIDE — x'])
      expect(ownerMarker(`done\n${l}`)).toEqual({ kind: 'decision', line: 'x' })
  })
  it('ignores an owner line buried in the middle of a reply, and look-alikes', () => {
    expect(ownerMarker('Worker said:\nOWNER: DECIDE — x\na\nb\nc\nd')).toBeUndefined()
    expect(ownerMarker('The OWNER: DECIDE line is for gates.')).toBeUndefined()
    expect(ownerMarker('OWNER: REPORTED nothing')).toBeUndefined()
    expect(ownerMarker('')).toBeUndefined()
  })
})

describe('stopAnnouncement', () => {
  const on = announceSettings({})
  const plain = { reply: 'Working on it: 3 cards started.', reportLink: false, askedApproval: false }
  it('stays silent on a progress reply, however long the turn', () => {
    expect(stopAnnouncement('conductor', 600_000, on, plain)).toBeNull()
    expect(stopAnnouncement('conductor', undefined, on, plain)).toBeNull()
  })
  it('announces a decision before a report, regardless of turn length', () => {
    expect(stopAnnouncement('conductor', 1_000, on, { ...plain, reply: 'x\nOWNER: DECIDE — merge?' })).toBe('decision')
    expect(stopAnnouncement('conductor', 1_000, on, { ...plain, askedApproval: true, reportLink: true })).toBe('decision')
    expect(stopAnnouncement('conductor', 1_000, on, { ...plain, reply: 'x\nOWNER: REPORT — done' })).toBe('report')
    expect(stopAnnouncement('conductor', 1_000, on, { ...plain, reportLink: true })).toBe('report')
  })
  it('only the conductor by default; target=all covers agent cards but never notes, browsers or external sessions', () => {
    const ask = { ...plain, askedApproval: true }
    expect(stopAnnouncement('claude', 60_000, on, ask)).toBeNull()
    const all = announceSettings({ announce: 'all' })
    for (const k of ['claude', 'terminal', 'command', 'conductor'] as const) expect(stopAnnouncement(k, 60_000, all, ask)).toBe('decision')
    for (const k of ['note', 'browser', 'external'] as const) expect(stopAnnouncement(k, 60_000, all, ask)).toBeNull()
  })
  it('is silent when off or when both channels are off', () => {
    const ask = { ...plain, askedApproval: true }
    expect(stopAnnouncement('conductor', 60_000, announceSettings({ announce: 'off' }), ask)).toBeNull()
    expect(stopAnnouncement('conductor', 60_000, announceSettings({ announceToast: false, announceVoice: false }), ask)).toBeNull()
  })
  it('every mode keeps the old rule: any turn of 10 s or more, named by its owner line when it has one', () => {
    const every = announceSettings({ announceMode: 'every' })
    expect(stopAnnouncement('conductor', MIN_TURN_MS, every, plain)).toBe('finished')
    expect(stopAnnouncement('conductor', MIN_TURN_MS - 1, every, plain)).toBeNull()
    expect(stopAnnouncement('conductor', undefined, every, plain)).toBe('finished')
    expect(stopAnnouncement('conductor', MIN_TURN_MS, every, { ...plain, reply: 'OWNER: REPORT — r' })).toBe('report')
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
