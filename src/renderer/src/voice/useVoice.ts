import { useCallback, useEffect, useRef, useState } from 'react'
import { useBoard } from '@/store/board'
import { isNonSpeech, matchWake, voiceSettings, wavFromFloat32, VOICE_LIMITS } from '@shared/voice'
import { Mic, chime } from './mic'

export type VoiceState = 'off' | 'idle' | 'recording' | 'transcribing'

/**
 * Push-to-talk (the mic button, the global hotkey) and, when it is on, the wake phrase, for the left composer.
 * `onText` gets each transcript; `fromWake` says it came with the wake phrase ("Ouroboros, run the tests").
 */
export function useVoice(onText: (text: string, fromWake: boolean) => void): { state: VoiceState; message: string; toggle: () => void; wakeOn: boolean } {
  const raw = useBoard((s) => s.settings.voice)
  const v = voiceSettings(raw)
  const wakeOn = v.enabled && v.wake && v.stt === 'whisper' && Boolean(v.whisperServerPath && v.whisperModelPath)
  const [state, setState] = useState<VoiceState>(v.enabled ? 'idle' : 'off')
  const [message, setMessage] = useState('')
  const mic = useRef<Mic | null>(null)
  const busy = useRef(false)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const wakeRef = useRef(wakeOn)
  wakeRef.current = wakeOn
  const deviceRef = useRef(v.micDeviceId)
  deviceRef.current = v.micDeviceId
  const phraseRef = useRef(v.wakePhrase)
  phraseRef.current = v.wakePhrase

  // one open at a time: a second caller waits for the first; a close while it opens closes what it opened
  const opening = useRef<Promise<Mic> | null>(null)
  const epoch = useRef(0)
  const openMic = useCallback(async (): Promise<Mic> => {
    if (mic.current) return mic.current
    if (!opening.current) {
      const mine = epoch.current
      opening.current = Mic.open(deviceRef.current || undefined).then(
        (m) => {
          opening.current = null
          if (mine !== epoch.current) {
            m.close()
            throw new Error('microphone closed while opening')
          }
          mic.current = m
          return m
        },
        (err) => {
          opening.current = null
          throw err
        }
      )
    }
    return opening.current
  }, [])
  const closeMic = useCallback((): void => {
    epoch.current++
    mic.current?.close()
    mic.current = null
  }, [])
  /** a take asked for while a wake clip was being written down: it runs right after */
  const takeQueued = useRef(false)

  const toText = useCallback(async (samples: Float32Array): Promise<string | undefined> => {
    const r = await window.ouroboros.voice.transcribe(wavFromFloat32(samples, VOICE_LIMITS.sampleRate))
    if (!r.ok) {
      setMessage(`Voice: ${r.error}`)
      return undefined
    }
    return isNonSpeech(r.text) ? '' : r.text
  }, [])

  // always-on: each utterance is checked for the wake phrase; the take that follows is the command
  const listen = useCallback((m: Mic): void => {
    m.listen((samples) => {
      if (busy.current) return
      busy.current = true
      void toText(samples)
        .then((text) => {
          if (!text) return
          const w = matchWake(text, phraseRef.current)
          if (!w.matched) return
          if (w.rest && !isNonSpeech(w.rest)) onTextRef.current(w.rest, true)
          else takeQueued.current = true
        })
        .catch((err: Error) => setMessage(`Voice: ${err.message}`))
        .finally(() => {
          busy.current = false
          if (takeQueued.current) {
            takeQueued.current = false
            void takeRef.current()
          }
        })
    })
  }, [toText])

  const take = useCallback(async (): Promise<void> => {
    if (busy.current) {
      // a wake clip is being written down: the take follows it instead of being dropped
      takeQueued.current = true
      return
    }
    busy.current = true
    try {
      setMessage('')
      const m = await openMic()
      chime(true)
      setState('recording')
      const samples = await m.take()
      chime(false)
      // the mic may have been closed under the take (a setting changed): then whoever closed it decides what is next
      if (mic.current === m) {
        if (wakeRef.current) listen(m)
        else closeMic() // the mic (and Windows' mic-in-use light) is only on while needed
      }
      if (!samples) {
        setMessage('Did not hear anything.')
        return
      }
      setState('transcribing')
      let text: string | undefined
      try {
        text = await toText(samples)
      } catch (err) {
        setMessage(`Voice: ${(err as Error).message}`)
        return
      }
      if (text === '') setMessage('Did not catch any words.')
      else if (text) onTextRef.current(text, false)
    } catch (err) {
      setMessage(`Microphone: ${(err as Error).message}`)
      closeMic()
    } finally {
      busy.current = false
      setState('idle')
    }
  }, [openMic, closeMic, listen, toText])
  const takeRef = useRef(take)
  takeRef.current = take

  const toggle = useCallback((): void => {
    if (!voiceSettings(useBoard.getState().settings.voice).enabled) return
    if (mic.current && state === 'recording') mic.current.stop()
    else void takeRef.current()
  }, [state])
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  useEffect(() => window.ouroboros.voice.onHotkey(() => toggleRef.current()), [])

  useEffect(() => {
    if (!v.enabled) closeMic() // a take in flight settles with nothing
    if (!busy.current) setState(v.enabled ? 'idle' : 'off')
  }, [v.enabled, closeMic])

  // the wake word: the mic stays open and listening while it is on (a device change reopens it)
  useEffect(() => {
    if (!wakeOn) {
      void window.ouroboros.voice.setListening(false)
      if (!busy.current) closeMic()
      return
    }
    let cancelled = false
    void window.ouroboros.voice.setListening(true)
    closeMic()
    void openMic()
      .then((m) => {
        if (!cancelled && !busy.current) listen(m)
      })
      .catch((err: Error) => setMessage(`Microphone: ${err.message}`))
    return () => {
      cancelled = true
      void window.ouroboros.voice.setListening(false)
      closeMic()
    }
  }, [wakeOn, v.micDeviceId, openMic, closeMic, listen])

  useEffect(() => () => closeMic(), [closeMic])

  return { state, message, toggle, wakeOn }
}
