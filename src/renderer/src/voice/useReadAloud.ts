import { useEffect, useRef } from 'react'
import { useBoard } from '@/store/board'
import { announceSettings, readAloudExchange, type AnnouncePayload, type ReadAloudIO, type ReadAloudSend } from '@shared/announce'
import { voiceSettings } from '@shared/voice'
import { holdAnnouncements, speakText, speechSettled } from '@/lib/speak'

/**
 * "Shall I read it?" after a spoken decision. The announcement itself still never carries the reply; the decision
 * is read out only on a spoken yes, and an answer said afterwards goes to that card once it has been read back and
 * confirmed with another yes. One exchange at a time: a decision announced meanwhile gets its announcement only,
 * and other announcements wait until the exchange is over, so the microphone never hears them as an answer.
 *
 * `ask` takes one utterance from the composer's microphone (useVoice); `send` types the answer into the card as
 * the owner's words, like the composer does.
 */
export function useReadAloud(ask: () => Promise<string | undefined>, send: (nodeId: string, text: string) => ReadAloudSend): void {
  const askRef = useRef(ask)
  askRef.current = ask
  const sendRef = useRef(send)
  sendRef.current = send
  const running = useRef(false)

  useEffect(() => {
    // the composer going away abandons an exchange: a reading stops after the piece playing, the held announcements go
    const stop = new AbortController()
    const io: ReadAloudIO = {
      say: speakText,
      hear: () => askRef.current(),
      send: (nodeId, text) => sendRef.current(nodeId, text),
      settled: speechSettled,
      hold: holdAnnouncements
    }
    const off = window.ouroboros.board.onAnnounce((p: AnnouncePayload) => {
      if (p.kind !== 'decision' || !p.read || !p.nodeId || running.current) return
      const settings = useBoard.getState().settings
      if (!announceSettings(settings).readAloud || !voiceSettings(settings.voice).enabled) return
      running.current = true
      void readAloudExchange(p, p.nodeId, p.read, io, stop.signal)
        .catch((err: Error) => console.warn(`[read-aloud] ${err.message}`))
        .finally(() => {
          running.current = false
        })
    })
    return () => {
      stop.abort()
      off()
    }
  }, [])
}
