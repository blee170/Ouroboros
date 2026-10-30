import { phrase, type AnnounceLang, type AnnouncePayload } from '@shared/announce'
import { ttsSettings } from '@shared/tts'
import { useBoard } from '@/store/board'

/**
 * Speaks announcements. With a voice engine chosen in Settings (Gemini, OpenAI, ElevenLabs — the owner's own
 * key) main fetches the sentence as audio and it is played here, one clip after another; the Windows voices
 * Chromium exposes (SAPI: "Microsoft Heami" for Korean, "Zira" for English) are the offline default and the
 * fallback when the engine fails. getVoices() is empty until `voiceschanged` fires once, so the list is refreshed.
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

/** Windows voice; a Korean sentence falls back to the English one when no Korean voice is installed. */
function speakWindows(p: AnnouncePayload): void {
  const synth = window.speechSynthesis
  if (!synth) return
  const lang: AnnounceLang = p.lang === 'ko' && !voiceFor('ko') ? 'en' : p.lang
  const u = new SpeechSynthesisUtterance(phrase(p, lang))
  const voice = voiceFor(lang)
  if (voice) u.voice = voice
  u.lang = lang === 'ko' ? 'ko-KR' : 'en-US'
  synth.speak(u)
}

let queue: Promise<void> = Promise.resolve()

/** Play one clip after the previous one has ended; rejects when the browser refuses to play it. */
function play(bytes: Uint8Array, mime: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }))
  const turn = queue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        const audio = new Audio(url)
        // a clip that stalls (audio device gone) must not hold every later announcement
        const watchdog = setTimeout(() => reject(new Error('audio playback stalled')), 30_000)
        audio.onended = () => {
          clearTimeout(watchdog)
          resolve()
        }
        audio.onerror = () => {
          clearTimeout(watchdog)
          reject(new Error('audio playback failed'))
        }
        audio.play().catch((err) => {
          clearTimeout(watchdog)
          reject(err)
        })
      })
  )
  queue = turn.catch(() => undefined).finally(() => URL.revokeObjectURL(url))
  return turn
}

/**
 * Say the announcement. Resolves with the engine's error when the chosen voice engine failed (the Windows
 * voice spoke instead), else with the engine's note when it has one (Voicebox's own Autoplay is on), else {}.
 */
export async function speak(p: AnnouncePayload): Promise<{ error?: string; note?: string }> {
  const tts = ttsSettings(useBoard.getState().settings)
  if (tts.engine === 'windows') {
    speakWindows(p)
    return {}
  }
  try {
    const r = await window.ouroboros.tts.synthesize(phrase(p))
    if (!r.ok) throw new Error(r.error)
    await play(r.bytes, r.mime)
    return r.note ? { note: r.note } : {}
  } catch (err) {
    const m = (err as Error).message
    console.warn(`[tts] ${tts.engine}: ${m} — Windows voice instead`)
    speakWindows(p)
    return { error: m }
  }
}
