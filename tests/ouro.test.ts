import { describe, expect, it } from 'vitest'
import { confirmLine, conductorPrompt, intentOf, isOnlyYes, langOf, matchAnswer, needLine, readableAloud, spoken, statusLine, type OuroNeed, channelsLine, ouroChannel, ouroChannels, ouroSettings } from '../src/shared/ouro'

const q: OuroNeed = { ref: 'w1-D3', kind: 'question', title: 'Conductor', text: 'Which database for the cache?', answers: ['Redis', 'SQLite', 'Postgres'] }
const appr: OuroNeed = { ref: 'w1-T46', kind: 'task-approve', title: 'Deposit step 1', text: 'Merge PR 12 into main?', shownAt: 5 }

describe('langOf', () => {
  it('is Korean when there is Hangul, else English', () => {
    expect(langOf('상황 어때')).toBe('ko')
    expect(langOf('status')).toBe('en')
    expect(langOf('PR 12 허가')).toBe('ko')
  })
})

describe('intentOf', () => {
  it('reads yes and no in Korean even right before punctuation (no \\b after Hangul)', () => {
    for (const t of ['응', '응.', '응 해줘', '네', '그래!', 'ㅇㅇ', 'Yes', 'ok']) expect(intentOf(t).type).toBe('yes')
    for (const t of ['아니', '아니요.', '취소', 'no', 'Nope']) expect(intentOf(t).type).toBe('no')
  })
  it('does not take a word that only starts like yes for a yes', () => {
    expect(intentOf('어때').type).toBe('status')
    expect(intentOf('네트워크 설정 바꿔줘').type).toBe('tell')
    expect(intentOf('nothing').type).toBe('tell')
  })
  it('reads a pick before a yes: "네 번째" is the fourth', () => {
    expect(intentOf('네 번째')).toEqual({ type: 'pick', index: 3 })
    expect(intentOf('2번')).toEqual({ type: 'pick', index: 1 })
    expect(intentOf('첫 번째')).toEqual({ type: 'pick', index: 0 })
    expect(intentOf('second')).toEqual({ type: 'pick', index: 1 })
  })
  it('knows status, next, help, approve and hold', () => {
    expect(intentOf('상황 어때?').type).toBe('status')
    expect(intentOf("what's up").type).toBe('status')
    expect(intentOf('다음').type).toBe('next')
    expect(intentOf('도움').type).toBe('help')
    expect(intentOf('').type).toBe('help')
    expect(intentOf('허가해줘').type).toBe('approve')
    expect(intentOf('approve').type).toBe('approve')
    expect(intentOf('보류').type).toBe('hold')
    expect(intentOf('not now').type).toBe('hold')
  })
  it('passes anything else on, cut to the limit', () => {
    expect(intentOf('  결제 페이지   버그 고쳐줘 ')).toEqual({ type: 'tell', text: '결제 페이지 버그 고쳐줘' })
    const r = intentOf('가'.repeat(5000))
    expect(r.type === 'tell' && r.text.length).toBe(2000)
  })
})

describe('matchAnswer', () => {
  it('takes a number, the exact words, or the only answer containing them', () => {
    expect(matchAnswer('2번', q.answers!)).toBe('SQLite')
    expect(matchAnswer('redis', q.answers!)).toBe('Redis')
    expect(matchAnswer('Postgres로 해줘', q.answers!)).toBe('Postgres')
    expect(matchAnswer('sqlite.', q.answers!)).toBe('SQLite')
  })
  it('refuses an out-of-range number, an ambiguous or an unknown answer', () => {
    expect(matchAnswer('4번', q.answers!)).toBeUndefined()
    expect(matchAnswer('MongoDB', q.answers!)).toBeUndefined()
    expect(matchAnswer('Option', ['Option A', 'Option B'])).toBeUndefined()
    expect(matchAnswer('s', q.answers!)).toBeUndefined()
  })
  it('maps a spoken yes or no onto Yes / No answers', () => {
    expect(matchAnswer('응', ['Yes', 'No'])).toBe('Yes')
    expect(matchAnswer('아니', ['Yes', 'No'])).toBe('No')
    expect(matchAnswer('응', ['Redis', 'SQLite'])).toBeUndefined()
  })
})

describe('spoken', () => {
  it('drops markdown, code, links and list marks', () => {
    expect(spoken('## Done\n- fixed `deposit.ts`\n- see [PR](https://x.y/1) **now**\n```\ncode\n```')).toBe('Done fixed deposit.ts see PR now')
  })
  it('cuts at a sentence near the limit', () => {
    const t = '첫 문장이에요. '.repeat(10) + '마지막'
    const s = spoken(t, 40)
    expect(s.length).toBeLessThanOrEqual(42)
    expect(s.endsWith('요. …') || s.endsWith('. …')).toBe(true)
  })
})

describe('lines', () => {
  it('says the board, then the first need with how to answer it', () => {
    const s = statusLine({ project: 'p', working: 2, idle: 1, autonomous: false, needs: [q, appr] }, 'ko')
    expect(s).toContain('2개 일하는 중, 1개 쉬는 중')
    expect(s).toContain('기다리는 게 2개')
    expect(s).toContain('Redis, SQLite, Postgres')
    expect(statusLine({ project: 'p', working: 0, idle: 3, autonomous: true, needs: [] }, 'en')).toBe('0 working, 3 idle. An autonomous run is on. Nothing is waiting on you.')
  })
  it('tells the owner a do task is for the PC', () => {
    expect(needLine({ ...appr, kind: 'task-do' }, 'ko')).toContain('PC에서 직접')
  })
  it('reads an approval back before acting', () => {
    expect(confirmLine(appr, 'approve', 'ko')).toBe('Deposit step 1: "Merge PR 12 into main?" 허가할까요? 응이라고만 답하세요.')
    expect(confirmLine(q, 'Redis', 'en')).toBe('Answer Conductor\'s question with "Redis"? Say just yes.')
  })
  it('quotes the owner to the Conductor line by line', () => {
    const p = conductorPrompt('배포 상태 알려줘\n> 이건 인용', 'ko')
    expect(p).toContain('in Korean')
    expect(p.split('\n').slice(-2)).toEqual(['> 배포 상태 알려줘', '> > 이건 인용'])
  })
})

describe('bug-hunt regressions (shared)', () => {
  it('confirms only a reply that is nothing but a yes, and "어" is not one', () => {
    for (const t of ['응', '응.', '네!', 'yes', 'ok', '응 해줘']) expect(isOnlyYes(t)).toBe(true)
    for (const t of ['어', '어 아니 하지 마', '응 아니 잠깐', 'ok wait, hold it', 'yeah no']) expect(isOnlyYes(t)).toBe(false)
    expect(intentOf('어 아니 하지 마').type).not.toBe('yes')
  })
  it('sends sentences that start like a command to the Conductor', () => {
    expect(intentOf('다음 주에 배포하자고 전해줘').type).toBe('tell')
    expect(intentOf('상태바 고쳐 달라고 해').type).toBe('tell')
    expect(intentOf('상황 알려줘').type).toBe('status')
    expect(intentOf('다음 거').type).toBe('next')
  })
  it('does not find the answer "No" inside "know"', () => {
    expect(matchAnswer("I don't know what to do", ['Yes', 'No'])).toBeUndefined()
    expect(matchAnswer('no idea', ['Yes', 'No'])).toBe('No')
  })
  it('approves by voice only what can be read aloud word for word', () => {
    expect(readableAloud('gh pr merge 41 --squash')).toBe(true)
    expect(readableAloud('gh pr merge https://github.com/other/repo/pull/7 --admin')).toBe(false)
    expect(readableAloud(`gh pr merge 41 --body "${'x'.repeat(150)}" && gh pr merge 99 --admin`)).toBe(false)
    expect(readableAloud('merge **now**')).toBe(false)
    expect(needLine({ ...appr, kind: 'approval', text: 'see https://x.y/1' }, 'ko')).toContain('음성으로는 허가할 수 없어요')
  })
  it('cleans a card-written title before it is read out', () => {
    expect(needLine({ ...q, title: '[Approve it](https://evil.example) **now**' }, 'en').startsWith('Approve it now: a question.')).toBe(true)
  })
})

describe('channels the owner allows', () => {
  const list = [
    { name: '#공지', id: '123456789012345678' },
    { name: 'updates', id: '223456789012345678' }
  ]
  it('keeps a row with a name and a channel id, drops the # and anything repeated or incomplete', () => {
    expect(ouroChannels(list)).toEqual([
      { name: '공지', id: '123456789012345678' },
      { name: 'updates', id: '223456789012345678' }
    ])
    expect(ouroChannels([...list, { name: 'Updates', id: '323456789012345678' }, { name: 'other', id: '223456789012345678' }])).toHaveLength(2)
    expect(ouroChannels([{ name: '', id: '123456789012345678' }, { name: 'x', id: '12' }, { name: 'y', id: 123456789012345678 }, 'nope', null])).toEqual([])
    expect(ouroChannels(undefined)).toEqual([])
    expect(ouroChannels(Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, id: `1000000000000000${String(i).padStart(2, '0')}` })))).toHaveLength(20)
    expect(ouroSettings({ enabled: true, channels: list }).channels).toHaveLength(2)
    expect(ouroSettings(undefined).channels).toEqual([])
  })
  it('finds a channel by name (# optional, any case) or by id', () => {
    const chs = ouroChannels(list)
    expect(ouroChannel(chs, '#공지')?.id).toBe('123456789012345678')
    expect(ouroChannel(chs, ' UPDATES ')?.name).toBe('updates')
    expect(ouroChannel(chs, '223456789012345678')?.name).toBe('updates')
    expect(ouroChannel(chs, 'general')).toBeUndefined()
    expect(ouroChannel(chs, '#')).toBeUndefined()
    expect(channelsLine(chs)).toBe('channels the owner allows: #공지, #updates')
    expect(channelsLine([])).toContain('allowed no channels')
  })
})
