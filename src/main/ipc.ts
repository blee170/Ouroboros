import { BrowserWindow, Notification, app, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import type { AgentStatusPayload, BoardSyncPayload, ClaudeLaunchOptions, HandoffFiredPayload, PtySpawnOptions, WorkspaceLoadResult } from '@shared/protocol'
import { IPC } from '@shared/protocol'
import { normalizeEngine, type AppSettings, type HookEvent, type NodeData, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '@shared/types'
import { DEFAULT_HANDOFF_TEMPLATE, REPORT_TEMPLATE, selectHandoffs, renderTemplate, toPastePayload } from '@shared/handoff'
import { tailLines } from '@shared/ansi'
import { detectClaudeReady } from '@shared/status'
import type { Board } from './board'
import { prepareLaunch } from './claude-launcher'
import { ROLE_PROMPT_PREFIX, roleAsMessage } from './agent-launcher'
import { setGlobalExternalHooks } from './external'
import type { ApiHandlers, HookServer } from './hook-server'
import { PtyManager, defaultShell } from './pty-manager'
import type { BrowserManager } from './browser-manager'
import { findNodeBinary } from './node-runner'
import { decryptToken, encryptToken, type Updater } from './updater'
import { buildCommandLine, extractCompleted, type RunningCommand } from './command-runner'
import { selectTidyCandidates } from '@shared/tidy'
import { listBookmarks } from './bookmarks'
import { logPath } from './diagnostics'
import { detectEngines } from './engines'
import { loadWorkspace, saveWorkspace, UserStore } from './workspace-store'
import { createWorktree, removeWorktree } from './worktree'
import { listClaudeSessions, listSubfolders, readSessionUsage } from './claude-history'
import { getChanges, getDiff, revertFile } from './git-changes'
import { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint } from './checkpoints'
import { normalizePath, type SessionRegistry } from './windows'

/** One window: its BrowserWindow, its own Board and the API scoped to that board. */
export interface WindowSession {
  /** webContents id */
  id: number
  win: BrowserWindow
  board: Board
  /** Project folder this window opened with (command line / "open in new window"). */
  initialProject?: string
  api: ApiHandlers
  fireHandoff: (edgeId: string, manual: boolean) => { ok: boolean; error?: string }
  hasNode(nodeId: string): boolean
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

/** Type a prompt into an agent terminal (bracketed paste + Enter); command cards run their template instead. */
export function sendPrompt(ctx: MainContext, s: WindowSession, nodeId: string, text: string): boolean {
  if (!ctx.ptys.isAlive(nodeId)) return false
  const n = s.board.nodes.get(nodeId)
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
        const id = nanoid(10)
        const count = board.nodes.size
        const node: WorkspaceNode = {
          id,
          position: { x: 80 + (count % 4) * 560, y: 80 + Math.floor(count / 4) * 420 },
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
    createAgent: async (input) => {
      const samePath = (x: string, y: string): boolean => x.replace(/[\\/]+$/, '').toLowerCase() === y.replace(/[\\/]+$/, '').toLowerCase()
      let cwd = input.cwd || board.projectRoot || app.getPath('home')
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
            sendToRenderer(s, IPC.boardUpdateNode, { nodeId: twin.id, data: { claude: claudeOpts }, restart: false })
            board.markRoleTurn(twin.id)
            sendPrompt(ctx, s, twin.id, roleAsMessage(role))
            if (input.prompt) pendingPrompts.set(twin.id, input.prompt)
          } else if (input.prompt) sendPrompt(ctx, s, twin.id, input.prompt)
          if (input.report_to && board.nodes.has(input.report_to) && !board.edges.some((e) => e.source === twin.id && e.target === input.report_to)) {
            createHandoffEdge(s, { source: twin.id, target: input.report_to, mode: 'auto', template: REPORT_TEMPLATE })
          }
          return { id: twin.id, cwd: twin.data.worktree?.path || twin.data.cwd, worktree: twin.data.worktree?.path, reused: true }
        }
        if (!alive || status === 'ended') {
          removeCard(ctx, s, twin.id)
          replaced = twin.id
        }
      }
      const id = nanoid(10)
      let worktree: WorkspaceNode['data']['worktree']
      if (input.worktree) {
        const wt = await createWorktree(cwd, title)
        worktree = wt
        cwd = wt.path
      }
      const count = board.nodes.size
      // Guard: --continue in a folder where a conductor already lives would clone the conductor's own
      // conversation (and re-run whatever it was doing). Start fresh there instead.
      const conductorHere = [...board.nodes.values()].some((n) => n.data.kind === 'conductor' && samePath(n.data.cwd, cwd))
      const wantContinue = Boolean(input.continue) && !conductorHere
      const claude: WorkspaceNode['data']['claude'] =
        input.kind === 'terminal' || input.kind === 'command'
          ? undefined
          : {
              appendSystemPrompt: input.role_prompt?.trim() || undefined,
              permissionMode: input.permission_mode as NonNullable<WorkspaceNode['data']['claude']>['permissionMode'],
              model: input.model || undefined,
              continue: wantContinue || undefined,
              resume: input.resume || undefined,
              boardTools: input.board_tools || undefined
            }
      const node: WorkspaceNode = {
        id,
        position: { x: 80 + (count % 4) * 600, y: 80 + Math.floor(count / 4) * 440 },
        width: 560,
        height: 400,
        data: {
          kind,
          engine: claude ? normalizeEngine(input.engine ?? ctx.store.getSettings().defaultEngine) : undefined,
          title,
          cwd: input.worktree ? input.cwd || board.projectRoot : cwd,
          worktree,
          claude,
          commandTemplate: input.kind === 'command' ? input.command_template || 'echo {{prompt}}' : undefined
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
    tidy: async (olderThanMinutes, dryRun) => {
      // cards that still have an un-fired manual line or are the target of an auto line from a working card stay
      const protect = new Set<string>()
      for (const e of board.edges) {
        const src = board.nodes.get(e.source)
        if (src?.data.status === 'working') protect.add(e.target)
      }
      const candidates = selectTidyCandidates(board.snapshot(), { olderThanMinutes, protect })
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

function notifyNeedsYou(ctx: MainContext, s: WindowSession, p: AgentStatusPayload): void {
  const settings = ctx.store.getSettings()
  if (!settings.notifications) return
  const n = s.board.nodes.get(p.nodeId)
  const title = n?.data.title ?? p.nodeId
  if (Notification.isSupported()) {
    const note = new Notification({ title: `${title} needs you`, body: p.statusDetail ?? 'Waiting for your input' })
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

/** Show a brief (claude.ai artifact, report URL) in the window's "📄 Briefs" browser card, created on first use. */
async function openBrief(ctx: MainContext, s: WindowSession, url: string): Promise<void> {
  // Briefs stay on the canvas. Only when the owner turned the setting on (claude.ai refusing to sign in
  // inside the card, which its ↗ button also works around per page) do claude.ai links go to the system browser.
  if (/^https:\/\/claude\.ai\//.test(url) && ctx.store.getSettings().claudeLinksExternal === true) {
    void shell.openExternal(url)
    return
  }
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
  // A reply that publishes something for the owner (claude.ai artifact or any https URL in a conductor's reply)
  // is opened in a "📄 Briefs" browser card so it can be read on the canvas.
  const lastOpened = new Map<string, number>()
  board.on('stop', (nodeId: string, message: string) => {
    const src = board.nodes.get(nodeId)
    if (!src || src.data.kind !== 'conductor') return
    const m = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_\-/.]+|https?:\/\/[^\s)>\]"'`]+/.exec(message)
    if (!m) return
    const url = m[0].replace(/[.,;:!?]+$/, '')
    if (Date.now() - (lastOpened.get(url) ?? 0) < 60_000) return
    lastOpened.set(url, Date.now())
    // remembered on the card so the owner can reopen it with the 📄 button
    src.data.lastBriefUrl = url
    sendToRenderer(s, IPC.boardUpdateNode, { nodeId, data: { lastBriefUrl: url }, restart: false })
    void openBrief(ctx, s, url)
  })

  // A card that needs a human (permission prompt, question) tells every conductor it reports to.
  const noticed = new Map<string, number>()
  board.on('status', (p: AgentStatusPayload) => {
    if (p.status !== 'needs-you') return
    const now = Date.now()
    if (now - (noticed.get(p.nodeId) ?? 0) < 60_000) return
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
    fireHandoff: () => ({ ok: false, error: 'not ready' }),
    hasNode: (nodeId) => board.nodes.has(nodeId),
    get projectRoot() {
      return board.projectRoot
    },
    dispose() {
      for (const id of board.nodes.keys()) {
        ctx.ptys.kill(id)
        ctx.browsers.unregister(id)
        running.delete(id)
      }
      board.removeAllListeners()
    }
  }
  s.api = createApiHandlers(ctx, s)
  s.fireHandoff = installHandoffRunner(ctx, s)
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
      if (detectClaudeReady(data)) board.setStatus(nodeId, { status: 'idle', statusDetail: 'ready' })
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
      const prepared = prepareLaunch({
        nodeId: opts.nodeId,
        kind: opts.kind,
        engine,
        claude: opts.claude,
        shell,
        baseUrl: hookServer.baseUrl,
        token: hookServer.token,
        tmpDir: ctx.tmpDir,
        execPath: process.execPath,
        nodeBin: findNodeBinary(),
        mcpScriptPath: ctx.mcpScriptPath,
        hookScriptPath: resolveHookScriptPath(),
        title: opts.title
      })
      ctx.windows.bindNode(opts.nodeId, s.id)
      await throttledSpawn(() => ptys.spawn({ nodeId: opts.nodeId, cwd: opts.cwd, shell, cols: opts.cols, rows: opts.rows, initialCommand: prepared.command, env: prepared.env }))
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
  ipcMain.handle(IPC.filesSaveImage, (_e, bytes: Uint8Array, ext: string) => {
    const dir = join(ctx.tmpDir, 'pasted')
    mkdirSync(dir, { recursive: true })
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase().replace('jpeg', 'jpg') : 'png'
    const file = join(dir, `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${nanoid(4)}.${safeExt}`)
    writeFileSync(file, Buffer.from(bytes))
    return file
  })
  ipcMain.handle(IPC.briefOpen, async (e, url: string) => {
    const s = sessionOf(e)
    if (s && /^https?:\/\//.test(url)) await openBrief(ctx, s, url)
  })
  ipcMain.handle(IPC.shellOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
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
  ipcMain.handle(IPC.tidyCandidates, async (e, minutes: number) => (await sessionOf(e)?.api.tidy(minutes, true))?.candidates ?? [])
  ipcMain.handle(IPC.tidyApply, async (e, ids: string[]) => {
    const s = sessionOf(e)
    let removed = 0
    if (s) for (const id of ids) if (await s.api.removeAgent(id)) removed++
    return { removed }
  })
  // optional auto-tidy, every window
  setInterval(() => {
    const minutes = store.getSettings().autoTidyMinutes ?? 0
    if (minutes > 0) for (const s of ctx.windows.all()) void s.api.tidy(minutes, false)
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
