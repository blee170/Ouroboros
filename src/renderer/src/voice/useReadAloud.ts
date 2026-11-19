import { useEffect, useRef } from 'react'
import { useBoard } from '@/store/board'
import { announceSettings, readAloudLine, yesNo, type AnnouncePayload } from '@shared/announce'
import { voiceSettings } from '@shared/voice'
import { holdAnnouncements, speakText, speechSettled } from '@/lib/speak'

/** What `send` did with a spoken answer. */
export type ReadAloudSend = 'sent' | 'gone' | 'busy'

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
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const off = window.ouroboros.board.onAnnounce((p: AnnouncePayload) => {
      if (p.kind !== 'decision' || !p.read || !p.nodeId || running.current) return
      const settings = useBoard.getState().settings
      if (!announceSettings(settings).readAloud || !voiceSettings(settings.voice).enabled) return
      running.current = true
      void exchange(p, p.nodeId, p.read)
        .catch((err: Error) => console.warn(`[read-aloud] ${err.message}`))
        .finally(() => {
          running.current = false
        })
    })
    return () => {
      alive.current = false
      off()
    }
  }, [])

  /** One utterance, or undefined once the composer (and its microphone) is gone. */
  const hear = async (): Promise<string | undefined> => (alive.current ? askRef.current() : undefined)

  async function exchange(p: AnnouncePayload, nodeId: string, read: string): Promise<void> {
    const lang = p.lang
    // the announcement (queued by App in the same emit) first, then the question; the mic opens after both
    await speechSettled()
    const release = holdAnnouncements()
    try {
      await speakText(readAloudLine('offer', lang), lang)
      if (yesNo((await hear()) ?? '') !== 'yes') return
      await speakText(read, lang)
      await speakText(readAloudLine('listen-answer', lang), lang)
      const answer = (await hear())?.trim()
      if (!answer || yesNo(answer) === 'no') return
      await speakText(readAloudLine('confirm', lang, answer), lang)
      const ok = yesNo((await hear()) ?? '')
      if (ok !== 'yes' || !alive.current) return void (await speakText(readAloudLine(ok === 'no' ? 'cancelled' : 'unclear', lang), lang))
      const r = sendRef.current(nodeId, answer)
      await speakText(r === 'sent' ? readAloudLine('sent', lang) : readAloudLine(r, lang, p.title), lang)
    } finally {
      release()
    }
  }
}
