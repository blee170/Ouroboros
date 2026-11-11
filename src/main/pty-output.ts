/**
 * PTY output on its way to a window, batched per card: one IPC message per card every ~16 ms instead of one per
 * node-pty chunk. Only the send is batched; everything in main that reads the raw chunks still sees each one as it
 * comes. A card's pending output is flushed before its exit is sent and before its window goes.
 */
export const OUTPUT_BATCH_MS = 16

export class OutputBatcher<T> {
  private pending = new Map<string, { target: T; data: string }>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private send: (target: T, nodeId: string, data: string) => void,
    private ms = OUTPUT_BATCH_MS
  ) {}

  push(target: T, nodeId: string, data: string): void {
    const p = this.pending.get(nodeId)
    if (p && p.target !== target) this.flush(nodeId) // the card moved window: what came before goes where it was meant
    const cur = this.pending.get(nodeId)
    if (cur) cur.data += data
    else this.pending.set(nodeId, { target, data })
    if (!this.timer) this.timer = setTimeout(() => this.flushAll(), this.ms)
  }

  /** Send one card's pending output now. */
  flush(nodeId: string): void {
    const p = this.pending.get(nodeId)
    if (!p) return
    this.pending.delete(nodeId)
    this.send(p.target, nodeId, p.data)
  }

  /** Send the pending output of every card of one window now. */
  flushTarget(target: T): void {
    for (const [id, p] of [...this.pending]) if (p.target === target) this.flush(id)
  }

  flushAll(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const id of [...this.pending.keys()]) this.flush(id)
  }
}
