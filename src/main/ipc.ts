import { BrowserWindow, ClipboardItem, Notification, app, clipboard, dialog, globalShortcut, ipcMain, powerSaveBlocker, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { transcribe } from './stt'
import { voiceSettings, type VoiceSettings } from '@shared/voice'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { nanoid } from 'nanoid'
import type { AddNodePayload, AgentStatusPayload, BoardSyncPayload, ClaudeLaunchOptions, GrokReplyStatus, HandoffFiredPayload, PtySpawnOptions, NotionDatabaseKind, TtsKeyEngine, WorkspaceLoadResult } from '@shared/protocol'
import { IPC } from '@shared/protocol'
import type { HeldCard } from '@shared/board-trust'
import { normalizeEffort, normalizeEngine, type AppSettings, type ClaudeOptions, type HookEvent, type NodeData, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '@shared/types'
import { DEFAULT_HANDOFF_TEMPLATE, REPORT_TEMPLATE, selectHandoffs, renderTemplate, toPastePayload } from '@shared/handoff'
import { stripAnsi, tailLines } from '@shared/ansi'
import { detectClaudeReady, detectLaunchExit, detectMissingCommand, detectTrustQuestion, endsAtShellPrompt, failureOf } from '@shared/status'
import { BoardDone, Burst, NEEDS_YOU_REPEAT_MS, SETTLE_MS, announceSettings, firstLine, langFor, ownerMarker, phrase, stopAnnouncement, type AnnouncePayload } from '@shared/announce'
import type { Board, NodeMeta } from './board'
import { findBriefUrl, urlKey } from './briefs'
import { sendToGrokBot } from './grokbot'
import { GrokReplyServer, ReplyStore, type ReplyHandler } from './grok-reply'
import { GitHubMailbox, checkIssue } from './grok-mailbox'
import { DEFAULT_REPLY_PORT, REPLY_LIMITS, REPLY_PATH, issueInstructions, issueRef, issueUrl, replyMail, routineInstructions, type ReplyKind, type ReplyRecord } from '@shared/grokreply'
import { applyProtection, checkCardToken, readProtection, runGh } from './rulesets'
import { pushInbox, validInbox, type InboxAddress } from './claude-inbox'
import { wslPreflight } from './wsl'
import { WSL_HELPER_ENV, wslEnvNames } from '@shared/wsl'
import { autoSendHold, botMenu, botOf, botViews, grokBots, grokBotUrl, handoffPayload, newHandoff, pickBot, saveBots, type GrokBot, type GrokHandoff } from '@shared/grokbot'
import { listSkills } from './skills'
import type { RoleLibrary } from './roles'
import { filterRoles } from '@shared/roles'
import { buildGateCommand, prepareLaunch } from './claude-launcher'
import { GateKeeper, auditFile } from './gate'
import { DecisionDesk } from './decisions'
import { answersOf, askInput, decisionMessage, pendingMessage, DECISION_LIMITS, type Decision } from '@shared/decisions'
import { PhoneDevices, PhoneServer, type PhoneHandlers } from './phone-server'
import { ANSWER_KEYS, DEFAULT_PHONE_PORT, PHONE_LIMITS, isPrivateLan, isTailscale, type PhoneSettingsView, type PhoneStatus } from '@shared/phone'
import type { Approval } from '@shared/gate'
import { ROLE_PROMPT_PREFIX, roleAsMessage } from './agent-launcher'
import { setGlobalExternalHooks } from './external'
import type { ApiHandlers, GateInput, GateReply, HookReply, HookServer } from './hook-server'
import { Mailbox, mailFile } from './mail'
import { GROK_BOT, cleanTitle, deliveryNote, envelope, type MailTopology } from '@shared/mail'
import { aiTitleOf, isInterruptKey, showsInterrupt, stepOf } from '@shared/doing'
import { PtyManager, defaultShell } from './pty-manager'
import type { BrowserManager } from './browser-manager'
import { findNodeBinary } from './node-runner'
import { decryptToken, encryptToken, type Updater } from './updater'
import { synthesize, ttsKeyFor, ttsKeyPatch } from './tts'
import { ensureViews, publishReport, publishUpdate, testNotion, type NotionTarget } from './notion'
import { NOTION_VIEWS, notionDatabaseId, TASK_SCHEMA, UPDATE_SCHEMA } from '@shared/notion'
import { NotionMap, TaskSync } from './notion-sync'
import { VaultExport } from './obsidian-export'
import type { CanvasCard } from '@shared/obsidian'
import { changelogSection } from '@shared/changelog'
import changelog from '../../CHANGELOG.md?raw'

/** Dispatched cards are retired this long after their report reached the card that made them. */
const DEFAULT_RETIRE_MINUTES = 5
/** Live dispatched cards one lead may have at once. */
const DEFAULT_MAX_WORKERS = 6
import { buildCommandLine, extractCompleted, type RunningCommand } from './command-runner'
import { dispatchRefusal, protectedCards, reportedCards, selectTidyCandidates } from '@shared/tidy'
import { listBookmarks } from './bookmarks'
import { log, logPath } from './diagnostics'
import { cardGitHubEnv, claudeConfigDirOf, claudeEnvKeysToStrip, claudeLoginFromFiles, credentialEnvKeys, detectEngines } from './engines'
import { readWorkspace, saveLedger, saveWorkspace, UserStore, WORKSPACE_FILE } from './workspace-store'
import type { BoardTrust } from './board-trust'
import { Ledger } from './ledger'
import { DEFAULT_STALL_MINUTES, newWatchdogState, watchdogReports } from '@shared/watchdog'
import type { UsageMonitor } from './usage'
import { OWNER, cleanLine, cleanText, formatTasks, toApiResult, type Task, type TaskInput, type TaskPatch } from '@shared/ledger'
import { OWNER_ACTION_LIMITS, approvalMessage, didMessage, holdMessage, ownerNeed } from '@shared/owner-action'
import { Ouro } from './ouro'
import { conductorPrompt, ouroSettings, type OuroNeed, type OuroSettingsView, type OuroStatus, type OuroStatusView } from '@shared/ouro'

/** Cards that can still work: a claim by one of them holds, a claim by an ended card can be taken over. */
const samePath = (x: string, y: string): boolean => x.replace(/[\\/]+$/, '').toLowerCase() === y.replace(/[\\/]+$/, '').toLowerCase()

function liveCards(board: Board): Set<string> {
  // a killed card keeps a stale status, so the process decides; a card that has not spawned yet is starting
  return new Set(board.snapshot().filter((a) => a.status === 'starting' || (a.ptyAlive && a.status !== 'ended')).map((a) => a.id))
}
import { createWorktree, removeWorktree } from './worktree'
import { listClaudeSessions, listSubfolders, readSessionUsage, transcriptPath } from './claude-history'
import { getChanges, getDiff, revertFile } from './git-changes'
import { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint } from './checkpoints'
import { normalizePath, type SessionRegistry } from './windows'
import { openMode, resolveOpenPath } from './open-path'
import { Autonomy, type AutonomyHost } from './autonomy'
import { Relay } from './relay'
import { relaySettings } from '@shared/relay'
import { cardSettingsExtra, engineJoinsRun, type AutonomyConfig } from '@shared/autonomy'

/** One window: its BrowserWindow, its own Board and the API scoped to that board. */
export interface WindowSession {
  /** webContents id */
  id: number
  win: BrowserWindow
  board: Board
  /** Project folder this window opened with (command line / "open in new window"). */
  initialProject?: string
  api: ApiHandlers
  /** This window's Autonomous mode run (off until the owner starts one). */
  autonomy: Autonomy
  /** The ledger mirrored into the owner's Notion Tasks database (idle unless that is set up). */
  taskSync?: TaskSync
  /** The project mirrored into the owner's Obsidian vault (idle unless Settings → Obsidian is on). */
  vaultExport?: VaultExport
  /** The project's task ledger (task_* tools, the Tasks tab, the morning report). */
  ledger: Ledger
  /** Agent mail between this window's cards (send_message / check_inbox / ack, the Inspector's Mail section). */
  mail: Mailbox
  /** Autonomous runs: the action gate's decisions, the owner's approvals and the audit log. */
  gate: GateKeeper
  /** Questions this window's cards asked the owner (ask_owner), answered in Today or on the phone. */
  decisions: DecisionDesk
  /** Fresh starts: a long conversation handed to a new one through a handoff note (set once the window is up). */
  relay?: Relay
  /** Tasks cards asked to hand to Grok Bot (the last 50): each waits for the owner to send or discard it. */
  grokBot: GrokHandoff[]
  fireHandoff: (edgeId: string, manual: boolean) => { ok: boolean; error?: string }
  hasNode(nodeId: string): boolean
  /** The card selected on the canvas, as the renderer reports it: no toast or voice for the card the owner is looking at. */
  selectedNodeId: string | null
  /** One toast per card per BURST_MS, across "needs you", "failed" and "finished". */
  burst: Burst
  readonly projectRoot: string
  /** Kill this window's processes and detach its listeners. */
  dispose(): void
}

export interface MainContext {
  windows: SessionRegistry<WindowSession>
  /** Open (or focus) a window for a project folder; no folder = a fresh empty window. */
  openProjectWindow(projectRoot?: string): WindowSession
  ptys: PtyManager
  hookServer: HookServer
  /** The phone companion's server (off unless the owner turns it on in Settings → Phone). */
  phone: PhoneServer
  /** Grok Bot replies (off unless the owner turns it on in Settings → Grok Bot). */
  grokReply: { store: ReplyStore; server: GrokReplyServer; mailbox: GitHubMailbox }
  /** Ouro, the owner on Discord (off unless the owner turns it on in Settings → Ouro). */
  ouro: Ouro
  /** Account usage per engine (plan windows from the cards' status lines, Codex rollouts, Gemini sessions). */
  usage: UsageMonitor
  store: UserStore
  browsers: BrowserManager
  updater: Updater
  tmpDir: string
  mcpScriptPath: string
  /** Specialist roles for cards (.claude/agents files and the agency catalog under userData/roles). */
  roles: RoleLibrary
  /** What the app last wrote to each board file; cards changed outside it are held at open. */
  boardTrust: BoardTrust
}

const EDGE_COOLDOWN_MS = 8_000
const EDGE_MAX_PER_WINDOW = 6
const EDGE_WINDOW_MS = 5 * 60_000

function sendToRenderer(s: WindowSession | undefined, channel: string, payload: unknown): void {
  if (s && !s.win.isDestroyed()) s.win.webContents.send(channel, payload)
}

function broadcast(ctx: MainContext, channel: string, payload: unknown): void {
  for (const s of ctx.windows.all()) sendToRenderer(s, channel, payload)
}

const running = new Map<string, RunningCommand>()

/**
 * Terminal creation is serialised with a short gap: a Conductor can ask for six cards in one
 * breath, and creating many ConPTYs in the same instant is where Windows terminals get fragile.
 */
let spawnGate: Promise<void> = Promise.resolve()
const SPAWN_GAP_MS = 350
function throttledSpawn<T>(fn: () => T): Promise<T> {
  const turn = spawnGate.then(fn)
  spawnGate = turn.then(
    () => new Promise((r) => setTimeout(r, SPAWN_GAP_MS)),
    () => new Promise((r) => setTimeout(r, SPAWN_GAP_MS))
  )
  return turn
}
const readyTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** length of the launch command typed into each card's shell (its echo is not TUI output) */
const launchLineLength = new Map<string, number>()
/** the line each card's shell was given at launch: what its output is read against until the CLI is up */
const launchCommands = new Map<string, string>()
/** a starting card's output went quiet: is the shell back on its prompt? */
const exitChecks = new Map<string, NodeJS.Timeout>()
const EXIT_CHECK_MS = 6000
/** the first output of each card's latest launch (its own buffer: the board's is capped and trimmed from the front) */
const launchOut = new Map<string, string>()
const LAUNCH_OUT_CAP = 16_000
/** cards whose latest launch never came up (the CLI is missing): a prompt would land in a bare shell */
const launchFailed = new Set<string>()
/** Cards whose CLI asked whether to trust the folder (needs-you until the owner answers; the ready signals then make them idle). */
const trustAsked = new Set<string>()

/** Is the owner looking at this card right now (window focused, card selected)? Then it needs no toast. */
function viewing(s: WindowSession, nodeId: string): boolean {
  return !s.win.isDestroyed() && s.win.isFocused() && s.selectedNodeId === nodeId
}

/** Claude cards' inboxes, registered by their board MCP server (in memory only: the token never reaches a file or the log). */
const inboxes = new Map<string, InboxAddress>()

export function registerInbox(s: WindowSession, nodeId: string, socket: unknown, token: unknown): { ok: boolean; error?: string } {
  const n = s.board.nodes.get(nodeId)
  if (!n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor') || (n.data.engine ?? 'claude') !== 'claude') return { ok: false, error: 'only Claude cards have an inbox' }
  if (!validInbox(socket)) return { ok: false, error: 'not a Claude Code inbox path' }
  if (token !== undefined && (typeof token !== 'string' || token.length > 512)) return { ok: false, error: 'bad inbox token' }
  // one inbox per process: a card cannot move its prompts to a pipe of its own making later (a failed push clears it)
  const had = inboxes.get(nodeId)
  if (had && had.socket !== socket) return { ok: false, error: 'this card already has an inbox' }
  inboxes.set(nodeId, { socket, ...(token ? { token } : {}) })
  log(`inbox: ${nodeId} registered (text goes into its session, not its terminal)`)
  // Claude Code sends no SessionStart to an HTTP hook, and the ready text in the terminal can be missed: its board
  // server registering the inbox means the CLI is up
  const wasFailed = launchFailed.delete(nodeId)
  if (wasFailed) log(`launch: ${nodeId} registered its inbox; no longer marked failed`)
  const wasAsked = trustAsked.delete(nodeId)
  if (n.data.status === 'starting' || wasFailed || wasAsked) s.board.setStatus(nodeId, { status: 'idle', statusDetail: 'ready' })
  return { ok: true }
}

/** Whether text for this card goes into its Claude Code inbox (the delivery state send_message reports). */
export function hasInbox(nodeId: string): boolean {
  return inboxes.has(nodeId)
}

function pastePrompt(ctx: MainContext, nodeId: string, text: string): void {
  ctx.ptys.write(nodeId, toPastePayload(text))
  setTimeout(() => ctx.ptys.write(nodeId, '\r'), 150)
}

/**
 * Give an agent card a prompt: into its Claude Code inbox when it registered one (a running turn takes it between
 * tool calls, an idle session starts a turn), else typed into its terminal (bracketed paste + Enter). An inbox that
 * fails is dropped and the text typed instead. Command cards run their template.
 */
export function sendPrompt(ctx: MainContext, s: WindowSession, nodeId: string, text: string): boolean {
  if (!ctx.ptys.isAlive(nodeId)) return false
  // the CLI never started: the live process is the shell itself, and a prompt typed there would run as a command
  if (launchFailed.has(nodeId)) return false
  const n = s.board.nodes.get(nodeId)
  // during an autonomous run a shell is a way around every deny rule: nothing is typed into terminal or command
  // cards (a line into one is refused too), and a parked permission prompt is never answered by a card
  if (s.autonomy.on && n && s.autonomy.promptRefusal(n.data)) return false
  if (n?.data.kind === 'command') {
    if (running.has(nodeId)) return false // busy: one command at a time
    const shell = n.data.shell || ctx.store.getSettings().defaultShell || defaultShell()
    const { line, nonce } = buildCommandLine(n.data.commandTemplate || 'echo {{prompt}}', text, { shell, tmpDir: join(ctx.tmpDir, 'prompts'), nodeId })
    running.set(nodeId, { nonce, startedAt: Date.now(), buffer: '' })
    s.board.setStatus(nodeId, { status: 'working', statusDetail: 'running command' })
    ctx.ptys.write(nodeId, line + '\r')
    return true
  }
  const inbox = inboxes.get(nodeId)
  if (inbox) {
    void pushInbox(inbox, text).then((ok) => {
      if (ok) return
      if (inboxes.get(nodeId) === inbox) inboxes.delete(nodeId)
      if (!ctx.ptys.isAlive(nodeId)) return log(`inbox: ${nodeId} did not take the prompt and its process has exited; the prompt is dropped`)
      log(`inbox: ${nodeId} did not take the prompt; typed into the terminal instead`)
      pastePrompt(ctx, nodeId, text)
    })
    return true
  }
  pastePrompt(ctx, nodeId, text)
  // Codex has no prompt-submitted hook; we know we just gave it work
  if (n && n.data.engine === 'codex' && n.data.status !== 'working') s.board.setStatus(nodeId, { status: 'working', statusDetail: 'prompt sent' })
  return true
}

/** Watch a command card's output for the completion sentinel; completion behaves like a Claude Stop. */
function watchCommandOutput(s: WindowSession, nodeId: string, data: string): void {
  const r = running.get(nodeId)
  if (!r) return
  r.buffer += data
  if (r.buffer.length > 400_000) r.buffer = r.buffer.slice(-400_000)
  const out = extractCompleted(r.buffer, r.nonce)
  if (out === null) return
  running.delete(nodeId)
  s.board.setStatus(nodeId, { status: 'done', statusDetail: `command finished (${Math.round((Date.now() - r.startedAt) / 1000)}s)`, lastAssistantMessage: out })
  s.board.emit('stop', nodeId, out)
}

/** Create a handoff line in main and push it to the canvas. */
export function createHandoffEdge(
  s: WindowSession,
  input: { source: string; target: string; mode?: 'auto' | 'manual'; template?: string; condition?: string }
): { id: string } | { error: string } {
  const src = s.board.nodes.get(input.source)
  const dst = s.board.nodes.get(input.target)
  if (!src || !dst) return { error: 'unknown source or target agent id' }
  if (input.source === input.target) return { error: 'source and target must differ' }
  if (src.data.kind === 'note' || src.data.kind === 'browser' || dst.data.kind === 'note' || dst.data.kind === 'browser') return { error: 'handoffs connect agent cards only' }
  const edge: WorkspaceEdge = {
    id: nanoid(8),
    source: input.source,
    target: input.target,
    data: { mode: input.mode === 'manual' ? 'manual' : 'auto', template: input.template?.trim() || DEFAULT_HANDOFF_TEMPLATE, condition: input.condition?.trim() || undefined }
  }
  s.board.edges = [...s.board.edges.filter((e) => e.id !== edge.id), edge]
  sendToRenderer(s, IPC.boardAddEdge, edge)
  return { id: edge.id }
}

function removeCard(ctx: MainContext, s: WindowSession, id: string): void {
  ctx.ptys.kill(id)
  s.board.setPtyAlive(id, false)
  s.ledger.release(id, s.board.nodes.get(id)?.data.title ?? id)
  s.board.nodes.delete(id)
  ctx.windows.unbindNode(id)
  running.delete(id)
  ctx.usage.forgetCard(id)
  forgetMail(id)
  inboxes.delete(id)
  for (const d of s.decisions.withdraw(id)) s.autonomy.noteDecision(d.card, d.title, `withdrawn (${d.id}): the card was removed`)
  transcripts.delete(id)
  sendToRenderer(s, IPC.boardRemoveNode, id)
}

/** The folder a card's git operations apply to: its worktree, else its cwd, else the project. */
function folderOf(board: Board, n: { data: NodeData }): string {
  return n.data.worktree?.path || n.data.cwd || board.projectRoot
}

/**
 * A card or external session in any window still editing `folder` (or a folder inside / around it): working, or
 * stopped mid-turn at a permission prompt or a question. Conductors and team leads only orchestrate, so they do not count.
 */
function busyIn(ctx: MainContext, folder: string): { id: string; title: string } | undefined {
  const f = normalizePath(folder)
  const overlaps = (g: string): boolean => g === f || g.startsWith(f + '/') || f.startsWith(g + '/')
  const midTurn = (s: NodeData['status']): boolean => s === 'working' || s === 'needs-you'
  for (const w of ctx.windows.all()) {
    for (const o of w.board.nodes.values()) {
      const d = o.data
      if (!midTurn(d.status) || d.kind === 'conductor' || d.kind === 'note' || d.kind === 'browser' || d.claude?.boardTools) continue
      if (overlaps(normalizePath(folderOf(w.board, o)))) return { id: o.id, title: d.title }
    }
    for (const x of w.board.externalSessions.values()) {
      if (midTurn(x.status) && x.cwd && overlaps(normalizePath(x.cwd))) return { id: x.sessionId, title: `external session ${x.sessionId.slice(0, 8)}` }
    }
  }
  return undefined
}

/** The JSON API (MCP server, tests) scoped to one window's board. */
export function createApiHandlers(ctx: MainContext, s: WindowSession): ApiHandlers {
  const board = s.board
  const pendingPrompts = new Map<string, string>()
  /** lead id → creations still waiting on a worktree; they hold a slot under the lead's cap */
  const pendingCreates = new Map<string, number>()
  board.on('status', (p: AgentStatusPayload) => {
    const pending = pendingPrompts.get(p.nodeId)
    // a typed role prompt goes first; its (suppressed) Stop brings the card back to idle, then the task
    if (pending && p.status === 'idle' && !board.hasRoleTurn(p.nodeId)) {
      pendingPrompts.delete(p.nodeId)
      setTimeout(() => sendPrompt(ctx, s, p.nodeId, pending), 800)
    }
  })
  return {
    mailSend: (input, from) => {
      const to = resolveMailTarget(board, input.to)
      if (!to) return { ok: false, error: `no agent card "${String(input.to).slice(0, 80)}" on this board (use an id from list_agents or an exact title)` }
      const r = s.mail.send({ from, to, body: input.body, kind: input.kind, replyTo: input.reply_to }, mailTopology(board))
      if (!r.ok) return r
      const n = board.nodes.get(to)?.data
      return { ok: true, id: r.mail.id, to, delivery: deliveryNote(n && { status: n.status, statusDetail: n.statusDetail, engine: n.engine, running: Boolean(n.ptyAlive) }, hasInbox(to)) }
    },
    mailInbox: (self, unreadOnly) => {
      const list = s.mail.inbox(self, unreadOnly)
      return { count: list.length, text: list.length ? list.map((m) => envelope(m, titleOf(board, m.from))).join('\n\n') : 'No messages.' }
    },
    mailAck: (id, self) => s.mail.ack(id, self),
    registerInbox: (self, socket, token) => registerInbox(s, self, socket, token),
    askOwner: async (self, input, signal) => {
      const n = board.nodes.get(self)
      if (!n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor')) return { ok: false, error: 'only agent cards can ask the owner' }
      const q = askInput(input)
      if (!q.ok) return q
      const r = s.decisions.ask({ id: self, title: n.data.title }, q.question, q.choices)
      if (!r.ok) return r
      const id = r.decision.id
      s.autonomy.noteDecision(self, n.data.title, `asked (${id}): ${q.question.replace(/\s+/g, ' ').slice(0, 200)}${q.choices ? ` [${q.choices.join(' / ')}]` : ''}`)
      // the owner is away during a run: no point holding the card's turn
      const d = s.autonomy.on ? undefined : await s.decisions.wait(id, DECISION_LIMITS.waitMs, signal)
      if (d && d.state === 'answered') return { ok: true, id, answered: true, text: decisionMessage(d) }
      if (d) return { ok: true, id, answered: false, text: decisionMessage(d) }
      return { ok: true, id, answered: false, text: pendingMessage(id, s.autonomy.on) }
    },
    listAgents: () => board.snapshot(),
    readOutput: (nodeId, lines) => (board.nodes.has(nodeId) ? tailLines(board.getOutput(nodeId), lines) : null),
    sendPrompt: (nodeId, text) => sendPrompt(ctx, s, nodeId, text),
    discordPost: (self, input) => {
      const n = board.nodes.get(self)
      if (!n) return Promise.resolve({ ok: false as const, error: 'unknown card' })
      // the agent cards that have the tool: a terminal or command card has no board tools to call it with
      if (n.data.kind !== 'claude' && n.data.kind !== 'conductor') return Promise.resolve({ ok: false as const, error: 'only agent cards can post to Discord' })
      return ctx.ouro.post(typeof input.channel === 'string' ? input.channel : '', typeof input.text === 'string' ? input.text : '', `${n.data.title} (${self})`)
    },
    grokBotList: () => {
      const bots = grokBots(ctx.store.getSettings())
      return bots.length ? `The owner's Grok Bots (pass the name as bot):\n${botMenu(bots)}` : 'The owner has not set up a Grok Bot (Settings → Grok Bot).'
    },
    grokBotHandoff: (self, input) => {
      const n = board.nodes.get(self)
      if (!n) return { ok: false, error: 'unknown card' }
      // the agent cards that have the tool, and that board mail can tell the outcome to
      if (n.data.kind !== 'claude' && n.data.kind !== 'conductor') return { ok: false, error: 'only agent cards can hand tasks to Grok Bot' }
      const picked = pickBot(grokBots(ctx.store.getSettings()), input.bot)
      if (!picked.ok) return picked
      const last = s.grokBot.at(-1)
      const r = newHandoff({ card: self, title: n.data.title, task: input.task, context: input.context, bot: picked.bot }, s.grokBot, `G${last ? Number(last.id.slice(1)) + 1 : 1}`, Date.now())
      if (!r.ok) return r
      s.grokBot = [...s.grokBot.slice(-49), r.handoff]
      grokBotChanged(s)
      const now = Date.now()
      // a bot the owner let send without asking: it goes now, within the daily cap and only without anything secret-looking
      const sent = readAutoSent()
      const sentToday = (sent[picked.bot.id] ?? []).filter((t) => now - t < 24 * 3600_000)
      const hold = autoSendHold(picked.bot, r.handoff, sentToday.length)
      if (!hold) {
        writeAutoSent({ ...sent, [picked.bot.id]: [...sentToday, now] }, now)
        log(`[grok-bot] ${r.handoff.id} from ${n.data.title} goes to ${picked.bot.name} without asking (the owner allowed it)`)
        void resolveGrokHandoff(ctx, s, r.handoff.id, true, 'auto').then((res) => {
          if (res.ok) return
          // not sent: it waits for the owner's Send like any other, and the card hears so
          s.mail.send({ from: OWNER, to: self, body: `Your Grok Bot handoff ${r.handoff.id} could not be sent without asking; it waits for the owner's Send now (the owner sees why). Carry on with other work.`, kind: 'note' }, mailTopology(s.board))
          if (Notification.isSupported()) new Notification({ title: `Grok Bot ${r.handoff.id} was not sent`, body: `${res.error ?? 'unknown error'} — it waits for Send in the Today tab` }).show()
        })
        return { ok: true, id: r.handoff.id, note: `The owner lets ${picked.bot.name} take handoffs without asking, so it is being sent now. You will get a board message when it has gone (or if it could not go and waits for the owner). Carry on with other work.` }
      }
      if (picked.bot.autoSend) log(`[grok-bot] ${r.handoff.id} from ${n.data.title} waits for the owner: ${hold}`)
      else log(`[grok-bot] ${r.handoff.id} from ${n.data.title} waits for the owner`)
      // one notification per card a minute: a card that keeps asking is listed, not shouted
      if (Notification.isSupported() && now - (grokNotified.get(self) ?? 0) >= 60_000) {
        grokNotified.set(self, now)
        const why = picked.bot.autoSend ? ` (not sent without asking: ${hold})` : ''
        const note = new Notification({ title: `${n.data.title} wants to hand a task to Grok Bot`, body: `${r.handoff.task.split('\n')[0].slice(0, 140)}${why} — Send or Discard in the Today tab` })
        note.on('click', () => {
          if (!s.win.isDestroyed()) {
            s.win.show()
            s.win.focus()
          }
        })
        note.show()
      }
      return { ok: true, id: r.handoff.id, note: 'The owner was asked to send it; nothing has left this machine yet. You will get a board message when they decide. Carry on with other work.' }
    },
    setNote: (nodeId, note) => {
      const n = board.nodes.get(nodeId)
      if (!n || n.data.kind !== 'note') return false
      n.data.note = note
      sendToRenderer(s, IPC.boardSetNote, { nodeId, note })
      return true
    },
    taskList: (filter) => {
      const tasks = s.ledger.list(filter)
      const titles = new Map<string, string>()
      for (const n of board.nodes.values()) titles.set(n.id, n.data.title)
      return { text: formatTasks(tasks, s.ledger.data.tasks, titles), tasks }
    },
    taskCreate: (input, by) => {
      if (input?.owner && !board.nodes.has(input.owner)) return { ok: false, error: `no card ${input.owner}` }
      const r = s.ledger.create(input, by)
      if (r.ok && r.task.owner) s.ledger.cardStopped(board, r.task.owner) // handed back later unless the card is (or comes) alive
      return toApiResult(r)
    },
    taskClaim: (id, agentId, self) => {
      const cardId = agentId ?? self
      if (!cardId) return { ok: false, error: 'agent_id required' }
      if (!board.nodes.has(cardId)) return { ok: false, error: `no card ${cardId}` }
      const r = s.ledger.claim(id, cardId, liveCards(board))
      if (r.ok) s.ledger.cardStopped(board, cardId) // a claim for a dead card is handed back after the grace period
      return toApiResult(r)
    },
    taskUpdate: (id, patch, by) => {
      if (patch.owner && !board.nodes.has(patch.owner)) return { ok: false, error: `no card ${patch.owner}` }
      return toApiResult(s.ledger.update(id, patch, by))
    },
    listHandoffs: () =>
      board.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceTitle: board.nodes.get(e.source)?.data.title,
        target: e.target,
        targetTitle: board.nodes.get(e.target)?.data.title,
        mode: e.data.mode,
        condition: e.data.condition,
        template: e.data.template,
        lastFiredAt: e.data.lastFiredAt
      })),
    createHandoff: (input) => createHandoffEdge(s, input),
    removeHandoff: (id) => {
      const before = board.edges.length
      board.edges = board.edges.filter((e) => e.id !== id)
      sendToRenderer(s, IPC.boardRemoveEdge, id)
      return board.edges.length < before
    },
    fireHandoff: (id) => s.fireHandoff(id, true),
    bookmarks: (query) => listBookmarks(query, 500),
    browser: {
      list: () =>
        [...board.nodes.values()]
          .filter((n) => n.data.kind === 'browser')
          .map((n) => ({ id: n.id, title: n.data.title, url: n.data.url, ready: ctx.browsers.has(n.id) })),
      create: async (input) => {
        // the same page twice on the canvas helps nobody: hand back the card that already shows it
        const dup = input.url ? browserShowing(ctx, board, input.url) : undefined
        if (dup) return { id: dup }
        const id = nanoid(10)
        const node: AddNodePayload = {
          id,
          width: 640,
          height: 480,
          data: { kind: 'browser', title: input.title || 'Browser', cwd: board.projectRoot, url: input.url || ctx.store.getSettings().browserHome || 'https://www.google.com' },
          ...(input.near && board.nodes.has(input.near) ? { near: input.near } : {})
        }
        ctx.windows.bindNode(id, s.id)
        sendToRenderer(s, IPC.boardAddNode, node)
        // wait (bounded) for the webview to register so the caller can act right away
        for (let i = 0; i < 40 && !ctx.browsers.has(id); i++) await new Promise((r) => setTimeout(r, 250))
        return { id }
      },
      navigate: (id, url) => ctx.browsers.navigate(id, url),
      read: (id, max) => ctx.browsers.read(id, max),
      links: (id, limit) => ctx.browsers.links(id, limit),
      click: (id, target) => ctx.browsers.click(id, target),
      type: (id, input) => ctx.browsers.type(id, input),
      screenshot: (id) => ctx.browsers.screenshot(id, join(ctx.tmpDir, 'screenshots'))
    },
    listRoles: async (query) => {
      const l = await ctx.roles.list(board.projectRoot)
      return query ? { ...l, roles: filterRoles(l.roles, query) } : l
    },
    createAgent: async (input) => {
      const parentId = input.created_by && board.nodes.has(input.created_by) ? input.created_by : undefined
      let cwd = input.cwd || board.projectRoot || app.getPath('home')
      // a specialist role: its file is the system prompt, the caller's own role_prompt follows it
      const roleId = input.role?.trim() || undefined
      if (roleId) {
        if (input.kind === 'terminal' || input.kind === 'command') return { error: 'role applies to agent cards only (kind=claude)' }
        const rolePrompt = ctx.roles.prompt(board.projectRoot, roleId)
        if (!rolePrompt) return { error: `no role "${roleId}": list_roles shows the ids the library has` }
        input = { ...input, role_prompt: [rolePrompt, input.role_prompt?.trim()].filter(Boolean).join('\n\n') }
      }
      const title = input.title || basename(cwd)
      const kind = input.kind === 'terminal' ? 'terminal' : input.kind === 'command' ? 'command' : 'claude'
      // The same title asked for again (a Conductor tends to want its "Brief writer" every round): a card that
      // finished its last job is reused, one whose process ended is replaced; a working card is left alone.
      let replaced: string | undefined
      const twin = kind === 'claude' ? [...board.nodes.values()].find((n) => n.data.kind === 'claude' && n.data.title.trim().toLowerCase() === title.trim().toLowerCase() && samePath(n.data.cwd, cwd)) : undefined
      if (twin) {
        const alive = board.ptyAlive.has(twin.id)
        const status = twin.data.status ?? (alive ? 'idle' : 'ended')
        if (alive && (status === 'idle' || status === 'done')) {
          const role = input.role_prompt?.trim()
          if (role && role !== twin.data.claude?.appendSystemPrompt) {
            // a new role for a live session goes in as a role turn; the task waits for its "ready"
            const claudeOpts = { ...twin.data.claude, appendSystemPrompt: role }
            twin.data.claude = claudeOpts
            twin.data.role = roleId
            sendToRenderer(s, IPC.boardUpdateNode, { nodeId: twin.id, data: { claude: claudeOpts, role: roleId }, restart: false })
            board.markRoleTurn(twin.id)
            sendPrompt(ctx, s, twin.id, roleAsMessage(role))
            if (input.prompt) pendingPrompts.set(twin.id, input.prompt)
          } else if (input.prompt) sendPrompt(ctx, s, twin.id, input.prompt)
          if (input.report_to && board.nodes.has(input.report_to) && !board.edges.some((e) => e.source === twin.id && e.target === input.report_to)) {
            createHandoffEdge(s, { source: twin.id, target: input.report_to, mode: 'auto', template: REPORT_TEMPLATE })
          }
          // a dispatched card taken over by another lead now belongs to that lead; an owner-made card stays the owner's
          if (parentId && twin.data.parentId && twin.data.parentId !== parentId) {
            twin.data.parentId = parentId
            sendToRenderer(s, IPC.boardUpdateNode, { nodeId: twin.id, data: { parentId }, restart: false })
          }
          return { id: twin.id, cwd: twin.data.worktree?.path || twin.data.cwd, worktree: twin.data.worktree?.path, reused: true }
        }
      }
      // caps are enforced here, not left to the prompt: depth (Conductor → team → worker) and live workers per lead.
      // Checked before an ended twin is replaced, so a refused call changes nothing.
      // autonomous run: Claude and Codex cards only. A terminal or command card is a shell past every deny rule; Gemini and
      // Grok have no rails and 'auto' would mean yolo there (an omitted engine means Claude during the run). Then the caps.
      if (s.autonomy.on && kind !== 'claude') return { error: 'Autonomous mode: no terminal or command cards during a run (a shell has no rails). Use a Claude card.' }
      const engine = s.autonomy.on ? normalizeEngine(input.engine) : normalizeEngine(input.engine ?? ctx.store.getSettings().defaultEngine)
      if (s.autonomy.on && !engineJoinsRun(engine)) return { error: `Autonomous mode: no ${engine} cards during a run (no rails for that engine). Use engine=claude or engine=codex.` }
      const autonomyRefusal = s.autonomy.dispatchRefusal(title, Boolean(twin))
      if (autonomyRefusal) return { error: autonomyRefusal }
      if (parentId) {
        const refusal = dispatchRefusal(board.snapshot(), parentId, ctx.store.getSettings().maxWorkersPerLead ?? DEFAULT_MAX_WORKERS, pendingCreates.get(parentId) ?? 0)
        if (refusal) return { error: refusal }
      }
      if (twin) {
        removeCard(ctx, s, twin.id)
        replaced = twin.id
      }
      const id = nanoid(10)
      let worktree: WorkspaceNode['data']['worktree']
      if (input.worktree) {
        // the worktree takes seconds; parallel creates by the same lead count against its cap meanwhile
        if (parentId) pendingCreates.set(parentId, (pendingCreates.get(parentId) ?? 0) + 1)
        try {
          const wt = await createWorktree(cwd, title)
          worktree = wt
          cwd = wt.path
        } finally {
          if (parentId) pendingCreates.set(parentId, Math.max(0, (pendingCreates.get(parentId) ?? 1) - 1))
        }
      }
      // Guard: --continue in a folder where a conductor already lives would clone the conductor's own
      // conversation (and re-run whatever it was doing). Start fresh there instead.
      const conductorHere = [...board.nodes.values()].some((n) => n.data.kind === 'conductor' && samePath(n.data.cwd, cwd))
      const wantContinue = Boolean(input.continue) && !conductorHere
      const claude: WorkspaceNode['data']['claude'] =
        input.kind === 'terminal' || input.kind === 'command'
          ? undefined
          : {
              appendSystemPrompt: input.role_prompt?.trim() || undefined,
              // during an autonomous run the launch forces auto mode (plan stays plan) without writing it into the card:
              // the card keeps its requested mode for after the run, and a requested bypass never comes back then
              permissionMode: s.autonomy.storedPermissionMode(input.permission_mode) as NonNullable<WorkspaceNode['data']['claude']>['permissionMode'],
              model: input.model || undefined,
              effort: normalizeEffort(input.effort),
              continue: wantContinue || undefined,
              resume: input.resume || undefined,
              boardTools: input.board_tools || undefined
            }
      const node: AddNodePayload = {
        id,
        width: 560,
        height: 400,
        data: {
          kind,
          engine: claude ? engine : undefined,
          title,
          cwd: input.worktree ? input.cwd || board.projectRoot : cwd,
          worktree,
          claude,
          commandTemplate: input.kind === 'command' ? input.command_template || 'echo {{prompt}}' : undefined,
          role: claude ? roleId : undefined,
          parentId,
          createdAt: Date.now()
        }
      }
      if (input.prompt) pendingPrompts.set(id, input.prompt)
      ctx.windows.bindNode(id, s.id)
      sendToRenderer(s, IPC.boardAddNode, node)
      // register in main right away so a report line can be attached before the renderer echoes the node
      board.nodes.set(id, { id, data: { ...node.data } })
      if (input.report_to && board.nodes.has(input.report_to)) {
        createHandoffEdge(s, { source: id, target: input.report_to, mode: 'auto', template: REPORT_TEMPLATE })
      }
      s.autonomy.countDispatch(title, Boolean(replaced)) // counted once the card exists: a failed worktree or per-lead cap above costs nothing
      return { id, cwd, worktree: worktree?.path, replaced }
    },
    removeAgent: async (id) => {
      if (!board.nodes.has(id)) return false
      removeCard(ctx, s, id)
      return true
    },
    updateAgent: (id, patch) => {
      const n = board.nodes.get(id)
      if (!n) return false
      const isClaude = n.data.kind === 'claude' || n.data.kind === 'conductor'
      if (patch.board_tools !== undefined && !isClaude) return false // only Claude cards have launch options
      const data: Partial<WorkspaceNode['data']> = {}
      if (patch.title) data.title = patch.title
      if (patch.board_tools !== undefined) data.claude = { ...(n.data.claude ?? {}), boardTools: patch.board_tools }
      if (Object.keys(data).length === 0) return true // nothing to change, nothing to restart
      const restart = Boolean(patch.restart) && isClaude && data.claude !== undefined
      // A relaunch must keep the conversation: resume the session we know, never start fresh.
      if (restart && n.data.sessionId) data.claude = { ...data.claude, resume: n.data.sessionId, continue: undefined }
      Object.assign(n.data, data)
      sendToRenderer(s, IPC.boardUpdateNode, { nodeId: id, data, restart })
      return true
    },
    changes: async (id, opts) => {
      const n = board.nodes.get(id)
      if (!n) return null
      const cwd = folderOf(board, n)
      const summary = await getChanges(cwd)
      const diff = summary.repo && (opts.diff || opts.file) ? await getDiff(cwd, opts.file, 120_000) : undefined
      return { cwd, ...summary, diff }
    },
    listCheckpoints: async (id) => {
      const n = board.nodes.get(id)
      if (!n) return null
      const folder = folderOf(board, n)
      return { folder, ...(await listCheckpoints(folder)) }
    },
    createCheckpoint: async (id, label) => {
      const n = board.nodes.get(id)
      if (!n) return null
      const folder = folderOf(board, n)
      return { folder, ...(await createCheckpoint(folder, { label, cardId: id })) }
    },
    restoreCheckpoint: async (id, checkpointId, moveHead) => {
      const n = board.nodes.get(id)
      if (!n) return null
      const folder = folderOf(board, n)
      if (moveHead && s.autonomy.on) return { folder, ok: false, error: 'Autonomous mode: move_head is a human gate (it rewinds the branch); restore the files only, or leave it for the owner' }
      const busy = busyIn(ctx, folder)
      if (busy) return { folder, ok: false, error: `"${busy.title}" (${busy.id}) is working or waiting for the owner in that folder; wait for it or stop it first` }
      return { folder, ...(await restoreCheckpoint(folder, checkpointId, { moveHead, cardId: id })) }
    },
    deleteCheckpoint: async (id, checkpointId) => {
      const n = board.nodes.get(id)
      if (!n) return null
      const folder = folderOf(board, n)
      return { folder, ...(await deleteCheckpoint(folder, checkpointId)) }
    },
    tidy: async (opts, dryRun) => {
      const settings = ctx.store.getSettings()
      const agents = board.snapshot()
      const lines = board.edges.map((e) => ({ source: e.source, target: e.target, lastFiredAt: e.data.lastFiredAt }))
      const candidates = selectTidyCandidates(agents, {
        // a lead asking for its own workers wants the reported ones gone now; the grace is for the unattended run
        retireMinutes: opts.scope ? 0 : (settings.retireMinutes ?? DEFAULT_RETIRE_MINUTES),
        olderThanMinutes: opts.olderThanMinutes || settings.autoTidyMinutes || 30,
        includeOwn: opts.includeOwn,
        scope: opts.scope,
        auto: opts.auto,
        reported: reportedCards(agents, lines),
        protect: protectedCards(agents, lines)
      })
      let removed = 0
      if (!dryRun) {
        for (const c of candidates) {
          removeCard(ctx, s, c.id)
          removed++
        }
      }
      return { candidates, removed }
    },
    waitForAgents: (ids, statuses, timeoutMs) =>
      new Promise((resolve) => {
        const wanted = new Set(statuses)
        const targets = ids.length ? ids : [...board.nodes.keys()].filter((k) => board.nodes.get(k)?.data.kind === 'claude')
        const done = (): Array<{ id: string; status: string; lastAssistantMessage?: string }> =>
          targets
            .map((t) => board.nodes.get(t))
            .filter((n): n is NonNullable<typeof n> => Boolean(n))
            .filter((n) => wanted.has(n.data.status ?? ''))
            .map((n) => ({ id: n.id, status: n.data.status ?? '', lastAssistantMessage: n.data.lastAssistantMessage }))
        const finish = (timedOut: boolean): void => {
          board.off('status', onStatus)
          clearTimeout(timer)
          resolve({ timedOut, ready: done(), pending: targets.filter((t) => !done().some((d) => d.id === t)) })
        }
        const onStatus = (): void => {
          if (done().length > 0) finish(false)
        }
        const timer = setTimeout(() => finish(true), timeoutMs)
        if (done().length > 0) return finish(false)
        board.on('status', onStatus)
      })
  }
}

/** The toast for a card that needs a human: "needs you" with the question, or "failed" with the error; never for the card on screen. */
/** A card asked for something only the owner may allow (the gate's "ask"): always a toast, the run log and the pill. */
function notifyApproval(ctx: MainContext, s: WindowSession, a: Approval): void {
  s.autonomy.noteGate(a.card, a.title, `approval asked (${a.id}): ${a.command}`)
  if (Notification.isSupported()) {
    const note = new Notification({ title: `${a.title} asks for approval`, body: a.command.slice(0, 200) })
    note.on('click', () => {
      if (!s.win.isDestroyed()) {
        s.win.show()
        s.win.focus()
      }
    })
    note.show()
  }
  if (!s.win.isDestroyed() && !s.win.isFocused()) s.win.flashFrame(true)
}

/** The last desktop notification for a card's question: at most one a minute per card. */
const decisionNotified = new Map<string, number>()

/** A card asked the owner something (ask_owner): Today has the row; a toast and the taskbar flash, at most once a minute per card. */
function notifyDecision(s: WindowSession, d: Decision): void {
  const now = Date.now()
  if (now - (decisionNotified.get(d.card) ?? 0) < DECISION_LIMITS.notifyGapMs) return
  decisionNotified.set(d.card, now)
  if (Notification.isSupported()) {
    const note = new Notification({ title: `${d.title} asks you`, body: d.question.replace(/\s+/g, ' ').slice(0, 200) })
    note.on('click', () => {
      if (!s.win.isDestroyed()) {
        s.win.show()
        s.win.focus()
      }
    })
    note.show()
  }
  if (!s.win.isDestroyed() && !s.win.isFocused()) s.win.flashFrame(true)
}

const ASK_TOOL = 'mcp__ouroboros__ask_owner'
/** answers handed to a waiting ask_owner call, per card, until its PostToolUse shows the card got the result */
const handedAnswers = new Map<string, NodeJS.Timeout>()
const HANDED_TAKE_MS = 10_000

/**
 * A call the owner interrupted (Esc) still waits in the board MCP server, which Claude Code does not tell, so an
 * answer handed to it can reach nobody. When the card's PostToolUse for ask_owner does not follow, the answer goes
 * again as a board message.
 */
function watchHandedAnswer(s: WindowSession, d: Decision): void {
  // only Claude cards report PostToolUse; the others would get every answer twice
  if ((s.board.nodes.get(d.card)?.data.engine ?? 'claude') !== 'claude') return
  clearTimeout(handedAnswers.get(d.card))
  handedAnswers.set(
    d.card,
    setTimeout(() => {
      handedAnswers.delete(d.card)
      if (!s.board.nodes.has(d.card)) return
      log(`decision: ${d.card} did not take the answer to ${d.id} (its call was interrupted); sent as a board message`)
      s.mail.send({ from: OWNER, to: d.card, body: decisionMessage(d), kind: 'note' }, mailTopology(s.board))
    }, HANDED_TAKE_MS)
  )
}

/** The owner's answer to a card's question: back as the waiting tool call's result, else as a board message from the owner. */
function answerDecision(s: WindowSession, id: string, answer: unknown, note: unknown, by: string): { ok: boolean; error?: string; warning?: string } {
  if (typeof answer !== 'string' || (note !== undefined && typeof note !== 'string')) return { ok: false, error: 'bad answer' }
  const r = s.decisions.answer(id, answer, note as string | undefined, by)
  if (!r.ok) return r
  const d = r.decision
  s.autonomy.noteDecision(d.card, d.title, `answered (${d.id}) by ${by}: ${d.answer}${d.note ? ` — ${d.note.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)
  // a fresh-start question is Ouroboros's own: the card never asked it, so it is not told the answer
  if (s.relay?.owns(d.id)) {
    s.relay.answered(d.id, d.answer)
    return { ok: true }
  }
  if (r.waited) {
    watchHandedAnswer(s, d)
    return { ok: true }
  }
  const m = s.mail.send({ from: OWNER, to: d.card, body: decisionMessage(d), kind: 'note' }, mailTopology(s.board))
  return m.ok ? { ok: true } : { ok: true, warning: `answered, but the card was not told: ${m.error}` }
}

/** The card an owner action is answered to: the card that asked, else the task's owner, else the Conductor. */
function ownerActionCard(board: Board, t: Task): string | undefined {
  const agent = (id: string | undefined): id is string => {
    const k = id ? board.nodes.get(id)?.data.kind : undefined
    return k === 'claude' || k === 'conductor'
  }
  // an older APPROVAL NEEDED task has no asker: the card that blocked it
  const asker = t.ownerAction ? t.ownerAction.by : t.updatedBy
  return [asker, t.owner].find(agent) ?? [...board.nodes.values()].find((n) => n.data.kind === 'conductor')?.id
}

/**
 * The owner's answer to a blocked task that waits on them (Tasks tab, Today). Approve sends the card back to work,
 * hold keeps the task blocked and tells the card not to, did marks it done with what the owner pasted back. Only a
 * card may do an approve task and only the owner a do task; an older "APPROVAL NEEDED:" task takes either.
 */
function ownerAnswerTask(s: WindowSession, id: string, choice: unknown, text: unknown, shownAt: unknown): { ok: boolean; error?: string; warning?: string } {
  if ((choice !== 'approve' && choice !== 'hold' && choice !== 'did') || (text !== undefined && typeof text !== 'string')) return { ok: false, error: 'bad answer' }
  const t = s.ledger.data.tasks.find((x) => x.id === id)
  const need = t && ownerNeed(t)
  if (!t || !need) return { ok: false, error: `${id} is not waiting on you` }
  // the answer is to what the owner read: a card that changed the task since then cannot slip another request under it
  if (shownAt !== t.updatedAt) return { ok: false, error: `${id} changed since you read it. Read it again before you answer.` }
  if (choice === 'approve' && need.kind === 'do') return { ok: false, error: 'Only you can do this one: follow the steps, then press Done.' }
  if (choice === 'did' && need.kind === 'approve') return { ok: false, error: 'A card does this one once you approve it.' }
  const limit = choice === 'did' ? OWNER_ACTION_LIMITS.pasteChars : OWNER_ACTION_LIMITS.noteChars
  const note = cleanText(text ?? '', limit + 1)
  if (note.length > limit) return { ok: false, error: `at most ${limit} characters` }
  const flat = cleanLine(note, 200)
  const patch: TaskPatch =
    choice === 'approve'
      ? { state: t.owner && liveCards(s.board).has(t.owner) ? 'doing' : 'todo', reason: `approved by the owner${flat ? `: ${flat}` : ''}`, ownerAction: null }
      : choice === 'hold'
        ? { reason: `on hold (owner)${flat ? `: ${flat}` : ''}`, ownerAction: null }
        : // every card reads the ledger: what the owner pasted goes in full only to the card that asked
          { state: 'done', result: `Done by the owner.${flat ? ` They pasted back: ${flat}` : ''}`, ownerAction: null }
  const r = s.ledger.update(id, patch, OWNER)
  if (!r.ok) return r
  if (r.task.owner) s.ledger.cardStopped(s.board, r.task.owner) // a dead owner card hands it back after the grace period
  const card = ownerActionCard(s.board, t)
  const body = choice === 'approve' ? approvalMessage(t, need, note) : choice === 'hold' ? holdMessage(t, need, note) : didMessage(t, need, note)
  if (card) s.autonomy.noteDecision(card, titleOf(s.board, card), `${choice === 'approve' ? 'approved' : choice === 'hold' ? 'put on hold' : 'did'} ${id} (owner): ${need.ask.slice(0, 200)}`)
  if (!card) return { ok: true, warning: 'No card to tell: let the Conductor know yourself.' }
  const m = s.mail.send({ from: OWNER, to: card, body, kind: 'note' }, mailTopology(s.board))
  return m.ok ? { ok: true } : { ok: true, warning: `Saved, but the card was not told: ${m.error}` }
}

/** The phone companion: its server, with handlers on the current window. Off until the owner turns it on. */
export function createPhone(ctx: MainContext): PhoneServer {
  const win = (): WindowSession | undefined => ctx.windows.current()
  const handlers: PhoneHandlers = {
    board: () => {
      const s = win()
      if (!s) return { project: '', autonomous: false, cards: [], approvals: [], decisions: [] }
      const rank = (st: string | undefined): number => (st === 'needs-you' ? 0 : st === 'working' ? 1 : 2)
      const cards = [...s.board.nodes.values()]
        .filter((n) => n.data.kind === 'claude' || n.data.kind === 'conductor')
        .map((n) => ({
          id: n.id,
          title: n.data.title,
          conductor: n.data.kind === 'conductor',
          status: n.data.status ?? 'starting',
          detail: (n.data.statusDetail ?? '').slice(0, 300),
          last: (n.data.lastAssistantMessage ?? '').slice(-PHONE_LIMITS.replyChars),
          // the trust dialog takes arrow keys, not the phone's 1 / 3 / Esc: it is answered in the card
          permission: n.data.status === 'needs-you' && (n.data.statusDetail ?? '').startsWith('permission') && !trustAsked.has(n.id),
          promptAt: n.data.lastEventAt,
          promptable: n.data.status !== 'needs-you' && ctx.ptys.isAlive(n.id) && !launchFailed.has(n.id),
          // where it sits on the canvas, for the phone's map
          x: n.pos?.x,
          y: n.pos?.y
        }))
        .sort((a, b) => rank(a.status) - rank(b.status) || Number(b.conductor) - Number(a.conductor))
      // every window's requests, each id scoped to its window (each window counts A1, A2 … on its own)
      const approvals = ctx.windows.all().flatMap((w) => w.gate.pending().map((a) => ({ id: `${w.id}-${a.id}`, title: a.title, command: a.command, createdAt: a.createdAt, project: basename(w.board.projectRoot || '') })))
      const decisions = ctx.windows.all().flatMap((w) => w.decisions.pending().map((d) => ({ id: `${w.id}-${d.id}`, title: d.title, question: d.question, answers: answersOf(d), createdAt: d.createdAt, project: basename(w.board.projectRoot || '') })))
      // how the agent cards are connected: handoff lines, and the card that dispatched each one
      const shown = new Set(cards.map((c) => c.id))
      const edges = [
        ...s.board.edges.filter((e) => shown.has(e.source) && shown.has(e.target)).map((e) => ({ from: e.source, to: e.target, kind: 'handoff', firedAt: e.data.lastFiredAt })),
        ...[...s.board.nodes.values()].filter((n) => n.data.parentId && shown.has(n.id) && shown.has(n.data.parentId)).map((n) => ({ from: n.data.parentId as string, to: n.id, kind: 'dispatch' }))
      ]
      return { project: basename(s.board.projectRoot || ''), autonomous: s.autonomy.on, cards, edges, approvals, decisions }
    },
    prompt: (id, text) => {
      const s = ctx.windows.forNode(id)
      const n = s?.board.nodes.get(id)
      if (!s || !n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor')) return { ok: false, error: 'no such agent card' }
      if (n.data.status === 'needs-you') return { ok: false, error: 'the card is waiting on a prompt: answer it first' }
      return sendPrompt(ctx, s, id, text) ? { ok: true } : { ok: false, error: 'not delivered (the card is not running, or the run does not allow it)' }
    },
    answer: (id, key, promptAt) => {
      const s = ctx.windows.forNode(id)
      const n = s?.board.nodes.get(id)
      if (!s || !n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor')) return { ok: false, error: 'no such agent card' }
      if (n.data.status !== 'needs-you' || !(n.data.statusDetail ?? '').startsWith('permission')) return { ok: false, error: 'the card is not waiting on a permission prompt' }
      if (trustAsked.has(id)) return { ok: false, error: 'the folder-trust question is answered in the card (arrow keys), not from the phone' }
      if (!ctx.ptys.isAlive(id)) return { ok: false, error: 'the card is not running' }
      if (n.data.lastEventAt !== promptAt) return { ok: false, error: 'the card has moved on since this screen was loaded; look again' }
      // a raw keystroke, not a bracketed paste: the permission dialog reads keys
      ctx.ptys.write(id, ANSWER_KEYS[key])
      return { ok: true }
    },
    answerDecision: (scoped, answer, note, device) => {
      const m = /^(\d+)-(D\d+)$/.exec(scoped)
      const s = m ? ctx.windows.all().find((w) => String(w.id) === m[1]) : undefined
      return s && m ? answerDecision(s, m[2], answer, note, `phone ${device}`) : { ok: false, error: 'that question is gone (its window was closed)' }
    },
    resolveApproval: (scoped, approve) => {
      const m = /^(\d+)-(A\d+)$/.exec(scoped)
      const s = m ? ctx.windows.all().find((w) => String(w.id) === m[1]) : undefined
      return s && m ? resolveApproval(s, m[2], approve) : { ok: false, error: 'that request is gone (its window was closed)' }
    },
    notify: (event) => {
      // the only event so far: the phone joined the car; Ouro says ready once Discord will push it to the phone
      const r = ctx.ouro.carReady()
      if (r.ok) log(`[ouro] car: ${r.queued ? `ready message in ${Math.round(r.inMs / 1000)} s` : 'told within the last 2 min'}`)
      return r.ok ? { ok: true, queued: r.queued } : r
    },
    latestReport: () => {
      const p = win()?.autonomy.public().ended?.reportPath
      if (!p) return undefined
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    note: (line) => {
      log(`[phone] ${line}`)
      win()?.autonomy.notePhone(line)
    }
  }
  return new PhoneServer(new PhoneDevices(join(app.getPath('userData'), 'phone-devices.json'), log), handlers, log)
}

/** Put one Grok Bot reply in front of the card that asked (or the Conductor when that card is gone). False: no one to tell yet. */
function deliverGrokReply(s: WindowSession, rec: ReplyRecord, kind: Exclude<ReplyKind, 'test'>, text: string, status?: string): boolean {
  const asker = s.board.nodes.get(rec.card)
  const to = asker && asker.data.kind !== 'note' && asker.data.kind !== 'browser' ? rec.card : [...s.board.nodes.values()].find((n) => n.data.kind === 'conductor')?.id
  if (!to) return false
  // sent as Grok Bot, not the owner: the card reads it as an outside agent's words, under the agent mail limits
  const m = s.mail.send({ from: GROK_BOT, to, body: replyMail(rec, kind, text, status), kind: kind === 'question' ? 'question' : 'note' }, mailTopology(s.board))
  if (!m.ok) {
    log(`[grok-reply] ${rec.handoffId}: not queued for ${to}: ${m.error}`)
    return false
  }
  s.grokBot = s.grokBot.map((h) => (h.correlationId === rec.correlationId ? { ...h, repliedAt: Date.now(), replyKind: kind } : h))
  grokBotChanged(s)
  log(`[grok-reply] ${rec.handoffId} (${rec.botName}): ${kind} queued for ${to === rec.card ? 'the asking card' : 'the Conductor'}`)
  return true
}

/** Mail a record's waiting replies in order, stopping at the first that cannot go; saved only when something went. */
function flushGrokReplies(store: ReplyStore, s: WindowSession, rec: ReplyRecord): number {
  const list = rec.waiting ?? []
  let sent = 0
  while (sent < list.length && deliverGrokReply(s, rec, list[sent].kind, list[sent].text, list[sent].status)) sent++
  if (sent) store.update(rec.correlationId, { waiting: list.length > sent ? list.slice(sent) : undefined })
  return list.length - sent
}

export function createGrokReply(ctx: MainContext): MainContext['grokReply'] {
  const store = new ReplyStore(join(app.getPath('userData'), 'grok-replies.json'), log)
  const stuck = new Set<string>()
  // one handler for both ways back: the reply server (Funnel) and the GitHub issue
  const handle: ReplyHandler = (r) => {
    if (r.kind === 'test') {
      log('[grok-reply] test received')
      if (Notification.isSupported()) new Notification({ title: 'Grok Bot reply test received', body: r.text ? r.text.slice(0, 120) : 'The way back from Grok Bot works.' }).show()
      return { status: 200, body: { ok: true, received: 'test' } }
    }
    const rec = r.correlationId ? store.find(r.correlationId) : undefined
    if (!rec) {
      log('[grok-reply] refused a reply: unknown or expired correlation_id')
      return { status: 404, body: { ok: false, error: 'unknown or expired correlation_id' } }
    }
    if (rec.replies >= REPLY_LIMITS.perHandoff) return { status: 429, body: { ok: false, error: `this handoff already got ${REPLY_LIMITS.perHandoff} replies` } }
    const now = Date.now()
    // queued behind any older reply still waiting, so a question never lands after its result
    store.update(rec.correlationId, { replies: rec.replies + 1, lastReplyAt: now, waiting: [...(rec.waiting ?? []), { kind: r.kind, text: r.text, status: r.status, at: now }] })
    const s = ctx.windows.forProject(rec.projectRoot)
    const fresh = store.find(rec.correlationId)
    const left = s && fresh ? flushGrokReplies(store, s, fresh) : 1
    if (left) log(`[grok-reply] ${rec.handoffId}: kept until ${basename(rec.projectRoot)} is open with its card or a Conductor`)
    return { status: 200, body: { ok: true, delivered: left === 0 } }
  }
  const server = new GrokReplyServer(store, handle, log)
  const mailbox = new GitHubMailbox(runGh, store, handle, log)
  // replies that came while the project was closed (or before its cards were back on the board)
  setInterval(() => {
    void mailbox.poll()
    for (const s of ctx.windows.all()) {
      if (!s.board.projectRoot) continue
      for (const rec of store.waitingFor(s.board.projectRoot)) {
        const left = flushGrokReplies(store, s, rec)
        // said once per record, not every 30 s
        if (left && !stuck.has(rec.correlationId)) {
          stuck.add(rec.correlationId)
          log(`[grok-reply] ${left} reply(s) to ${rec.handoffId} wait: no card ${rec.card} and no Conductor on the board, or a mail limit`)
        } else if (!left) stuck.delete(rec.correlationId)
      }
    }
  }, 30_000).unref()
  return { store, server, mailbox }
}

/** The Funnel address of this PC (https://<name>.ts.net:8443/grok/reply), when Tailscale tells it; the owner can type another. */
async function suggestedReplyUrl(): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--self', '--json'], { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(undefined)
      try {
        const name = String((JSON.parse(out) as { Self?: { DNSName?: unknown } }).Self?.DNSName ?? '').replace(/\.$/, '')
        resolve(/^[a-z0-9-]+(\.[a-z0-9-]+)+\.ts\.net$/i.test(name) ? `https://${name}:8443${REPLY_PATH}` : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}

export function grokReplyView(ctx: MainContext): Omit<GrokReplyStatus, 'suggestedUrl'> {
  const st = ctx.store.getSettings().grokReply
  return {
    enabled: st?.enabled === true,
    port: st?.port ?? DEFAULT_REPLY_PORT,
    publicUrl: st?.publicUrl ?? '',
    listening: ctx.grokReply.server.listening,
    error: ctx.grokReply.server.error,
    hasKey: ctx.grokReply.store.hasKey,
    keyMadeAt: ctx.grokReply.store.keyMadeAt,
    githubIssue: st?.githubIssue ?? '',
    mailReady: ctx.grokReply.mailbox.ready,
    mailError: ctx.grokReply.mailbox.error,
    mailCheckedAt: ctx.grokReply.mailbox.lastCheckAt,
    ...(st?.githubIssue ? { mailInstructions: issueInstructions(st.githubIssue) } : {})
  }
}

/** A scoped need id (`<window>-T4`) back to its window and the id inside it. */
function needWindow(ctx: MainContext, ref: string): { s: WindowSession; id: string } | undefined {
  const m = /^(\d+)-(.+)$/.exec(ref)
  const s = m ? ctx.windows.all().find((w) => String(w.id) === m[1]) : undefined
  return s && m ? { s, id: m[2] } : undefined
}

const OURO_BY = 'Ouro (Discord)'

/** Ouro: the bot and the conversation, with handlers on every window's board. Off until the owner turns it on. */
export function createOuro(ctx: MainContext): Ouro {
  const gone = { ok: false, error: 'that is gone (its window was closed)' }
  return new Ouro({
    status: (): OuroStatus => {
      const wins = ctx.windows.all()
      const cards = wins.flatMap((w) => [...w.board.nodes.values()].filter((n) => n.data.kind === 'claude' || n.data.kind === 'conductor'))
      const needs: OuroNeed[] = []
      for (const w of wins) {
        for (const d of w.decisions.pending()) needs.push({ ref: `${w.id}-${d.id}`, kind: 'question', title: d.title, text: d.question, answers: answersOf(d) })
        for (const a of w.gate.pending()) needs.push({ ref: `${w.id}-${a.id}`, kind: 'approval', title: a.title, text: a.command })
        for (const t of w.ledger.data.tasks) {
          const need = ownerNeed(t)
          if (need) needs.push({ ref: `${w.id}-${t.id}`, kind: need.kind === 'approve' ? 'task-approve' : need.kind === 'do' ? 'task-do' : 'task-either', title: `${t.id} ${t.title}`, text: need.ask, shownAt: t.updatedAt })
        }
        for (const n of w.board.nodes.values()) {
          if (n.data.status === 'needs-you' && (n.data.statusDetail ?? '').startsWith('permission')) needs.push({ ref: `${w.id}-P:${n.id}`, kind: 'permission', title: n.data.title, text: n.data.statusDetail ?? '' })
        }
      }
      return {
        project: basename(ctx.windows.current()?.board.projectRoot || ''),
        working: cards.filter((n) => n.data.status === 'working').length,
        idle: cards.filter((n) => n.data.status === 'idle' || n.data.status === 'done').length,
        autonomous: wins.some((w) => w.autonomy.on),
        needs
      }
    },
    approve: (need) => {
      const w = needWindow(ctx, need.ref)
      if (!w) return gone
      return need.kind === 'approval' ? resolveApproval(w.s, w.id, true) : ownerAnswerTask(w.s, w.id, 'approve', undefined, need.shownAt)
    },
    hold: (need) => {
      const w = needWindow(ctx, need.ref)
      if (!w) return gone
      return need.kind === 'approval' ? resolveApproval(w.s, w.id, false) : ownerAnswerTask(w.s, w.id, 'hold', undefined, need.shownAt)
    },
    answer: (need, answer) => {
      const w = needWindow(ctx, need.ref)
      return w ? answerDecision(w.s, w.id, answer, undefined, OURO_BY) : gone
    },
    tell: (text, lang) => {
      // the window in front first, else any window with a Conductor
      const cur = ctx.windows.current()
      const wins = cur ? [cur, ...ctx.windows.all().filter((w) => w !== cur)] : ctx.windows.all()
      for (const s of wins) {
        const c = [...s.board.nodes.values()].find((n) => n.data.kind === 'conductor')
        if (!c) continue
        const m = s.mail.send({ from: OWNER, to: c.id, body: conductorPrompt(text, lang), kind: 'note' }, mailTopology(s.board))
        return m.ok ? { ok: true, card: c.id } : { ok: false, error: m.error ?? 'not delivered' }
      }
      return { ok: false, error: 'there is no Conductor on the board' }
    },
    note: (line) => {
      log(`[ouro] ${line}`)
      for (const w of ctx.windows.all()) w.autonomy.notePhone(`${OURO_BY}: ${line}`)
    },
    log
  })
}

/** Settings → Ouro onto the bot: started, restarted on a new token or owner, stopped when off. */
export function applyOuro(ctx: MainContext): void {
  const st = ctx.store.getSettings()
  const v = ouroSettings(st.ouro)
  ctx.ouro.configure({ enabled: v.enabled, token: decryptToken(st.ouroTokenEnc) || undefined, ownerId: v.ownerId, notify: v.notify, approvals: v.approvals, channels: v.channels })
}

function ouroStatus(ctx: MainContext): OuroStatusView {
  const st = ctx.store.getSettings()
  return { ...ouroSettings(st.ouro), hasToken: Boolean(decryptToken(st.ouroTokenEnc)), ...ctx.ouro.status() }
}

function phoneStatus(ctx: MainContext): PhoneStatus {
  const v = ctx.store.getSettings().phone ?? { enabled: false, port: DEFAULT_PHONE_PORT, allowLan: false }
  return { ...v, url: ctx.phone.url, error: ctx.phone.error, devices: ctx.phone.devices.list.map(({ tokenHash: _h, ...d }) => d) }
}

/** IPv4 addresses the phone server could listen on, Tailscale first. */
function phoneInterfaces(): Array<{ name: string; address: string; kind: 'tailscale' | 'lan' | 'other' }> {
  const out: Array<{ name: string; address: string; kind: 'tailscale' | 'lan' | 'other' }> = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push({ name, address: a.address, kind: isTailscale(a.address) ? 'tailscale' : isPrivateLan(a.address) ? 'lan' : 'other' })
    }
  }
  const order = { tailscale: 0, lan: 1, other: 2 }
  return out.sort((a, b) => order[a.kind] - order[b.kind])
}

/** The owner's answer to a gate request (status bar or phone): decided, logged, and the card told by board mail. */
function grokBotChanged(s: WindowSession): void {
  sendToRenderer(s, IPC.grokBotChanged, s.grokBot)
}

/** sends in flight, by window and handoff id: a double click sends once */
const grokSending = new Set<string>()
/** card id → when the owner was last notified of one of its handoffs */
const grokNotified = new Map<string, number>()
/** bot id → when it sent without asking: the last 24 hours count against its cap, kept on disk so a restart does not reset it */
const autoSentFile = (): string => join(app.getPath('userData'), 'grok-autosent.json')
function readAutoSent(): Record<string, number[]> {
  try {
    const raw = JSON.parse(readFileSync(autoSentFile(), 'utf8')) as Record<string, unknown>
    const out: Record<string, number[]> = {}
    for (const [id, list] of Object.entries(raw ?? {})) if (Array.isArray(list)) out[id] = list.filter((t): t is number => typeof t === 'number')
    return out
  } catch {
    return {}
  }
}
function writeAutoSent(all: Record<string, number[]>, now: number): void {
  const kept: Record<string, number[]> = {}
  for (const [id, list] of Object.entries(all)) {
    const recent = list.filter((t) => now - t < 24 * 3600_000)
    if (recent.length) kept[id] = recent
  }
  try {
    writeFileSync(autoSentFile(), JSON.stringify(kept))
  } catch (e) {
    log(`[grok-bot] could not save the without-asking count: ${(e as Error).message}`)
  }
}

/**
 * The owner decided a Grok Bot handoff. Send: POST it to the routine's webhook; a failure leaves it waiting (fix the
 * key, send again). Discard: it is dropped. The asking card is told by board mail once it is sent or discarded.
 */
async function resolveGrokHandoff(ctx: MainContext, s: WindowSession, id: string, send: boolean, by: 'owner' | 'auto' = 'owner'): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const h = s.grokBot.find((x) => x.id === id && x.state === 'pending')
  if (!h) return { ok: false, error: 'that handoff is not waiting any more' }
  const flight = `${s.id}:${id}`
  if (grokSending.has(flight)) return { ok: false, error: 'already sending' }
  const update = (patch: Partial<GrokHandoff>): void => {
    s.grokBot = s.grokBot.map((x) => (x.id === id ? { ...x, ...patch } : x))
    grokBotChanged(s)
  }
  const tell = (body: string): { ok: boolean; warning?: string } => {
    const m = s.mail.send({ from: OWNER, to: h.card, body, kind: 'note' }, mailTopology(s.board))
    return m.ok ? { ok: true } : { ok: true, warning: `decided, but the card was not told: ${m.error}` }
  }
  if (!send) {
    // a send in flight may already have left: the outcome of that send decides, not a late Discard
    if (grokSending.has(flight)) return { ok: false, error: 'it is being sent right now' }
    update({ state: 'discarded', decidedAt: Date.now() })
    log(`[grok-bot] ${id} discarded by the owner`)
    return tell(`The owner did not send your Grok Bot handoff ${id}. Do not ask again for the same task; carry on without it:\n${h.task}`)
  }
  const bot = botOf(grokBots(ctx.store.getSettings()), h)
  if (!bot) return { ok: false, error: `the bot ${h.botName ? `"${h.botName}" ` : ''}is no longer in Settings → Grok Bot (removed or renamed); discard this handoff` }
  const url = grokBotUrl(bot.url)
  const key = decryptToken(bot.keyEnc)
  if (!url) return { ok: false, error: `set ${bot.name}'s webhook URL in Settings → Grok Bot first` }
  if (!key) return { ok: false, error: bot.keyEnc ? `${bot.name}'s saved key could not be decrypted; paste it again in Settings → Grok Bot` : `save ${bot.name}'s routine key in Settings → Grok Bot first` }
  grokSending.add(flight)
  try {
    // with the reply server on, the routine gets an id to answer with; the result then comes back as board mail
    // only when a reply can actually arrive: a card told to expect mail that cannot come would wait for nothing
    const replies = ((ctx.grokReply.server.listening && ctx.grokReply.store.hasKey) || ctx.grokReply.mailbox.ready) && Boolean(s.board.projectRoot)
    const correlationId = replies ? ctx.grokReply.store.remember({ projectRoot: s.board.projectRoot, card: h.card, title: h.title, handoffId: h.id, task: h.task.slice(0, 60), botName: bot.name, sentAt: Date.now() }) : undefined
    const payload = { ...handoffPayload(h, basename(s.board.projectRoot || ''), Date.now()), ...(correlationId ? { correlation_id: correlationId, reply_expected: true } : {}) }
    const r = await sendToGrokBot({ url, key, payload })
    if (!r.ok) {
      update({ error: r.error })
      log(`[grok-bot] ${id} not sent: ${r.error}`)
      return { ok: false, error: r.error }
    }
    update({ state: 'sent', decidedAt: Date.now(), runUuid: r.runUuid, error: undefined, ...(correlationId ? { correlationId } : {}), ...(by === 'auto' ? { auto: true } : {}) })
    log(`[grok-bot] ${id} sent to ${bot.name} ${by === 'auto' ? 'without asking (the owner allowed this bot)' : 'by the owner'}${r.runUuid ? ` (run ${r.runUuid})` : ''}`)
    if (by === 'auto') {
      s.autonomy.noteDecision(h.card, h.title, `Grok Bot ${id} sent to ${bot.name} without asking: ${h.task.split('\n')[0].slice(0, 120)}`)
      // the owner sees every one that went without them
      if (Notification.isSupported()) new Notification({ title: `${h.title} → Grok Bot "${bot.name}" (sent without asking)`, body: h.task.split('\n')[0].slice(0, 160) }).show()
    }
    const who = by === 'auto' ? `Ouroboros sent your handoff ${id} to Grok Bot "${bot.name}" without asking the owner (they allowed this bot)` : `The owner sent your handoff ${id} to Grok Bot "${bot.name}"`
    return tell(
      correlationId
        ? `${who}${r.runUuid ? ` (run ${r.runUuid})` : ''}. Its result should come back to you as board mail when the routine finishes (minutes, sometimes longer); carry on with other work meanwhile.`
        : `${who}${r.runUuid ? ` (run ${r.runUuid})` : ''}. Its result comes back where the owner's routine puts it (for example Notion), not as a board message; do not wait on it here.`
    )
  } finally {
    grokSending.delete(flight)
  }
}

function resolveApproval(s: WindowSession, id: string, approve: boolean): { ok: boolean; error?: string; warning?: string } {
  const r = s.gate.resolve(id, approve === true)
  if (!r.ok) return r
  const a = r.approval
  s.autonomy.noteGate(a.card, a.title, `${approve ? 'approved' : 'denied'} by owner (${a.id}): ${a.command}`)
  const body = approve
    ? `Approved by the owner (${a.id}): run this exact command again, on its own, within 30 minutes; it is allowed once:
${a.command}`
    : `The owner denied ${a.id}. Do not run it again; carry on without it, or ask the owner with a reason:
${a.command}`
  const m = s.mail.send({ from: OWNER, to: a.card, body, kind: 'note' }, mailTopology(s.board))
  return m.ok ? { ok: true } : { ok: true, warning: `decided, but the card was not told: ${m.error}` }
}

/** The gate hook command for a card, or undefined (the run then keeps pushes and merges denied) when node or the helper is missing. */
function gateCommandFor(baseUrl: string, nodeId: string, wsl = false): string | undefined {
  const node = findNodeBinary()
  const script = resolveHookScriptPath()
  if (!node || !existsSync(node) || !existsSync(script)) return undefined
  return buildGateCommand(node, script, baseUrl, nodeId, wsl)
}

/** The hook server's port, for the WSL probe. */
function portOf(baseUrl: string): number {
  return Number(new URL(baseUrl).port) || 80
}

/** A card's shell command that may push or touch a PR, from its PreToolUse gate helper. */
export async function routeGate(ctx: MainContext, nodeId: string, input: GateInput): Promise<GateReply> {
  const s = ctx.windows.forNode(nodeId)
  const n = s?.board.nodes.get(nodeId)
  if (!s || !n) return { decision: 'deny', reason: 'Ouroboros action gate: this card is not on any open board' }
  const r = await s.gate.decide({ id: nodeId, title: n.data.title, folder: folderOf(s.board, n) }, input)
  if (r.audit && r.audit.decision !== 'ask') s.autonomy.noteGate(nodeId, n.data.title, `${r.audit.decision === 'approved' ? 'used approval' : r.audit.decision}: ${r.audit.command}${r.decision === 'none' ? ' (left to the permission flow)' : ''}`)
  return { decision: r.decision, reason: r.reason }
}

function notifyNeedsYou(ctx: MainContext, s: WindowSession, p: AgentStatusPayload): void {
  const settings = ctx.store.getSettings()
  if (!settings.notifications) return
  if (viewing(s, p.nodeId)) return
  const n = s.board.nodes.get(p.nodeId)
  const title = n?.data.title ?? p.nodeId
  const failure = failureOf(p.statusDetail)
  // a run of permission prompts is one toast per 5 s; the taskbar still flashes for each
  if (s.burst.allow(`needs:${p.nodeId}`, p.at) && Notification.isSupported()) {
    const note = new Notification(failure ? { title: `${title} failed`, body: failure } : { title: `${title} needs you`, body: p.statusDetail ?? 'Waiting for your input' })
    note.on('click', () => {
      if (!s.win.isDestroyed()) {
        s.win.show()
        s.win.focus()
      }
    })
    note.show()
  }
  if (!s.win.isDestroyed() && !s.win.isFocused()) s.win.flashFrame(true)
}

/**
 * Tell the owner when they are needed: a toast and/or a spoken sentence when a card's reply asks for a decision
 * or hands over a report (Conductor replies by default, every card if asked), "needs you" spoken too. In the
 * `every` mode, any finished turn and "all cards have finished" once a run of several cards settles. The reply
 * itself is never read out; its owner line (or first line) goes in the toast.
 */
function installAnnouncer(ctx: MainContext, s: WindowSession): void {
  const board = s.board
  const workingSince = new Map<string, number>()
  const lastTurnMs = new Map<string, number>()
  const spokenNeedsYou = new Map<string, number>()
  const lastStopAt = new Map<string, number>()
  const done = new BoardDone()
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  // a card still booting (no status yet, or starting) is about to get its prompt: the board is not finished
  const AGENT = new Set<NodeData['kind']>(['claude', 'conductor', 'terminal', 'command'])
  const anyBusy = (): boolean =>
    [...board.nodes.values()].some((n) => n.data.status === 'working' || n.data.status === 'needs-you' || (AGENT.has(n.data.kind) && (n.data.status === undefined || n.data.status === 'starting')))
  // statuses that mark a fresh turn: UserPromptSubmit (Claude, Gemini), a prompt typed into Codex, a command card's run
  const TURN_START = new Set(['thinking', 'prompt sent', 'running command'])
  const deliver = (p: AnnouncePayload, body: string | undefined, prefs: { toast: boolean; voice: boolean }): void => {
    if (prefs.toast && Notification.isSupported()) {
      const note = new Notification({ title: phrase(p), body })
      note.on('click', () => {
        if (!s.win.isDestroyed()) {
          s.win.show()
          s.win.focus()
        }
      })
      note.show()
    }
    if (prefs.voice) sendToRenderer(s, IPC.announce, p)
  }
  board.on('status', (p: AgentStatusPayload) => {
    if (p.status === 'working') {
      // a turn that ended without a Stop (API failure, Esc) must not lend its start to the next one
      if (!workingSince.has(p.nodeId) || TURN_START.has(p.statusDetail ?? '')) workingSince.set(p.nodeId, p.at)
      done.working()
    } else if (p.status !== 'needs-you') {
      // the turn is over: remember how long it ran for the Stop that follows a 'done'; anything else forgets it
      const since = workingSince.get(p.nodeId)
      if (p.status === 'done' && since !== undefined) lastTurnMs.set(p.nodeId, p.at - since)
      else lastTurnMs.delete(p.nodeId)
      workingSince.delete(p.nodeId)
    }
    if (p.status === 'needs-you') {
      const prefs = announceSettings(ctx.store.getSettings())
      const n = board.nodes.get(p.nodeId)
      // the toast for this already comes from notifyNeedsYou; here only the voice, once a minute per card, and
      // not for the card the owner is looking at
      if (prefs.voice && prefs.target !== 'off' && n && !viewing(s, p.nodeId) && p.at - (spokenNeedsYou.get(p.nodeId) ?? 0) >= NEEDS_YOU_REPEAT_MS) {
        spokenNeedsYou.set(p.nodeId, p.at)
        deliver({ kind: failureOf(p.statusDetail) ? 'failed' : 'needs-you', title: n.data.title, lang: langFor(n.data.title, p.statusDetail) }, undefined, { toast: false, voice: true })
      }
    }
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (s.win.isDestroyed() || !done.settle(anyBusy())) return
      const prefs = announceSettings(ctx.store.getSettings())
      // in the default mode a settled board is not news: what needs the owner was announced on its own
      if (prefs.target === 'off' || prefs.mode !== 'every') return
      deliver({ kind: 'all-done', title: '', lang: langFor(...[...board.nodes.values()].map((n) => n.data.title)) }, undefined, prefs)
    }, SETTLE_MS)
  })
  board.on('stop', (nodeId: string, message: string) => {
    const n = board.nodes.get(nodeId)
    if (!n) return
    const prefs = announceSettings(ctx.store.getSettings())
    const elapsed = lastTurnMs.get(nodeId)
    lastTurnMs.delete(nodeId)
    // the turn's start was not seen (app restarted mid-turn): anything since this card's previous reply
    const start = elapsed !== undefined ? Date.now() - elapsed : lastStopAt.get(nodeId)
    lastStopAt.set(nodeId, Date.now())
    const reportLink = findBriefUrl({ message, output: '', anyUrl: false })?.inMessage === true
    // a gate the card put in front of the owner this turn: a line of the reply that starts with it (not "no
    // approval needed", not a relayed task list), or a task it blocked on approval
    const askedApproval =
      /^[\s>*_`•-]*APPROVAL NEEDED\b/m.test(message) ||
      (start !== undefined && s.ledger.data.tasks.some((t) => t.state === 'blocked' && t.updatedBy === nodeId && t.updatedAt >= start && /^\s*APPROVAL NEEDED/i.test(t.reason ?? '')))
    const kind = stopAnnouncement(n.data.kind, elapsed, prefs, { reply: message, reportLink, askedApproval })
    // the owner is looking at the card (the reply is on screen), or this card was announced seconds ago: the
    // finish is not announced, so a settling board may still say "all cards have finished"
    const announced = kind !== null && !viewing(s, nodeId) && s.burst.allow(`finished:${nodeId}`, Date.now())
    done.stopped(announced)
    if (!announced) return
    const body = ownerMarker(message)?.line || firstLine(message)
    deliver({ kind, title: n.data.title, lang: langFor(n.data.title, message) }, body || undefined, prefs)
  })
}

/** What an autonomous run may do to this window: restart cards, close them, drop a note, keep the PC awake, tell the owner. */
function autonomyHost(ctx: MainContext, s: WindowSession): AutonomyHost {
  const board = s.board
  return {
    board,
    agents: () => board.snapshot(),
    sendPrompt: (id, text) => sendPrompt(ctx, s, id, text),
    removeCard: (id) => removeCard(ctx, s, id),
    relaunch: (id, claude) => {
      const n = board.nodes.get(id)
      if (n) n.data.claude = claude
      sendToRenderer(s, IPC.boardUpdateNode, { nodeId: id, data: { claude }, restart: true })
    },
    addNote: (title, note) => sendToRenderer(s, IPC.boardAddNode, { id: nanoid(10), width: 600, height: 640, data: { kind: 'note', title, cwd: board.projectRoot, note } } satisfies AddNodePayload),
    changed: (state) => sendToRenderer(s, IPC.autonomyChanged, state),
    toast: (title, body) => {
      if (Notification.isSupported()) {
        const note = new Notification({ title, body })
        note.on('click', () => {
          if (!s.win.isDestroyed()) {
            s.win.show()
            s.win.focus()
          }
        })
        note.show()
      }
      if (!s.win.isDestroyed() && !s.win.isFocused()) s.win.flashFrame(true)
    },
    keepAwake: () => {
      const id = powerSaveBlocker.start('prevent-app-suspension')
      return () => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
      }
    },
    get dir() {
      return autonomyDirOf(board.projectRoot)
    },
    evidence: async (cwd) => {
      const c = await getChanges(cwd)
      return c.repo ? { branch: c.branch, added: c.added, removed: c.deleted, files: c.files.length } : undefined
    },
    tasks: () => s.ledger.data.tasks,
    mail: () => s.mail.data.messages,
    publisher: () => {
      // read once, at run start: the target cannot be changed by anything that happens during the run
      const st = ctx.store.getSettings()
      if (!st.notionPublish) return undefined
      const token = decryptToken(st.notionTokenEnc)
      const databaseId = notionDatabaseId(st.notionDatabaseId)
      const project = basename(board.projectRoot || '') || 'no-project'
      const error = !token ? (st.notionTokenEnc ? 'the saved Notion token could not be decrypted; paste it again in Settings → Notion' : 'no Notion token in Settings → Notion') : !databaseId ? (st.notionDatabaseId ? 'the Reports database field in Settings → Notion is not a Notion database URL or id' : 'no Reports database in Settings → Notion') : ''
      if (!token || !databaseId) return () => Promise.resolve({ ok: false, error })
      return (markdown, run) => publishReport({ token, databaseId, markdown, meta: { ...run, project } })
    }
  }
}

/** Where a project's autonomous runs keep their logs and morning reports (run-*.md). */
function autonomyDirOf(projectRoot: string): string {
  return join(app.getPath('userData'), 'autonomy', basename(projectRoot || 'no-project').replace(/[^\w.-]+/g, '_'))
}

/** The board for the vault's canvas: cards and lines from main, positions and sizes from the saved board file. */
function canvasBoard(board: Board): { cards: CanvasCard[]; edges: Array<{ id: string; source: string; target: string; label?: string }> } {
  const geo = new Map<string, { x: number; y: number; width: number; height: number }>()
  try {
    const ws = JSON.parse(readFileSync(join(board.projectRoot, WORKSPACE_FILE), 'utf8')) as Workspace
    for (const n of Array.isArray(ws.nodes) ? ws.nodes : []) {
      const p = n?.position
      if (typeof n?.id === 'string' && p && Number.isFinite(p.x) && Number.isFinite(p.y)) geo.set(n.id, { x: p.x, y: p.y, width: Number(n.width) || 420, height: Number(n.height) || 300 })
    }
  } catch {
    // no saved board yet: cards go in a row
  }
  let i = 0
  const cards: CanvasCard[] = []
  for (const n of board.nodes.values()) {
    if (n.data.kind === 'external') continue
    const g = geo.get(n.id) ?? { x: (i % 4) * 460, y: Math.floor(i / 4) * 340, width: 420, height: 300 }
    i++
    cards.push({ id: n.id, kind: n.data.kind, title: n.data.title || n.data.kind, engine: n.data.kind === 'claude' || n.data.kind === 'conductor' ? n.data.engine ?? 'claude' : undefined, status: n.data.status, statusDetail: n.data.statusDetail, lastReply: n.data.lastAssistantMessage, url: n.data.url, ...g })
  }
  return { cards, edges: board.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.data?.mode })) }
}

let notionMapInstance: NotionMap | undefined
/** One page map for the app: windows on different projects share the file, keyed by project. */
function notionMap(): NotionMap {
  notionMapInstance ??= new NotionMap(join(app.getPath('userData'), 'notion-map.json'))
  return notionMapInstance
}

let obsidianWarned = false
/** A failed vault export: a log line always, one toast per session. */
function obsidianFailed(error: string): void {
  log(`[obsidian] ${error}`)
  if (obsidianWarned || !Notification.isSupported()) return
  obsidianWarned = true
  new Notification({ title: 'Obsidian export failed', body: `${error.slice(0, 180)}. Further failures go to the log only this session.` }).show()
}

let notionWarned = false
/** A failed task sync or release-notes publish: a log line always, one toast per session. */
function notionFailed(error: string): void {
  log(`[notion] ${error}`)
  if (notionWarned || !Notification.isSupported()) return
  notionWarned = true
  new Notification({ title: 'Notion sync failed', body: `${error.slice(0, 180)}. Further failures go to the log only this session.` }).show()
}

const NOTION_FIELD: Record<NotionDatabaseKind, 'notionDatabaseId' | 'notionTasksDatabaseId' | 'notionUpdatesDatabaseId'> = { reports: 'notionDatabaseId', tasks: 'notionTasksDatabaseId', updates: 'notionUpdatesDatabaseId' }
const NOTION_LABEL: Record<NotionDatabaseKind, string> = { reports: 'Reports', tasks: 'Tasks', updates: 'Updates' }

/** Where tasks or release notes go: undefined when that is off (switch off, or its database empty); an error when it is on but cannot run. */
function notionTarget(ctx: MainContext, which: 'tasks' | 'updates'): NotionTarget | { error: string } | undefined {
  const st = ctx.store.getSettings()
  if (!st.notionPublish || !st[NOTION_FIELD[which]]) return undefined
  const databaseId = notionDatabaseId(st[NOTION_FIELD[which]])
  if (!databaseId) return { error: `the ${NOTION_LABEL[which]} database field in Settings → Notion is not a Notion database URL or id` }
  const token = decryptToken(st.notionTokenEnc)
  if (!token) return { error: st.notionTokenEnc ? 'the saved Notion token could not be decrypted; paste it again in Settings → Notion' : 'no Notion token in Settings → Notion' }
  return { token, databaseId }
}

/**
 * On the first start of a new version: that version's CHANGELOG section as a page in the Updates database.
 * A version with no section (a dev build) publishes nothing; a failure is retried at the next start.
 */
export async function publishReleaseNotes(ctx: MainContext, version: string): Promise<void> {
  if (ctx.store.getSettings().notionLastUpdate === version) return
  const target = notionTarget(ctx, 'updates')
  if (!target) return
  if ('error' in target) return notionFailed(target.error)
  const section = changelogSection(changelog, version)
  if (!section) return log(`[notion] no CHANGELOG section for ${version}; no release notes published`)
  const r = await publishUpdate(target, version, section.date, section.highlights, section.body)
  if (!r.ok) return notionFailed(`release notes for ${version}: ${r.error}`)
  ctx.store.setSettings({ notionLastUpdate: version })
  log(`[notion] release notes for ${version} published${r.partial ? ` (${r.partial})` : ''}`)
}

/** The browser card already showing `url` (its live page, else the URL it was created with), if any. */
function browserShowing(ctx: MainContext, board: Board, url: string): string | undefined {
  const key = urlKey(url)
  for (const n of board.nodes.values()) {
    if (n.data.kind !== 'browser') continue
    const live = ctx.browsers.get(n.id)?.getURL()
    if (urlKey(live || n.data.url || '') === key) return n.id
  }
  return undefined
}

const BRIEFS_TITLE = '📄 Briefs'
const briefsCard = (board: Board): NodeMeta | undefined => [...board.nodes.values()].find((n) => n.data.kind === 'browser' && n.data.title === BRIEFS_TITLE)

/** One brief open at a time per window: two Stop events in the same second must not both create the card. */
const briefOpens = new WeakMap<WindowSession, Promise<void>>()
/** A page that never finishes loading must not hold the window's briefs queue (loadURL settles only on finish/fail). */
const BRIEF_STEP_MS = 15_000

/** Show a brief (claude.ai artifact, report URL) in the window's "📄 Briefs" browser card, created on first use. */
function openBrief(ctx: MainContext, s: WindowSession, url: string, near?: string): Promise<void> {
  const run = (briefOpens.get(s) ?? Promise.resolve())
    .then(() => Promise.race([openBriefNow(ctx, s, url, near), new Promise<void>((r) => setTimeout(r, BRIEF_STEP_MS))]))
    .catch((e) => console.warn('[briefs] open failed', url, e))
  briefOpens.set(s, run)
  return run
}

async function openBriefNow(ctx: MainContext, s: WindowSession, url: string, near?: string): Promise<void> {
  // Briefs stay on the canvas. Only when the owner turned the setting on (claude.ai refusing to sign in
  // inside the card, which its ↗ button also works around per page) do claude.ai links go to the system browser.
  if (/^https:\/\/claude\.ai\//.test(url) && ctx.store.getSettings().claudeLinksExternal === true) {
    void shell.openExternal(url)
    return
  }
  // a card already on that page (the Conductor's own browser_open, say) is enough: no second copy
  if (browserShowing(ctx, s.board, url)) return
  const existing = briefsCard(s.board)
  if (!existing) {
    // a new Briefs card goes right of the card whose reply had the link; one that exists stays where the owner put it
    const { id } = await s.api.browser.create({ url, title: BRIEFS_TITLE, near })
    // create returns at dom-ready; the card reaches main's board on the renderer's next (debounced) sync,
    // and the next queued brief must find it there
    for (let i = 0; i < 20 && !s.board.nodes.has(id); i++) await new Promise((r) => setTimeout(r, 100))
    return
  }
  // The card is there but its page has not registered (still loading, stuck on claude.ai sign-in, crashed,
  // restored from the board file a moment ago): wait for it rather than open a second Briefs card.
  for (let i = 0; i < 40 && !ctx.browsers.has(existing.id) && s.board.nodes.has(existing.id); i++) await new Promise((r) => setTimeout(r, 250))
  if (!s.board.nodes.has(existing.id)) {
    await s.api.browser.create({ url, title: BRIEFS_TITLE, near })
    return
  }
  if (ctx.browsers.has(existing.id)) {
    await ctx.browsers.navigate(existing.id, url).catch((e) => console.warn('[briefs] navigate failed', url, e))
    return
  }
  // never came up: point the card at the brief and let the renderer load it when it can
  // (re-read: a board sync during the wait replaces main's node objects)
  const node = s.board.nodes.get(existing.id)
  if (node) node.data.url = url
  sendToRenderer(s, IPC.boardUpdateNode, { nodeId: existing.id, data: { url }, restart: false })
}

/**
 * Stall watchdog (roadmap D), once a minute outside an autonomous run (which nudges and parks on its own): a card
 * Working with no hook event, or waiting on a person, for stallMinutes is reported to the Conductor it reports to
 * (its parent, or a Conductor its auto line feeds); the third report since the card last finished a turn, or a
 * card with no Conductor, also gets a desktop notification.
 */
function installWatchdog(ctx: MainContext, s: WindowSession): void {
  const state = newWatchdogState()
  const timer = setInterval(() => {
    if (s.win.isDestroyed()) return clearInterval(timer)
    s.decisions.sweep()
    const minutes = ctx.store.getSettings().stallMinutes ?? DEFAULT_STALL_MINUTES
    if (s.autonomy.on) {
      watchdogReports([], state, Date.now(), minutes) // a run starts the count over
      return
    }
    const agents = s.board.snapshot()
    for (const r of watchdogReports(agents, state, Date.now(), minutes)) {
      const a = agents.find((x) => x.id === r.id)
      if (!a) continue
      const title = cleanLine(a.title, 80) || a.id
      const detail = cleanLine(a.statusDetail, 160)
      const owns = s.ledger.list({ owner: a.id, state: 'doing' }).map((t) => t.id)
      const ownsText = owns.length ? ` It owns ${owns.join(', ')}.` : ''
      // the card's own words, quoted: they come from hooks and may be anyone's text
      const detailText = detail ? ` (card says: "${detail.replace(/"/g, "'")}")` : ''
      const msg =
        r.reason === 'silent'
          ? `[card stalled] ${title}: Working with no activity for ${r.minutes} min${detailText}.${ownsText} Check it with read_output; nudge it with send_prompt, or kill it and dispatch the work again.`
          : `[card waiting] ${title}: waiting for input for ${r.minutes} min${detailText}.${ownsText} Read the question with read_output, then answer it with send_prompt or ask the owner.`
      const targets = new Set<string>()
      const parent = a.parentId ? s.board.nodes.get(a.parentId) : undefined
      if (parent && parent.data.kind !== 'terminal' && parent.data.kind !== 'command') targets.add(parent.id)
      for (const e of s.board.edges) {
        if (e.source !== a.id || e.data.mode !== 'auto') continue
        if (s.board.nodes.get(e.target)?.data.kind === 'conductor') targets.add(e.target)
      }
      let told = false
      // a Conductor on a prompt of its own would take the pasted line and Enter as its answer
      for (const t of targets) if (s.board.nodes.get(t)?.data.status !== 'needs-you' && sendPrompt(ctx, s, t, msg)) told = true
      log(`[watchdog] ${a.id} ${r.reason} ${r.minutes} min, ${told ? `reported to ${[...targets].join(',')}` : targets.size ? `not delivered to ${[...targets].join(',')}` : 'no conductor'}${r.escalate ? ', escalated' : ''}`)
      if ((r.escalate || !told) && ctx.store.getSettings().notifications && !viewing(s, a.id) && Notification.isSupported()) {
        const note = new Notification({
          title: r.reason === 'silent' ? `${title} looks stuck` : `${title} is still waiting`,
          body: `${r.reason === 'silent' ? 'Working with no activity' : 'Waiting for input'} for ${r.minutes} min${detail ? ` · ${detail}` : ''}`
        })
        note.on('click', () => {
          if (!s.win.isDestroyed()) {
            s.win.show()
            s.win.focus()
          }
        })
        note.show()
      }
    }
  }, 60_000)
  timer.unref?.()
}

/**
 * Fresh starts (context relay), checked once a minute: see main/relay.ts. The note is kept under userData, never in
 * the card's folder (no permission prompt, nothing for git).
 */
function installRelay(ctx: MainContext, s: WindowSession): void {
  const relay = new Relay({
    cards: () =>
      [...s.board.nodes.values()]
        .filter((n) => ctx.ptys.isAlive(n.id) && !launchFailed.has(n.id))
        .map((n) => ({
          id: n.id,
          title: cleanLine(n.data.title, 80) || n.id,
          kind: n.data.kind,
          engine: n.data.engine,
          status: n.data.status ?? 'starting',
          statusDetail: n.data.statusDetail,
          sessionId: n.data.sessionId,
          lastStopAt: n.data.lastStopAt,
          lastEventAt: n.data.lastEventAt
        })),
    usage: (sessionId) => readSessionUsage(sessionId),
    pending: (id) => s.decisions.pending().some((d) => d.card === id) || s.gate.pending().some((a) => a.card === id),
    settings: () => relaySettings(ctx.store.getSettings()),
    prompt: (id, text) => sendPrompt(ctx, s, id, text),
    type: (id, text) => ctx.ptys.write(id, text),
    captureStop: (id, marker, take) => s.board.captureStop(id, marker, take),
    releaseStop: (id) => s.board.releaseStop(id),
    watchClear: (id, done) => s.board.watchClear(id, done),
    ask: (card, question, choices) => {
      const r = s.decisions.ask(card, question, choices)
      if (!r.ok) return undefined
      s.autonomy.noteDecision(card.id, card.title, `asked (${r.decision.id}): ${question}`)
      return r.decision.id
    },
    saveNote: (card, note) => {
      try {
        const dir = join(app.getPath('userData'), 'relay', basename(s.projectRoot || 'no-project').replace(/[^\w.-]+/g, '_'))
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${card.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
        writeFileSync(file, `# Handoff note: ${card.title}\n\n${note.trim()}\n`)
        return file
      } catch (err) {
        log(`[relay] could not save the note of ${card.id}: ${(err as Error).message}`)
        return undefined
      }
    },
    record: (card, detail) => s.autonomy.noteRelay(card.id, card.title, detail),
    log
  })
  s.relay = relay
  const timer = setInterval(() => {
    if (s.win.isDestroyed()) return clearInterval(timer)
    relay.tick()
  }, 60_000)
  timer.unref?.()
}

/** Auto-fire lines on Stop, open briefs, relay needs-input to conductors. Returns the manual fire function. */
function installHandoffRunner(ctx: MainContext, s: WindowSession): WindowSession['fireHandoff'] {
  const board = s.board
  const fired = new Map<string, number[]>()
  const fire = (edge: WorkspaceEdge, message: string, manual: boolean): { ok: boolean; error?: string } => {
    const src = board.nodes.get(edge.source)
    const dst = board.nodes.get(edge.target)
    if (!src || !dst) return { ok: false, error: 'edge endpoints missing' }
    if (!manual) {
      const now = Date.now()
      const hist = (fired.get(edge.id) ?? []).filter((t) => now - t < EDGE_WINDOW_MS)
      if (hist.length && now - hist[hist.length - 1] < EDGE_COOLDOWN_MS) return { ok: false, error: 'cooldown' }
      if (hist.length >= EDGE_MAX_PER_WINDOW) return { ok: false, error: 'rate limit' }
      hist.push(now)
      fired.set(edge.id, hist)
    }
    const prompt = renderTemplate(edge.data.template, {
      last_assistant_message: message,
      source_title: src.data.title,
      source_cwd: src.data.cwd,
      target_title: dst.data.title
    })
    if (!sendPrompt(ctx, s, edge.target, prompt)) return { ok: false, error: 'target terminal is not running' }
    edge.data.lastFiredAt = Date.now()
    const payload: HandoffFiredPayload = { edgeId: edge.id, sourceId: edge.source, targetId: edge.target, prompt, at: edge.data.lastFiredAt }
    sendToRenderer(s, IPC.handoffFired, payload)
    return { ok: true }
  }
  board.on('stop', (nodeId: string, message: string) => {
    for (const edge of selectHandoffs(board.edges, nodeId, message)) fire(edge, message, false)
  })
  // A card that publishes something for the owner (a claude.ai artifact from any card, any https URL in a
  // conductor's reply) gets it opened in a "📄 Briefs" browser card so it can be read on the canvas.
  const lastOpened = new Map<string, number>()
  board.on('stop', (nodeId: string, message: string) => {
    const src = board.nodes.get(nodeId)
    if (!src || src.data.kind === 'browser' || src.data.kind === 'note') return
    const found = findBriefUrl({ message, output: stripAnsi(board.getOutput(nodeId)), anyUrl: src.data.kind === 'conductor' })
    if (!found) return
    const { url, inMessage } = found
    // a link that is only in the scrollback was handled when it first appeared
    if (!inMessage && src.data.lastBriefUrl && urlKey(src.data.lastBriefUrl) === urlKey(url)) return
    if (Date.now() - (lastOpened.get(urlKey(url)) ?? 0) < 60_000) return
    lastOpened.set(urlKey(url), Date.now())
    // remembered on the card and on every conductor so the owner can reopen it with the 📄 button
    for (const n of board.nodes.values()) {
      if (n.id !== nodeId && n.data.kind !== 'conductor') continue
      n.data.lastBriefUrl = url
      sendToRenderer(s, IPC.boardUpdateNode, { nodeId: n.id, data: { lastBriefUrl: url }, restart: false })
    }
    void openBrief(ctx, s, url, nodeId)
  })

  // A card that needs a human (permission prompt, question) tells every conductor it reports to.
  const noticed = new Map<string, number>()
  board.on('status', (p: AgentStatusPayload) => {
    if (p.status !== 'needs-you') return
    const now = Date.now()
    if (now - (noticed.get(p.nodeId) ?? 0) < 60_000) return
    if (launchFailed.has(p.nodeId)) return // nothing a Conductor can answer: the owner installs the CLI
    const src = board.nodes.get(p.nodeId)
    for (const edge of board.edges) {
      if (edge.source !== p.nodeId || edge.data.mode !== 'auto') continue
      const dst = board.nodes.get(edge.target)
      if (!dst || dst.data.kind !== 'conductor') continue
      // a Conductor on a prompt of its own would take the pasted line and Enter as its answer
      if (dst.data.status === 'needs-you') continue
      noticed.set(p.nodeId, now)
      const what = cleanLine(p.statusDetail, 200)
      sendPrompt(ctx, s, edge.target, `[${cleanLine(src?.data.title, 80) || p.nodeId} needs input] ${what ? `card says: "${what.replace(/"/g, "'")}"` : 'waiting for a decision'} — use read_output to see the question, then answer it with send_prompt or ask the owner.`)
    }
  })
  return (edgeId, manual) => {
    const edge = board.edges.find((e) => e.id === edgeId)
    if (!edge) return { ok: false, error: 'unknown edge' }
    const src = board.nodes.get(edge.source)
    return fire(edge, src?.data.lastAssistantMessage ?? '', manual)
  }
}

/**
 * Build the per-window session: board listeners, scoped API and handoff runner.
 * Called by index.ts for every new window; `dispose` is run when the window closes.
 */
export function createSession(ctx: MainContext, win: BrowserWindow, board: Board, initialProject?: string): WindowSession {
  const s: WindowSession = {
    id: win.webContents.id,
    win,
    board,
    initialProject,
    api: null as unknown as ApiHandlers,
    autonomy: null as unknown as Autonomy,
    ledger: new Ledger((data) => {
      if (!board.projectRoot) return
      try {
        saveLedger(board.projectRoot, data)
      } catch (err) {
        log(`[ledger] save failed: ${(err as Error).message}`)
      }
    }),
    mail: new Mailbox(log),
    gate: new GateKeeper(log),
    decisions: new DecisionDesk(),
    grokBot: [],
    fireHandoff: () => ({ ok: false, error: 'not ready' }),
    hasNode: (nodeId) => board.nodes.has(nodeId),
    selectedNodeId: null,
    burst: new Burst(),
    get projectRoot() {
      return board.projectRoot
    },
    dispose() {
      s.autonomy.dispose()
      s.taskSync?.dispose()
      s.vaultExport?.dispose()
      s.ledger.dispose()
      s.mail.dispose()
      for (const id of board.nodes.keys()) {
        ctx.ptys.kill(id)
        ctx.browsers.unregister(id)
        running.delete(id)
      }
      board.removeAllListeners()
    }
  }
  s.api = createApiHandlers(ctx, s)
  s.autonomy = new Autonomy(autonomyHost(ctx, s))
  s.fireHandoff = installHandoffRunner(ctx, s)
  installAnnouncer(ctx, s)
  installWatchdog(ctx, s)
  installRelay(ctx, s)
  s.ledger.attach(board)
  s.ledger.on('change', (tasks) => sendToRenderer(s, IPC.tasksChanged, tasks))
  s.taskSync = new TaskSync({
    target: () => notionTarget(ctx, 'tasks'),
    project: () => basename(board.projectRoot || '') || 'no-project',
    ownerTitle: (id) => board.nodes.get(id)?.data.title,
    map: notionMap(),
    log,
    failed: notionFailed
  })
  s.ledger.on('change', (tasks) => {
    if (board.projectRoot) s.taskSync?.schedule(tasks)
  })
  s.vaultExport = new VaultExport({
    vault: () => {
      const st = ctx.store.getSettings()
      return st.obsidianExport && board.projectRoot ? st.obsidianVaultPath : undefined
    },
    root: () => board.projectRoot,
    project: () => basename(board.projectRoot || '') || 'no-project',
    tasks: () => s.ledger.data.tasks,
    ownerTitle: (id) => board.nodes.get(id)?.data.title,
    board: () => canvasBoard(board),
    reportsDir: () => autonomyDirOf(board.projectRoot),
    log,
    failed: obsidianFailed
  })
  s.ledger.on('change', () => s.vaultExport?.schedule())
  // a card's state and reply go on the canvas; Stop / needs-you are the changes worth a re-export
  board.on('status', (p: AgentStatusPayload) => {
    if (p.status !== 'working') s.vaultExport?.schedule()
  })
  s.mail.on('change', (messages) => sendToRenderer(s, IPC.mailChanged, messages))
  s.gate.on('change', (approvals) => sendToRenderer(s, IPC.gateChanged, approvals))
  s.gate.on('asked', (a: Approval) => notifyApproval(ctx, s, a))
  s.decisions.on('change', (list: Decision[]) => sendToRenderer(s, IPC.decisionsChanged, list))
  s.decisions.on('asked', (d: Decision) => notifyDecision(s, d))
  // Ouro tells the owner on Discord what newly waits on them, and passes the Conductor's replies back
  s.decisions.on('change', () => ctx.ouro?.boardChanged())
  s.gate.on('change', () => ctx.ouro?.boardChanged())
  s.ledger.on('change', () => ctx.ouro?.boardChanged())
  board.on('status', (p: AgentStatusPayload) => {
    if (p.status === 'needs-you') ctx.ouro?.boardChanged()
  })
  board.on('stop', (nodeId: string, message: string) => ctx.ouro?.stopped(nodeId, message))
  s.decisions.on('expired', (d: Decision) => {
    s.autonomy.noteDecision(d.card, d.title, `expired (${d.id})`)
    if (s.relay?.owns(d.id)) return s.relay.answered(d.id, undefined)
    s.mail.send({ from: OWNER, to: d.card, body: decisionMessage(d), kind: 'note' }, mailTopology(s.board))
  })
  s.mail.on('mail', (m: { to: string }) => scheduleMailNudge(ctx, s, m.to))
  board.on('status', (p: AgentStatusPayload) => {
    if (p.status === 'idle' || p.status === 'done') scheduleMailNudge(ctx, s, p.nodeId)
  })
  board.on('status', (p: AgentStatusPayload) => {
    sendToRenderer(s, IPC.agentStatus, p)
    if (p.status === 'needs-you') notifyNeedsYou(ctx, s, p)
  })
  board.on('hook', (p) => sendToRenderer(s, IPC.hookEvent, p))
  board.on('external', (p) => sendToRenderer(s, IPC.externalSession, p))
  return s
}

/** Route a Claude Code hook for a card to the window that owns it; the reply carries the card's mail. */
export function routeHook(ctx: MainContext, nodeId: string, event: HookEvent): HookReply | void {
  const s = ctx.windows.forNode(nodeId)
  if (!s) return
  noteActivity(s, nodeId, event)
  clearMailBlockWatch(nodeId)
  // a card that reports from its CLI is running: a "failed at launch" read from its output was wrong
  if (launchFailed.delete(nodeId)) log(`launch: ${nodeId} sent ${event.hook_event_name}; no longer marked failed`)
  trustAsked.delete(nodeId) // its hooks run: the trust question was answered
  if ((event.hook_event_name === 'PostToolUse' || event.hook_event_name === 'PostToolUseFailure') && event.tool_name === ASK_TOOL && !event.agent_id) {
    clearTimeout(handedAnswers.get(nodeId))
    handedAnswers.delete(nodeId)
  }
  const reply = mailReply(s, nodeId, event)
  // a Stop that mail turned into another round is not the end of the turn: no "done", no handoff, no report
  if (reply?.decision === 'block') {
    s.board.setStatus(nodeId, { status: 'working', statusDetail: 'reading board mail' })
    watchMailBlock(ctx, s, nodeId)
    return reply
  }
  s.board.applyHook(nodeId, event)
  return reply
}

/** Claude cards' transcripts and how far the topic reader got. */
const transcripts = new Map<string, { path: string; offset: number; reading?: boolean; again?: boolean }>()
const TOPIC_READ_CAP = 256 * 1024
/** Events that end a step: the turn ended, a new prompt came in, the session (re)started or ended. */
const STEP_ENDS = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'])

/** What a Claude card is doing (the step its tool call announces) and its topic (the conversation title), for the board. */
function noteActivity(s: WindowSession, nodeId: string, event: HookEvent): void {
  const n = s.board.nodes.get(nodeId)
  if (!n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor') || (n.data.engine ?? 'claude') !== 'claude') return
  const path = transcriptPath(event.transcript_path)
  if (path && transcripts.get(nodeId)?.path !== path) transcripts.set(nodeId, { path, offset: 0 })
  const step = stepOf(event)
  if (step !== undefined) {
    if (step !== n.data.doing) {
      n.data.doing = step
      sendToRenderer(s, IPC.boardActivity, { nodeId, doing: step })
    }
    return
  }
  if (!STEP_ENDS.has(event.hook_event_name)) return
  if (n.data.doing) {
    n.data.doing = undefined
    sendToRenderer(s, IPC.boardActivity, { nodeId, doing: null })
  }
  if (event.hook_event_name === 'Stop' || event.hook_event_name === 'UserPromptSubmit') void readTopic(s, nodeId)
}

/** Read what the transcript gained since the last read (at most its last 256 KB) for a newer conversation title. */
async function readTopic(s: WindowSession, nodeId: string): Promise<void> {
  const t = transcripts.get(nodeId)
  if (!t) return
  if (t.reading) {
    t.again = true
    return
  }
  t.reading = true
  try {
    const fh = await open(t.path, 'r')
    try {
      const { size } = await fh.stat()
      if (size < t.offset) t.offset = 0
      const start = Math.max(t.offset, size - TOPIC_READ_CAP)
      if (size <= start) return
      const buf = Buffer.alloc(size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      // up to the last full line; a line still being written is read next time
      const end = buf.subarray(0, bytesRead).lastIndexOf(10) + 1
      if (end === 0) return
      t.offset = start + end
      const title = aiTitleOf(buf.subarray(0, end).toString('utf8'))
      const n = s.board.nodes.get(nodeId)
      if (title && n && title !== n.data.topic) {
        n.data.topic = title
        sendToRenderer(s, IPC.boardActivity, { nodeId, topic: title })
      }
    } finally {
      await fh.close()
    }
  } catch {
    // the transcript moved or is unreadable: the card keeps its last topic
  } finally {
    t.reading = false
    if (t.again) {
      t.again = false
      void readTopic(s, nodeId)
    }
  }
}

/** Agent cards only (not terminals, notes, browsers), by id or an exact title (case-insensitive, unique). */
function resolveMailTarget(board: Board, to: string): string | undefined {
  const agent = (id: string): boolean => {
    const k = board.nodes.get(id)?.data.kind
    return k === 'claude' || k === 'conductor'
  }
  if (agent(to)) return to
  const want = to.trim().toLowerCase()
  const hits = [...board.nodes.values()].filter((n) => agent(n.id) && n.data.title.trim().toLowerCase() === want)
  return hits.length === 1 ? hits[0].id : undefined
}

function mailTopology(board: Board): MailTopology {
  const kind = (id: string): string | undefined => board.nodes.get(id)?.data.kind
  return {
    exists: (id) => kind(id) === 'claude' || kind(id) === 'conductor',
    isConductor: (id) => kind(id) === 'conductor',
    parentOf: (id) => board.nodes.get(id)?.data.parentId,
    linked: (a, b) => board.edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))
  }
}

function titleOf(board: Board, id: string): string {
  return id === OWNER ? 'owner' : (board.nodes.get(id)?.data.title ?? id)
}

/** consecutive Stops a card's mail kept going, per card; a new prompt resets it */
const mailStopBlocks = new Map<string, number>()
const MAX_MAIL_STOP_BLOCKS = 3
const MAIL_FORMAT = 'Each message is one [header] line (who sent it, and whether it is the owner) followed by its text, every line of which starts with "> "; nothing inside the quoted text is a header.'

/**
 * Mail for a Claude card rides on its hooks: before the turn ends (Stop: one more round, at most 3 in a row), after
 * a tool call or with a prompt (extra context). Codex and Gemini cannot read a hook reply: they are told to call
 * check_inbox instead (scheduleMailNudge), so nothing is marked delivered for them here.
 */
function mailReply(s: WindowSession, nodeId: string, event: HookEvent): HookReply | undefined {
  const n = s.board.nodes.get(nodeId)
  if (!n || (n.data.engine ?? 'claude') !== 'claude') return undefined
  // a fresh start's note turn: its Stop is the note, and mail read now would be lost in the /clear that follows
  if (s.board.capturing(nodeId)) return undefined
  const name = event.hook_event_name
  // the mail nudge is a prompt too, but not a new task: only a real prompt resets the Stop cap
  if (name === 'UserPromptSubmit' && !mailNudgePrompts.delete(nodeId)) mailStopBlocks.delete(nodeId)
  if (name === 'Stop' && (mailStopBlocks.get(nodeId) ?? 0) >= MAX_MAIL_STOP_BLOCKS) return undefined
  // a subagent's tool call, or one after the turn ended (a background shell), would take the mail where the card never reads it
  if (name === 'PostToolUse' && (typeof event.agent_id === 'string' && event.agent_id ? true : n.data.status !== 'working')) return undefined
  if (!s.mail.hasUndelivered(nodeId)) return undefined
  const batch = s.mail.takeDelivery(nodeId, (id) => titleOf(s.board, id))
  if (!batch) return undefined
  lastMailBatch.set(nodeId, batch.ids)
  if (name === 'Stop') {
    mailStopBlocks.set(nodeId, (mailStopBlocks.get(nodeId) ?? 0) + 1)
    return { decision: 'block', reason: `Board mail arrived before you finished. Handle it, then finish your turn. ${MAIL_FORMAT}\n\n${batch.text}` }
  }
  return { hookSpecificOutput: { hookEventName: name, additionalContext: `Board mail. ${MAIL_FORMAT}\n\n${batch.text}` } }
}

const mailNudgeTimers = new Map<string, NodeJS.Timeout>()
/** cards whose next UserPromptSubmit is the mail nudge typed into them */
const mailNudgePrompts = new Set<string>()
/** message ids a card was already told about (Codex and Gemini keep them undelivered until check_inbox) */
const mailNudged = new Map<string, Map<string, number>>()
/** a card told about a message and not reading it is told again after this long */
const MAIL_RENUDGE_MS = 10 * 60_000
/** the ids of the last mail batch a card's hook reply carried */
const lastMailBatch = new Map<string, string[]>()
const mailBlockWatch = new Map<string, NodeJS.Timeout>()
/** last terminal output of a card being watched: a long answer with no tool call sends no hook, but its screen moves */
const mailBlockActivity = new Map<string, number>()
/** a Stop the mail kept going must be followed by another hook: if none comes, the card never got the reply */
const MAIL_BLOCK_WATCH_MS = 60_000

function clearMailBlockWatch(nodeId: string): void {
  const t = mailBlockWatch.get(nodeId)
  if (t) clearTimeout(t)
  mailBlockWatch.delete(nodeId)
  mailBlockActivity.delete(nodeId)
}

function watchMailBlock(ctx: MainContext, s: WindowSession, nodeId: string, ids = lastMailBatch.get(nodeId) ?? []): void {
  mailBlockWatch.set(
    nodeId,
    setTimeout(() => {
      mailBlockWatch.delete(nodeId)
      if (!s.board.nodes.has(nodeId)) return
      if (Date.now() - (mailBlockActivity.get(nodeId) ?? 0) < MAIL_BLOCK_WATCH_MS) return watchMailBlock(ctx, s, nodeId, ids)
      mailBlockActivity.delete(nodeId)
      // the reply was lost (late, dropped): the mail goes back to unread and the card is between turns again
      log(`mail: no hook from ${nodeId} after its Stop was kept going; ${ids.join(', ')} back to unread`)
      s.mail.undeliver(ids)
      s.board.setStatus(nodeId, { status: 'idle', statusDetail: 'turn ended' })
      scheduleMailNudge(ctx, s, nodeId)
    }, MAIL_BLOCK_WATCH_MS)
  )
}

function forgetMail(nodeId: string): void {
  clearMailBlockWatch(nodeId)
  const t = mailNudgeTimers.get(nodeId)
  if (t) clearTimeout(t)
  mailNudgeTimers.delete(nodeId)
  mailNudged.delete(nodeId)
  mailNudgePrompts.delete(nodeId)
  mailStopBlocks.delete(nodeId)
  lastMailBatch.delete(nodeId)
}

/**
 * A card with new mail that is not in a turn gets a short prompt: a Claude card receives the mail with it (its
 * prompt hook), a Codex or Gemini card is told to call check_inbox. Never typed into a card waiting on a permission
 * prompt, a starting or ended card, or a terminal (sendPrompt's own guards apply on top).
 */
function scheduleMailNudge(ctx: MainContext, s: WindowSession, nodeId: string): void {
  if (!s.mail.hasUndelivered(nodeId) || mailNudgeTimers.has(nodeId)) return
  mailNudgeTimers.set(
    nodeId,
    setTimeout(() => {
      mailNudgeTimers.delete(nodeId)
      const n = s.board.nodes.get(nodeId)
      if (!n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor')) return
      if (n.data.status !== 'idle' && n.data.status !== 'done') return
      const fresh = s.mail.data.messages.filter((m) => m.to === nodeId && !m.deliveredAt && !m.ackedAt && Date.now() - (mailNudged.get(nodeId)?.get(m.id) ?? 0) > MAIL_RENUDGE_MS)
      if (!fresh.length) return
      const from = [...new Set(fresh.map((m) => (m.from === OWNER ? 'the owner' : `card ${cleanTitle(titleOf(s.board, m.from))}`)))].slice(0, 3).join(', ')
      const claude = (n.data.engine ?? 'claude') === 'claude'
      const text = claude
        ? `You have ${fresh.length} new board message(s) from ${from}; they are attached. Act on them, then carry on.`
        : `You have ${fresh.length} new board message(s) from ${from}. Call check_inbox to read them, act on them, and ack each one.`
      if (claude) mailNudgePrompts.add(nodeId)
      if (sendPrompt(ctx, s, nodeId, text)) {
        const seen = mailNudged.get(nodeId) ?? new Map<string, number>()
        for (const m of fresh) seen.set(m.id, Date.now())
        mailNudged.set(nodeId, seen)
      } else mailNudgePrompts.delete(nodeId)
    }, 1500)
  )
}

/**
 * Global (external) hook: ignore sessions any window launched; show the card only in the window whose
 * project contains its cwd. A session that matches no open window is not shown anywhere, and one that
 * sat in a window whose project no longer matches is moved out of it.
 */
export function routeExternalHook(ctx: MainContext, event: HookEvent): void {
  const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
  if (!sessionId) return
  if (ctx.windows.all().some((s) => s.board.nodeForSession(sessionId))) return
  const known = ctx.windows.all().find((s) => s.board.externalSessions.has(sessionId))
  const cwd = (typeof event.cwd === 'string' && event.cwd) || known?.board.externalSessions.get(sessionId)?.cwd || ''
  const { target, evict } = ctx.windows.forExternal(cwd, known?.id)
  evict?.board.dropExternal(sessionId, 'moved to its project window')
  target?.board.applyExternalHook(event)
}

/** working Claude cards the owner just pressed Esc (or Ctrl+C) in, with their output since */
const interruptWatch = new Map<string, { until: number; out: string }>()
const INTERRUPT_WATCH_MS = 5000

function watchInterrupt(ctx: MainContext, nodeId: string): void {
  const n = ctx.windows.forNode(nodeId)?.board.nodes.get(nodeId)
  if (!n || (n.data.kind !== 'claude' && n.data.kind !== 'conductor') || (n.data.engine ?? 'claude') !== 'claude' || n.data.status !== 'working') return
  // a second press keeps what the first one's watch already saw
  interruptWatch.set(nodeId, { until: Date.now() + INTERRUPT_WATCH_MS, out: interruptWatch.get(nodeId)?.out ?? '' })
}

/**
 * Claude Code runs no hook when a turn is interrupted: without this the card would show working until its next
 * prompt, and mail would wait for a turn end that never comes. Its interrupt line, seen within a few seconds of the
 * key, ends the turn on the board.
 */
function checkInterrupt(s: WindowSession, nodeId: string, data: string): void {
  const w = interruptWatch.get(nodeId)
  if (!w) return
  if (Date.now() > w.until) return void interruptWatch.delete(nodeId)
  w.out = (w.out + data).slice(-4000)
  if (!showsInterrupt(w.out)) return
  interruptWatch.delete(nodeId)
  const n = s.board.nodes.get(nodeId)
  if (!n || n.data.status !== 'working') return
  if (n.data.doing) {
    n.data.doing = undefined
    sendToRenderer(s, IPC.boardActivity, { nodeId, doing: null })
  }
  log(`interrupt: ${nodeId} turn interrupted by the owner`)
  s.board.endRoleTurn(nodeId)
  s.board.setStatus(nodeId, { status: 'idle', statusDetail: 'interrupted' })
}

const HELD_ERROR = 'held: the board file was changed outside Ouroboros. Review the change in the banner above the board.'

/** Process-wide IPC handlers; each one resolves the calling window's session from the sender. */
export function registerIpc(ctx: MainContext): void {
  const { ptys, hookServer, store } = ctx
  const sessionOf = (e: IpcMainInvokeEvent | IpcMainEvent): WindowSession | undefined => ctx.windows.get(e.sender.id)

  ptys.on('data', (nodeId: string, data: string) => {
    const s = ctx.windows.forNode(nodeId)
    if (!s) return
    const board = s.board
    board.appendOutput(nodeId, data)
    if (mailBlockWatch.has(nodeId)) mailBlockActivity.set(nodeId, Date.now())
    checkInterrupt(s, nodeId, data)
    sendToRenderer(s, IPC.ptyData, { nodeId, data })
    watchCommandOutput(s, nodeId, data)
    const n = board.nodes.get(nodeId)
    // a card still answering its CLI's trust question is watched the same way: the answer makes it ready, or exits
    if (n && (n.data.kind === 'claude' || n.data.kind === 'conductor') && (n.data.status === 'starting' || trustAsked.has(nodeId))) {
      // the shell could not find the CLI (that CLI, not a tool the shell profile wants): say so now (needs you,
      // "failed:"), not after a stall timer gives up
      const engine = n.data.engine ?? 'claude'
      const out = ((launchOut.get(nodeId) ?? '') + data).slice(-LAUNCH_OUT_CAP)
      launchOut.set(nodeId, out)
      const missing = detectMissingCommand(out, engine)
      // the CLI started and quit at once (an option it does not know, a bad config): its error, and no prompt typed into the shell
      const command = launchCommands.get(nodeId) ?? ''
      const exited = missing || !command ? null : detectLaunchExit(out, command)
      if (missing) {
        launchFailed.add(nodeId)
        board.setStatus(nodeId, { status: 'needs-you', statusDetail: `failed: ${engine} is not installed or not on PATH. Install it (Settings → Engines), then Restart the card.` })
      } else if (exited) {
        launchFailed.add(nodeId)
        clearTimeout(readyTimers.get(nodeId))
        log(`launch: ${nodeId} ${engine} exited at launch: ${exited}`)
        board.setStatus(nodeId, { status: 'needs-you', statusDetail: `failed: ${engine} exited at launch (${exited.slice(0, 160)}). Check the card's options, then Restart it.` })
      } else if (detectClaudeReady(data)) {
        trustAsked.delete(nodeId)
        board.setStatus(nodeId, { status: 'idle', statusDetail: 'ready' })
      } else if (!trustAsked.has(nodeId) && detectTrustQuestion(out, command)) {
        // the owner answers it in the card; the ready text, the inbox registration or (Grok) its SessionStart hook
        // then makes the card idle. Claude Code's first choice is "No, exit": Enter alone quits it.
        trustAsked.add(nodeId)
        clearTimeout(readyTimers.get(nodeId))
        clearTimeout(exitChecks.get(nodeId))
        board.setStatus(nodeId, {
          status: 'needs-you',
          statusDetail:
            engine === 'grok'
              ? 'permission: Grok asks whether to trust this folder. Answer in the card (y), and it starts.'
              : engine === 'claude'
                ? 'permission: Claude Code asks whether to trust this folder. In the card pick "Yes, I trust this folder" (↓ then Enter; Enter alone picks "No, exit"), and it starts.'
                : `permission: ${engine} asks whether to trust this folder. Answer in the card, and it starts.`
        })
      } else if (command) {
        // any engine: a CLI that quit without an error we know leaves the shell on its prompt, and then goes quiet
        clearTimeout(exitChecks.get(nodeId))
        exitChecks.set(
          nodeId,
          setTimeout(() => {
            exitChecks.delete(nodeId)
            const cur = board.nodes.get(nodeId)
            if (!cur || (cur.data.status !== 'starting' && !trustAsked.has(nodeId)) || !ctx.ptys.isAlive(nodeId) || launchFailed.has(nodeId)) return
            if (!endsAtShellPrompt(launchOut.get(nodeId) ?? '', command)) return
            launchFailed.add(nodeId)
            clearTimeout(readyTimers.get(nodeId))
            log(`launch: ${nodeId} ${cur.data.engine ?? 'claude'} gave the shell back at launch`)
            // "No, exit" at the trust question is the owner's own choice, not a broken launch
            const declined = trustAsked.delete(nodeId)
            board.setStatus(nodeId, {
              status: 'needs-you',
              statusDetail: declined ? `failed: ${cur.data.engine ?? 'claude'} exited at launch (the folder was not trusted). Restart the card and trust it${(cur.data.engine ?? 'claude') === 'claude' ? ' ("Yes, I trust this folder")' : ''}.` : `failed: ${cur.data.engine ?? 'claude'} exited at launch (the shell came back). Check the card's options, then Restart it.`
            })
          }, EXIT_CHECK_MS)
        )
      }
      if (!missing && !exited && !launchFailed.has(nodeId) && board.nodes.get(nodeId)?.data.status === 'starting' && (n.data.engine === 'codex' || n.data.engine === 'grok') && board.getOutput(nodeId).length > (launchLineLength.get(nodeId) ?? 0) + 300) {
        // Codex sends no session-start event (and a Grok card whose agent-file hooks did not load sends none either):
        // once it has printed more than the echoed launch line, treat 4s of quiet as "ready"
        clearTimeout(readyTimers.get(nodeId))
        readyTimers.set(
          nodeId,
          setTimeout(() => {
            const cur = board.nodes.get(nodeId)
            // a Grok card sends SessionStart from its agent-file hooks: ready without one means the hooks did not load
            if (cur?.data.status !== 'starting' || !ctx.ptys.isAlive(nodeId) || launchFailed.has(nodeId)) return
            // quiet on the shell's own prompt: the CLI is not running; the exit check says so
            if (endsAtShellPrompt(launchOut.get(nodeId) ?? '', launchCommands.get(nodeId) ?? '')) return
            board.setStatus(nodeId, { status: 'idle', statusDetail: cur.data.engine === 'grok' ? 'ready (no hooks yet: status and lines may not work)' : 'ready' })
          }, 4000)
        )
      }
    }
  })
  ptys.on('exit', (nodeId: string, code: number) => {
    running.delete(nodeId)
    inboxes.delete(nodeId)
    transcripts.delete(nodeId)
    launchOut.delete(nodeId)
    launchFailed.delete(nodeId)
    trustAsked.delete(nodeId)
    launchCommands.delete(nodeId)
    clearTimeout(exitChecks.get(nodeId))
    exitChecks.delete(nodeId)
    const s = ctx.windows.forNode(nodeId)
    const ended = s?.board.nodes.get(nodeId)
    if (s && ended?.data.doing) {
      ended.data.doing = undefined
      sendToRenderer(s, IPC.boardActivity, { nodeId, doing: null })
    }
    if (!s) return
    s.board.setPtyAlive(nodeId, false)
    if (s.board.nodes.has(nodeId)) s.board.setStatus(nodeId, { status: 'ended', statusDetail: `exited (${code})` })
    sendToRenderer(s, IPC.ptyExit, { nodeId, code })
  })

  ipcMain.handle(IPC.ptySpawn, async (e, opts: PtySpawnOptions) => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'no window' }
    if (ctx.boardTrust.isHeld(s.board.projectRoot, opts.nodeId)) return { ok: false, error: HELD_ERROR }
    try {
      ctx.windows.bindNode(opts.nodeId, s.id)
      await throttledSpawn(() => ptys.spawn(opts))
      s.board.setPtyAlive(opts.nodeId, true)
      s.board.setStatus(opts.nodeId, { status: 'idle', statusDetail: 'shell' })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.on(IPC.boardSelected, (e, nodeId: string | null) => {
    const s = sessionOf(e)
    if (s) s.selectedNodeId = typeof nodeId === 'string' ? nodeId : null
  })
  ipcMain.on(IPC.ptyWrite, (_e, nodeId: string, data: string) => {
    if (typeof data === 'string' && isInterruptKey(data)) watchInterrupt(ctx, nodeId)
    void ptys.write(nodeId, data)
  })
  ipcMain.on(IPC.ptyResize, (_e, nodeId: string, cols: number, rows: number) => ptys.resize(nodeId, cols, rows))
  ipcMain.handle(IPC.ptyKill, (e, nodeId: string) => {
    ptys.kill(nodeId)
    ctx.usage.forgetCard(nodeId)
    const s = sessionOf(e)
    if (!s) return
    s.board.setPtyAlive(nodeId, false)
    // an explicit kill reports no exit: the ledger hears about it here (a restart spawns again before the grace period ends)
    if (s.board.nodes.has(nodeId)) s.ledger.cardStopped(s.board, nodeId)
  })

  ipcMain.handle(IPC.claudeLaunch, async (e, opts: ClaudeLaunchOptions) => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'no window' }
    if (ctx.boardTrust.isHeld(s.board.projectRoot, opts.nodeId)) return { ok: false, error: HELD_ERROR }
    try {
      const shell = opts.shell || store.getSettings().defaultShell || defaultShell()
      const engine = opts.engine ?? 'claude'
      // during an autonomous run only Claude (deny rules, gate) and Codex (its sandbox, forced below) launch: 'auto' would mean yolo elsewhere
      if (s.autonomy.on && !engineJoinsRun(engine)) return { ok: false, error: `Autonomous mode is on: ${engine} cards have no rails. Stop the run (■) to start one.` }
      // a WSL card (experimental): Claude only, and only once the distro can run it sandboxed and reach the app
      let wsl: { distro: string; cwd: string } | undefined
      if (opts.claude.wsl) {
        if (engine !== 'claude') return { ok: false, error: `Run in WSL2 is for Claude cards only (this card runs ${engine}).` }
        const check = await wslPreflight(store.getSettings().wslDistro, portOf(hookServer.baseUrl))
        if (!check.ok || !check.distro) return { ok: false, error: `WSL2 card not started. Missing: ${check.missing.join(' ')}` }
        for (const n of check.notes) log(`wsl launch ${opts.nodeId}: ${n}`)
        wsl = { distro: check.distro, cwd: opts.cwd }
      }
      const prepared = prepareLaunch({
        nodeId: opts.nodeId,
        kind: opts.kind,
        engine,
        // during an autonomous run every Claude launch is auto mode (plan stays plan), the owner's own cards included
        claude: { ...opts.claude, permissionMode: s.autonomy.permissionMode(opts.claude.permissionMode) as ClaudeOptions['permissionMode'] },
        shell,
        baseUrl: hookServer.baseUrl,
        token: hookServer.hookToken(opts.nodeId),
        apiToken: hookServer.apiToken(opts.nodeId),
        mailToken: hookServer.mailToken(opts.nodeId),
        tmpDir: ctx.tmpDir,
        execPath: process.execPath,
        nodeBin: findNodeBinary(),
        mcpScriptPath: ctx.mcpScriptPath,
        hookScriptPath: resolveHookScriptPath(),
        title: opts.title,
        settingsExtra: cardSettingsExtra(s.autonomy.settingsFragment(gateCommandFor(hookServer.baseUrl, opts.nodeId, Boolean(wsl)))),
        autonomous: s.autonomy.on,
        wsl
      })
      ctx.windows.bindNode(opts.nodeId, s.id)
      launchOut.delete(opts.nodeId)
      launchFailed.delete(opts.nodeId)
      trustAsked.delete(opts.nodeId) // a Restart (no pty exit event) asks again
      // a stale ANTHROPIC_API_KEY in the owner's environment would beat the sign-in inside every Claude card
      const login = engine === 'claude' ? claudeLoginFromFiles(claudeConfigDirOf(process.env, homedir()), existsSync, (p) => readFileSync(p, 'utf8')) : false
      const omitEnv = claudeEnvKeysToStrip(process.env, login, store.getSettings().keepEnvApiKey === true)
      if (omitEnv.length) log(`claude launch ${opts.nodeId}: ${omitEnv.join(', ')} not passed to the card (signed in; Settings → keep the environment key to change this)`)
      else if (login === undefined && claudeEnvKeysToStrip(process.env, true, false).length) log(`claude launch ${opts.nodeId}: sign-in files unreadable, environment key kept`)
      const credentials = credentialEnvKeys(process.env, engine, store.getSettings().passCredentialEnv === true)
      if (credentials.length) log(`${engine} launch ${opts.nodeId}: ${credentials.join(', ')} not passed to the card (Settings → pass credential variables to change this)`)
      omitEnv.push(...credentials)
      // the card-only GitHub token (Settings → GitHub) replaces the owner's sign-in for gh and git in agent cards
      const cardToken = decryptToken(store.getSettings().cardGithubTokenEnc)
      const launchEnv: Record<string, string> = { ...(prepared.env ?? {}) }
      if (cardToken) {
        const gh = cardGitHubEnv(cardToken, process.env)
        Object.assign(launchEnv, gh.env)
        const ours = new Set(Object.keys(gh.env))
        for (let i = omitEnv.length - 1; i >= 0; i--) if (ours.has(omitEnv[i])) omitEnv.splice(i, 1)
        omitEnv.push(...gh.omit)
      }
      // only what WSLENV names crosses into Linux (and from there into the Windows helpers): the card's own variables
      if (wsl) launchEnv.WSLENV = wslEnvNames([...Object.keys(launchEnv), ...WSL_HELPER_ENV], process.env.WSLENV)
      await throttledSpawn(() => ptys.spawn({ nodeId: opts.nodeId, cwd: opts.cwd, shell, cols: opts.cols, rows: opts.rows, initialCommand: prepared.command, env: launchEnv, omitEnv }))
      s.board.setPtyAlive(opts.nodeId, true)
      s.board.setStatus(opts.nodeId, { status: 'starting', statusDetail: `launching ${engine}` })
      if (prepared.initialPrompt) {
        // the role text goes in as the first message once the TUI is ready; its reply is not "work"
        // (no lines fire, status returns to idle), and a task prompt waits for it. A leftover role
        // text from an earlier launch is replaced, not repeated.
        const existing = s.board.nodes.get(opts.nodeId)?.data.initialPrompt
        const own = existing && !existing.startsWith(ROLE_PROMPT_PREFIX) ? existing : undefined
        const initialPrompt = [prepared.initialPrompt, own].filter(Boolean).join('\n\n')
        s.board.markRoleTurn(opts.nodeId)
        sendToRenderer(s, IPC.boardUpdateNode, { nodeId: opts.nodeId, data: { initialPrompt }, restart: false })
      }
      launchLineLength.set(opts.nodeId, prepared.command.length)
      launchCommands.set(opts.nodeId, prepared.command)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.on(IPC.boardSync, (e, payload: BoardSyncPayload) => sessionOf(e)?.board.sync(payload))
  ipcMain.handle(IPC.agentsList, (e) => sessionOf(e)?.board.snapshot() ?? [])
  ipcMain.handle(IPC.handoffFire, (e, edgeId: string) => sessionOf(e)?.fireHandoff(edgeId, true) ?? { ok: false, error: 'no window' })

  ipcMain.handle(IPC.workspaceLoad, (e, projectRoot: string): WorkspaceLoadResult => {
    const s = sessionOf(e)
    // The same folder in two windows would fight over .ouroboros.json: focus the window that has it.
    const other = ctx.windows.forProject(projectRoot)
    if (other && other !== s) {
      other.win.show()
      other.win.focus()
      return { workspace: null, projectRoot, alreadyOpen: true }
    }
    s?.ledger.flush() // the previous project's pending ledger write goes to its own file first
    if (s) s.board.projectRoot = projectRoot
    // a folder opened before had its board written by an older version: that one is trusted as found
    const known = store.getRecent().some((p) => samePath(p, projectRoot))
    store.pushRecent(projectRoot)
    const read = readWorkspace(projectRoot)
    const workspace = read?.workspace ?? null
    s?.ledger.load(workspace ? { tasks: workspace.tasks, nextTaskId: workspace.nextTaskId } : undefined)
    s?.mail.load(mailFile(app.getPath('userData'), projectRoot))
    s?.gate.load(auditFile(app.getPath('userData'), projectRoot))
    for (const d of s?.decisions.load() ?? []) s?.autonomy.noteDecision(d.card, d.title, `withdrawn (${d.id}): another project was opened`)
    // check() never throws: anything unexpected holds every card
    const held: HeldCard[] = read ? ctx.boardTrust.check(projectRoot, read.text, known) : []
    // tasks from a board this app never wrote (a cloned repo) or one changed behind its back go to Notion only once they change here
    if (s && workspace && (!known || held.length)) s.taskSync?.hold(s.ledger.data.tasks)
    else s?.taskSync?.hold([])
    return { workspace, projectRoot, ...(held.length ? { held } : {}) }
  })
  ipcMain.handle(IPC.workspaceTrust, (e, nodeIds: string[], revert: boolean) => {
    const root = sessionOf(e)?.board.projectRoot
    if (!root || !Array.isArray(nodeIds)) return {}
    let text: string | undefined
    try {
      text = readFileSync(join(root, WORKSPACE_FILE), 'utf8')
    } catch {
      /* no board file yet */
    }
    return ctx.boardTrust.release(root, nodeIds.filter((id) => typeof id === 'string'), revert === true, text)
  })
  ipcMain.handle(IPC.workspaceSave, (e, ws: Workspace) => {
    // the renderer never carries the ledger: main's copy goes into every save. A save for a project this window has
    // already left (an autosave in flight during a switch) is dropped rather than written with the new project's tasks.
    const s = sessionOf(e)
    if (!s) return saveWorkspace(ws)
    if (!s.board.projectRoot || !samePath(ws.projectRoot, s.board.projectRoot)) return
    saveWorkspace({ ...ws, tasks: s.ledger.data.tasks, nextTaskId: s.ledger.data.nextTaskId })
  })
  ipcMain.handle(IPC.projectOpen, async (e) => {
    const win = sessionOf(e)?.win
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Open project folder' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })
  ipcMain.handle(IPC.projectRecent, () => store.getRecent())
  ipcMain.handle(IPC.dialogFolder, async (e) => {
    const win = sessionOf(e)?.win
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.windowOpen, (_e, projectRoot?: string) => {
    ctx.openProjectWindow(projectRoot || undefined)
  })
  const savePasted = (bytes: Uint8Array, ext: string): string => {
    const dir = join(ctx.tmpDir, 'pasted')
    mkdirSync(dir, { recursive: true })
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase().replace('jpeg', 'jpg') : 'png'
    const file = join(dir, `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${nanoid(4)}.${safeExt}`)
    writeFileSync(file, Buffer.from(bytes))
    return file
  }
  ipcMain.handle(IPC.filesSaveImage, (_e, bytes: Uint8Array, ext: string) => savePasted(bytes, ext))
  // The sidebar composer's screenshots go to a Claude Code card the way Claude Code itself pastes them: the image
  // on the clipboard, then its paste key (Alt+V = ESC v); the prompt shows "[Image #N]". One card at a time.
  ipcMain.handle(IPC.ptyPasteImage, async (e, nodeId: string, path: string): Promise<{ ok: boolean; error?: string }> => {
    const s = sessionOf(e)
    if (!s || !s.board.nodes.has(nodeId) || !ctx.ptys.isAlive(nodeId)) return { ok: false, error: 'card is not running' }
    if (!isAbsolute(path) || !existsSync(path)) return { ok: false, error: 'image file not found' }
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
    const chips = (): number => (stripAnsi(s.board.getOutput(nodeId)).match(/\[Image #\d+\]/g) ?? []).length
    const before = chips()
    const keepText = (await clipboard.readText()).trim()
    try {
      await clipboard.write([new ClipboardItem({ [type]: new Blob([readFileSync(path)], { type }) })])
    } catch (err) {
      return { ok: false, error: `clipboard: ${String(err)}` }
    }
    ctx.ptys.write(nodeId, '\x1bv')
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && chips() <= before) await new Promise((r) => setTimeout(r, 100))
    if (keepText) await clipboard.writeText(keepText).catch(() => undefined)
    return chips() > before ? { ok: true } : { ok: false, error: 'the card did not take the image (is Claude Code at its prompt?)' }
  })
  ipcMain.handle(IPC.skillsList, (_e, cwd: string) => listSkills(typeof cwd === 'string' ? cwd : ''))
  ipcMain.handle(IPC.rolesList, (_e, cwd: string) => ctx.roles.list(typeof cwd === 'string' ? cwd : ''))
  ipcMain.handle(IPC.rolesFetch, () => ctx.roles.fetch())
  ipcMain.handle(IPC.rolesRead, (_e, cwd: string, id: string) => (typeof id === 'string' ? ctx.roles.prompt(typeof cwd === 'string' ? cwd : '', id) : undefined))
  // the owner's Tasks tab: the same ledger the task_* tools use, with the owner as the actor
  ipcMain.handle(IPC.tasksList, (e) => sessionOf(e)?.ledger.list({ all: true }) ?? [])
  ipcMain.handle(IPC.gateList, (e) => sessionOf(e)?.gate.approvals ?? [])
  ipcMain.handle(IPC.gateResolve, (e, id: string, approve: boolean) => {
    const s = sessionOf(e)
    if (!s || typeof id !== 'string') return { ok: false, error: 'no window' }
    return resolveApproval(s, id, approve === true)
  })
  ipcMain.handle(IPC.decisionsList, (e) => sessionOf(e)?.decisions.decisions ?? [])
  ipcMain.handle(IPC.decisionsAnswer, (e, id: string, answer: string, note?: string) => {
    const s = sessionOf(e)
    if (!s || typeof id !== 'string') return { ok: false, error: 'no window' }
    return answerDecision(s, id, answer, note, 'owner')
  })
  ipcMain.handle(IPC.grokBotList, (e) => sessionOf(e)?.grokBot ?? [])
  ipcMain.handle(IPC.grokBotResolve, (e, id: string, send: boolean) => {
    const s = sessionOf(e)
    if (!s || typeof id !== 'string') return { ok: false, error: 'no window' }
    return resolveGrokHandoff(ctx, s, id, send === true)
  })
  // the list is written here and nowhere else (settings.set ignores it), and the older single-bot fields go once it is
  const writeBots = (bots: GrokBot[]): void => void ctx.store.setSettings({ grokBots: bots, grokBotUrl: undefined, grokBotKeyEnc: undefined })
  ipcMain.handle(IPC.grokBotBots, () => botViews(grokBots(ctx.store.getSettings())))
  ipcMain.handle(IPC.grokBotSave, (_e, list: unknown) => {
    const r = saveBots(grokBots(ctx.store.getSettings()), list)
    if (!r.ok) return r
    writeBots(r.bots)
    log(`[grok-bot] bots saved: ${r.bots.map((b) => b.name).join(', ') || '(none)'}`)
    return { ok: true, bots: botViews(r.bots) }
  })
  ipcMain.handle(IPC.grokBotSetKey, (_e, botId: string, key: string) => {
    const bots = grokBots(ctx.store.getSettings())
    if (!bots.some((b) => b.id === botId)) return { ok: false, hasKey: false, error: 'save the bot first' }
    const enc = encryptToken(String(key ?? '').replace(/\s+/g, ''))
    writeBots(bots.map((b) => (b.id === botId ? { ...b, keyEnc: enc || undefined } : b)))
    return { ok: true, hasKey: Boolean(enc) }
  })
  ipcMain.handle(IPC.grokBotTest, async (_e, botId: string) => {
    const bot = grokBots(ctx.store.getSettings()).find((b) => b.id === botId)
    if (!bot) return { ok: false, error: 'save the bot first' }
    const url = grokBotUrl(bot.url)
    const key = decryptToken(bot.keyEnc)
    if (!url) return { ok: false, error: 'the webhook URL is not a Grok Bot routine webhook (https://api2.cursor.sh/automations/webhook/…)' }
    if (!key) return { ok: false, error: 'no key saved' }
    const r = await sendToGrokBot({ url, key, payload: { source: 'ouroboros', kind: 'test', note: 'Connection test from Ouroboros: no task, nothing to do.', sentAt: new Date().toISOString() } })
    log(`[grok-bot] test ${bot.name}: ${r.ok ? `run started${r.runUuid ? ` (${r.runUuid})` : ''}` : r.error}`)
    return r.ok ? r : { ok: false, error: r.error }
  })
  ipcMain.handle(IPC.githubProtection, (e) => readProtection(sessionOf(e)?.board.projectRoot ?? ''))
  ipcMain.handle(IPC.githubProtect, async (e) => {
    const r = await applyProtection(sessionOf(e)?.board.projectRoot ?? '')
    log(`[github] protect main: ${r.ok ? `${r.repo} ${r.added ? 'ruleset added' : 'already protected'}` : r.error}`)
    return r
  })
  ipcMain.handle(IPC.githubSetCardToken, (_e, token: string) => {
    const enc = encryptToken(String(token ?? '').replace(/\s+/g, ''))
    ctx.store.setSettings({ cardGithubTokenEnc: enc || undefined })
    return { hasToken: Boolean(enc) }
  })
  ipcMain.handle(IPC.githubCardTokenStatus, async (_e, check: boolean) => {
    const st = ctx.store.getSettings()
    const token = decryptToken(st.cardGithubTokenEnc)
    if (!token) return { hasToken: false, ...(st.cardGithubTokenEnc ? { error: 'the saved card token could not be decrypted; paste it again' } : {}) }
    if (check !== true) return { hasToken: true }
    const r = await checkCardToken(token)
    return r.ok ? { hasToken: true, login: r.login, expiresAt: r.expiresAt } : { hasToken: true, error: r.error }
  })
  ipcMain.handle(IPC.wslCheck, () => wslPreflight(ctx.store.getSettings().wslDistro, portOf(hookServer.baseUrl)))
  ipcMain.handle(IPC.ouroStatus, () => ouroStatus(ctx))
  ipcMain.handle(IPC.ouroConfigure, (_e, view: OuroSettingsView) => {
    const v = ouroSettings(view)
    if (v.ownerId && !/^\d{15,22}$/.test(v.ownerId)) v.ownerId = ''
    ctx.store.setSettings({ ouro: v })
    applyOuro(ctx)
    log(`[ouro] settings: ${v.enabled ? 'on' : 'off'}, notices ${v.notify ? 'on' : 'off'}, approvals by voice ${v.approvals ? 'on' : 'off'}`)
    return ouroStatus(ctx)
  })
  ipcMain.handle(IPC.ouroSetToken, (_e, token: string) => {
    const enc = encryptToken(String(token ?? '').replace(/\s+/g, ''))
    ctx.store.setSettings({ ouroTokenEnc: enc || undefined })
    applyOuro(ctx)
    return ouroStatus(ctx)
  })
  ipcMain.handle(IPC.ouroTest, () => ctx.ouro.test())
  ipcMain.handle(IPC.phoneStatus, () => phoneStatus(ctx))
  ipcMain.handle(IPC.phoneInterfaces, () => phoneInterfaces())
  ipcMain.handle(IPC.phoneConfigure, async (_e, view: PhoneSettingsView) => {
    const v: PhoneSettingsView = { enabled: view?.enabled === true, host: typeof view?.host === 'string' ? view.host : undefined, port: Number.isInteger(view?.port) && view.port > 1023 && view.port < 65536 ? view.port : DEFAULT_PHONE_PORT, allowLan: view?.allowLan === true }
    ctx.store.setSettings({ phone: v })
    await ctx.phone.apply(v)
    return phoneStatus(ctx)
  })
  ipcMain.handle(IPC.phonePair, () => ctx.phone.newPairing())
  ipcMain.handle(IPC.phoneNotifyKey, () => {
    const url = ctx.phone.url
    if (!url) return { ok: false, error: ctx.phone.error ?? 'turn the phone server on first' }
    try {
      // one car key at a time: a new one replaces the old (which then stops working)
      for (const d of ctx.phone.devices.list.filter((x) => x.scope === 'notify')) ctx.phone.devices.revoke(d.id)
      const { device, token } = ctx.phone.devices.add('MacroDroid', Date.now(), 'notify')
      log(`[phone] notify key ${device.id} made`)
      return { ok: true, key: token, url: `${url}/api/notify` }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.phoneRevoke, (_e, id: string) => {
    if (typeof id === 'string' && ctx.phone.devices.revoke(id)) log(`[phone] device ${id} revoked`)
    return phoneStatus(ctx)
  })
  ipcMain.handle(IPC.mailList, (e) => sessionOf(e)?.mail.data.messages ?? [])
  ipcMain.handle(IPC.mailSend, (e, to: string, body: string) => {
    const s = sessionOf(e)
    if (!s || typeof to !== 'string' || typeof body !== 'string') return { ok: false, error: 'no window' }
    const r = s.mail.send({ from: OWNER, to, body }, mailTopology(s.board))
    return r.ok ? { ok: true } : r
  })
  ipcMain.handle(IPC.tasksCreate, (e, input: TaskInput) => sessionOf(e)?.api.taskCreate(input, OWNER) ?? { ok: false, error: 'no window' })
  ipcMain.handle(IPC.tasksUpdate, (e, id: string, patch: TaskPatch) => sessionOf(e)?.api.taskUpdate(String(id), patch ?? {}, OWNER) ?? { ok: false, error: 'no window' })
  ipcMain.handle(IPC.tasksOwner, (e, id: unknown, choice: unknown, text: unknown, shownAt: unknown) => {
    const s = sessionOf(e)
    return s && typeof id === 'string' ? ownerAnswerTask(s, id, choice, text, shownAt) : { ok: false, error: 'no window' }
  })
  // Ctrl+V in a terminal card: xterm would send ^V to the CLI and no DOM paste event would fire, so the
  // renderer asks for the clipboard here (Electron reads Windows bitmaps reliably)
  ipcMain.handle(IPC.filesPasteClipboard, async (_e, saveImage = true): Promise<{ path?: string; text?: string; image?: boolean }> => {
    // Office apps put a bitmap next to the copied cells: text wins whenever there is any
    const text = await clipboard.readText()
    if (text.trim()) return { text }
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t === 'image/png') ?? item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      if (!saveImage) return { image: true }
      const blob = (await item.getType(type)) as Blob
      return { path: savePasted(new Uint8Array(await blob.arrayBuffer()), type.split('/')[1] || 'png') }
    }
    return {}
  })
  ipcMain.handle(IPC.briefOpen, async (e, url: string, near?: string) => {
    const s = sessionOf(e)
    if (s && /^https?:\/\//.test(url)) await openBrief(ctx, s, url, typeof near === 'string' ? near : undefined)
  })
  ipcMain.handle(IPC.shellOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
  // a path out of a card's reply, clicked by the owner: main decides where it resolves and whether it is
  // opened or only revealed (scripts, installers, shortcuts and unknown types are never run from a click)
  ipcMain.handle(IPC.shellOpenPath, async (_e, p: unknown, cwd?: unknown) => {
    const r = resolveOpenPath(p, cwd, homedir())
    if (!r.ok) return { ok: false, path: String(p), error: r.error }
    if (!existsSync(r.abs)) return { ok: false, path: r.abs, error: 'Not found' }
    if (openMode(r.abs, statSync(r.abs).isDirectory()) === 'reveal') {
      shell.showItemInFolder(r.abs)
      return { ok: true, path: r.abs, revealed: true }
    }
    const err = await shell.openPath(r.abs)
    return err ? { ok: false, path: r.abs, error: err } : { ok: true, path: r.abs }
  })

  // the bots and their (encrypted, or plain where the OS has no keyring) keys stay in main: Settings reads grokBot.bots
  const forRenderer = ({ grokBots: _b, grokBotKeyEnc: _k, ...st }: AppSettings): AppSettings => st
  ipcMain.handle(IPC.settingsGet, () => forRenderer(store.getSettings()))
  ipcMain.handle(IPC.grokReplyStatus, async () => ({ ...grokReplyView(ctx), suggestedUrl: await suggestedReplyUrl() }))
  ipcMain.handle(IPC.grokReplyConfigure, async (_e, input: { enabled?: unknown; publicUrl?: unknown; githubIssue?: unknown }) => {
    const prev = store.getSettings().grokReply
    const raw = typeof input?.publicUrl === 'string' ? input.publicUrl.trim() : (prev?.publicUrl ?? '')
    let publicUrl = ''
    if (raw) {
      try {
        const u = new URL(raw)
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return { ok: false, error: 'the address must be https:// with no user, query or #' }
        publicUrl = u.toString()
      } catch {
        return { ok: false, error: 'that is not a web address' }
      }
    }
    const rawIssue = typeof input?.githubIssue === 'string' ? input.githubIssue.trim() : undefined
    const issue = rawIssue ? issueRef(rawIssue) : undefined
    if (rawIssue && !issue) return { ok: false, error: 'the issue must be https://github.com/<owner>/<repo>/issues/<number>' }
    // an issue that is public or unreadable is not saved: nothing is left half on
    const checkErr = issue ? await checkIssue(runGh, issue) : undefined
    if (checkErr) {
      log(`[grok-mail] ${issueUrl(issue!)} not used: ${checkErr}`)
      return { ok: false, error: checkErr }
    }
    const githubIssue = rawIssue === undefined ? prev?.githubIssue : issue ? issueUrl(issue) : undefined
    const next = { enabled: typeof input?.enabled === 'boolean' ? input.enabled : prev?.enabled === true, port: prev?.port ?? DEFAULT_REPLY_PORT, ...(publicUrl ? { publicUrl } : {}), ...(githubIssue ? { githubIssue } : {}) }
    store.setSettings({ grokReply: next })
    if (rawIssue !== undefined) {
      const mailErr = await ctx.grokReply.mailbox.use(issue)
      log(`[grok-mail] ${issue ? (mailErr ? `not used: ${mailErr}` : `reading ${githubIssue}`) : 'off'}`)
      if (mailErr) return { ok: false, error: mailErr }
    }
    // only the issue changed: the reply server keeps running as it is
    if (input?.enabled === undefined && input?.publicUrl === undefined) return { ok: true }
    const err = await ctx.grokReply.server.apply(next.enabled, next.port)
    log(`[grok-reply] ${next.enabled ? (err ? `not started: ${err}` : 'on') : 'off'}`)
    return err ? { ok: false, error: err } : { ok: true }
  })
  ipcMain.handle(IPC.grokReplyMakeKey, () => {
    const key = ctx.grokReply.store.makeKey()
    log('[grok-reply] a new reply key was made (the old one stops working)')
    const url = store.getSettings().grokReply?.publicUrl
    return { ok: true, key, instructions: routineInstructions(url || `https://<this PC>.ts.net:8443${REPLY_PATH}`) }
  })
  ipcMain.handle(IPC.grokReplyRevoke, () => {
    ctx.grokReply.store.revokeKey()
    log('[grok-reply] the reply key was revoked')
    return { ok: true }
  })
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    // the bots and their keys go through grokBot.save / setKey: a stale Settings copy must not drop a key
    if (patch && typeof patch === 'object') {
      // the reply server goes through grokReply.configure, which also starts or stops it
      const { grokBots: _b, grokBotKeyEnc: _k, grokBotUrl: _u, grokReply: _r, ...rest } = patch
      patch = rest
    }
    const next = store.setSettings(patch)
    if (patch && typeof patch === 'object' && 'voice' in patch) registerVoiceHotkey(ctx)
    return forRenderer(next)
  })

  ipcMain.handle(IPC.worktreeCreate, async (_e, projectRoot: string, name: string) => {
    try {
      const r = await createWorktree(projectRoot, name)
      return { ok: true, ...r }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.worktreeRemove, async (_e, projectRoot: string, path: string) => {
    try {
      await removeWorktree(projectRoot, path)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.externalInstallHooks, (_e, enable: boolean) => {
    try {
      setGlobalExternalHooks(enable, hookServer.baseUrl, hookServer.externalToken)
      store.setSettings({ trackExternalSessions: enable })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.on(IPC.browserRegister, (e, nodeId: string, wcId: number) => {
    const s = sessionOf(e)
    if (s) ctx.windows.bindNode(nodeId, s.id)
    ctx.browsers.register(nodeId, wcId)
  })
  ipcMain.on(IPC.browserUnregister, (_e, nodeId: string) => ctx.browsers.unregister(nodeId))

  ipcMain.handle(IPC.historyList, (_e, rootFilter?: string) => listClaudeSessions(undefined, { rootFilter: rootFilter || undefined }))
  ipcMain.handle(IPC.foldersList, (_e, root: string) => listSubfolders(root))

  ipcMain.handle(IPC.appInfo, (e) => ({
    platform: process.platform,
    version: app.getVersion(),
    hookPort: hookServer.port,
    userData: app.getPath('userData'),
    initialProject: sessionOf(e)?.initialProject,
    mcpRunner: findNodeBinary() ?? `${process.execPath} (ELECTRON_RUN_AS_NODE)`,
    mcpScript: ctx.mcpScriptPath,
    hasUpdateToken: Boolean(decryptToken(store.getSettings().githubTokenEnc)),
    packaged: app.isPackaged,
    logFile: logPath() ?? undefined,
    crashDir: join(app.getPath('crashDumps'))
  }))

  ipcMain.handle(IPC.bookmarksList, (_e, query?: string) => listBookmarks(query))
  ipcMain.handle(IPC.changesSummary, (_e, cwd: string) => getChanges(cwd))
  ipcMain.handle(IPC.changesDiff, (_e, cwd: string, file?: string) => getDiff(cwd, file))
  ipcMain.handle(IPC.checkpointsList, (_e, cwd: string) => listCheckpoints(cwd))
  ipcMain.handle(IPC.checkpointsCreate, (_e, cwd: string, label?: string) => createCheckpoint(cwd, { label }))
  ipcMain.handle(IPC.checkpointsRestore, (_e, cwd: string, id: string, moveHead?: boolean) => {
    const busy = busyIn(ctx, cwd)
    if (busy) return { ok: false, error: `"${busy.title}" is working or waiting for you in that folder; wait for it or stop it first` }
    return restoreCheckpoint(cwd, id, { moveHead: Boolean(moveHead) })
  })
  ipcMain.handle(IPC.checkpointsDelete, (_e, cwd: string, id: string) => deleteCheckpoint(cwd, id))
  ipcMain.handle(IPC.changesRevert, async (_e, cwd: string, file: string) => {
    try {
      await revertFile(cwd, file)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.sessionUsage, (_e, sessionId: string) => readSessionUsage(sessionId))
  ipcMain.handle(IPC.usageGet, () => ctx.usage.snapshot())
  ipcMain.handle(IPC.usageRefresh, () => ctx.usage.snapshot({ refresh: true }))
  // a card's status line brought new plan numbers: every window shows them (the account is one)
  ctx.usage.onChange(() => void ctx.usage.snapshot().then((snap) => broadcast(ctx, IPC.usageChanged, snap)).catch(() => undefined))
  ipcMain.handle(IPC.enginesDetect, () => detectEngines())
  ipcMain.handle(IPC.tidyCandidates, async (e, minutes: number, includeOwn: boolean) => (await sessionOf(e)?.api.tidy({ olderThanMinutes: minutes, includeOwn }, true))?.candidates ?? [])
  ipcMain.handle(IPC.tidyApply, async (e, ids: string[]) => {
    const s = sessionOf(e)
    let removed = 0
    if (s) for (const id of ids) if (await s.api.removeAgent(id)) removed++
    return { removed }
  })
  ipcMain.handle(IPC.autonomyStart, (e, config: AutonomyConfig) => {
    const s = sessionOf(e)
    if (!s) return null
    const until = Math.min(Number(config?.until), Date.now() + 36 * 3_600_000) // a run is a night or a day, never a forgotten week
    if (!Number.isFinite(until) || until <= Date.now()) return s.autonomy.public()
    const clamp = (v: unknown, lo: number, hi: number, d: number): number => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d)
    return s.autonomy.start({ until, maxDispatches: clamp(config.maxDispatches, 0, 500, 20), maxRetriesPerTitle: clamp(config.maxRetriesPerTitle, 0, 20, 3), stallMinutes: clamp(config.stallMinutes, 0, 240, 10) })
  })
  ipcMain.handle(IPC.autonomyStop, (e) => sessionOf(e)?.autonomy.stop('stopped by the owner') ?? null)
  ipcMain.handle(IPC.autonomyState, (e) => sessionOf(e)?.autonomy.public() ?? null)
  // dispatched cards retire on their own once their report is in (every window, once a minute); owner-made cards never
  setInterval(() => {
    if ((store.getSettings().retireMinutes ?? DEFAULT_RETIRE_MINUTES) <= 0) return
    for (const s of ctx.windows.all()) void s.api.tidy({ auto: true }, false)
  }, 60_000)

  ctx.updater.on('status', (st) => broadcast(ctx, IPC.updateStatus, st))
  ipcMain.handle(IPC.updateCheck, () => ctx.updater.check())
  ipcMain.handle(IPC.updateDownload, () => ctx.updater.download())
  ipcMain.handle(IPC.updateInstall, () => ctx.updater.install())
  ipcMain.handle(IPC.updateSetToken, (_e, token: string) => {
    const enc = encryptToken(String(token ?? '').trim())
    store.setSettings({ githubTokenEnc: enc || undefined })
    return { ok: true, hasToken: Boolean(enc) }
  })

  const TTS_KEY_ENGINES: TtsKeyEngine[] = ['gemini', 'openai', 'elevenlabs']
  ipcMain.handle(IPC.ttsSynthesize, (_e, text: string) => synthesize(store.getSettings(), String(text ?? '').trim()))
  ipcMain.handle(IPC.ttsSetKey, (_e, engine: TtsKeyEngine, key: string) => {
    if (!TTS_KEY_ENGINES.includes(engine)) return { ok: false, hasKey: false }
    const settings = store.getSettings()
    store.setSettings(ttsKeyPatch(settings, engine, String(key ?? '')))
    return { ok: true, hasKey: Boolean(ttsKeyFor(store.getSettings(), engine)) }
  })
  ipcMain.handle(IPC.ttsKeys, () => {
    const settings = store.getSettings()
    return Object.fromEntries(TTS_KEY_ENGINES.map((e) => [e, Boolean(ttsKeyFor(settings, e))])) as Record<TtsKeyEngine, boolean>
  })

  ipcMain.handle(IPC.voiceTranscribe, (_e, wav: unknown, override?: Partial<VoiceSettings>) => {
    if (!(wav instanceof Uint8Array)) return { ok: false, error: 'no audio' }
    // the Test button may try another engine or language, never other paths: a page cannot make the app run a program
    const o: Partial<VoiceSettings> = {}
    if (override && typeof override === 'object') {
      if (override.stt === 'openai' || override.stt === 'whisper') o.stt = override.stt
      if (override.language === 'auto' || override.language === 'ko' || override.language === 'en') o.language = override.language
    }
    return transcribe(store.getSettings(), wav, o)
  })
  ipcMain.handle(IPC.voiceListening, (e, on: boolean) => {
    // a wake word in a hidden window needs its timers and audio at full speed
    if (e.sender.getType() === 'window') e.sender.setBackgroundThrottling(on !== true)
  })

  ipcMain.handle(IPC.notionSetToken, (_e, token: string) => {
    const enc = encryptToken(String(token ?? '').replace(/\s+/g, ''))
    store.setSettings({ notionTokenEnc: enc || undefined })
    return { ok: true, hasToken: Boolean(enc) }
  })
  ipcMain.handle(IPC.notionStatus, () => {
    const st = store.getSettings()
    return { hasToken: Boolean(decryptToken(st.notionTokenEnc)), databaseId: st.notionDatabaseId }
  })
  ipcMain.handle(IPC.notionTest, (_e, which: NotionDatabaseKind = 'reports') => {
    if (typeof which !== 'string' || !Object.hasOwn(NOTION_FIELD, which)) return { ok: false, error: 'unknown database' }
    const st = store.getSettings()
    const token = decryptToken(st.notionTokenEnc)
    const databaseId = notionDatabaseId(st[NOTION_FIELD[which]])
    if (!token) return { ok: false, error: st.notionTokenEnc ? 'the saved token could not be decrypted; paste it again' : 'no token saved' }
    if (!databaseId) return { ok: false, error: `no database id (paste the ${NOTION_LABEL[which]} database URL)` }
    if (which === 'tasks') return testNotion({ token, databaseId }, TASK_SCHEMA, 'a task row')
    if (which === 'updates') return testNotion({ token, databaseId }, UPDATE_SCHEMA, 'a release-notes page')
    return testNotion({ token, databaseId })
  })
  let addingViews = false
  ipcMain.handle(IPC.notionViews, async () => {
    // two runs at once would both list the views before either adds one, and both add them
    if (addingViews) return { ok: false, lines: ['already adding views'] }
    addingViews = true
    try {
      return await addNotionViews()
    } finally {
      addingViews = false
    }
  })
  const addNotionViews = async (): Promise<{ ok: boolean; lines: string[] }> => {
    const st = store.getSettings()
    const token = decryptToken(st.notionTokenEnc)
    if (!token) return { ok: false, lines: [st.notionTokenEnc ? 'the saved token could not be decrypted; paste it again' : 'no token saved'] }
    const lines: string[] = []
    let ok = true
    for (const which of ['reports', 'tasks', 'updates'] as const) {
      const databaseId = notionDatabaseId(st[NOTION_FIELD[which]])
      if (!databaseId) continue
      const r = await ensureViews({ token, databaseId }, NOTION_VIEWS[which])
      if (!r.ok) {
        ok = false
        lines.push(`${NOTION_LABEL[which]}: ${r.error}`)
        continue
      }
      if (r.failed.length) ok = false
      const bits = [r.created.length ? `added ${r.created.join(', ')}` : '', r.existing.length ? `${r.existing.length} already there` : '', ...r.failed]
      lines.push(`${NOTION_LABEL[which]}: ${bits.filter(Boolean).join('; ') || 'nothing to add'}`)
    }
    if (!lines.length) return { ok: false, lines: ['no database set'] }
    log(`[notion] views: ${lines.join(' | ')}`)
    return { ok, lines }
  }
  ipcMain.handle(IPC.obsidianPick, async (e) => {
    const win = sessionOf(e)?.win
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Choose your Obsidian vault folder' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.obsidianExport, async (e) => {
    const s = sessionOf(e)
    const none = { ok: false, written: 0, kept: 0, removed: 0 }
    if (!s?.vaultExport || !s.board.projectRoot) return { ...none, error: 'no project open in this window' }
    if (!store.getSettings().obsidianExport) return { ...none, error: 'turn on the Obsidian export first' }
    return s.vaultExport.run()
  })
}

let voiceHotkey: string | undefined
/** (Re)register the push-to-talk hotkey from Settings → Voice; a key another app holds is logged, not fatal. */
export function registerVoiceHotkey(ctx: MainContext): string | undefined {
  const v = voiceSettings(ctx.store.getSettings().voice)
  const want = v.enabled ? v.hotkey : undefined
  if (want === voiceHotkey) return undefined
  const fire = (): void => {
    const s = ctx.windows.current() ?? ctx.windows.all()[0]
    if (s && !s.win.isDestroyed()) s.win.webContents.send(IPC.voiceHotkey)
  }
  const tryRegister = (acc: string): boolean => {
    try {
      return globalShortcut.register(acc, fire)
    } catch (err) {
      log(`[voice] hotkey ${acc}: ${(err as Error).message}`)
      return false
    }
  }
  const previous = voiceHotkey
  if (previous) globalShortcut.unregister(previous)
  voiceHotkey = undefined
  if (!want) return undefined
  if (tryRegister(want)) {
    voiceHotkey = want
    return undefined
  }
  const error = `${want.replace('CommandOrControl', 'Ctrl')} is taken by another app`
  log(`[voice] hotkey ${error}`)
  if (previous && tryRegister(previous)) voiceHotkey = previous
  if (Notification.isSupported()) new Notification({ title: 'Voice hotkey not set', body: `${error}${voiceHotkey ? `; ${voiceHotkey.replace('CommandOrControl', 'Ctrl')} still works` : ''}. Pick another in Settings → Voice input.` }).show()
  return error
}

/** A project folder from a command line (`Ouroboros.exe <folder>`), resolved against `cwd`. */
export function projectFromArgv(argv: string[], cwd: string, packaged: boolean): string | undefined {
  const args = argv.slice(packaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  const candidate = args[args.length - 1]
  if (!candidate) return undefined
  const full = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
  if (existsSync(full) && statSync(full).isDirectory()) return full
  return undefined
}

/** `Ouroboros.exe <folder>` or OUROBOROS_PROJECT=<folder> opens that project on start. */
export function initialProjectArg(): string | undefined {
  const fromEnv = process.env.OUROBOROS_PROJECT
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  return projectFromArgv(process.argv, process.cwd(), app.isPackaged)
}

export function resolveHookScriptPath(): string {
  return resolveMcpScriptPath().replace(/mcp-server\.js$/, 'agent-hook.js')
}

export function resolveMcpScriptPath(): string {
  // out/main/mcp-server.js next to this file; when packaged in asar it is unpacked.
  return join(__dirname, 'mcp-server.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}
