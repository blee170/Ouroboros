import { phrase, type AnnounceLang, type AnnouncePayload } from '@shared/announce'

/**
 * Speaks announcements with the Windows voices Chromium exposes (SAPI: "Microsoft Heami Desktop" for Korean,
 * "Zira" for English). getVoices() is empty until `voiceschanged` fires once, so the list is refreshed.
 */
let voices: SpeechSynthesisVoice[] = []

function load(): void {
  voices = window.speechSynthesis?.getVoices() ?? []
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  load()
  window.speechSynthesis.addEventListener('voiceschanged', load)
}

export function voiceFor(lang: AnnounceLang): SpeechSynthesisVoice | undefined {
  if (!voices.length) load()
  const want = lang === 'ko' ? /^ko/i : /^en/i
  return voices.find((v) => want.test(v.lang) && v.default) ?? voices.find((v) => want.test(v.lang))
}

/** Say the announcement; a Korean one falls back to the English sentence when no Korean voice is installed. */
export function speak(p: AnnouncePayload): void {
  const synth = window.speechSynthesis
  if (!synth) return
  const lang: AnnounceLang = p.lang === 'ko' && !voiceFor('ko') ? 'en' : p.lang
  const u = new SpeechSynthesisUtterance(phrase(p, lang))
  const voice = voiceFor(lang)
  if (voice) u.voice = voice
  u.lang = lang === 'ko' ? 'ko-KR' : 'en-US'
  synth.speak(u)
}
