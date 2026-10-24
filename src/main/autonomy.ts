import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatusPayload } from '@shared/protocol'
import type { AgentSnapshot, ClaudeOptions, HookEvent, NodeData } from '@shared/types'
import { LIMIT_PROMPT, LIMIT_RETRY_MINUTES, NUDGE_PROMPT, RESUME_PROMPT, START_GRACE_MINUTES, autonomyBrief, autonomyDispatchRefusal, autonomyRetryRefusal, autonomySettingsFragment, endsEarly, isUsageLimit, newRunState, relaunchAction, reportMarkdown, stallActions, staleStarting, type AutonomyConfig, type AutonomyPublic, type CardEvidence, type RunEvent, type RunState } from '@shared/autonomy'
import type { Board } from './board'
import type { Task } from '@shared/ledger'

export type { AutonomyPublic }

/** Everything the run needs from the window: injected so the controller runs without Electron in tests. */
export interface AutonomyHost {
  board: Board
  agents(): AgentSnapshot[]
  sendPrompt(id: string, text: string): boolean
  removeCard(id: string): void
  /** Restart a Claude card with new launch options (same conversation when `resume` is set). */
  relaunch(id: string, claude: ClaudeOptions): void
  /** Put a note card on the canvas (the morning report). */
  addNote(title: string, note: string): void
  /** Tell the renderer the run changed. */
  changed(state: AutonomyPublic): void
  toast(title: string, body: string): void
  /** Keep the machine awake; returns the release. */
  keepAwake(): () => void
  /** Where the event log and the report go (created on demand). */
  dir: string
  /** Uncommitted-changes summary for a folder, for the report's evidence column. */
  evidence(cwd: string): Promise<CardEvidence | undefined>
  /** The task ledger, for the report's Tasks section and the blocked tasks under "Waiting on you". */
  tasks?(): Task[]
  now?: () => number
}

const TICK_MS = 30_000

/**
 * One window's autonomous run. The rails are enforced here and in the handlers that consult it
 * (create_agent caps and permission mode, the deny rules written into every launch), never by a prompt.
 */
export class Autonomy {
  private state: RunState | null = null
  private events: RunEvent[] = []
  private logPath = ''
  private reportPath = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private release: (() => void) | null = null
  private lastBusyAt = 0
  /** relaunched Conductors that still owe the brief, and relaunched cards cut mid-turn that owe a "continue" */
  private briefPending = new Set<string>()
  private resumePending = new Set<string>()
  private ended: AutonomyPublic['ended']
  private readonly onStatus = (p: AgentStatusPayload): void => this.handleStatus(p)
  private readonly onHook = (p: { nodeId: string; event: HookEvent }): void => this.handleHook(p)
  private readonly onStop = (nodeId: string, message: string): void => this.handleStop(nodeId, message)

  constructor(private host: AutonomyHost) {}

  get on(): boolean {
    return this.state !== null && !this.state.stopped
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now()
  }

  public(): AutonomyPublic {
    const s = this.state
    const parked = s ? Object.entries(s.parked).map(([id, p]) => ({ id, title: p.title, reason: p.reason, at: p.at })) : []
    return { on: this.on, startedAt: s?.startedAt, until: s?.config.until, dispatches: s?.dispatches ?? 0, maxDispatches: s?.config.maxDispatches, parked, ended: this.ended }
  }

  /** Begin a run: keep-awake, the log, relaunch the live Claude cards in auto mode with the rails, brief the Conductors. */
  start(config: AutonomyConfig): AutonomyPublic {
    if (this.on) return this.public()
    const now = this.now()
    // the fallible steps first: a run is never half on
    mkdirSync(this.host.dir, { recursive: true })
    const d = new Date(now)
    const two = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}` // local time, like the report's title
    this.logPath = join(this.host.dir, `run-${stamp}.jsonl`)
    this.reportPath = join(this.host.dir, `run-${stamp}.md`)
    this.release = this.host.keepAwake()
    this.state = newRunState(config, now)
    this.events = []
    this.ended = undefined
    this.lastBusyAt = now
    this.briefPending.clear()
    this.resumePending.clear()
    this.record({ kind: 'start', detail: `until ${new Date(config.until).toLocaleTimeString()} · ${config.maxDispatches} dispatches · stall ${config.stallMinutes} min` })
    for (const a of this.host.agents()) {
      const action = relaunchAction(a)
      if (action === 'close') {
        this.record({ kind: 'closed', card: a.id, title: a.title, detail: `${a.engine} card closed: no auto-mode rails for that engine` })
        this.host.removeCard(a.id)
      } else if (action === 'relaunch') {
        const n = this.host.board.nodes.get(a.id)
        const prev = n?.data.claude ?? {}
        // the permission mode is forced at launch while the run is on and is not written into the card, so it ends with the run;
        // the conversation continues by session id, else by what the card already had (never a bare --continue: in the
        // project root that would clone the Conductor's conversation)
        const resume = a.sessionId || prev.resume
        const claude: ClaudeOptions = { ...prev, resume, continue: resume ? undefined : prev.continue }
        this.record({ kind: 'relaunch', card: a.id, title: a.title, detail: resume ? 'auto mode, same conversation' : prev.continue ? 'auto mode, --continue' : 'auto mode, fresh conversation' })
        if (n?.data.kind === 'conductor') this.briefPending.add(a.id)
        else if (a.status === 'working') this.resumePending.add(a.id) // its turn is cut: tell it to carry on once it is back
        this.host.relaunch(a.id, claude)
      }
    }
    this.host.board.on('status', this.onStatus)
    this.host.board.on('hook', this.onHook)
    this.host.board.on('stop', this.onStop)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.host.changed(this.public())
    return this.public()
  }

  /**
   * End the run: release the machine, write the report, put it on the canvas, tell the owner. The report is
   * written at once without evidence (a closing window may not wait), then again with the git evidence.
   */
  async stop(reason: string, opts: { quick?: boolean } = {}): Promise<AutonomyPublic> {
    const s = this.state
    if (!s || s.stopped) return this.public()
    s.stopped = { at: this.now(), reason }
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host.board.off('status', this.onStatus)
    this.host.board.off('hook', this.onHook)
    this.host.board.off('stop', this.onStop)
    this.release?.()
    this.release = null
    this.briefPending.clear()
    this.resumePending.clear()
    this.record({ kind: 'stop', detail: reason })
    const agents = this.host.agents()
    const tasks = this.host.tasks?.() ?? []
    let saveError = this.writeReport(reportMarkdown(s, this.events, agents, {}, tasks))
    this.ended = { at: s.stopped.at, reason, reportPath: this.reportPath }
    this.host.changed(this.public())
    if (opts.quick) return this.public()
    const evidence: Record<string, CardEvidence> = {}
    for (const a of agents) {
      if (a.kind === 'note' || a.kind === 'browser') continue
      const n = this.host.board.nodes.get(a.id)
      const cwd = n?.data.worktree?.path || a.cwd
      const ev = await this.host.evidence(cwd).catch(() => undefined)
      if (ev) evidence[a.id] = ev
    }
    const md = reportMarkdown(s, this.events, agents, evidence, tasks)
    saveError = this.writeReport(md)
    this.host.addNote('Morning report', `${md}\n\n_${saveError ? `Could not save the report file (${saveError}); this note is the only copy` : `Saved at ${this.reportPath}`}_`)
    this.host.toast('Autonomous run ended', `${reason}. ${Object.keys(s.parked).length} waiting on you; the report is on the canvas${saveError ? ' (file not saved)' : ''}.`)
    return this.public()
  }

  private writeReport(md: string): string | null {
    try {
      writeFileSync(this.reportPath, md, 'utf8')
      return null
    } catch (err) {
      return (err as Error).message
    }
  }

  /** The window is closing: end the run with what can be written synchronously. */
  dispose(): void {
    if (this.on) void this.stop('window closed', { quick: true })
  }

  /** Settings fragment for every card launched while the run is on. */
  settingsFragment(): Record<string, unknown> | undefined {
    return this.on ? autonomySettingsFragment() : undefined
  }

  /** New cards never ask during a run: auto mode (plan stays plan). */
  permissionMode(requested: string | undefined): string | undefined {
    if (!this.on) return requested
    return requested === 'plan' ? 'plan' : 'auto'
  }

  /** What a card made during a run keeps as its own mode for after the run: never a bypass asked for under cover of the night. */
  storedPermissionMode(requested: string | undefined): string | undefined {
    if (!this.on) return requested
    return requested === 'plan' || requested === 'default' || requested === 'acceptEdits' ? requested : undefined
  }

  /** Why a prompt to this card is refused during a run, or null: shells are a way around every rule, and a parked permission prompt is the owner's to answer. */
  promptRefusal(n: Pick<NodeData, 'kind' | 'status' | 'statusDetail'>): string | null {
    if (!this.on) return null
    if (n.kind === 'terminal' || n.kind === 'command') return 'Autonomous mode: nothing is typed into terminal or command cards during a run'
    if (n.status === 'needs-you' && n.statusDetail?.startsWith('permission:')) return 'Autonomous mode: this card waits on a permission prompt; only the owner answers those'
    return null
  }

  /** create_agent during a run: the dispatch cap, and the retry cap when a card with this title is re-made. Pure check; `countDispatch` after the card exists. */
  dispatchRefusal(title: string, replacing: boolean): string | null {
    const s = this.state
    if (!s || s.stopped) return null
    const refusal = autonomyDispatchRefusal(s) ?? (replacing ? autonomyRetryRefusal(s, title) : null)
    if (refusal) this.record({ kind: 'refused', title, detail: refusal })
    return refusal
  }

  /** A card was made (or re-made) during the run. */
  countDispatch(title: string, replacing: boolean): void {
    const s = this.state
    if (!s || s.stopped) return
    s.dispatches++
    if (replacing) {
      const key = title.trim().toLowerCase()
      s.retries[key] = (s.retries[key] ?? 0) + 1
      this.record({ kind: 'retry', title, detail: `re-made (${s.retries[key]}/${s.config.maxRetriesPerTitle})` })
    } else this.record({ kind: 'dispatch', title, detail: `${s.dispatches}/${s.config.maxDispatches}` })
    this.host.changed(this.public())
  }

  private record(e: Omit<RunEvent, 'at'>): void {
    const full: RunEvent = { at: this.now(), ...e }
    this.events.push(full)
    try {
      appendFileSync(this.logPath, JSON.stringify(full) + '\n')
    } catch {
      /* the in-memory log still feeds the report */
    }
  }

  private titleOf(id: string): string {
    return this.host.board.nodes.get(id)?.data.title ?? id
  }

  private park(id: string, reason: string): void {
    const s = this.state
    if (!s || s.parked[id]) return
    s.parked[id] = { at: this.now(), title: this.titleOf(id), reason }
    this.record({ kind: 'park', card: id, title: s.parked[id].title, detail: reason })
    this.host.changed(this.public())
  }

  private handleStatus(p: AgentStatusPayload): void {
    const s = this.state
    if (!s || s.stopped) return
    if ((p.status === 'working' || p.status === 'starting') && !s.parked[p.nodeId]) this.lastBusyAt = p.at
    if (p.status === 'needs-you') this.park(p.nodeId, p.statusDetail ?? 'asked a question')
    else if (p.status === 'working' || p.status === 'done') {
      // a lead answered it within the plan, or it carried on: it is no longer waiting on the owner, nor limited
      delete s.limited[p.nodeId]
      if (s.parked[p.nodeId]) {
        delete s.parked[p.nodeId]
        delete s.nudged[p.nodeId]
        this.record({ kind: 'unpark', card: p.nodeId, title: this.titleOf(p.nodeId), detail: p.status })
        this.host.changed(this.public())
      }
    }
    if (p.status === 'idle') {
      if (this.briefPending.delete(p.nodeId)) setTimeout(() => this.on && this.host.sendPrompt(p.nodeId, autonomyBrief(s.config.until, s.config.maxDispatches)), 1200)
      else if (this.resumePending.delete(p.nodeId)) setTimeout(() => this.on && this.host.sendPrompt(p.nodeId, RESUME_PROMPT), 1200)
    }
  }

  private handleHook(p: { nodeId: string; event: HookEvent }): void {
    const s = this.state
    if (!s || s.stopped) return
    const ev = p.event
    if (ev.hook_event_name === 'PermissionDenied') {
      const input = typeof ev.tool_input === 'object' && ev.tool_input ? JSON.stringify(ev.tool_input).slice(0, 160) : ''
      this.record({ kind: 'deny', card: p.nodeId, title: this.titleOf(p.nodeId), detail: `${ev.tool_name ?? 'tool'} ${input}`.trim() })
    } else if (ev.hook_event_name === 'StopFailure' && isUsageLimit(typeof ev.message === 'string' ? ev.message : undefined)) {
      s.limited[p.nodeId] = this.now()
      this.record({ kind: 'limit', card: p.nodeId, title: this.titleOf(p.nodeId), detail: String(ev.message ?? '').slice(0, 160) })
    }
  }

  private handleStop(nodeId: string, message: string): void {
    if (!this.on) return
    this.record({ kind: 'turn', card: nodeId, title: this.titleOf(nodeId), detail: message.split('\n').find((l) => l.trim())?.trim().slice(0, 120) })
  }

  /** The clock: deadline, stalls, cards that never came up, usage-limit retries, and the early end when nothing is left to do. */
  async tick(): Promise<void> {
    const s = this.state
    if (!s || s.stopped) return
    const now = this.now()
    if (now >= s.config.until) {
      await this.stop('deadline reached')
      return
    }
    const agents = this.host.agents()
    for (const a of staleStarting(agents, s, now)) {
      this.briefPending.delete(a.id)
      this.resumePending.delete(a.id)
      this.record({ kind: 'stall', card: a.id, title: a.title, detail: `never came up (${START_GRACE_MINUTES} min)` })
      this.park(a.id, `failed to start: no session after ${START_GRACE_MINUTES} min (a stale --resume id, a trust prompt, or a crashed launch)`)
    }
    for (const act of stallActions(agents, s, now)) {
      if (act.action === 'nudge') {
        s.nudged[act.id] = now
        this.record({ kind: 'nudge', card: act.id, title: this.titleOf(act.id), detail: `silent ${s.config.stallMinutes} min` })
        this.host.sendPrompt(act.id, NUDGE_PROMPT)
      } else {
        this.record({ kind: 'stall', card: act.id, title: this.titleOf(act.id), detail: 'still silent after the nudge' })
        this.park(act.id, `stalled: no activity for ${2 * s.config.stallMinutes} min`)
      }
    }
    for (const [id, at] of Object.entries(s.limited)) {
      if (now - at < LIMIT_RETRY_MINUTES * 60_000) continue
      const a = agents.find((x) => x.id === id)
      // only a card still stuck gets the continue; one that went on by itself was cleared in handleStatus
      if (!a || !s.parked[id]) {
        delete s.limited[id]
        continue
      }
      s.limited[id] = now
      this.record({ kind: 'limit', card: id, title: this.titleOf(id), detail: 'continue sent' })
      this.host.sendPrompt(id, LIMIT_PROMPT)
    }
    if (endsEarly(agents, s, this.lastBusyAt, now)) await this.stop(Object.keys(s.parked).length ? 'nothing left to do: every card is parked, idle or done' : 'nothing left to do: every card is idle or done')
  }
}
