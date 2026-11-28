import { phrase, type AnnounceLang, type AnnouncePayload } from '@shared/announce'
import { SPEECH_SILENCE_MS, speakPieces, speechPieces, ttsSettings, windowsUtterance } from '@shared/tts'
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

/**
 * Windows voice; a Korean sentence falls back to the English one when no Korean voice is installed. Resolves when
 * it has been said, after a watchdog (Chromium does not always fire `end`), or once `stop` has silenced it. The
 * stop cancels the whole synthesizer, which holds nothing else: all speech goes through `queued`, one text at a time.
 */
function speakWindows(text: (lang: AnnounceLang) => string, want: AnnounceLang, stop?: AbortSignal): Promise<void> {
  const synth = window.speechSynthesis
  if (!synth) return Promise.resolve()
  const lang: AnnounceLang = want === 'ko' && !voiceFor('ko') ? 'en' : want
  const said = text(lang)
  const u = new SpeechSynthesisUtterance(said)
  const voice = voiceFor(lang)
  if (voice) u.voice = voice
  u.lang = lang === 'ko' ? 'ko-KR' : 'en-US'
  return windowsUtterance(
    (done) => {
      u.onend = u.onerror = done
      synth.speak(u)
    },
    5000 + said.length * 150,
    () => synth.cancel(),
    stop
  )
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
 * Say any text: the chosen engine, else the Windows voice. A long text goes in sentence pieces, the next made while
 * one plays, so a slow local voice starts within one piece's time and no request runs into main's limit; a piece
 * that keeps the speaker silent too long sends the rest to the Windows voice. Resolves once all of it has been said,
 * or once `stop` has dropped what was left.
 */
async function say(text: (lang: AnnounceLang) => string, lang: AnnounceLang, stop?: AbortSignal): Promise<{ error?: string; note?: string }> {
  if (stop?.aborted) return {}
  const tts = ttsSettings(useBoard.getState().settings)
  if (tts.engine === 'windows') {
    await speakWindows(text, lang, stop)
    return {}
  }
  const pieces = speechPieces(text(lang))
  let note: string | undefined
  const r = await speakPieces(
    pieces,
    {
      make: async (piece) => {
        const c = await window.ouroboros.tts.synthesize(piece)
        if (!c.ok) throw new Error(c.error)
        note ??= c.note
        return c
      },
      play: (c) => play(c.bytes, c.mime),
      // nothing said yet: the whole text as before (a Korean sentence can still turn English); else what is left
      fallback: (from) => speakWindows(from === 0 ? text : () => pieces.slice(from).join(' '), lang, stop)
    },
    { silenceMs: SPEECH_SILENCE_MS, signal: stop }
  )
  if (r.error) {
    console.warn(`[tts] ${tts.engine}: ${r.error} — Windows voice instead`)
    return { error: r.error }
  }
  return note ? { note } : {}
}

/** Everything asked to be said (announcements, read-alouds), one after another; settles when the last one has. */
let speaking: Promise<unknown> = Promise.resolve()

function queued<T>(job: () => Promise<T>): Promise<T> {
  const turn = speaking.then(job, job)
  speaking = turn.catch(() => undefined)
  return turn
}

/** Resolves once everything asked to be said so far has been said. */
export function speechSettled(): Promise<void> {
  return speaking.then(
    () => undefined,
    () => undefined
  )
}

/**
 * Say the announcement. Resolves with the engine's error when the chosen voice engine failed (the Windows
 * voice spoke instead), else with the engine's note when it has one (Voicebox's own Autoplay is on), else {}.
 */
export async function speak(p: AnnouncePayload): Promise<{ error?: string; note?: string }> {
  // a read-aloud exchange is listening: another card's announcement waits, so the mic never takes it for an answer
  while (held) await held
  return queued(() => say((lang) => phrase(p, lang), p.lang))
}

let held: Promise<void> | null = null

/** Hold announcements back while a read-aloud exchange runs; the returned function lets them go. */
export function holdAnnouncements(): () => void {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  held = gate
  return () => {
    if (held === gate) held = null
    release()
  }
}

/** Say one sentence of the read-aloud exchange (the question, the decision itself, the read-back), in turn; `stop` drops what is not said yet. */
export function speakText(text: string, lang: AnnounceLang, stop?: AbortSignal): Promise<void> {
  return queued(() => say(() => text, lang, stop)).then(() => undefined)
}
