import { useEffect, useState } from 'react'
import type { ChangesSummary } from '@shared/protocol'
import type { AgentStatus } from '@shared/types'
import { changesPollMs, hiddenAwarePoll } from '@shared/changes-poll'

/** Uncommitted git changes of a card's folder; refreshed when the card's status changes, every 30s while it works and every 2 minutes otherwise. */
export function useCardChanges(cwd: string | undefined, status: AgentStatus): ChangesSummary | null {
  const [changes, setChanges] = useState<ChangesSummary | null>(null)
  useEffect(() => {
    if (!cwd) return
    let alive = true
    const load = (): void => {
      void window.ouroboros.changes.summary(cwd).then((c) => {
        if (alive) setChanges(c)
      }).catch(() => undefined)
    }
    const t = setTimeout(load, 1200)
    const poll = hiddenAwarePoll(load, () => document.hidden)
    const iv = setInterval(poll.tick, changesPollMs(status))
    document.addEventListener('visibilitychange', poll.visible)
    return () => {
      alive = false
      clearTimeout(t)
      clearInterval(iv)
      document.removeEventListener('visibilitychange', poll.visible)
    }
  }, [cwd, status])
  return changes
}
