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
import { MAX_TTS_CHARS, buildTtsRequest, geminiAudioData, looksLikeAudio, ttsError, ttsSettings, wavFromPcm16, type TtsRequest } from '@shared/tts'
import type { TtsKeyEngine, TtsResult } from '@shared/protocol'
import type { AppSettings } from '@shared/types'
import { log } from './diagnostics'
import { decryptToken, encryptToken } from './updater'

const TIMEOUT_MS = 20_000
/** Voicebox loads its model on the first request; once it has answered, a slow reply means it is stuck. */
const LOCAL_COLD_TIMEOUT_MS = 90_000
let voiceboxWarm = false

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
  const req = buildTtsRequest(s.engine, text.slice(0, MAX_TTS_CHARS), s, key ?? '')
  const timeoutMs = local && !voiceboxWarm ? LOCAL_COLD_TIMEOUT_MS : TIMEOUT_MS
  let bytes: Uint8Array
  let file: string | undefined
  try {
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
    } else bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    const m =
      (err as Error).name === 'TimeoutError'
        ? `${s.engine}: no answer within ${timeoutMs / 1000} s`
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
  if (local) voiceboxWarm = true
  return { ok: true, bytes, mime: req.mime }
}
