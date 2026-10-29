import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useBoard } from '@/store/board'
import { isNonSpeech, matchWake, voiceSettings, wavFromFloat32, VOICE_LIMITS } from '@shared/voice'
import { Mic, chime, wakeChime } from './mic'

export type VoiceState = 'off' | 'idle' | 'recording' | 'transcribing'

/**
 * Settings' mic tests: while one runs, the composer lets go of the microphone (two streams on one device make
 * Windows end the first one, silently) and ignores what it hears; afterwards the wake listener opens it again.
 */
let wakePaused = 0
const pauseListeners = new Set<(paused: boolean) => void>()
export function pauseWake(on: boolean): void {
  const was = wakePaused > 0
  wakePaused = Math.max(0, wakePaused + (on ? 1 : -1))
  const now = wakePaused > 0
  if (was !== now) for (const l of pauseListeners) l(now)
}
/** How long the wake listener waits before opening a microphone that ended, and how often it tries. */
const REOPEN_MS = 1500
const REOPEN_TRIES = 5

/**
 * Push-to-talk (the mic button, the global hotkey) and, when it is on, the wake phrase, for the left composer.
 * `onText` gets each transcript; `fromWake` says it came with the wake phrase ("Ouroboros, run the tests").
 */
export function useVoice(onText: (text: string, fromWake: boolean) => void): { state: VoiceState; message: string; toggle: () => void; wakeOn: boolean; meterRef: MutableRefObject<HTMLElement | null> } {
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
  /** the element that shows the mic's live level (--mic-level 0..1, data-speech while the gate hears speech) */
  const meterRef = useRef<HTMLElement | null>(null)
  /** bumped to make the wake listener open the microphone again (it ended, or a Settings test gave it back) */
  const [wakeRound, setWakeRound] = useState(0)
  const reopenTries = useRef(0)

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
          // written straight to the element: a React state update 15 times a second would re-render the sidebar
          m.onLevel = (level, speech) => {
            const el = meterRef.current
            if (!el) return
            el.style.setProperty('--mic-level', level.toFixed(2))
            el.toggleAttribute('data-speech', speech)
          }
          m.onEnded = () => {
            if (mic.current !== m) return
            epoch.current++
            mic.current = null
            m.close()
            if (!wakeRef.current) return
            // after the take the close settled ("Did not hear anything"), so this line is the one that stays
            setTimeout(() => setMessage('Microphone stopped (a device change, or another app took it); opening it again…'), 0)
            setTimeout(() => setWakeRound((n) => n + 1), REOPEN_MS)
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
  /** the queued take comes from the wake phrase, whose chime already said "speak now" */
  const wakeHeard = useRef(false)

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
      if (busy.current || wakePaused > 0) return
      busy.current = true
      void toText(samples)
        .then((text) => {
          if (!text) return
          const w = matchWake(text, phraseRef.current)
          if (!w.matched) return
          // heard: say so by ear right away (the take that follows skips its own start tone)
          wakeChime()
          if (w.rest && !isNonSpeech(w.rest)) onTextRef.current(w.rest, true)
          else {
            takeQueued.current = true
            wakeHeard.current = true
          }
        })
        .catch((err: Error) => setMessage(`Voice: ${err.message}`))
        .finally(() => {
          busy.current = false
          if (takeQueued.current) {
            takeQueued.current = false
            void takeRef.current()
          } else if (wakeRef.current && mic.current && mic.current !== m) {
            // the mic was reopened while this clip was being written down: the new one gets the listener
            listen(mic.current)
          }
        })
    })
  }, [toText])

  const take = useCallback(async (): Promise<void> => {
    if (wakePaused > 0) return // a Settings test holds the microphone
    if (busy.current) {
      // a wake clip is being written down: the take follows it instead of being dropped
      takeQueued.current = true
      return
    }
    busy.current = true
    try {
      setMessage('')
      const afterWake = wakeHeard.current
      wakeHeard.current = false
      const m = await openMic()
      if (!afterWake) chime(true)
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
    let retry: ReturnType<typeof setTimeout> | undefined
    void window.ouroboros.voice.setListening(true)
    // a Settings test takes the microphone: let go of it, and open it again when the test is over. Registered
    // before anything else: a run that starts during a test must still hear the test end.
    const onPause = (paused: boolean): void => {
      if (paused) closeMic()
      else setWakeRound((n) => n + 1)
    }
    pauseListeners.add(onPause)
    const done = (): void => {
      cancelled = true
      clearTimeout(retry)
      pauseListeners.delete(onPause)
      void window.ouroboros.voice.setListening(false)
    }
    if (wakePaused > 0) return done // a Settings test has the mic now
    // a reopen round while a take already holds a fresh mic (the owner pressed the button meanwhile): keep it
    if (mic.current || busy.current) return () => done()
    closeMic()
    void openMic()
      .then((m) => {
        reopenTries.current = 0
        setMessage('')
        if (!cancelled && !busy.current) listen(m)
      })
      .catch((err: Error) => {
        if (cancelled || wakePaused > 0) return
        // the device may be back in a moment (a headset reconnecting): a few more tries, then the message stays
        const again = reopenTries.current < REOPEN_TRIES
        if (again) reopenTries.current++
        setMessage(`Microphone: ${err.message}${again ? ' — trying again…' : ''}`)
        if (again) retry = setTimeout(() => setWakeRound((n) => n + 1), REOPEN_MS * 2)
      })
    return () => {
      done()
      closeMic()
    }
  }, [wakeOn, v.micDeviceId, wakeRound, openMic, closeMic, listen])

  useEffect(() => () => closeMic(), [closeMic])

  return { state, message, toggle, wakeOn, meterRef }
}
