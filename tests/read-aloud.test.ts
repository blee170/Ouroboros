import { describe, expect, it } from 'vitest'
import { READ_ALOUD_MAX, readAloudLine, readAloudText, yesNo } from '@shared/announce'

describe('what a decision read-out says', () => {
  it('keeps the question and its options, drops the label, markdown, code and links', () => {
    const reply = [
      '## Status',
      'Design finished the 63 shots.',
      '```ts',
      'const secret = 1',
      '```',
      'See [the brief](https://example.com/brief) and https://x.test/a.',
      '- **A**: ship crimson',
      '- **B**: keep cyan',
      '**OWNER: DECIDE** — A or B?'
    ].join('\n')
    const t = readAloudText(reply, 'en')
    expect(t).toContain('A: ship crimson')
    expect(t).toContain('B: keep cyan')
    expect(t.endsWith('A or B?')).toBe(true)
    expect(t).toContain('See the brief and link')
    expect(t).not.toMatch(/OWNER|DECIDE|secret|https|\*\*|##/)
    expect(readAloudText('결정: https://a.b 참고', 'ko')).toBe('결정: 링크 참고')
  })

  it('a long reply keeps whole lines from the end and says the start is on screen', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Line number ${i} with some words in it.`)
    lines.push('OWNER: DECIDE — go ahead?')
    const t = readAloudText(lines.join('\n'), 'en')
    expect(t.startsWith('The start is on screen. ')).toBe(true)
    expect(t.endsWith('go ahead?')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(READ_ALOUD_MAX + 30)
    expect(t).not.toContain('Line number 0 ')
    // one line longer than the limit keeps its end
    const one = readAloudText('x'.repeat(2000) + ' end?', 'ko')
    expect(one.endsWith('end?')).toBe(true)
    expect(one.startsWith('앞부분은 화면에 있어요. …')).toBe(true)
    expect(one.length).toBeLessThanOrEqual(READ_ALOUD_MAX + 30)
    expect(readAloudText('```\nonly code\n```', 'en')).toBe('')
  })
})

describe('a spoken yes or no', () => {
  it('hears yes in Korean and English', () => {
    for (const s of ['응', '네', '네.', '예 읽어주세요', '응 읽어줘', '그래', '좋아요', '보내', '오케이', 'Yes', 'yeah sure', 'OK.', 'read it', 'Go ahead!']) expect(yesNo(s), s).toBe('yes')
  })
  it('hears no first, even with a yes word in it', () => {
    for (const s of ['아니', '아니요', '아뇨 괜찮아요', '됐어', '나중에', '읽지 마', '보내지 마', '취소', 'No', 'nope', "no, don't read it", 'not now', 'later']) expect(yesNo(s), s).toBe('no')
  })
  it('anything else is neither: nothing is read or sent', () => {
    for (const s of ['', '   ', '어떻게 된 거야', '네가 해', '음', 'what was that', 'the weather']) expect(yesNo(s), s).toBeUndefined()
  })
  it('never takes a sentence with a yes word in it, a filler, a question or the app itself for a yes', () => {
    // another card's announcement, the exchange's own question, a Whisper silence hallucination
    for (const s of ['Builder finished. Please check the report.', 'Builder failed. Please take a look.', 'Shall I read it to you?', '내용을 읽어드릴까요?', '시청해주셔서 감사합니다. 구독과 좋아요 부탁드립니다.', '어', '그래?', "I'm not sure", 'yes, but change the colour first'])
      expect(yesNo(s), s).not.toBe('yes')
    for (const s of ['안 보내', '안 읽어도 돼', '안 좋아', '어 잠깐만', 'please wait']) expect(yesNo(s), s).toBe('no')
  })
})

describe('the read-aloud sentences', () => {
  it('reads the answer back before sending, in the card language', () => {
    expect(readAloudLine('offer', 'ko')).toBe('내용을 읽어드릴까요?')
    expect(readAloudLine('confirm', 'ko', 'A로 가자')).toBe('"A로 가자" 이렇게 보낼까요?')
    expect(readAloudLine('confirm', 'en', 'go with A')).toBe('Send "go with A"?')
    expect(readAloudLine('gone', 'en', 'Design')).toBe('Design is gone; not sent.')
    expect(readAloudLine('busy', 'en', 'Design')).toContain('not sent')
  })

  it('a runaway card title is cut in the gone and busy lines, the spoken answer never', () => {
    const title = 'Marketing landing page copy reviewer for the spring campaign '.repeat(90).trim()
    for (const step of ['gone', 'busy'] as const)
      for (const lang of ['en', 'ko'] as const) {
        const line = readAloudLine(step, lang, title)
        expect(line.length, `${step} ${lang}`).toBeLessThan(140)
        expect(line.startsWith('Marketing landing page'), `${step} ${lang}`).toBe(true)
        expect(line, `${step} ${lang}`).toContain('…')
      }
    const answer = '크림슨으로 가되 '.repeat(40).trim()
    expect(readAloudLine('confirm', 'ko', answer)).toBe(`"${answer}" 이렇게 보낼까요?`)
  })
})
