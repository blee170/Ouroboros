/**
 * Speech to text for the voice composer: the owner's OpenAI key (the one Settings → Voice announcements keeps)
 * or a local whisper.cpp `whisper-server` the app starts on 127.0.0.1 from the paths in Settings and stops on
 * quit. Audio comes in as a 16 kHz mono WAV from the renderer; only text goes back.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { sttFields, sttText, voiceSettings, type VoiceSettings } from '@shared/voice'
import type { AppSettings } from '@shared/types'
import { log } from './diagnostics'
import { ttsKeyFor } from './tts'

export type SttResult = { ok: true; text: string } | { ok: false; error: string }

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions'
const TIMEOUT_MS = 30_000
/** a WAV of 30 s at 16 kHz mono 16-bit is ~960 KB; anything far past that is not from our recorder */
export const MAX_WAV_BYTES = 2_000_000

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

/** The local whisper-server: started on first use, restarted when its paths change, stopped on quit. */
class WhisperServer {
  private child: ChildProcess | undefined
  private key = ''
  private ready: Promise<string> | undefined
  /** bumped by stop(): a start still waiting for its port gives up instead of spawning an orphan */
  private generation = 0

  /** The base URL of a running server for these paths, starting it if needed. */
  url(exe: string, model: string): Promise<string> {
    const key = `${exe}\0${model}`
    if (this.ready && this.key === key && this.child && this.child.exitCode === null) return this.ready
    this.stop()
    this.key = key
    this.ready = this.start(exe, model, this.generation)
    this.ready.catch(() => {
      if (this.key === key) this.ready = undefined
    })
    return this.ready
  }

  private async start(exe: string, model: string, generation: number): Promise<string> {
    if (!existsSync(exe)) throw new Error(`whisper-server not found at ${exe}`)
    if (!existsSync(model)) throw new Error(`whisper model not found at ${model}`)
    const port = await freePort()
    if (generation !== this.generation) throw new Error('whisper-server start was cancelled')
    // only what a Windows program and the CUDA runtime need: none of the owner's tokens go to it
    const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ComSpec', 'HOME', 'LANG']
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (keep.includes(k) || /^CUDA_/i.test(k))) env[k] = v
    const child = spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env })
    this.child = child
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    child.on('exit', (code) => {
      log(`[voice] whisper-server exited (${code})`)
      if (this.child === child) this.child = undefined
    })
    const base = `http://127.0.0.1:${port}`
    // a large model takes a while to load on first start
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`whisper-server stopped while starting: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
      try {
        const r = await fetch(base, { signal: AbortSignal.timeout(1000) })
        if (r.status < 500) return base
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    child.kill()
    throw new Error('whisper-server did not start within 2 minutes')
  }

  stop(): void {
    this.generation++
    this.child?.kill()
    this.child = undefined
    this.ready = undefined
  }
}

export const whisper = new WhisperServer()

function form(wav: Uint8Array, fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  f.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav')
  return f
}

async function post(url: string, body: FormData, headers: Record<string, string>, key?: string): Promise<SttResult> {
  try {
    const res = await fetch(url, { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    let json: unknown = undefined
    try {
      json = await res.json()
    } catch {
      /* not JSON: the status says it */
    }
    if (!res.ok) {
      const msg = typeof json === 'object' && json ? ((json as { error?: { message?: string } | string }).error ?? '') : ''
      const text = typeof msg === 'string' ? msg : (msg.message ?? '')
      return { ok: false, error: `${res.status}${text ? `: ${scrubKey(text, key).slice(0, 200)}` : ''}` }
    }
    const text = sttText(json)
    return text === undefined ? { ok: false, error: 'the answer had no text' } : { ok: true, text }
  } catch (err) {
    return { ok: false, error: scrubKey((err as Error).message, key).slice(0, 200) }
  }
}

const scrubKey = (s: string, key?: string): string => (key ? s.split(key).join('[key]') : s).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[key]')

/** One take's WAV to text, with the engine chosen in Settings → Voice (or `override` for the Test button). */
export async function transcribe(settings: AppSettings, wav: Uint8Array, override?: Partial<VoiceSettings>): Promise<SttResult> {
  const v = voiceSettings({ ...settings.voice, ...override })
  if (!(wav instanceof Uint8Array) || wav.length < 44 || wav.length > MAX_WAV_BYTES) return { ok: false, error: 'no usable audio' }
  if (v.stt === 'openai') {
    const key = ttsKeyFor(settings, 'openai')
    if (!key) return { ok: false, error: 'no OpenAI key: save one in Settings → Voice' }
    const r = await post(OPENAI_URL, form(wav, sttFields('openai', v.language)), { Authorization: `Bearer ${key}` }, key)
    return r.ok ? r : { ok: false, error: `OpenAI ${r.error}` }
  }
  if (!v.whisperServerPath || !v.whisperModelPath) return { ok: false, error: 'set the whisper-server and model paths in Settings → Voice' }
  let base: string
  try {
    base = await whisper.url(v.whisperServerPath, v.whisperModelPath)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const r = await post(`${base}/inference`, form(wav, sttFields('whisper', v.language)), {})
  return r.ok ? r : { ok: false, error: `whisper ${r.error}` }
}
