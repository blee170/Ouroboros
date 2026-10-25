import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import { DEFAULT_VOICE, isNonSpeech, validAccelerator, voiceSettings, wavFromFloat32, VOICE_LIMITS, type VoiceSettings as Voice } from '@shared/voice'
import { Mic } from '@/voice/mic'

/**
 * Settings → Voice input: the composer's mic button and hotkey, the speech-to-text engine (the OpenAI key the
 * announcements use, or a local whisper.cpp server), the microphone, auto-send, and the wake phrase.
 */
export function VoiceSettings() {
  const raw = useBoard((s) => s.settings.voice)
  const setSettings = useBoard((s) => s.setSettings)
  const v = voiceSettings(raw)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [hasKey, setHasKey] = useState(false)
  const [msg, setMsg] = useState('')
  const [testing, setTesting] = useState(false)
  const [hotkey, setHotkey] = useState(v.hotkey)
  const save = (patch: Partial<Voice>): void => void setSettings({ voice: { ...(raw ?? {}), ...patch } })

  const loadDevices = (): void => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')))
      .catch(() => setDevices([]))
  }
  useEffect(() => {
    loadDevices()
    void window.ouroboros.tts.keys().then((k) => setHasKey(k.openai))
  }, [])

  // say something, see what the engine wrote: the whole path (mic, engine, key or server) in one press
  const test = async (): Promise<void> => {
    setTesting(true)
    setMsg('Listening… say a sentence.')
    let mic: Mic | undefined
    try {
      mic = await Mic.open(v.micDeviceId || undefined)
      const label = mic.label
      loadDevices() // labels appear once the mic was allowed
      const samples = await mic.take()
      mic.close()
      mic = undefined
      if (!samples) return setMsg(`Heard nothing from ${label || 'the microphone'}. Pick another microphone above, or check Windows Settings → System → Sound → Input.`)
      setMsg(v.stt === 'whisper' ? 'Writing it down (the first time starts the whisper server; a large model can take a minute)…' : 'Writing it down…')
      const r = await window.ouroboros.voice.transcribe(wavFromFloat32(samples, VOICE_LIMITS.sampleRate))
      setMsg(r.ok ? (isNonSpeech(r.text) ? `${label}: no words recognised.` : `${label}: “${r.text}”`) : `Voice: ${r.error}`)
    } catch (err) {
      setMsg(`Microphone: ${(err as Error).message}`)
    } finally {
      mic?.close()
      setTesting(false)
    }
  }

  const whisperReady = Boolean(v.whisperServerPath && v.whisperModelPath)
  return (
    <section className="settings-section">
      <h4>Voice input</h4>
      <label className="check">
        <input type="checkbox" checked={v.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Speak prompts into the composer (mic button and a hotkey that works with the window hidden)
      </label>
      <div className="hint">With no card checked the composer talks to the Conductor. What you say is written into the composer; you press Send, or turn on auto-send below.</div>
      <label className="field">
        <span>Hotkey</span>
        <div className="ctl">
          <input
            className="text"
            value={hotkey}
            onChange={(e) => setHotkey(e.target.value)}
            onBlur={() => {
              const h = hotkey.trim()
              if (validAccelerator(h)) save({ hotkey: h })
              else {
                setMsg('A hotkey needs a modifier and one key, like Ctrl+Alt+Space or Ctrl+Shift+F9.')
                setHotkey(v.hotkey)
              }
            }}
          />
        </div>
        <div className="hint">Press once to talk; it stops by itself after a pause (or press again). Default {DEFAULT_VOICE.hotkey.replace('CommandOrControl', 'Ctrl')}.</div>
      </label>
      <label className="field">
        <span>Microphone</span>
        <div className="ctl">
          <select className="text" value={v.micDeviceId ?? ''} onChange={(e) => save({ micDeviceId: e.target.value || undefined })} onFocus={loadDevices}>
            <option value="">System default input</option>
            {v.micDeviceId && !devices.some((d) => d.deviceId === v.micDeviceId) && <option value={v.micDeviceId}>(saved microphone, not connected now)</option>}
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1} (press Test to see names)`}
              </option>
            ))}
          </select>
          <button className="btn" disabled={testing} onClick={() => void test()}>
            {testing ? 'Listening…' : 'Test'}
          </button>
        </div>
      </label>
      <label className="field">
        <span>Speech to text</span>
        <div className="ctl">
          <select className="text" value={v.stt} onChange={(e) => save({ stt: e.target.value as Voice['stt'] })}>
            <option value="openai">OpenAI (cloud, ~$0.003/min)</option>
            <option value="whisper">Local whisper.cpp (free)</option>
          </select>
          <select className="text" value={v.language} onChange={(e) => save({ language: e.target.value as Voice['language'] })}>
            <option value="auto">Any language</option>
            <option value="ko">Korean</option>
            <option value="en">English</option>
          </select>
        </div>
        {v.stt === 'openai' && <div className="hint">{hasKey ? 'Uses the OpenAI key saved under Announcements.' : 'Save an OpenAI key under Announcements (pick OpenAI as the voice engine to see its key field); only the recording of each take is sent.'}</div>}
      </label>
      {v.stt === 'whisper' && (
        <>
          <label className="field">
            <span>whisper-server</span>
            <div className="ctl">
              <input className="text" placeholder="C:\whisper\whisper-server.exe" defaultValue={v.whisperServerPath ?? ''} onBlur={(e) => save({ whisperServerPath: e.target.value.trim() || undefined })} />
            </div>
          </label>
          <label className="field">
            <span>Model</span>
            <div className="ctl">
              <input className="text" placeholder="C:\whisper\ggml-large-v3-turbo.bin" defaultValue={v.whisperModelPath ?? ''} onBlur={(e) => save({ whisperModelPath: e.target.value.trim() || undefined })} />
            </div>
            <div className="hint">From github.com/ggml-org/whisper.cpp releases (a CUDA build for an NVIDIA card) and a ggml model (large-v3-turbo for Korean). The app starts the server on 127.0.0.1 when first needed and stops it on quit; audio never leaves the PC.</div>
          </label>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={v.autoSend} onChange={(e) => save({ autoSend: e.target.checked })} /> Send what I said after a 3-second countdown (Esc cancels)
      </label>
      <label className="check">
        <input type="checkbox" checked={v.wake} disabled={v.stt !== 'whisper' || !whisperReady} onChange={(e) => save({ wake: e.target.checked })} /> Listen for a wake phrase
      </label>
      <label className="field">
        <span>Wake phrase</span>
        <div className="ctl">
          <input className="text" defaultValue={v.wakePhrase} maxLength={40} onBlur={(e) => save({ wakePhrase: e.target.value.trim() || DEFAULT_VOICE.wakePhrase })} />
        </div>
        <div className="hint">
          {v.stt !== 'whisper' || !whisperReady
            ? 'Needs the local whisper server: every sentence spoken near the PC is written down to look for the phrase, so it never goes to the cloud.'
            : 'Any language (e.g. “우로보로스” or “Hey Chief”). Say it alone and wait for the tone, or say it with the prompt in one go: “Ouroboros, run the tests”. The microphone stays on while this is ticked (Windows shows the mic-in-use icon), and the GPU works on every sentence it hears.'}
        </div>
      </label>
      {msg && <div className="small">{msg}</div>}
    </section>
  )
}
