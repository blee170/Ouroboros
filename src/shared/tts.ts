/**
 * Natural voices for announcements: the owner's own TTS subscription (a Gemini, OpenAI or ElevenLabs API key),
 * a Voicebox app running on this PC (no key), or the Windows voices built into the renderer. Pure: request shapes and response parsing are unit-tested;
 * main does the fetch, the renderer plays the bytes.
 */
import type { AppSettings } from './types'

export type TtsEngine = 'windows' | 'gemini' | 'openai' | 'elevenlabs' | 'voicebox'

export interface TtsSettings {
  engine: TtsEngine
  /** Voice name (Gemini: Kore…; OpenAI: coral…; ElevenLabs: a voice id; Voicebox: a profile name). Empty = the engine's default. */
  voice: string
  /** Delivery hint (Gemini speech_metadata style, OpenAI instructions). Ignored by ElevenLabs, Voicebox and Windows. */
  style: string
}

export interface TtsEngineInfo {
  label: string
  defaultVoice: string
  voiceHint: string
  keyHint: string
}

export const TTS_ENGINES: Record<TtsEngine, TtsEngineInfo> = {
  windows: { label: 'Windows voice (offline, no key)', defaultVoice: '', voiceHint: '', keyHint: '' },
  gemini: { label: 'Gemini TTS (Google AI Studio key, free tier)', defaultVoice: 'Kore', voiceHint: 'Kore, Zephyr, Puck, Achird, Sulafat…', keyHint: 'API key from aistudio.google.com/app/apikey' },
  openai: { label: 'OpenAI gpt-4o-mini-tts', defaultVoice: 'coral', voiceHint: 'coral, alloy, nova, onyx, sage…', keyHint: 'API key from platform.openai.com' },
  elevenlabs: { label: 'ElevenLabs multilingual v2', defaultVoice: '21m00Tcm4TlvDq8ikWAM', voiceHint: 'voice id (Voices → ⋯ → Copy voice ID); default: Rachel', keyHint: 'xi-api-key from elevenlabs.io' },
  voicebox: { label: 'Voicebox (local app, your own voice)', defaultVoice: '', voiceHint: 'profile name from Voicebox (empty = the default profile set in Voicebox → Settings → MCP); the profile sets the language', keyHint: '' }
}

/** Voicebox's local API; it listens on 127.0.0.1 only and takes no key. */
export const VOICEBOX_URL = 'http://127.0.0.1:17493'

/** A Voicebox route under its API for one generation id. */
export function voiceboxUrl(route: 'history' | 'audio' | 'cancel', id: string): string {
  const safe = encodeURIComponent(id)
  return route === 'cancel' ? `${VOICEBOX_URL}/generate/${safe}/cancel` : `${VOICEBOX_URL}/${route}/${safe}`
}

/** Voicebox's generation settings (GET): its Autoplay switch lives here. */
export const VOICEBOX_SETTINGS_URL = `${VOICEBOX_URL}/settings/generation`

/** Told with the clip when Voicebox's own Autoplay is on: it plays every clip itself, so each announcement is heard twice. */
export const VOICEBOX_AUTOPLAY_NOTE = 'Voicebox also played that clip itself: its "Autoplay on generate" switch (Voicebox → Settings) is on, so every announcement is heard twice until you turn it off there.'

/** True when Voicebox's generation settings say it plays each new clip itself (autoplay_on_generate). Any other shape counts as off. */
export function voiceboxAutoplay(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as Record<string, unknown>).autoplay_on_generate === true
}

/** The engines Voicebox 0.5.0's /generate takes (its OpenAPI pattern). */
const VOICEBOX_ENGINES = new Set(['qwen', 'qwen_custom_voice', 'luxtts', 'chatterbox', 'chatterbox_turbo', 'tada', 'kokoro'])

export interface VoiceboxProfile {
  id: string
  /** the engine the profile was made for: /generate refuses any other ("Preset profile … only supports engine 'kokoro'") */
  engine: string
  /** the profile's language code, when Voicebox knows one it accepts */
  language?: string
}

/**
 * The profile named in Settings (by name, case-insensitively, or by id) out of Voicebox's /profiles list, with the
 * engine and language /generate needs. Undefined when the list has no such profile.
 */
export function voiceboxProfile(list: unknown, nameOrId: string): VoiceboxProfile | undefined {
  if (!Array.isArray(list)) return undefined
  const want = nameOrId.trim().toLowerCase()
  if (!want) return undefined
  const p = list.find((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && ((x as { id: string }).id === nameOrId.trim() || String((x as { name?: unknown }).name ?? '').toLowerCase() === want)) as
    | { id: string; default_engine?: unknown; preset_engine?: unknown; language?: unknown }
    | undefined
  if (!p) return undefined
  // a preset is bound to its engine (/generate refuses any other); default_engine is free text in Voicebox, so only
  // a name /generate accepts is passed, else Voicebox's own default (qwen) applies
  const engine = [p.preset_engine, p.default_engine].find((e): e is string => typeof e === 'string' && VOICEBOX_ENGINES.has(e)) ?? 'qwen'
  const language = typeof p.language === 'string' && /^[a-z]{2}$/.test(p.language) ? p.language : undefined
  return { id: p.id, engine, language }
}

/**
 * A Voicebox generation record (from /generate, then /history/{id} while polling): /generate answers at once with
 * "generating", the audio exists once the status is "completed", "failed" carries the reason. Anything else
 * (a "not_found" status) is a failure. Undefined when the JSON is not a record.
 */
export function voiceboxGeneration(json: unknown): { id: string; status: 'generating' | 'completed' | 'failed'; error?: string } | undefined {
  const j = json as { id?: unknown; status?: unknown; error?: unknown } | null
  if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !j.id) return undefined
  const status = typeof j.status === 'string' ? j.status : ''
  const error = typeof j.error === 'string' && j.error ? j.error : undefined
  if (status === 'completed') return { id: j.id, status, error }
  // only the end states are failures: the record also passes through loading_model (the first clip after a backend
  // switch, measured on the CUDA backend 2026-10-30) and whatever else a later Voicebox adds before generating
  if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'error' || status === 'not_found') return { id: j.id, status: 'failed', error: error ?? status }
  return { id: j.id, status: 'generating', error }
}

export const DEFAULT_STYLE = 'calm and friendly, like a colleague letting you know'

export function ttsSettings(s: Pick<AppSettings, 'ttsEngine' | 'ttsVoice' | 'ttsStyle'>): TtsSettings {
  const engine: TtsEngine = s.ttsEngine && s.ttsEngine in TTS_ENGINES ? s.ttsEngine : 'windows'
  // only OpenAI gets a default style: Gemini's voice drifts with every word of style it is sent (Google's own
  // guidance is an empty style, or one short constant), and the other engines ignore it
  return { engine, voice: (s.ttsVoice ?? '').trim() || TTS_ENGINES[engine].defaultVoice, style: (s.ttsStyle ?? '').trim() || (engine === 'openai' ? DEFAULT_STYLE : '') }
}

export interface TtsRequest {
  url: string
  headers: Record<string, string>
  body: string
  /** How the response carries the audio: raw bytes, JSON with base64 inside (Gemini), or a generation record to poll and then fetch (Voicebox). */
  response: 'bytes' | 'gemini-json' | 'voicebox-json'
  mime: string
}

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts'

/** The HTTP request that turns `text` into audio with the chosen engine; the key goes in a header, never the URL. */
export function buildTtsRequest(engine: Exclude<TtsEngine, 'windows'>, text: string, s: TtsSettings, key: string, voicebox?: VoiceboxProfile): TtsRequest {
  switch (engine) {
    case 'gemini':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: GEMINI_TTS_MODEL,
          input: [{ type: 'user_input', content: [{ type: 'text', text, ...(s.style ? { annotations: [{ type: 'speech_metadata', style: s.style }] } : {}) }] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: s.voice }] }
        }),
        response: 'gemini-json',
        mime: 'audio/wav'
      }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/audio/speech',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: text, voice: s.voice, instructions: s.style, response_format: 'mp3' }),
        response: 'bytes',
        mime: 'audio/mpeg'
      }
    case 'voicebox':
      // /generate only makes the clip (/speak would also play it through Voicebox's own speakers, on top of ours);
      // it wants the profile's id and engine, which main looks up with voiceboxProfile first
      if (!voicebox) throw new Error('Voicebox needs a resolved profile')
      return {
        url: `${VOICEBOX_URL}/generate`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: voicebox.id, text, engine: voicebox.engine, ...(voicebox.language ? { language: voicebox.language } : {}) }),
        response: 'voicebox-json',
        mime: 'audio/wav'
      }
    case 'elevenlabs':
      return {
        url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voice)}?output_format=mp3_44100_128`,
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
        response: 'bytes',
        mime: 'audio/mpeg'
      }
  }
}

/** Base64 audio out of a Gemini Interactions response: the last model_output audio part (or the output_audio shortcut). */
export function geminiAudioData(json: unknown): string | undefined {
  const j = json as { steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }>; output_audio?: { data?: string } }
  const parts = (j?.steps ?? []).filter((st) => st?.type === 'model_output').flatMap((st) => st.content ?? [])
  const last = [...parts].reverse().find((p) => p?.type === 'audio' && typeof p.data === 'string')
  return last?.data ?? (typeof j?.output_audio?.data === 'string' ? j.output_audio.data : undefined)
}

/** Announcements are one sentence; a runaway card title must not turn into a long, billed request. */
export const MAX_TTS_CHARS = 300

/**
 * The most one spoken piece of a long text carries. A heavy local voice (Voicebox "Sohee", a qwen clone, on an
 * RTX 4090) took 196 s for 300 characters, about 0.65 s a character, so 100 stays well inside main's 120 s per
 * request; and its clip stays under the 30 s the renderer gives one clip to play.
 */
export const SPEECH_PIECE_MAX = 100
/** A sentence shorter than this joins its neighbour: a lone "네." is not worth a request of its own. */
const SPEECH_PIECE_MIN = 20
/**
 * Where a sentence ends: its marks (an ellipsis run whole, closing quotes and brackets with it) and the space after
 * them unless a lowercase word follows ("e.g. this", "ready... but"); a CJK full stop, space or not; a line break.
 * A decimal point or a version (1.5, v0.20.8) has no space after its dot, so it never ends one.
 */
const SENTENCE_END = /[.!?…]+[)\]"'”’」』]*\s+(?![\sa-z])|[。！？]+[)\]"'”’」』]*\s*|\n\s*/g

/**
 * Long text in the pieces it is spoken in, in order: each at most `max` characters, broken at sentence ends, a short
 * sentence joined to its neighbour, a sentence longer than `max` broken at a comma or a space. Every word reaches a
 * piece; only whitespace between pieces is dropped. A text that fits in one piece is that one piece.
 */
export function speechPieces(text: string, max = SPEECH_PIECE_MAX): string[] {
  const all = text.trim()
  if (all.length <= max) return all ? [all] : []
  // sentences exactly as written (marks and the space after them included), so the pieces put back together are the text
  const sentences: string[] = []
  let from = 0
  for (const m of all.matchAll(SENTENCE_END)) {
    sentences.push(all.slice(from, m.index + m[0].length))
    from = m.index + m[0].length
  }
  if (from < all.length) sentences.push(all.slice(from))
  // a short sentence waits for the next one (the last one joins the one before), as long as the piece stays within max
  const pieces: string[] = []
  let carry = ''
  for (const s of sentences.flatMap((s) => cutLong(s, max))) {
    if (carry && (carry + s).trim().length > max) {
      pieces.push(carry)
      carry = ''
    }
    carry += s
    if (carry.trim().length >= SPEECH_PIECE_MIN) {
      pieces.push(carry)
      carry = ''
    }
  }
  if (carry) {
    if (pieces.length && (pieces[pieces.length - 1] + carry).trim().length <= max) pieces[pieces.length - 1] += carry
    else pieces.push(carry)
  }
  return pieces.map((p) => p.trim()).filter(Boolean)
}

/** A sentence longer than `max` cut at the last comma past half a piece, else the last space; a single word longer than `max` is cut where it must be. */
function cutLong(sentence: string, max: number): string[] {
  const out: string[] = []
  let rest = sentence
  while (rest.trim().length > max) {
    const head = rest.slice(0, max)
    // an ASCII comma only with a space after it, so 1,000 stays whole; a CJK comma takes none
    let at = lastEnd(head, /,\s+|[，、]\s*/g, max / 2) ?? lastEnd(head, /\s+/g, 1)
    if (at === undefined) {
      at = max
      // never between the two halves of an emoji
      const c = rest.charCodeAt(at)
      if (c >= 0xdc00 && c <= 0xdfff) at--
    }
    out.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  out.push(rest)
  return out
}

/** Where the last match of `re` in `s` ends, when that is at `min` or later. */
function lastEnd(s: string, re: RegExp, min: number): number | undefined {
  let end: number | undefined
  for (const m of s.matchAll(re)) end = m.index + m[0].length
  return end !== undefined && end >= min ? end : undefined
}

/** Only audio goes into the cache: a 200 with an HTML or JSON body would otherwise be replayed as a broken clip forever. */
export function looksLikeAudio(bytes: Uint8Array, mime: string): boolean {
  if (bytes.length < 4) return false
  if (mime === 'audio/wav') return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 // RIFF
  return (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) // ID3 tag or an MPEG frame
}

/** Headerless 16-bit mono PCM (Gemini's L16 shape) wrapped as a WAV file the renderer can play. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate = 24_000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const v = new DataView(out.buffer)
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

/** One line for the Settings dialog when an engine rejects the request. */
export function ttsError(engine: TtsEngine, status: number, bodyText: string): string {
  let detail = bodyText
  try {
    // Gemini / OpenAI wrap the reason in { error: { message } } (Gemini inside an array), ElevenLabs in { detail: { message } }
    const parsed = JSON.parse(bodyText) as unknown
    const j = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: string } | string; detail?: { message?: string } | string; message?: string }
    const inner = [j?.error, j?.detail].map((e) => (typeof e === 'string' ? e : e?.message)).find(Boolean)
    detail = inner ?? j?.message ?? bodyText
  } catch {
    // not JSON: keep the text
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key/i.test(detail)) return `${TTS_ENGINES[engine].label}: key rejected (${status}). ${detail}`
  if (status === 429) return `${TTS_ENGINES[engine].label}: rate limit or quota (429). ${detail}`
  return `${TTS_ENGINES[engine].label}: HTTP ${status}. ${detail}`
}
