/**
 * PTY output in the window, routed by card: one IPC listener for all of it, and each card's terminal is called
 * only for its own output (it used to filter every card's chunks itself).
 */
export interface DataRouter {
  on(nodeId: string, cb: (data: string) => void): () => void
  dispatch(nodeId: string, data: string): void
}

export function createDataRouter(): DataRouter {
  const byNode = new Map<string, Set<(data: string) => void>>()
  return {
    on(nodeId, cb) {
      let set = byNode.get(nodeId)
      if (!set) byNode.set(nodeId, (set = new Set()))
      set.add(cb)
      const mine = set
      return () => {
        mine.delete(cb)
        if (!mine.size && byNode.get(nodeId) === mine) byNode.delete(nodeId)
      }
    },
    dispatch(nodeId, data) {
      const set = byNode.get(nodeId)
      if (set) for (const cb of [...set]) cb(data)
    }
  }
}
