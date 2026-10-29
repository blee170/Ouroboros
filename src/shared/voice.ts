/**
 * Voice input for the left composer: the settings, the wake-phrase match and the speech-to-text request. Pure;
 * the renderer records (src/renderer/src/voice), the main process sends the audio (src/main/stt.ts).
 */

export type SttEngine = 'openai' | 'whisper'
export type VoiceLanguage = 'auto' | 'ko' | 'en'

export interface VoiceSettings {
  /** the mic button and the hotkey (default off) */
  enabled: boolean
  stt: SttEngine
  language: VoiceLanguage
  /** send the transcript after a 3-second countdown (Esc cancels); off: it waits in the composer */
  autoSend: boolean
  /** Electron accelerator, works with the window hidden */
  hotkey: string
  /** MediaDeviceInfo.deviceId; empty: the system default input */
  micDeviceId?: string
  /** whisper.cpp `whisper-server` executable and ggml model, started by the app on 127.0.0.1 when first needed */
  whisperServerPath?: string
  whisperModelPath?: string
  /** listen for the wake phrase all the time (needs the local whisper server; default off) */
  wake: boolean
  wakePhrase: string
}

export const DEFAULT_VOICE: VoiceSettings = { enabled: false, stt: 'openai', language: 'auto', autoSend: false, hotkey: 'CommandOrControl+Alt+Space', wake: false, wakePhrase: 'Ouroboros' }

export const VOICE_LIMITS = {
  /** a take ends after this much silence */
  silenceMs: 1200,
  /** and never runs longer than this */
  maxTakeMs: 30_000,
  /** an always-on clip (wake phrase plus maybe a command) */
  maxWakeClipMs: 10_000,
  /** shorter than this is a cough, not speech */
  minSpeechMs: 300,
  sampleRate: 16_000,
  autoSendMs: 3000
} as const

export function voiceSettings(v: Partial<VoiceSettings> | undefined): VoiceSettings {
  const s = { ...DEFAULT_VOICE, ...(v ?? {}) }
  if (s.stt !== 'openai' && s.stt !== 'whisper') s.stt = 'openai'
  if (!['auto', 'ko', 'en'].includes(s.language)) s.language = 'auto'
  if (!validAccelerator(s.hotkey)) s.hotkey = DEFAULT_VOICE.hotkey
  s.wakePhrase = (s.wakePhrase || '').trim().slice(0, MAX_WAKE_PHRASE)
  // only commas (or nothing) would never match: the default instead
  if (!wakePhrases(s.wakePhrase).length) s.wakePhrase = DEFAULT_VOICE.wakePhrase
  return s
}

const MODIFIERS = new Set(['commandorcontrol', 'cmdorctrl', 'control', 'ctrl', 'alt', 'option', 'shift', 'super', 'meta', 'command', 'cmd', 'altgr'])
const KEYS = /^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|space|tab|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|plus|[`\-=[\]\\;',./])$/i

/** An Electron accelerator: two modifiers and one key (one modifier only with F13-F24); a common combination would be taken from every app. */
export function validAccelerator(acc: string | undefined): boolean {
  if (!acc || acc.length > 60) return false
  const parts = acc.split('+').map((p) => p.trim())
  if (parts.some((p) => !p)) return false
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase())
  const spare = /^f(1[3-9]|2[0-4])$/i.test(key)
  return mods.length >= (spare ? 1 : 2) && mods.every((m) => MODIFIERS.has(m)) && new Set(mods).size === mods.length && KEYS.test(key)
}

/** Lower case, letters and digits only (Hangul kept), so "Hey, Ouroboros!" and "hey ouroboros" compare equal. */
export function normalizeSpeech(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/**
 * Whether a transcript starts with the wake phrase, and what was said after it. Speech recognisers spell a
 * name differently from take to take ("Ouroboros", "Uroboros", "우로보로스"), so the start of the transcript
 * is compared with a tolerance: at most a quarter of the phrase's characters may differ (one for short ones).
 * `phrase` may list other spellings after commas ("hey ouro, hey aro, 헤이 우로"): any one of them counts.
 */
export function matchWake(transcript: string, phrase: string): { matched: false } | { matched: true; rest: string } {
  for (const one of wakePhrases(phrase)) {
    const m = matchOne(transcript, one)
    if (m.matched) return m
  }
  return { matched: false }
}

/** The spellings in a wake phrase setting: comma-separated, blanks dropped. */
export function wakePhrases(phrase: string): string[] {
  return phrase
    .split(/[,，、]/)
    .map((p) => p.trim())
    .filter((p) => normalizeSpeech(p))
}

/** Longest wake phrase setting: the original phrase plus a few spellings the recogniser wrote for it. */
export const MAX_WAKE_PHRASE = 120

/**
 * The wake phrase setting with what the recogniser heard added as one more spelling (the Settings test), or
 * undefined when it already matches, has no words, or would not fit.
 */
export function addWakeSpelling(phrase: string, heard: string): string | undefined {
  const spelling = heard
    .replace(/[\s"'“”‘’「」『』()[\]{}.,!?~、。，！？:;-]+$/u, '')
    .replace(/^[\s"'“”‘’「」『』()[\]{}.,!?~、。，！？:;-]+/u, '')
    .replace(/[,，、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // a short recogniser guess ("네", "응") for a mumbled test would wake on everything
  if (normalizeSpeech(spelling).length < 3 || spelling.length > 30 || matchWake(spelling, phrase).matched) return undefined
  const next = `${phrase.trim()}, ${spelling}`
  return next.length <= MAX_WAKE_PHRASE ? next : undefined
}

function matchOne(transcript: string, phrase: string): { matched: false } | { matched: true; rest: string } {
  const want = normalizeSpeech(phrase)
  if (!want) return { matched: false }
  // one or two characters with a typo allowed would match nearly any sentence: those must be exact
  const allowed = want.length < 3 ? 0 : Math.max(1, Math.floor(want.length / 4))
  // walk the transcript's characters, keeping where each normalized character came from, to cut the rest out
  const chars: Array<{ c: string; end: number }> = []
  const src = transcript.normalize('NFC')
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i) as number
    const ch = String.fromCodePoint(cp)
    i += ch.length
    const n = normalizeSpeech(ch)
    if (n) for (const c of n) chars.push({ c, end: i })
  }
  // a leading "hey" / "ok" / "야" is allowed before the phrase
  for (const skip of [0, ...['hey', 'hi', 'ok', 'okay', '야', '헤이'].map((w) => (chars.slice(0, w.length).map((x) => x.c).join('') === w ? w.length : -1)).filter((n) => n > 0)]) {
    let best: { d: number; len: number } | undefined
    for (let len = Math.max(1, want.length - allowed); len <= want.length + allowed && skip + len <= chars.length; len++) {
      const got = chars.slice(skip, skip + len).map((x) => x.c).join('')
      const d = distance(got, want)
      if (d <= allowed && (!best || d < best.d)) best = { d, len }
    }
    if (best) {
      const end = chars[skip + best.len - 1].end
      const rest = src.slice(end).replace(/^[\s,.!?~、。，！？"'“”‘’」』-]+/u, '').trim()
      return { matched: true, rest }
    }
  }
  return { matched: false }
}

/** Little-endian 16-bit mono WAV around float samples in [-1, 1]. */
export function wavFromFloat32(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(out.buffer)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i)
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return out
}

/** The form fields of a transcription request; the audio goes in `file`. */
export function sttFields(engine: SttEngine, language: VoiceLanguage): Record<string, string> {
  if (engine === 'openai') return { model: 'gpt-4o-mini-transcribe', response_format: 'json', ...(language === 'auto' ? {} : { language }) }
  return { response_format: 'json', temperature: '0', language: language === 'auto' ? 'auto' : language }
}

/** The text out of a transcription answer (OpenAI and whisper-server both answer `{ text }`). */
export function sttText(body: unknown): string | undefined {
  const t = typeof body === 'object' && body ? (body as { text?: unknown }).text : undefined
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : undefined
}

/**
 * Whisper writes these when it hears no words (silence, a fan, a keyboard): "[BLANK_AUDIO]", "(music)",
 * and the subtitle credits it learned from video ("Thank you for watching", "시청해주셔서 감사합니다").
 */
export function isNonSpeech(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/^[[(].*[\])]$/.test(t)) return true
  const n = normalizeSpeech(t)
  return ['thankyouforwatching', 'thanksforwatching', '시청해주셔서감사합니다', '구독과좋아요부탁드립니다', 'you'].includes(n)
}
