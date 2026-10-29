/**
 * The microphone for the voice composer: one stream, 16 kHz mono, cut into utterances by a simple energy gate
 * (speech is a frame well above the room's own noise floor; an utterance ends after a stretch of quiet).
 * No model and no network here: audio leaves this file only as the samples of a finished utterance.
 */
import { VOICE_LIMITS } from '@shared/voice'

const RATE = VOICE_LIMITS.sampleRate
const FRAME = 1024 // 64 ms at 16 kHz
const FRAME_MS = (FRAME / RATE) * 1000
const PRE_ROLL = Math.ceil(300 / FRAME_MS)

type Sink = (samples: Float32Array) => void

export class Mic {
  private frames: Float32Array[] = []
  private pre: Float32Array[] = []
  private speaking = false
  private loud = 0
  private quietMs = 0
  private floor = 0.005
  private heardMs = 0
  private startedAt = 0
  private sink: { kind: 'take' | 'listen'; done: Sink; maxMs: number } | undefined
  private takeTimeout: ReturnType<typeof setTimeout> | undefined
  /** Every frame's loudness (0..1) and whether the gate counts it as speech: the composer's live meter. */
  onLevel: ((level: number, speech: boolean) => void) | undefined

  private constructor(
    private stream: MediaStream,
    private ctx: AudioContext,
    private node: ScriptProcessorNode,
    private source: MediaStreamAudioSourceNode
  ) {
    node.onaudioprocess = (e) => this.frame(new Float32Array(e.inputBuffer.getChannelData(0)))
    source.connect(node)
    // a ScriptProcessor only runs while connected to the output; it writes silence there
    node.connect(ctx.destination)
  }

  static async open(deviceId?: string): Promise<Mic> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    const ctx = new AudioContext({ sampleRate: RATE })
    const source = ctx.createMediaStreamSource(stream)
    const node = ctx.createScriptProcessor(FRAME, 1, 1)
    return new Mic(stream, ctx, node, source)
  }

  /** The device the stream actually opened (the label shows in Settings). */
  get label(): string {
    return this.stream.getAudioTracks()[0]?.label ?? ''
  }

  close(): void {
    this.cancelTake()
    const sink = this.sink
    this.sink = undefined
    // a take in flight settles (with nothing) so whoever awaits it is not left waiting forever
    if (sink?.kind === 'take') {
      this.heardMs = 0
      sink.done(new Float32Array(0))
    }
    this.node.onaudioprocess = null
    this.onLevel?.(0, false)
    this.onLevel = undefined
    try {
      this.source.disconnect()
      this.node.disconnect()
    } catch {
      /* already disconnected */
    }
    for (const t of this.stream.getTracks()) t.stop()
    void this.ctx.close().catch(() => {})
  }

  /**
   * One take: starts now, ends after speech then `silenceMs` of quiet, at `maxTakeMs`, or on stop(). Resolves
   * with the samples, or null when nobody spoke within the first 6 seconds.
   */
  take(): Promise<Float32Array | null> {
    this.cancelTake()
    return new Promise((resolve) => {
      this.reset()
      this.speaking = true // a take records from the first frame; the gate only decides when it ends
      this.heardMs = 0
      this.sink = {
        kind: 'take',
        maxMs: VOICE_LIMITS.maxTakeMs,
        done: (s) => resolve(this.heardMs >= VOICE_LIMITS.minSpeechMs ? s : null)
      }
      this.takeTimeout = setTimeout(() => {
        if (this.sink?.kind === 'take' && this.heardMs < VOICE_LIMITS.minSpeechMs) this.finish()
      }, 6000)
    })
  }

  /** End the take now (the button or the hotkey again). */
  stop(): void {
    if (this.sink?.kind === 'take') this.finish()
  }

  /** Always on: every utterance (up to maxWakeClipMs) goes to `cb`, until close() or a take. */
  listen(cb: Sink): void {
    this.cancelTake()
    this.reset()
    this.sink = { kind: 'listen', done: cb, maxMs: VOICE_LIMITS.maxWakeClipMs }
  }

  private cancelTake(): void {
    if (this.takeTimeout) clearTimeout(this.takeTimeout)
    this.takeTimeout = undefined
  }

  private reset(): void {
    this.frames = []
    this.pre = []
    this.speaking = false
    this.loud = 0
    this.quietMs = 0
    this.startedAt = 0
  }

  private finish(): void {
    const sink = this.sink
    if (!sink) return
    const total = this.frames.reduce((n, f) => n + f.length, 0)
    const out = new Float32Array(total)
    let o = 0
    for (const f of this.frames) {
      out.set(f, o)
      o += f.length
    }
    if (sink.kind === 'take') {
      this.cancelTake()
      this.sink = undefined
    }
    this.reset()
    sink.done(out)
  }

  private frame(f: Float32Array): void {
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    const rms = Math.sqrt(sum / f.length)
    const isSpeech = rms > Math.max(0.012, this.floor * 3)
    this.onLevel?.(micLevel(rms), isSpeech)
    if (!this.sink) return
    if (!isSpeech) this.floor = this.floor * 0.95 + rms * 0.05 // the room's noise, followed while quiet
    if (!this.speaking) {
      this.pre.push(f)
      if (this.pre.length > PRE_ROLL) this.pre.shift()
      this.loud = isSpeech ? this.loud + 1 : 0
      if (this.loud >= 2) {
        this.speaking = true
        this.frames = [...this.pre]
        this.pre = []
        this.startedAt = 0
        this.heardMs = this.loud * FRAME_MS
        this.quietMs = 0
      }
      return
    }
    this.frames.push(f)
    this.startedAt += FRAME_MS
    if (isSpeech) {
      this.heardMs += FRAME_MS
      this.quietMs = 0
    } else this.quietMs += FRAME_MS
    const heardSomething = this.heardMs >= VOICE_LIMITS.minSpeechMs
    if ((heardSomething && this.quietMs >= VOICE_LIMITS.silenceMs) || this.startedAt >= this.sink.maxMs) {
      // a cough in listen mode is dropped, not sent
      if (this.sink.kind === 'listen' && !heardSomething) return this.reset()
      this.finish()
    }
  }
}

/** RMS to a 0..1 meter: square root so quiet speech still moves it, full at about 0.1 RMS (loud, close speech). */
export function micLevel(rms: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, rms) / 0.1))
}

/**
 * The wake phrase was heard: two bright notes, louder than the take tones, so the owner knows without looking
 * (alone: "speak now"; with a prompt: "got it, it is in the composer").
 */
export function wakeChime(): void {
  try {
    const ctx = new AudioContext()
    const notes: Array<[number, number]> = [
      [988, 0],
      [1319, 0.13]
    ]
    for (const [freq, at] of notes) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'triangle'
      o.frequency.setValueAtTime(freq, ctx.currentTime + at)
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + at + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.22)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + 0.24)
    }
    setTimeout(() => void ctx.close().catch(() => {}), 600)
  } catch {
    /* no audio output: the composer's state line still says it */
  }
}

/** A short rising (start) or falling (end) tone, so the owner knows when the app is listening. */
export function chime(up: boolean): void {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(up ? 660 : 880, ctx.currentTime)
    o.frequency.linearRampToValueAtTime(up ? 880 : 660, ctx.currentTime + 0.12)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.2)
    o.onended = () => void ctx.close().catch(() => {})
  } catch {
    /* no audio output: the composer's state line still says it */
  }
}
