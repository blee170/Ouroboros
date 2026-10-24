import { useEffect, useState } from 'react'
import type { ChangesSummary } from '@shared/protocol'
import type { AgentStatus } from '@shared/types'

const POLL_MS = 30_000

/** Uncommitted git changes of a card's folder; refreshed when the card's status changes and every 30s. */
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
    const iv = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearTimeout(t)
      clearInterval(iv)
    }
  }, [cwd, status])
  return changes
}
