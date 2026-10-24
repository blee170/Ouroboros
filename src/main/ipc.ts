import { BrowserWindow, ClipboardItem, Notification, app, clipboard, dialog, ipcMain, powerSaveBlocker, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { nanoid } from 'nanoid'
import type { AddNodePayload, AgentStatusPayload, BoardSyncPayload, ClaudeLaunchOptions, HandoffFiredPayload, PtySpawnOptions, TtsKeyEngine, WorkspaceLoadResult } from '@shared/protocol'
import { IPC } from '@shared/protocol'
import { normalizeEngine, type AppSettings, type ClaudeOptions, type HookEvent, type NodeData, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '@shared/types'
import { DEFAULT_HANDOFF_TEMPLATE, REPORT_TEMPLATE, selectHandoffs, renderTemplate, toPastePayload } from '@shared/handoff'
import { stripAnsi, tailLines } from '@shared/ansi'
import { detectClaudeReady, detectMissingCommand, failureOf } from '@shared/status'
import { BoardDone, Burst, NEEDS_YOU_REPEAT_MS, SETTLE_MS, announceSettings, announcesStop, firstLine, langFor, phrase, type AnnouncePayload } from '@shared/announce'
import type { Board } from './board'
import { findBriefUrl } from './briefs'
import { listSkills } from './skills'
import type { RoleLibrary } from './roles'
import { filterRoles } from '@shared/roles'
import { prepareLaunch } from './claude-launcher'
import { ROLE_PROMPT_PREFIX, roleAsMessage } from './agent-launcher'
import { setGlobalExternalHooks } from './external'
import type { ApiHandlers, HookServer } from './hook-server'
import { PtyManager, defaultShell } from './pty-manager'
import type { BrowserManager } from './browser-manager'
import { findNodeBinary } from './node-runner'
import { decryptToken, encryptToken, type Updater } from './updater'
import { synthesize, ttsKeyFor, ttsKeyPatch } from './tts'

/** Dispatched cards are retired this long after their report reached the card that made them. */
const DEFAULT_RETIRE_MINUTES = 5
/** Live dispatched cards one lead may have at once. */
const DEFAULT_MAX_WORKERS = 6
import { buildCommandLine, extractCompleted, type RunningCommand } from './command-runner'
import { dispatchRefusal, protectedCards, reportedCards, selectTidyCandidates } from '@shared/tidy'
import { listBookmarks } from './bookmarks'
import { log, logPath } from './diagnostics'
import { claudeConfigDirOf, claudeEnvKeysToStrip, claudeLoginFromFiles, detectEngines } from './engines'
import { loadWorkspace, saveWorkspace, UserStore } from './workspace-store'
import { createWorktree, removeWorktree } from './worktree'
import { listClaudeSessions, listSubfolders, readSessionUsage } from './claude-history'
import { getChanges, getDiff, revertFile } from './git-changes'
import { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint } from './checkpoints'
import { normalizePath, type SessionRegistry } from './windows'
import { openMode, resolveOpenPath } from './open-path'
import { Autonomy, type AutonomyHost } from './autonomy'
import type { AutonomyConfig } from '@shared/autonomy'

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
  store: UserStore
  browsers: BrowserManager
  updater: Updater
  tmpDir: string
  mcpScriptPath: string
  /** Specialist roles for cards (.claude/agents files and the agency catalog under userData/roles). */
  roles: RoleLibrary
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
/** the first output of each card's latest launch (its own buffer: the board's is capped and trimmed from the front) */
const launchOut = new Map<string, string>()
const LAUNCH_OUT_CAP = 16_000
/** cards whose latest launch never came up (the CLI is missing): a prompt would land in a bare shell */
const launchFailed = new Set<string>()

/** Is the owner looking at this card right now (window focused, card selected)? Then it needs no toast. */
function viewing(s: WindowSession, nodeId: string): boolean {
  return !s.win.isDestroyed() && s.win.isFocused() && s.selectedNodeId === nodeId
}

/** Type a prompt into an agent terminal (bracketed paste + Enter); command cards run their template instead. */
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
  ctx.ptys.write(nodeId, toPastePayload(text))
  setTimeout(() => ctx.ptys.write(nodeId, '\r'), 150)
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
  s.board.nodes.delete(id)
  ctx.windows.unbindNode(id)
  running.delete(id)
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
    listAgents: () => board.snapshot(),
    readOutput: (nodeId, lines) => (board.nodes.has(nodeId) ? tailLines(board.getOutput(nodeId), lines) : null),
    sendPrompt: (nodeId, text) => sendPrompt(ctx, s, nodeId, text),
    setNote: (nodeId, note) => {
      const n = board.nodes.get(nodeId)
      if (!n || n.data.kind !== 'note') return false
      n.data.note = note
      sendToRenderer(s, IPC.boardSetNote, { nodeId, note })
      return true
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
          data: { kind: 'browser', title: input.title || 'Browser', cwd: board.projectRoot, url: input.url || ctx.store.getSettings().browserHome || 'https://www.google.com' }
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
      const samePath = (x: string, y: string): boolean => x.replace(/[\\/]+$/, '').toLowerCase() === y.replace(/[\\/]+$/, '').toLowerCase()
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
      // autonomous run: Claude cards only. A terminal or command card is a shell past every deny rule; Codex and Gemini
      // have no deny rules and 'auto' would mean yolo there (an omitted engine means Claude during the run). Then the caps.
      if (s.autonomy.on && kind !== 'claude') return { error: 'Autonomous mode: no terminal or command cards during a run (a shell has no rails). Use a Claude card.' }
      const engine = s.autonomy.on ? normalizeEngine(input.engine) : normalizeEngine(input.engine ?? ctx.store.getSettings().defaultEngine)
      if (s.autonomy.on && engine) return { error: `Autonomous mode: no ${engine} cards during a run (no deny rules for that engine). Omit the engine or pass engine=claude.` }
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
 * Tell the owner when work is done: a toast and/or a spoken sentence when a card finishes a turn (Conductor
 * replies by default, every card if asked), "needs you" spoken too, and "all cards have finished" once a
 * run of several cards settles. The reply itself is never read out; its first line goes in the toast.
 */
function installAnnouncer(ctx: MainContext, s: WindowSession): void {
  const board = s.board
  const workingSince = new Map<string, number>()
  const lastTurnMs = new Map<string, number>()
  const spokenNeedsYou = new Map<string, number>()
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
      if (prefs.target === 'off') return
      deliver({ kind: 'all-done', title: '', lang: langFor(...[...board.nodes.values()].map((n) => n.data.title)) }, undefined, prefs)
    }, SETTLE_MS)
  })
  board.on('stop', (nodeId: string, message: string) => {
    const n = board.nodes.get(nodeId)
    if (!n) return
    const prefs = announceSettings(ctx.store.getSettings())
    const elapsed = lastTurnMs.get(nodeId)
    lastTurnMs.delete(nodeId)
    // the owner is looking at the card (the reply is on screen), or this card was announced seconds ago: the
    // finish is not announced, so a settling board may still say "all cards have finished"
    const announced = announcesStop(n.data.kind, elapsed, prefs) && !viewing(s, nodeId) && s.burst.allow(`finished:${nodeId}`, Date.now())
    done.stopped(announced)
    if (!announced) return
    deliver({ kind: 'finished', title: n.data.title, lang: langFor(n.data.title, message) }, firstLine(message) || undefined, prefs)
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
      return join(app.getPath('userData'), 'autonomy', basename(board.projectRoot || 'no-project').replace(/[^\w.-]+/g, '_'))
    },
    evidence: async (cwd) => {
      const c = await getChanges(cwd)
      return c.repo ? { branch: c.branch, added: c.added, removed: c.deleted, files: c.files.length } : undefined
    }
  }
}

const urlKey = (u: string): string => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()

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

/** Show a brief (claude.ai artifact, report URL) in the window's "📄 Briefs" browser card, created on first use. */
async function openBrief(ctx: MainContext, s: WindowSession, url: string): Promise<void> {
  // Briefs stay on the canvas. Only when the owner turned the setting on (claude.ai refusing to sign in
  // inside the card, which its ↗ button also works around per page) do claude.ai links go to the system browser.
  if (/^https:\/\/claude\.ai\//.test(url) && ctx.store.getSettings().claudeLinksExternal === true) {
    void shell.openExternal(url)
    return
  }
  // a card already on that page (the Conductor's own browser_open, say) is enough: no second copy
  if (browserShowing(ctx, s.board, url)) return
  const existing = [...s.board.nodes.values()].find((n) => n.data.kind === 'browser' && n.data.title === '📄 Briefs')
  if (existing && ctx.browsers.has(existing.id)) await ctx.browsers.navigate(existing.id, url).catch(() => undefined)
  else await s.api.browser.create({ url, title: '📄 Briefs' })
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
    if (!inMessage && src.data.lastBriefUrl === url) return
    if (Date.now() - (lastOpened.get(url) ?? 0) < 60_000) return
    lastOpened.set(url, Date.now())
    // remembered on the card and on every conductor so the owner can reopen it with the 📄 button
    for (const n of board.nodes.values()) {
      if (n.id !== nodeId && n.data.kind !== 'conductor') continue
      n.data.lastBriefUrl = url
      sendToRenderer(s, IPC.boardUpdateNode, { nodeId: n.id, data: { lastBriefUrl: url }, restart: false })
    }
    void openBrief(ctx, s, url)
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
      noticed.set(p.nodeId, now)
      sendPrompt(ctx, s, edge.target, `[${src?.data.title ?? p.nodeId} needs input] ${p.statusDetail ?? 'waiting for a decision'} — use read_output to see the question, then answer it with send_prompt or ask the owner.`)
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
    fireHandoff: () => ({ ok: false, error: 'not ready' }),
    hasNode: (nodeId) => board.nodes.has(nodeId),
    selectedNodeId: null,
    burst: new Burst(),
    get projectRoot() {
      return board.projectRoot
    },
    dispose() {
      s.autonomy.dispose()
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
  board.on('status', (p: AgentStatusPayload) => {
    sendToRenderer(s, IPC.agentStatus, p)
    if (p.status === 'needs-you') notifyNeedsYou(ctx, s, p)
  })
  board.on('hook', (p) => sendToRenderer(s, IPC.hookEvent, p))
  board.on('external', (p) => sendToRenderer(s, IPC.externalSession, p))
  return s
}

/** Route a Claude Code hook for a card to the window that owns it. */
export function routeHook(ctx: MainContext, nodeId: string, event: HookEvent): void {
  ctx.windows.forNode(nodeId)?.board.applyHook(nodeId, event)
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

/** Process-wide IPC handlers; each one resolves the calling window's session from the sender. */
export function registerIpc(ctx: MainContext): void {
  const { ptys, hookServer, store } = ctx
  const sessionOf = (e: IpcMainInvokeEvent | IpcMainEvent): WindowSession | undefined => ctx.windows.get(e.sender.id)

  ptys.on('data', (nodeId: string, data: string) => {
    const s = ctx.windows.forNode(nodeId)
    if (!s) return
    const board = s.board
    board.appendOutput(nodeId, data)
    sendToRenderer(s, IPC.ptyData, { nodeId, data })
    watchCommandOutput(s, nodeId, data)
    const n = board.nodes.get(nodeId)
    if (n && (n.data.kind === 'claude' || n.data.kind === 'conductor') && n.data.status === 'starting') {
      // the shell could not find the CLI (that CLI, not a tool the shell profile wants): say so now (needs you,
      // "failed:"), not after a stall timer gives up
      const engine = n.data.engine ?? 'claude'
      const out = ((launchOut.get(nodeId) ?? '') + data).slice(-LAUNCH_OUT_CAP)
      launchOut.set(nodeId, out)
      const missing = detectMissingCommand(out, engine)
      if (missing) {
        launchFailed.add(nodeId)
        board.setStatus(nodeId, { status: 'needs-you', statusDetail: `failed: ${engine} is not installed or not on PATH. Install it (Settings → Engines), then Restart the card.` })
      } else if (detectClaudeReady(data)) board.setStatus(nodeId, { status: 'idle', statusDetail: 'ready' })
      else if (n.data.engine === 'codex' && board.getOutput(nodeId).length > (launchLineLength.get(nodeId) ?? 0) + 300) {
        // Codex sends no session-start event: once it has printed more than the echoed launch line,
        // treat 4s of quiet as "ready"
        clearTimeout(readyTimers.get(nodeId))
        readyTimers.set(
          nodeId,
          setTimeout(() => {
            const cur = board.nodes.get(nodeId)
            if (cur?.data.status === 'starting' && ctx.ptys.isAlive(nodeId)) board.setStatus(nodeId, { status: 'idle', statusDetail: 'ready' })
          }, 4000)
        )
      }
    }
  })
  ptys.on('exit', (nodeId: string, code: number) => {
    running.delete(nodeId)
    launchOut.delete(nodeId)
    launchFailed.delete(nodeId)
    const s = ctx.windows.forNode(nodeId)
    if (!s) return
    s.board.setPtyAlive(nodeId, false)
    if (s.board.nodes.has(nodeId)) s.board.setStatus(nodeId, { status: 'ended', statusDetail: `exited (${code})` })
    sendToRenderer(s, IPC.ptyExit, { nodeId, code })
  })

  ipcMain.handle(IPC.ptySpawn, async (e, opts: PtySpawnOptions) => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'no window' }
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
  ipcMain.on(IPC.ptyWrite, (_e, nodeId: string, data: string) => void ptys.write(nodeId, data))
  ipcMain.on(IPC.ptyResize, (_e, nodeId: string, cols: number, rows: number) => ptys.resize(nodeId, cols, rows))
  ipcMain.handle(IPC.ptyKill, (e, nodeId: string) => {
    ptys.kill(nodeId)
    sessionOf(e)?.board.setPtyAlive(nodeId, false)
  })

  ipcMain.handle(IPC.claudeLaunch, async (e, opts: ClaudeLaunchOptions) => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'no window' }
    try {
      const shell = opts.shell || store.getSettings().defaultShell || defaultShell()
      const engine = opts.engine ?? 'claude'
      // during an autonomous run only Claude launches: the deny rules are Claude settings, and 'auto' would mean yolo elsewhere
      if (s.autonomy.on && engine !== 'claude') return { ok: false, error: `Autonomous mode is on: ${engine} cards have no rails. Stop the run (■) to start one.` }
      const prepared = prepareLaunch({
        nodeId: opts.nodeId,
        kind: opts.kind,
        engine,
        // during an autonomous run every Claude launch is auto mode (plan stays plan), the owner's own cards included
        claude: { ...opts.claude, permissionMode: s.autonomy.permissionMode(opts.claude.permissionMode) as ClaudeOptions['permissionMode'] },
        shell,
        baseUrl: hookServer.baseUrl,
        token: hookServer.token,
        tmpDir: ctx.tmpDir,
        execPath: process.execPath,
        nodeBin: findNodeBinary(),
        mcpScriptPath: ctx.mcpScriptPath,
        hookScriptPath: resolveHookScriptPath(),
        title: opts.title,
        settingsExtra: s.autonomy.settingsFragment()
      })
      ctx.windows.bindNode(opts.nodeId, s.id)
      launchOut.delete(opts.nodeId)
      launchFailed.delete(opts.nodeId)
      // a stale ANTHROPIC_API_KEY in the owner's environment would beat the sign-in inside every Claude card
      const login = engine === 'claude' ? claudeLoginFromFiles(claudeConfigDirOf(process.env, homedir()), existsSync, (p) => readFileSync(p, 'utf8')) : false
      const omitEnv = claudeEnvKeysToStrip(process.env, login, store.getSettings().keepEnvApiKey === true)
      if (omitEnv.length) log(`claude launch ${opts.nodeId}: ${omitEnv.join(', ')} not passed to the card (signed in; Settings → keep the environment key to change this)`)
      else if (login === undefined && claudeEnvKeysToStrip(process.env, true, false).length) log(`claude launch ${opts.nodeId}: sign-in files unreadable, environment key kept`)
      await throttledSpawn(() => ptys.spawn({ nodeId: opts.nodeId, cwd: opts.cwd, shell, cols: opts.cols, rows: opts.rows, initialCommand: prepared.command, env: prepared.env, omitEnv }))
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
    if (s) s.board.projectRoot = projectRoot
    store.pushRecent(projectRoot)
    return { workspace: loadWorkspace(projectRoot), projectRoot }
  })
  ipcMain.handle(IPC.workspaceSave, (_e, ws: Workspace) => saveWorkspace(ws))
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
  ipcMain.handle(IPC.briefOpen, async (e, url: string) => {
    const s = sessionOf(e)
    if (s && /^https?:\/\//.test(url)) await openBrief(ctx, s, url)
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

  ipcMain.handle(IPC.settingsGet, () => store.getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => store.setSettings(patch))

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
      setGlobalExternalHooks(enable, hookServer.baseUrl)
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
