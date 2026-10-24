import { EventEmitter } from 'node:events'
import type { AgentStatusPayload } from '@shared/protocol'
import { claimTask, createTask, emptyLedger, filterTasks, releaseTasksOf, sanitizeLedger, updateTask, type LedgerData, type LedgerResult, type Task, type TaskFilter, type TaskInput, type TaskPatch } from '@shared/ledger'
import type { Board } from './board'

/** A card that ended and did not come back within this long has its doing tasks released (a restart brings it back sooner). */
export const RELEASE_GRACE_MS = 20_000
const SAVE_DELAY_MS = 300

/**
 * The live task ledger of one window. Main owns it: the task_* tools, the owner's Tasks tab and the morning
 * report all go through here. Every change is pushed as 'change' (the full task list) and saved into the
 * board file a moment later through the save callback.
 */
export class Ledger extends EventEmitter {
  data: LedgerData = emptyLedger()
  private saveTimer?: NodeJS.Timeout
  private releaseTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private save: (data: LedgerData) => void,
    private saveDelayMs = SAVE_DELAY_MS
  ) {
    super()
  }

  /** Replace the ledger with what the board file holds (a project was opened). Emits, does not save. */
  load(raw: unknown): void {
    this.cancelReleases()
    this.data = sanitizeLedger(raw)
    this.emit('change', this.data.tasks)
  }

  /** Release the tasks of cards that end and do not come back; cancel when the card returns (a restart). */
  attach(board: Board): void {
    board.on('status', (p: AgentStatusPayload) => {
      if (p.status === 'ended') this.cardStopped(board, p.nodeId)
      else this.cancelRelease(p.nodeId)
    })
  }

  /**
   * A card's process ended (its status, or an explicit kill, which emits no exit): its doing tasks go back to
   * todo after a grace period unless the card is alive again by then (a restart) or was removed meanwhile.
   */
  cardStopped(board: Board, nodeId: string): void {
    if (this.releaseTimers.has(nodeId) || !this.data.tasks.some((t) => t.owner === nodeId && t.state === 'doing')) return
    const title = board.nodes.get(nodeId)?.data.title ?? nodeId
    this.releaseTimers.set(
      nodeId,
      setTimeout(() => {
        this.releaseTimers.delete(nodeId)
        // a card whose process is alive again (a restart) keeps its tasks; a killed card's stale status does not count
        if (board.ptyAlive.has(nodeId)) return
        this.release(nodeId, title)
      }, RELEASE_GRACE_MS)
    )
  }

  private cancelRelease(nodeId: string): void {
    const pending = this.releaseTimers.get(nodeId)
    if (!pending) return
    clearTimeout(pending)
    this.releaseTimers.delete(nodeId)
  }

  list(filter?: TaskFilter): Task[] {
    return filterTasks(this.data.tasks, filter)
  }

  get(id: string): Task | undefined {
    return this.data.tasks.find((t) => t.id === id)
  }

  create(input: TaskInput, by: string): LedgerResult {
    return this.commit(createTask(this.data, input, by))
  }

  claim(id: string, cardId: string, liveCards: ReadonlySet<string>): LedgerResult {
    return this.commit(claimTask(this.data, id, cardId, liveCards))
  }

  update(id: string, patch: TaskPatch, by: string): LedgerResult {
    return this.commit(updateTask(this.data, id, patch, by))
  }

  /** A card is gone: its doing tasks go back to todo. Returns the released ids. */
  release(cardId: string, cardTitle: string): string[] {
    this.cancelRelease(cardId)
    const r = releaseTasksOf(this.data, cardId, cardTitle)
    if (r.released.length) this.set(r.data)
    return r.released
  }

  /** Write now (the window is closing). */
  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.save(this.data)
  }

  dispose(): void {
    this.flush()
    this.cancelReleases()
    this.removeAllListeners()
  }

  private commit(r: LedgerResult): LedgerResult {
    if (r.ok) this.set(r.data)
    return r
  }

  private set(data: LedgerData): void {
    this.data = data
    this.emit('change', this.data.tasks)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save(this.data)
    }, this.saveDelayMs)
  }

  private cancelReleases(): void {
    for (const t of this.releaseTimers.values()) clearTimeout(t)
    this.releaseTimers.clear()
  }
}
