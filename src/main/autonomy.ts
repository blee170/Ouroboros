import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatusPayload } from '@shared/protocol'
import type { AgentSnapshot, ClaudeOptions, HookEvent, NodeData } from '@shared/types'
import { LIMIT_PROMPT, LIMIT_RETRY_MINUTES, NUDGE_PROMPT, RESUME_PROMPT, START_GRACE_MINUTES, autonomyBrief, autonomyDispatchRefusal, autonomyRetryRefusal, autonomySettingsFragment, endsEarly, isUsageLimit, newRunState, relaunchAction, reportMarkdown, stallActions, staleStarting, type AutonomyConfig, type AutonomyPublic, type CardEvidence, type RunEvent, type RunState } from '@shared/autonomy'
import { failureOf } from '@shared/status'
import type { Board } from './board'
import type { Task } from '@shared/ledger'
import type { Mail } from '@shared/mail'
import type { ReportMeta } from '@shared/notion'
import type { NotionResult } from './notion'

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
  /** Board mail, for the report's Mail line and unhandled escalations. */
  mail?(): Mail[]
  /**
   * The report publisher (Notion) for a run, resolved from Settings when the run *starts*: a card that rewrites the
   * settings file during the night cannot redirect the morning report. Undefined when publishing is off; the
   * publisher itself is never awaited before the note is on the canvas.
   */
  publisher?(): ((markdown: string, run: Omit<ReportMeta, 'project'>) => Promise<NotionResult>) | undefined
  now?: () => number
}

const TICK_MS = 30_000

/** A card between turns: idle, done, or stopped on an error (not the SessionStart after an auto-compaction, which comes mid-turn). */
const turnOver = (status: string | undefined, detail: string | undefined): boolean =>
  (status === 'idle' && detail !== 'session compact') || status === 'done' || (status === 'needs-you' && !!failureOf(detail))

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
  /** cards still on the run's deny rules and auto mode after it stopped: relaunched (same conversation) once their turn is over */
  private unrail = new Set<string>()
  private ended: AutonomyPublic['ended']
  private publishTo: ((markdown: string, run: Omit<ReportMeta, 'project'>) => Promise<NotionResult>) | undefined
  private readonly onStatus = (p: AgentStatusPayload): void => this.handleStatus(p)
  private readonly onHook = (p: { nodeId: string; event: HookEvent }): void => this.handleHook(p)
  private readonly onStop = (nodeId: string, message: string): void => this.handleStop(nodeId, message)
  private readonly onAfterRun = (p: AgentStatusPayload): void => this.handleAfterRun(p)

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
    this.publishTo = this.host.publisher?.()
    this.state = newRunState(config, now)
    this.events = []
    this.ended = undefined
    this.lastBusyAt = now
    this.briefPending.clear()
    this.resumePending.clear()
    this.clearUnrail()
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
    const reportPath = this.reportPath
    const logPath = this.logPath
    const agents = this.host.agents()
    const tasks = this.host.tasks?.() ?? []
    const mail = this.host.mail?.() ?? []
    let saveError = this.writeReport(reportMarkdown(s, this.events, agents, {}, tasks, mail))
    this.ended = { at: s.stopped.at, reason, reportPath: this.reportPath }
    this.host.changed(this.public())
    if (opts.quick) {
      // the window is closing and the process may quit under a request: say so instead of publishing into the void
      if (this.publishTo) this.record({ kind: 'notion', detail: 'not published: window closed before the run ended; the report file is complete' })
      return this.public()
    }
    this.dropRails()
    const evidence: Record<string, CardEvidence> = {}
    for (const a of agents) {
      if (a.kind === 'note' || a.kind === 'browser') continue
      const n = this.host.board.nodes.get(a.id)
      const cwd = n?.data.worktree?.path || a.cwd
      const ev = await this.host.evidence(cwd).catch(() => undefined)
      if (ev) evidence[a.id] = ev
    }
    const md = reportMarkdown(s, this.events, agents, evidence, tasks, this.host.mail?.() ?? mail)
    saveError = this.writeReport(md)
    this.host.addNote('Morning report', `${md}\n\n_${saveError ? `Could not save the report file (${saveError}); this note is the only copy` : `Saved at ${this.reportPath}`}_`)
    this.host.toast('Autonomous run ended', `${reason}. ${Object.keys(s.parked).length} waiting on you; the report is on the canvas${saveError ? ' (file not saved)' : ''}. Cards restart without the run's rules once their turn is over.`)
    this.publish(md, s, tasks, reportPath, logPath)
    return this.public()
  }

  /** Fire-and-forget: the note, the file and the toast never wait for Notion; the outcome goes to the run log, a failure also to a toast. */
  private publish(md: string, s: RunState, tasks: Task[], reportPath: string, logPath: string): void {
    const endedAt = s.stopped?.at ?? this.now()
    let p: Promise<NotionResult> | undefined
    try {
      p = this.publishTo?.(md, { startedAt: s.startedAt, endedAt, reason: s.stopped?.reason ?? '', waiting: Object.keys(s.parked).length + tasks.filter((t) => t.state === 'blocked').length, dispatches: s.dispatches, reportPath })
    } catch (err) {
      p = Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    if (!p) return
    // the outcome lands in *this* run's log: by then a new run may own this.logPath and this.events
    const note = (detail: string): void => {
      const full: RunEvent = { at: this.now(), kind: 'notion', detail }
      if (this.state === s) this.events.push(full)
      try {
        appendFileSync(logPath, JSON.stringify(full) + '\n')
      } catch {
        /* the toast still says it */
      }
    }
    const failed = (error: string): void => {
      note(`not published: ${error}`)
      this.host.toast('Morning report not published to Notion', `${error}. The note on the canvas and the report file are complete.`)
    }
    p.then(
      (r) => (r.ok ? note(`published ${r.url}${r.partial ? ` · ${r.partial}` : ''}`) : failed(r.error)),
      (err: unknown) => failed(err instanceof Error ? err.message : String(err))
    ).catch(() => {
      /* a toast or a log line that itself failed: nothing left to say it with */
    })
  }

  private writeReport(md: string): string | null {
    try {
      writeFileSync(this.reportPath, md, 'utf8')
      return null
    } catch (err) {
      return (err as Error).message
    }
  }

  /**
   * Every live Claude card was launched with the run's deny rules and in auto mode, and keeps both until it is
   * launched again. Relaunch each one as its own card (same conversation) once it is idle, done or stopped on an
   * error; a card mid-turn or waiting on a prompt is left until its turn is over.
   */
  private dropRails(): void {
    for (const a of this.host.agents()) if (a.ptyAlive && relaunchAction(a) === 'relaunch') this.unrail.add(a.id)
    if (!this.unrail.size) return
    this.host.board.on('status', this.onAfterRun)
    for (const a of this.host.agents()) if (this.unrail.has(a.id) && turnOver(a.status, a.statusDetail)) this.unrailCard(a.id)
  }

  private handleAfterRun(p: AgentStatusPayload): void {
    for (const id of this.unrail) if (!this.host.board.nodes.has(id)) this.unrail.delete(id) // closed cards
    if (this.unrail.has(p.nodeId)) {
      // ended, or launched again by the owner (ours delete the id first): either way its next launch is a plain one
      if (p.status === 'ended' || p.status === 'starting') this.unrail.delete(p.nodeId)
      else if (turnOver(p.status, p.statusDetail)) this.unrailCard(p.nodeId)
    }
    if (!this.unrail.size) this.clearUnrail()
  }

  private unrailCard(id: string): void {
    this.unrail.delete(id)
    const n = this.host.board.nodes.get(id)
    if (!n) return
    const prev = n.data.claude ?? {}
    const resume = this.host.agents().find((a) => a.id === id)?.sessionId || prev.resume
    const title = this.titleOf(id)
    if (!resume && !prev.continue) {
      // a relaunch would start a fresh conversation: leave the card as it is and say so
      this.record({ kind: 'relaunch', card: id, title, detail: 'run over: kept auto mode and the deny rules (no session to resume)' })
      this.host.toast('Card still on the autonomous rails', `${title} has no session to resume, so it was not restarted: restart it yourself to drop auto mode and the deny rules.`)
      return
    }
    this.record({ kind: 'relaunch', card: id, title, detail: 'run over: auto mode and deny rules off, same conversation' })
    this.host.relaunch(id, { ...prev, resume, continue: resume ? undefined : prev.continue })
  }

  private clearUnrail(): void {
    this.unrail.clear()
    this.host.board.off('status', this.onAfterRun)
  }

  /** The window is closing: end the run with what can be written synchronously. */
  dispose(): void {
    this.clearUnrail()
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
