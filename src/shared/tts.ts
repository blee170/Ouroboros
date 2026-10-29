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
  voicebox: { label: 'Voicebox (local app, your own voice)', defaultVoice: '', voiceHint: 'profile name from Voicebox (empty = its default voice); the profile sets the language', keyHint: '' }
}

/** Voicebox's local API (its OpenAI-compatible speech route); it listens on 127.0.0.1 only and takes no key. */
export const VOICEBOX_URL = 'http://127.0.0.1:17493/v1/audio/speech'

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
  /** How the response carries the audio: raw bytes, or JSON with base64 inside (Gemini). */
  response: 'bytes' | 'gemini-json'
  mime: string
}

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts'

/** The HTTP request that turns `text` into audio with the chosen engine; the key goes in a header, never the URL. */
export function buildTtsRequest(engine: Exclude<TtsEngine, 'windows'>, text: string, s: TtsSettings, key: string): TtsRequest {
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
      return {
        url: VOICEBOX_URL,
        headers: { 'content-type': 'application/json' },
        // tts-1 = whatever engine the profile uses; no voice = Voicebox's default playback voice
        body: JSON.stringify({ model: 'tts-1', input: text, ...(s.voice ? { voice: s.voice } : {}), response_format: 'wav' }),
        response: 'bytes',
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
