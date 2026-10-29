import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE, MAX_WAKE_PHRASE, addWakeSpelling, isNonSpeech, matchWake, normalizeSpeech, sttFields, sttText, validAccelerator, voiceSettings, wakePhrases, wavFromFloat32 } from '../src/shared/voice'

describe('wake phrase', () => {
  it('matches the phrase at the start, with what followed as the prompt', () => {
    expect(matchWake('Ouroboros, run the tests.', 'Ouroboros')).toEqual({ matched: true, rest: 'run the tests.' })
    expect(matchWake('Hey Ouroboros!', 'Ouroboros')).toEqual({ matched: true, rest: '' })
    expect(matchWake('Uroboros what is left', 'Ouroboros')).toEqual({ matched: true, rest: 'what is left' })
    expect(matchWake('우로보로스, 테스트 돌려줘', '우로보로스')).toEqual({ matched: true, rest: '테스트 돌려줘' })
    expect(matchWake('우르보로스 상태 알려줘', '우로보로스')).toEqual({ matched: true, rest: '상태 알려줘' })
    expect(matchWake('야 치프야 이거 봐줘', '치프야')).toEqual({ matched: true, rest: '이거 봐줘' })
    expect(matchWake('Hey Chief, merge it', 'hey chief')).toEqual({ matched: true, rest: 'merge it' })
  })
  it('does not fire on ordinary speech or a phrase mid-sentence', () => {
    expect(matchWake('I was reading about ouroboros yesterday', 'Ouroboros').matched).toBe(false)
    expect(matchWake('오늘 날씨 어때', '우로보로스').matched).toBe(false)
    expect(matchWake('Our robots', 'Ouroboros').matched).toBe(false)
    expect(matchWake('', 'Ouroboros').matched).toBe(false)
    expect(matchWake('anything', '  ').matched).toBe(false)
  })
  it('takes other spellings after commas, as whisper writes "hey ouro" (measured on the owner’s whisper server)', () => {
    const phrase = 'hey ouro'
    expect(matchWake('Hey Aro, run the tests', phrase).matched).toBe(false)
    expect(matchWake('헤이 우로', phrase).matched).toBe(false)
    const more = 'hey ouro, Hey Aro, 헤이 우로'
    expect(wakePhrases(more)).toEqual(['hey ouro', 'Hey Aro', '헤이 우로'])
    expect(matchWake('Hey Aro, run the tests', more)).toEqual({ matched: true, rest: 'run the tests' })
    expect(matchWake('헤이 우로 상태 알려줘', more)).toEqual({ matched: true, rest: '상태 알려줘' })
    expect(matchWake('I was reading about ouroboros', more).matched).toBe(false)
    expect(wakePhrases(' , ,')).toEqual([])
  })
  it('drops quotes the recogniser put around the phrase from the prompt', () => {
    expect(matchWake('"Hey Uro!" 테스트 돌려줘.', 'hey ouro')).toEqual({ matched: true, rest: '테스트 돌려줘.' })
  })
  it('adds what was heard as a spelling only when it is new, short and fits', () => {
    expect(addWakeSpelling('hey ouro', ' "Hey Aro." ')).toBe('hey ouro, Hey Aro')
    expect(addWakeSpelling('hey ouro', 'Hey Ouro!')).toBeUndefined()
    expect(addWakeSpelling('hey ouro', '...')).toBeUndefined()
    expect(addWakeSpelling('hey ouro', 'this is a whole sentence that someone said instead')).toBeUndefined()
    expect(addWakeSpelling('a'.repeat(115), 'Hey Aro')).toBeUndefined()
    expect(addWakeSpelling('hey ouro', 'Hey, Aro')).toBe('hey ouro, Hey Aro')
    expect(voiceSettings({ wakePhrase: 'x'.repeat(200) }).wakePhrase).toHaveLength(MAX_WAKE_PHRASE)
    expect(addWakeSpelling('hey ouro', '네.')).toBeUndefined()
    expect(addWakeSpelling('hey ouro', '응응')).toBeUndefined()
  })
  it('a one- or two-character spelling must match exactly, so it cannot wake on every sentence', () => {
    expect(matchWake('오늘 날씨 어때', 'hey ouro, 네').matched).toBe(false)
    expect(matchWake('뭐 해', 'hey ouro, 네').matched).toBe(false)
    expect(matchWake('네 알겠어', 'hey ouro, 네').matched).toBe(true)
    expect(matchWake('우루야. 보고서 읽어줘.', '우로야')).toEqual({ matched: true, rest: '보고서 읽어줘.' })
  })
  it('a phrase of only commas falls back to the default', () => {
    expect(voiceSettings({ wakePhrase: ' , ,' }).wakePhrase).toBe(DEFAULT_VOICE.wakePhrase)
  })
  it('normalizes case, punctuation and spacing', () => {
    expect(normalizeSpeech('Hey, Ouro-boros!')).toBe('heyouroboros')
    expect(normalizeSpeech('우로 보로스.')).toBe('우로보로스')
  })
})

describe('settings and hotkeys', () => {
  it('takes only accelerators with a modifier and one key', () => {
    expect(validAccelerator('CommandOrControl+Alt+Space')).toBe(true)
    expect(validAccelerator('Ctrl+Shift+F9')).toBe(true)
    expect(validAccelerator('Space')).toBe(false)
    expect(validAccelerator('Ctrl+C')).toBe(false)
    expect(validAccelerator('Alt+Tab')).toBe(false)
    expect(validAccelerator('Ctrl+F13')).toBe(true)
    expect(validAccelerator('Ctrl+')).toBe(false)
    expect(validAccelerator('Ctrl+Ctrl+A')).toBe(false)
    expect(validAccelerator('Ctrl+Ctrl+Alt+A')).toBe(false)
    expect(validAccelerator('Ctrl+Alt+Banana')).toBe(false)
    expect(validAccelerator(undefined)).toBe(false)
  })
  it('fills defaults and repairs bad values', () => {
    expect(voiceSettings(undefined)).toEqual(DEFAULT_VOICE)
    const s = voiceSettings({ stt: 'x' as never, language: 'fr' as never, hotkey: 'A', wakePhrase: '   ' })
    expect([s.stt, s.language, s.hotkey, s.wakePhrase]).toEqual(['openai', 'auto', DEFAULT_VOICE.hotkey, DEFAULT_VOICE.wakePhrase])
  })
})

describe('audio and transcription requests', () => {
  it('writes a 16-bit mono WAV header and clamps samples', () => {
    const wav = wavFromFloat32(new Float32Array([0, 1, -1, 2]), 16000)
    const v = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(40, true)).toBe(8)
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767])
  })
  it('builds the form fields for each engine', () => {
    expect(sttFields('openai', 'auto')).toEqual({ model: 'gpt-4o-mini-transcribe', response_format: 'json' })
    expect(sttFields('openai', 'ko')).toMatchObject({ language: 'ko' })
    expect(sttFields('whisper', 'auto')).toEqual({ response_format: 'json', temperature: '0', language: 'auto' })
  })
  it('reads the text and knows whisper filler from speech', () => {
    expect(sttText({ text: '  hello\n world ' })).toBe('hello world')
    expect(sttText({})).toBeUndefined()
    expect(isNonSpeech('[BLANK_AUDIO]')).toBe(true)
    expect(isNonSpeech('(music)')).toBe(true)
    expect(isNonSpeech('시청해주셔서 감사합니다.')).toBe(true)
    expect(isNonSpeech('Thank you for watching!')).toBe(true)
    expect(isNonSpeech('run the tests')).toBe(false)
  })
})
