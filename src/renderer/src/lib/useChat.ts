import { useCallback, useEffect, useRef, useState } from 'react'
import { applyChatEvents, type ChatItem } from '@shared/chat'
import type { AgentStatus } from '@shared/types'

export interface ChatState {
  items: ChatItem[]
  /** the conversation is longer than what is shown */
  clipped: boolean
  /** the last read failed: what the owner is told (the items stay as they were) */
  error?: string
  /** the first read came back */
  loaded: boolean
}

/** Reads in one refresh at most (each up to the read cap): a burst of 30 MB is caught up in one go, anything larger over the next refreshes. */
const MAX_READS = 16

/**
 * A Claude card's conversation for the chat view: read from its transcript through main, then kept up to date
 * on every hook event of the card and on a timer (faster while it works, since a transcript line can land
 * between hooks). Reads only while `active`; what was read stays, so showing the chat again continues from there.
 */
export function useChat(nodeId: string, active: boolean, status: AgentStatus): ChatState {
  const [state, setState] = useState<ChatState>({ items: [], clipped: false, loaded: false })
  const cursor = useRef<{ key?: string; offset?: number }>({})
  const items = useRef<ChatItem[]>([])
  const clipped = useRef(false)
  const busy = useRef(false)
  const again = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    let error: string | undefined
    try {
      for (let i = 0; i < MAX_READS; i++) {
        const r = await window.ouroboros.chat.read(nodeId, cursor.current)
        if (!r.ok) {
          error = r.error ?? 'The conversation could not be read.'
          break
        }
        if (r.key === undefined) break // no transcript yet
        if (r.reset) {
          // another file is another conversation (/clear, a fresh start): what was shown stays above a divider
          const continued = cursor.current.key !== undefined && cursor.current.key !== r.key && items.current.length > 0
          items.current = applyChatEvents(continued ? [...items.current, { type: 'note', id: `new:${r.key}`, text: 'New conversation' }] : [], r.events)
          clipped.current = continued ? clipped.current || r.clipped === true : r.clipped === true
        } else items.current = applyChatEvents(items.current, r.events)
        cursor.current = { key: r.key, offset: r.offset }
        if (!r.more) break
      }
    } catch (err) {
      error = `The conversation could not be read (${err instanceof Error ? err.message : String(err)}).`
    } finally {
      busy.current = false
    }
    if (!alive.current) return
    setState((s) => (s.items === items.current && s.clipped === clipped.current && s.error === error && s.loaded ? s : { items: items.current, clipped: clipped.current, error, loaded: true }))
    if (again.current) {
      again.current = false
      void refresh()
    }
  }, [nodeId])

  useEffect(() => {
    if (!active) return
    void refresh()
    // the line a hook announces is written around the hook, not always before it: read now and once more shortly after
    let late: ReturnType<typeof setTimeout> | undefined
    const off = window.ouroboros.board.onHookEvent((p) => {
      if (p.nodeId !== nodeId) return
      void refresh()
      clearTimeout(late)
      late = setTimeout(() => void refresh(), 700)
    })
    const timer = setInterval(() => void refresh(), status === 'working' || status === 'needs-you' ? 1500 : 5000)
    return () => {
      off()
      clearTimeout(late)
      clearInterval(timer)
    }
  }, [active, nodeId, status, refresh])

  return state
}
