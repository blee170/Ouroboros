/**
 * Fetches announcement audio from the engine chosen in Settings with the owner's own API key (or from the local
 * Voicebox app, keyless and uncached), and keeps every cloud sentence it has fetched under userData/tts so a
 * repeated announcement costs nothing. Keys live encrypted in
 * the settings file and are only ever sent in the engine's own auth header.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_TTS_CHARS, VOICEBOX_AUTOPLAY_NOTE, VOICEBOX_SETTINGS_URL, VOICEBOX_URL, buildTtsRequest, geminiAudioData, looksLikeAudio, ttsError, ttsSettings, voiceboxAutoplay, voiceboxGeneration, voiceboxProfile, voiceboxUrl, wavFromPcm16, type TtsRequest, type VoiceboxProfile } from '@shared/tts'
import type { TtsKeyEngine, TtsResult } from '@shared/protocol'
import type { AppSettings } from '@shared/types'
import { log } from './diagnostics'
import { decryptToken, encryptToken } from './updater'

const TIMEOUT_MS = 20_000
/** Voicebox is local and free, and a cloned voice on the CPU backend takes 20 s and more per sentence (plus a model load). */
const VOICEBOX_TIMEOUT_MS = 120_000

/** One file per engine + request body (model, voice, style, text); a changed model or voice is a new clip. */
function cacheFile(engine: string, req: TtsRequest): string {
  const dir = join(app.getPath('userData'), 'tts')
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha1').update(`${engine}\u0000${req.body}`).digest('hex').slice(0, 24)
  return join(dir, `${engine}-${hash}.${req.mime === 'audio/wav' ? 'wav' : 'mp3'}`)
}

export function ttsKeyFor(settings: AppSettings, engine: TtsKeyEngine): string | undefined {
  return decryptToken(settings.ttsKeysEnc?.[engine])
}

/** The patch that stores (or clears) one engine's key. */
export function ttsKeyPatch(settings: AppSettings, engine: TtsKeyEngine, key: string): Pick<AppSettings, 'ttsKeysEnc'> {
  // keys never contain whitespace; one pasted from wrapped text would break the auth header and echo itself in the error
  const enc = encryptToken(key.replace(/\s+/g, ''))
  const next = { ...(settings.ttsKeysEnc ?? {}) }
  if (enc) next[engine] = enc
  else delete next[engine]
  return { ttsKeysEnc: Object.keys(next).length ? next : undefined }
}

export async function synthesize(settings: AppSettings, text: string): Promise<TtsResult> {
  const s = ttsSettings(settings)
  if (s.engine === 'windows') return { ok: false, error: 'Windows voice' }
  const local = s.engine === 'voicebox'
  const key = s.engine === 'voicebox' ? '' : ttsKeyFor(settings, s.engine)
  if (!local && !key) {
    log(`tts ${s.engine}: no key saved`)
    return { ok: false, error: `No ${s.engine} key saved in Settings` }
  }
  const timeoutMs = local ? VOICEBOX_TIMEOUT_MS : TIMEOUT_MS
  let req: TtsRequest
  let bytes: Uint8Array
  let file: string | undefined
  /** which call a timeout names: the short Voicebox calls have their own 5 s limit, the main one `timeoutMs` */
  let step = 'the request'
  let stepMs = timeoutMs
  /** Voicebox plays the clip itself too (its own Autoplay switch): said with the clip, so Settings → Test can show it */
  let note: string | undefined
  try {
    let profile: VoiceboxProfile | undefined
    if (local) {
      // /generate wants the profile's id and engine: the name in Settings is looked up in Voicebox's list each time
      // (a profile re-made under the same name gets a new id)
      if (!s.voice) return { ok: false, error: 'Voicebox: put a profile name from Voicebox in Voice.' }
      step = 'the profile list'
      stepMs = 5000
      const pr = await fetch(`${VOICEBOX_URL}/profiles`, { signal: AbortSignal.timeout(stepMs) })
      if (!pr.ok) return { ok: false, error: ttsError(s.engine, pr.status, await pr.text().catch(() => '')) }
      profile = voiceboxProfile(await pr.json(), s.voice)
      if (!profile) return { ok: false, error: `Voicebox: no profile named "${s.voice}" (the names are in Voicebox's left column).` }
      // Voicebox's Autoplay plays every /generate result in its own window as well; a settings route that fails is no reason not to speak
      note = await fetch(VOICEBOX_SETTINGS_URL, { signal: AbortSignal.timeout(stepMs) })
        .then((r) => (r.ok ? r.json() : undefined))
        .then((j) => (voiceboxAutoplay(j) ? VOICEBOX_AUTOPLAY_NOTE : undefined))
        .catch(() => undefined)
    }
    req = buildTtsRequest(s.engine, text.slice(0, MAX_TTS_CHARS), s, key ?? '', profile)
    step = 'the request'
    stepMs = timeoutMs
    // a local clip is free, and a profile re-recorded under the same name must not replay the old voice
    file = local ? undefined : cacheFile(s.engine, req)
    if (file && existsSync(file)) return { ok: true, bytes: new Uint8Array(readFileSync(file)), mime: req.mime }
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      const err = ttsError(s.engine, res.status, await res.text().catch(() => ''))
      log(`tts ${s.engine}: ${err}`)
      return { ok: false, error: err }
    }
    if (req.response === 'gemini-json') {
      const data = geminiAudioData(await res.json())
      if (!data) {
        log('tts gemini: no audio part in the response')
        return { ok: false, error: 'Gemini TTS: no audio in the response' }
      }
      bytes = new Uint8Array(Buffer.from(data, 'base64'))
      // unary answers are WAV; raw L16 PCM (the streaming shape) gets a header so the renderer can play it
      if (bytes.length && !looksLikeAudio(bytes, 'audio/wav')) bytes = wavFromPcm16(bytes)
    } else if (req.response === 'voicebox-json') {
      // /generate answers at once with a generation record; the clip exists once /history/{id} says completed
      // (the audio route answers 500 until then). One deadline covers the whole wait.
      const deadline = Date.now() + timeoutMs
      let g = voiceboxGeneration(await res.json())
      if (!g) return { ok: false, error: 'Voicebox: no generation record in the answer' }
      while (g.status === 'generating') {
        if (Date.now() > deadline) {
          // Voicebox would keep the CPU on a clip nobody will play
          void fetch(voiceboxUrl('cancel', g.id), { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {})
          return { ok: false, error: `Voicebox: not finished within ${timeoutMs / 1000} s (a cloned voice on its CPU backend is slow; its GPU backend is in Voicebox's Settings)` }
        }
        await new Promise((r) => setTimeout(r, 400))
        step = 'the progress check'
        stepMs = 5000
        const h = await fetch(voiceboxUrl('history', g.id), { signal: AbortSignal.timeout(stepMs) })
        if (!h.ok) return { ok: false, error: ttsError(s.engine, h.status, await h.text().catch(() => '')) }
        g = voiceboxGeneration(await h.json()) ?? { id: g.id, status: 'failed', error: 'no generation record' }
      }
      if (g.status === 'failed') {
        log(`tts voicebox: generation failed: ${g.error ?? ''}`)
        return { ok: false, error: `Voicebox: ${g.error ?? 'generation failed'}` }
      }
      step = 'the audio'
      stepMs = Math.max(1000, deadline - Date.now())
      const a = await fetch(voiceboxUrl('audio', g.id), { signal: AbortSignal.timeout(stepMs) })
      if (!a.ok) return { ok: false, error: ttsError(s.engine, a.status, await a.text().catch(() => '')) }
      bytes = new Uint8Array(await a.arrayBuffer())
    } else bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    const m =
      (err as Error).name === 'TimeoutError'
        ? `${s.engine}: no answer to ${step} within ${stepMs / 1000} s`
        : local && (err as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED'
          ? 'Voicebox is not running (nothing answers on 127.0.0.1:17493). Start the Voicebox app.'
          : `${s.engine}: ${(err as Error).message}`
    log(`tts ${m}`)
    return { ok: false, error: m }
  }
  if (!looksLikeAudio(bytes, req.mime)) {
    log(`tts ${s.engine}: response is not ${req.mime} (${bytes.length} bytes)`)
    return { ok: false, error: `${s.engine}: the response was not audio (${bytes.length} bytes)` }
  }
  // the clip plays even when it cannot be kept: write to a temp name, then rename, so a crash never leaves half a file
  try {
    if (file) {
      writeFileSync(`${file}.tmp`, bytes)
      renameSync(`${file}.tmp`, file)
    }
  } catch (err) {
    log(`tts cache write failed: ${(err as Error).message}`)
  }
  return note ? { ok: true, bytes, mime: req.mime, note } : { ok: true, bytes, mime: req.mime }
}
