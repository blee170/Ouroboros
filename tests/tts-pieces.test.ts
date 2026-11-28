import { describe, expect, it } from 'vitest'
import { readAloudText } from '@shared/announce'
import { MAX_TTS_CHARS, SPEECH_PIECE_MAX, speechPieces } from '@shared/tts'

/** The words of a text in order: a piece that ends inside a word shows up as a word the text does not have. */
const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** What every split must keep: pieces in order, none empty or over the limit, every word of the text said once. */
function expectWhole(text: string, pieces: string[]): void {
  for (const p of pieces) {
    expect(p.length, p).toBeGreaterThan(0)
    expect(p.length, p).toBeLessThanOrEqual(SPEECH_PIECE_MAX)
    expect(p, p).toBe(p.trim())
    expect(loneSurrogate.test(p), p).toBe(false)
  }
  expect(words(pieces.join(' '))).toEqual(words(text))
}

describe('speechPieces: long text in sentence pieces', () => {
  it('a piece is short enough for one request', () => {
    expect(SPEECH_PIECE_MAX).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })

  it('a text that fits in one piece is one piece, as it is today', () => {
    expect(speechPieces('총괄 작업이 끝났습니다. 보고를 확인해 주세요.')).toEqual(['총괄 작업이 끝났습니다. 보고를 확인해 주세요.'])
    expect(speechPieces('  Conductor needs your decision.  ')).toEqual(['Conductor needs your decision.'])
    expect(speechPieces('   ')).toEqual([])
  })

  it('breaks Korean at sentence ends, keeps decimals and versions whole, and a lone "네." joins its neighbour', () => {
    const text = '디자인 카드가 착샷 63장을 모두 끝냈습니다. 검수 시간은 1.5배 줄었고, v0.20.8 기준으로 회귀 테스트 1009개가 모두 통과했습니다. 네. 마케팅 보고서 초안도 올라왔어요… 어느 쪽?'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX)
    const pieces = speechPieces(text)
    expect(pieces).toEqual(['디자인 카드가 착샷 63장을 모두 끝냈습니다.', '검수 시간은 1.5배 줄었고, v0.20.8 기준으로 회귀 테스트 1009개가 모두 통과했습니다.', '네. 마케팅 보고서 초안도 올라왔어요… 어느 쪽?'])
    expectWhole(text, pieces)
  })

  it('breaks English at sentence ends and keeps ellipsis runs, decimals and versions with their sentence', () => {
    const text = 'Design finished all 63 shots. QA got 1.5 times faster, and nothing regressed on v0.20.8! The release notes are ready... but the changelog still says 0.20.7. Ship crimson now, or keep cyan until Friday?'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX)
    const pieces = speechPieces(text)
    expectWhole(text, pieces)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.some((p) => p.includes('1.5 times'))).toBe(true)
    expect(pieces.some((p) => p.includes('v0.20.8!'))).toBe(true)
    expect(pieces.some((p) => p.includes('ready... but'))).toBe(true)
    expect(pieces.some((p) => p.includes('0.20.7.'))).toBe(true)
    expect(pieces.every((p) => !/^[.…!?]/.test(p))).toBe(true)
    expect(pieces.at(-1)?.endsWith('until Friday?')).toBe(true)
  })

  it('a 600-character read-aloud reaches speech whole: the lead-in joins the next sentence and the question is the last piece', () => {
    // older lines first: readAloudText keeps whole lines from the end, so these are the ones it drops
    const older = Array.from({ length: 10 }, (_, i) => `어제 작업 기록 ${i + 1}번: 서버 로그를 정리하고 경고 메시지를 줄였습니다.`)
    const reply = [
      ...older,
      '디자인 카드가 착샷 63장을 모두 끝냈습니다. 검수 시간은 1.5배 줄었어요.',
      'Builder는 v0.20.8 기준으로 회귀 테스트 1009개를 통과했습니다 🎉',
      '마케팅 보고서 초안도 올라왔어요… 다만 수치 몇 개는 다시 확인이 필요합니다.',
      '네.',
      'The release notes are ready... but the changelog still says 0.20.7.',
      '- A안: 크림슨 색으로 지금 출시하고, 틀린 수치는 다음 주에 고칩니다.',
      '- B안: 시안 색을 유지하고, 수치를 고친 뒤 금요일에 출시합니다.',
      '**OWNER: DECIDE** — A안으로 갈까요, B안으로 갈까요?'
    ].join('\n')
    const text = readAloudText(reply, 'ko')
    expect(text.startsWith('앞부분은 화면에 있어요. ')).toBe(true)
    expect(text.length).toBeGreaterThan(500)
    for (const kept of ['1.5배', 'v0.20.8', '🎉', '올라왔어요…', '\n네.\n', 'ready... but', '0.20.7.']) expect(text, kept).toContain(kept)
    const pieces = speechPieces(text)
    expectWhole(text, pieces)
    expect(pieces[0].startsWith('앞부분은 화면에 있어요.')).toBe(true)
    expect(pieces[0]).not.toBe('앞부분은 화면에 있어요.')
    expect(pieces).not.toContain('네.')
    expect(pieces.at(-1)?.endsWith('A안으로 갈까요, B안으로 갈까요?')).toBe(true)
    for (const kept of ['1.5배', 'v0.20.8', '🎉', 'ready... but', '0.20.7.']) expect(pieces.some((p) => p.includes(kept)), kept).toBe(true)
  })

  it('breaks at line breaks when a line has no end mark', () => {
    const text = 'Line one has no stop at the end\nLine two has none either but it goes on a while\nLine three is the last one and it is long too'
    expect(speechPieces(text)).toEqual(['Line one has no stop at the end', 'Line two has none either but it goes on a while', 'Line three is the last one and it is long too'])
  })

  it('breaks at a CJK full stop with no space after it', () => {
    const text = '今日はサーバーのログを整理して警告メッセージを減らしました。明日はデプロイスクリプトの古いパスを直して確認します。そのあとでテストデータベースのロック順序をもう一度見直します。最後にリリースノートを英語と韓国語で書きます。'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX)
    const pieces = speechPieces(text)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => p.endsWith('。'))).toBe(true)
    expect(pieces.join('')).toBe(text)
  })

  it('a sentence longer than a piece breaks at a comma, never inside a word', () => {
    const text = '오늘 할 일은 서버 로그를 정리하고, 경고 메시지를 줄이고, 배포 스크립트의 오래된 경로를 고치고, 테스트 데이터베이스의 잠금 순서를 다시 확인하고, 마케팅 보고서의 수치 다섯 개를 원본과 대조하고, 디자인 팀이 보낸 착샷 예순세 장의 색감을 하나씩 검수하고, 마지막으로 릴리스 노트를 영어와 한국어로 정리하는 것입니다.'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX * 2)
    const pieces = speechPieces(text)
    expectWhole(text, pieces)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces.slice(0, -1)) expect(p.endsWith(','), p).toBe(true)
  })

  it('a sentence longer than a piece with no comma breaks at a space', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') + '.'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX * 2)
    const pieces = speechPieces(text)
    expectWhole(text, pieces)
    expect(pieces.length).toBeGreaterThan(2)
  })

  it('one word longer than a piece is cut, losing nothing and never splitting an emoji', () => {
    const long = 'x'.repeat(250)
    const pieces = speechPieces(long)
    expect(pieces.join('')).toBe(long)
    expect(pieces.every((p) => p.length <= SPEECH_PIECE_MAX)).toBe(true)
    // the odd 'a' puts a second half of an emoji exactly where a plain cut would fall
    const party = 'a' + '🎉'.repeat(80)
    const cut = speechPieces(party)
    expect(cut.join('')).toBe(party)
    expect(cut.every((p) => p.length <= SPEECH_PIECE_MAX && !loneSurrogate.test(p))).toBe(true)
  })
})
