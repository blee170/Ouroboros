import type { AgentStatus } from './types'

/** Only a card in a turn changes its files by itself: the others refresh their git summary on a status change alone. */
export function pollsChanges(status: AgentStatus): boolean {
  return status === 'working' || status === 'needs-you'
}

/**
 * How often a card's git summary is polled: every 30s in a turn, else every 2 minutes (a terminal card, or files
 * another card or the owner changed in its folder, change nothing in its status).
 */
export function changesPollMs(status: AgentStatus): number {
  return pollsChanges(status) ? 30_000 : 120_000
}

/** A poll tick that is skipped while the window is hidden, with one catch-up load when it shows again. */
export function hiddenAwarePoll(load: () => void, hidden: () => boolean): { tick(): void; visible(): void } {
  let missed = false
  return {
    tick: () => {
      if (hidden()) missed = true
      else load()
    },
    visible: () => {
      if (hidden() || !missed) return
      missed = false
      load()
    }
  }
}
