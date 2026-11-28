import { describe, expect, it } from 'vitest'
import { phrase, readAloudText } from '@shared/announce'
import { MAX_TTS_CHARS, SPEECH_PIECE_MAX, speakPieces, speechPieces } from '@shared/tts'

/** The words of a text in order: a piece that ends inside a word shows up as a word the text does not have. */
const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** What every split must keep: pieces in order, none empty or over the limit, every character of the text said once. */
function expectWhole(text: string, pieces: string[]): void {
  for (const p of pieces) {
    expect(p.length, p).toBeGreaterThan(0)
    expect(p.length, p).toBeLessThanOrEqual(SPEECH_PIECE_MAX)
    expect(p, p).toBe(p.trim())
    expect(loneSurrogate.test(p), p).toBe(false)
  }
  expect(words(pieces.join(' '))).toEqual(words(text))
  // only whitespace between pieces may go
  expect(pieces.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
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

  it('an ordinary announcement is one request, never cut after the card title', () => {
    const decision = phrase({ kind: 'decision', title: 'Marketing landing page copy reviewer (EN)', lang: 'en' })
    expect(decision.length).toBe(62)
    expect(speechPieces(decision)).toEqual([decision])
    const finished = phrase({ kind: 'finished', title: 'Marketing landing page copy reviewer (EN)', lang: 'en' })
    expect(speechPieces(finished)).toEqual([finished])
  })

  it('in a long text, a sentence a little longer than the old 60-character piece stays whole', () => {
    const sentence = '📹 레인이 녹화로 정답과 대조하고, 자동 비우기가 사이트에서 실제로 무엇을 했는지 읽기 전용 조회로 확인해요.'
    const next = '노트북 Claude 메모: «Court Watch 클라우드 세션» 은 제 쪽에서 안 보여요.'
    expect(sentence.length).toBeGreaterThan(60)
    expect(speechPieces(`${sentence}\n${next}`)).toEqual([sentence, next])
  })

  it('breaks Korean at sentence ends, keeps decimals and versions whole, and a lone "네." joins its neighbour', () => {
    const text = '디자인 카드가 착샷 63장을 모두 끝냈습니다. 검수 시간은 1.5배 줄었고, v0.20.8 기준으로 회귀 테스트 1009개가 모두 통과했습니다. 네. 마케팅 보고서 초안도 올라왔어요… 어느 쪽?'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX)
    const pieces = speechPieces(text)
    expect(pieces).toEqual(['디자인 카드가 착샷 63장을 모두 끝냈습니다.', '검수 시간은 1.5배 줄었고, v0.20.8 기준으로 회귀 테스트 1009개가 모두 통과했습니다.', '네. 마케팅 보고서 초안도 올라왔어요… 어느 쪽?'])
    expectWhole(text, pieces)
  })

  it('a short last sentence that has no room beside the one before is still said, as its own piece', () => {
    // as long as a piece may be, give or take a word: " OK?" does not fit beside it
    const long = 'word '.repeat(Math.floor((SPEECH_PIECE_MAX - 4) / 5)) + 'end.'
    expect(speechPieces(`${long} OK?`)).toEqual([long, 'OK?'])
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
    const text = '오늘 할 일은 서버 로그를 정리하고, 경고 메시지를 줄이고, 배포 스크립트의 오래된 경로를 고치고, 테스트 데이터베이스의 잠금 순서를 다시 확인하고, 마케팅 보고서의 수치 다섯 개를 원본과 대조하고, 디자인 팀이 보낸 착샷 예순세 장의 색감을 하나씩 검수하고, 고객 문의 메일 열두 통에 답장을 쓰고, 다음 주 회의 일정을 팀원들과 맞추고, 마지막으로 릴리스 노트를 영어와 한국어로 정리하는 것입니다.'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX * 2)
    const pieces = speechPieces(text)
    expectWhole(text, pieces)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces.slice(0, -1)) expect(p.endsWith(','), p).toBe(true)
  })

  it('a sentence a little over a piece is cut with a sentence’s worth on each side, so its verb never goes off alone or into the next sentence', () => {
    // from a real read-aloud, made longer than a piece: filled to the limit, it left "확인해요." for the start of the next sentence
    const withComma = '📹 레인이 녹화로 정답과 대조하고, 자동 비우기가 사이트에서 실제로 무엇을 했는지 읽기 전용 조회와 서버 로그 두 가지로 모두 꼼꼼하게 확인해요.'
    const next = '노트북 Claude 메모: «Court Watch 클라우드 세션» 은 제 쪽에서 안 보여요.'
    expect(withComma.length).toBeGreaterThan(SPEECH_PIECE_MAX)
    const cut = speechPieces(`${withComma}\n${next}`)
    expectWhole(`${withComma} ${next}`, cut)
    expect(cut).toEqual(['📹 레인이 녹화로 정답과 대조하고,', '자동 비우기가 사이트에서 실제로 무엇을 했는지 읽기 전용 조회와 서버 로그 두 가지로 모두 꼼꼼하게 확인해요.', next])
    const noComma = withComma.replace(',', '')
    const even = speechPieces(`${noComma} ${next}`)
    expectWhole(`${noComma} ${next}`, even)
    expect(even.some((p) => p.endsWith('꼼꼼하게 확인해요.') && p.length > 20)).toBe(true)
    expect(even.every((p) => !p.startsWith('확인해요'))).toBe(true)
  })

  it('a sentence longer than a piece with no comma breaks at a space', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') + '.'
    expect(text.length).toBeGreaterThan(SPEECH_PIECE_MAX * 2)
    const pieces = speechPieces(text)
    expectWhole(text, pieces)
    expect(pieces.length).toBeGreaterThan(2)
    // the only space leaves a short side: still better than cutting inside a word
    const lopsided = 'abc ' + 'x'.repeat(SPEECH_PIECE_MAX - 3) + '.'
    expectWhole(lopsided, speechPieces(lopsided))
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

  it('a cut inside a word never splits an emoji joined from several (ZWJ)', () => {
    // 11 code units: 👨 ZWJ 👩 ZWJ 👧 ZWJ 👦. After the leading "a", a plain cut at 15 falls between a joiner and 👩,
    // and one at the real piece size on a joiner
    const family = '👨‍👩‍👧‍👦'
    for (const [text, max] of [
      ['a' + family.repeat(10), 15],
      ['a' + family.repeat(30), SPEECH_PIECE_MAX]
    ] as const) {
      const pieces = speechPieces(text, max)
      expect(pieces.join('')).toBe(text)
      for (const p of pieces) {
        expect(p.length, p).toBeLessThanOrEqual(max)
        expect(p.replace(/^a/, '').replaceAll(family, ''), p).toBe('')
      }
    }
  })

  it('a tiny or broken max still ends, loses nothing and keeps every character whole', () => {
    const text = 'hello world, 🎉 party 👨‍👩‍👧‍👦 done.'
    const chars = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((g) => g.segment))
    for (const max of [0, -3, 0.5, 1, 2, Number.NaN]) {
      const pieces = speechPieces(text, max)
      expect(pieces.join('').replace(/\s+/g, ''), String(max)).toBe(text.replace(/\s+/g, ''))
      for (const p of pieces) for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(p)) expect(chars.has(segment), `${max}: ${p}`).toBe(true)
    }
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
/** Lets every promise that can settle now settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A voice engine and a speaker driven by hand: each request and each clip finishes when the test says so. */
function rig() {
  const asked: string[] = []
  const played: string[] = []
  const fellBack: number[] = []
  const requests = new Map<string, Deferred<string>>()
  const clips = new Map<string, Deferred<void>>()
  let open = 0
  let mostOpen = 0
  const voice = {
    make: (text: string): Promise<string> => {
      asked.push(text)
      open++
      mostOpen = Math.max(mostOpen, open)
      const d = deferred<string>()
      requests.set(text, d)
      return d.promise.finally(() => open--)
    },
    play: (clip: string): Promise<void> => {
      played.push(clip)
      const d = deferred<void>()
      clips.set(clip, d)
      return d.promise
    },
    fallback: async (from: number): Promise<void> => {
      fellBack.push(from)
    }
  }
  return { voice, asked, played, fellBack, request: (t: string) => requests.get(t)!, clip: (c: string) => clips.get(c)!, mostOpen: () => mostOpen }
}

describe('speakPieces: a long text said piece by piece', () => {
  it('plays the pieces in order, making the next one while one plays, never two requests at once', async () => {
    const r = rig()
    let done = false
    const said = speakPieces(['one', 'two', 'three'], r.voice).then((x) => {
      done = true
      return x
    })
    await settle()
    expect(r.asked).toEqual(['one'])
    r.request('one').resolve('ONE')
    await settle()
    // the second piece is asked for as soon as the first is ready, while it plays
    expect(r.played).toEqual(['ONE'])
    expect(r.asked).toEqual(['one', 'two'])
    r.request('two').resolve('TWO')
    await settle()
    // the second is ready but the first still plays: nothing more is asked for yet
    expect(r.asked).toEqual(['one', 'two'])
    expect(r.played).toEqual(['ONE'])
    r.clip('ONE').resolve()
    await settle()
    expect(r.played).toEqual(['ONE', 'TWO'])
    expect(r.asked).toEqual(['one', 'two', 'three'])
    // the first clip ended before the next was ready: it plays when it is
    r.clip('TWO').resolve()
    await settle()
    expect(r.played).toEqual(['ONE', 'TWO'])
    r.request('three').resolve('THREE')
    await settle()
    expect(r.played).toEqual(['ONE', 'TWO', 'THREE'])
    // whoever waits on this text (the next announcement) waits for the last piece to be heard
    expect(done).toBe(false)
    r.clip('THREE').resolve()
    expect(await said).toEqual({})
    expect(r.mostOpen()).toBe(1)
    expect(r.fellBack).toEqual([])
  })

  it('a piece the engine fails is said another way with every piece after it, and the error is told once', async () => {
    const asked: string[] = []
    const played: string[] = []
    const fellBack: number[] = []
    const result = await speakPieces(['one', 'two', 'three'], {
      make: async (t) => {
        asked.push(t)
        if (t === 'two') throw new Error('Voicebox: not finished within 120 s')
        return t.toUpperCase()
      },
      play: async (c) => {
        played.push(c)
      },
      fallback: async (from) => {
        fellBack.push(from)
      }
    })
    expect(played).toEqual(['ONE'])
    expect(fellBack).toEqual([1])
    expect(asked).toEqual(['one', 'two'])
    expect(result).toEqual({ error: 'Voicebox: not finished within 120 s' })
  })

  it('a clip that will not play is said another way from there on, and the request already sent is waited out first', async () => {
    const r = rig()
    let done = false
    const said = speakPieces(['one', 'two', 'three'], r.voice).then((x) => {
      done = true
      return x
    })
    await settle()
    r.request('one').resolve('ONE')
    await settle()
    r.request('two').resolve('TWO')
    r.clip('ONE').resolve()
    await settle()
    // "three" is being made while "two" plays; then "two" fails to play
    expect(r.asked).toEqual(['one', 'two', 'three'])
    r.clip('TWO').reject(new Error('audio playback stalled'))
    await settle()
    expect(r.fellBack).toEqual([1])
    // the engine is still making "three": the next text must not ask it for another clip meanwhile
    expect(done).toBe(false)
    r.request('three').resolve('THREE')
    expect(await said).toEqual({ error: 'audio playback stalled' })
    expect(r.played).toEqual(['ONE', 'TWO'])
  })

  it('a text of one piece is one request, and a first piece that fails hands the whole text over', async () => {
    const asked: string[] = []
    const played: string[] = []
    const ok = await speakPieces(['총괄 작업이 끝났습니다. 보고를 확인해 주세요.'], {
      make: async (t) => {
        asked.push(t)
        return t
      },
      play: async (c) => {
        played.push(c)
      },
      fallback: async () => {
        throw new Error('not expected')
      }
    })
    expect(ok).toEqual({})
    expect(asked).toEqual(['총괄 작업이 끝났습니다. 보고를 확인해 주세요.'])
    expect(played).toEqual(['총괄 작업이 끝났습니다. 보고를 확인해 주세요.'])

    const fellBack: number[] = []
    const failed = await speakPieces(['one', 'two'], {
      make: async () => {
        throw new Error('No gemini key saved in Settings')
      },
      play: async () => {},
      fallback: async (from) => {
        fellBack.push(from)
      }
    })
    expect(fellBack).toEqual([0])
    expect(failed).toEqual({ error: 'No gemini key saved in Settings' })
  })

  it('a make that throws at once is a piece that failed, never a rejected call', async () => {
    const played: string[] = []
    const fellBack: number[] = []
    const voice = (failOn: string) => ({
      make: (t: string): Promise<string> => {
        if (t === failOn) throw new Error('synthesize is not a function')
        return Promise.resolve(t.toUpperCase())
      },
      play: async (c: string): Promise<void> => {
        played.push(c)
      },
      fallback: async (from: number): Promise<void> => {
        fellBack.push(from)
      }
    })
    await expect(speakPieces(['one', 'two'], voice('one'))).resolves.toEqual({ error: 'synthesize is not a function' })
    expect(played).toEqual([])
    expect(fellBack).toEqual([0])
    // on a later piece: the one before it is still heard, then the rest goes the other way
    played.length = 0
    fellBack.length = 0
    await expect(speakPieces(['one', 'two', 'three'], voice('two'))).resolves.toEqual({ error: 'synthesize is not a function' })
    expect(played).toEqual(['ONE'])
    expect(fellBack).toEqual([1])
  })

  it('nothing to say asks for nothing', async () => {
    const r = rig()
    expect(await speakPieces([], r.voice)).toEqual({})
    expect(r.asked).toEqual([])
    expect(r.fellBack).toEqual([])
  })
})
