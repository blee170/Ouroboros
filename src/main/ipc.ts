import { BrowserWindow, Notification, app, dialog, ipcMain } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { AgentStatusPayload, BoardSyncPayload, ClaudeLaunchOptions, HandoffFiredPayload, PtySpawnOptions } from '@shared/protocol'
import { IPC } from '@shared/protocol'
import type { AppSettings, Workspace, WorkspaceEdge, WorkspaceNode } from '@shared/types'
import { DEFAULT_HANDOFF_TEMPLATE, REPORT_TEMPLATE, selectHandoffs, renderTemplate, toPastePayload } from '@shared/handoff'
import { tailLines } from '@shared/ansi'
import { detectClaudeReady } from '@shared/status'
import type { Board } from './board'
import { prepareLaunch } from './claude-launcher'
import { setGlobalExternalHooks } from './external'
import type { ApiHandlers, HookServer } from './hook-server'
import { PtyManager, defaultShell } from './pty-manager'
import type { BrowserManager } from './browser-manager'
import { findNodeBinary } from './node-runner'
import { decryptToken, encryptToken, type Updater } from './updater'
import { loadWorkspace, saveWorkspace, UserStore } from './workspace-store'
import { createWorktree, removeWorktree } from './worktree'
import { listClaudeSessions, listSubfolders } from './claude-history'

export interface MainContext {
  /** Set by installHandoffRunner; fires an edge now (manual = ignore cooldown). */
  fireHandoff?: (edgeId: string, manual: boolean) => { ok: boolean; error?: string }
  board: Board
  ptys: PtyManager
  hookServer: HookServer
  store: UserStore
  browsers: BrowserManager
  updater: Updater
  tmpDir: string
  mcpScriptPath: string
  getWindow(): BrowserWindow | null
}

const EDGE_COOLDOWN_MS = 8_000
const EDGE_MAX_PER_WINDOW = 6
const EDGE_WINDOW_MS = 5 * 60_000

function sendToRenderer(ctx: MainContext, channel: string, payload: unknown): void {
  const win = ctx.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Type a prompt into an agent terminal (bracketed paste + Enter). */
export function sendPrompt(ctx: MainContext, nodeId: string, text: string): boolean {
  if (!ctx.ptys.isAlive(nodeId)) return false
  ctx.ptys.write(nodeId, toPastePayload(text))
  setTimeout(() => ctx.ptys.write(nodeId, '\r'), 150)
  return true
}

/** Create a handoff line in main and push it to the canvas. */
export function createHandoffEdge(
  ctx: MainContext,
  input: { source: string; target: string; mode?: 'auto' | 'manual'; template?: string; condition?: string }
): { id: string } | { error: string } {
  const src = ctx.board.nodes.get(input.source)
  const dst = ctx.board.nodes.get(input.target)
  if (!src || !dst) return { error: 'unknown source or target agent id' }
  if (input.source === input.target) return { error: 'source and target must differ' }
  if (src.data.kind === 'note' || src.data.kind === 'browser' || dst.data.kind === 'note' || dst.data.kind === 'browser') return { error: 'handoffs connect agent cards only' }
  const edge: WorkspaceEdge = {
    id: nanoid(8),
    source: input.source,
    target: input.target,
    data: { mode: input.mode === 'manual' ? 'manual' : 'auto', template: input.template?.trim() || DEFAULT_HANDOFF_TEMPLATE, condition: input.condition?.trim() || undefined }
  }
  ctx.board.edges = [...ctx.board.edges.filter((e) => e.id !== edge.id), edge]
  sendToRenderer(ctx, IPC.boardAddEdge, edge)
  return { id: edge.id }
}

export function createApiHandlers(ctx: MainContext): ApiHandlers {
  const pendingPrompts = new Map<string, string>()
  ctx.board.on('status', (p: AgentStatusPayload) => {
    const pending = pendingPrompts.get(p.nodeId)
    if (pending && p.status === 'idle') {
      pendingPrompts.delete(p.nodeId)
      setTimeout(() => sendPrompt(ctx, p.nodeId, pending), 800)
    }
  })
  return {
    listAgents: () => ctx.board.snapshot(),
    readOutput: (nodeId, lines) => (ctx.board.nodes.has(nodeId) ? tailLines(ctx.board.getOutput(nodeId), lines) : null),
    sendPrompt: (nodeId, text) => sendPrompt(ctx, nodeId, text),
    setNote: (nodeId, note) => {
      const n = ctx.board.nodes.get(nodeId)
      if (!n || n.data.kind !== 'note') return false
      n.data.note = note
      sendToRenderer(ctx, IPC.boardSetNote, { nodeId, note })
      return true
    },
    listHandoffs: () =>
      ctx.board.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceTitle: ctx.board.nodes.get(e.source)?.data.title,
        target: e.target,
        targetTitle: ctx.board.nodes.get(e.target)?.data.title,
        mode: e.data.mode,
        condition: e.data.condition,
        template: e.data.template,
        lastFiredAt: e.data.lastFiredAt
      })),
    createHandoff: (input) => createHandoffEdge(ctx, input),
    removeHandoff: (id) => {
      const before = ctx.board.edges.length
      ctx.board.edges = ctx.board.edges.filter((e) => e.id !== id)
      sendToRenderer(ctx, IPC.boardRemoveEdge, id)
      return ctx.board.edges.length < before
    },
    fireHandoff: (id) => ctx.fireHandoff?.(id, true) ?? { ok: false, error: 'not ready' },
    browser: {
      list: () =>
        [...ctx.board.nodes.values()]
          .filter((n) => n.data.kind === 'browser')
          .map((n) => ({ id: n.id, title: n.data.title, url: n.data.url, ready: ctx.browsers.has(n.id) })),
      create: async (input) => {
        const id = nanoid(10)
        const count = ctx.board.nodes.size
        const node: WorkspaceNode = {
          id,
          position: { x: 80 + (count % 4) * 560, y: 80 + Math.floor(count / 4) * 420 },
          width: 640,
          height: 480,
          data: { kind: 'browser', title: input.title || 'Browser', cwd: ctx.board.projectRoot, url: input.url || ctx.store.getSettings().browserHome || 'https://www.google.com' }
        }
        sendToRenderer(ctx, IPC.boardAddNode, node)
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
      const id = nanoid(10)
      let cwd = input.cwd || ctx.board.projectRoot || app.getPath('home')
      const title = input.title || basename(cwd)
      let worktree: WorkspaceNode['data']['worktree']
      if (input.worktree) {
        const wt = await createWorktree(cwd, title)
        worktree = wt
        cwd = wt.path
      }
      const count = ctx.board.nodes.size
      // Guard: --continue in a folder where a conductor already lives would clone the conductor's own
      // conversation (and re-run whatever it was doing). Start fresh there instead.
      const samePath = (x: string, y: string): boolean => x.replace(/[\\/]+$/, '').toLowerCase() === y.replace(/[\\/]+$/, '').toLowerCase()
      const conductorHere = [...ctx.board.nodes.values()].some((n) => n.data.kind === 'conductor' && samePath(n.data.cwd, cwd))
      const wantContinue = Boolean(input.continue) && !conductorHere
      const claude: WorkspaceNode['data']['claude'] =
        input.kind === 'terminal'
          ? undefined
          : {
              appendSystemPrompt: input.role_prompt?.trim() || undefined,
              permissionMode: input.permission_mode as NonNullable<WorkspaceNode['data']['claude']>['permissionMode'],
              model: input.model || undefined,
              continue: wantContinue || undefined,
              resume: input.resume || undefined
            }
      const node: WorkspaceNode = {
        id,
        position: { x: 80 + (count % 4) * 600, y: 80 + Math.floor(count / 4) * 440 },
        width: 560,
        height: 400,
        data: { kind: input.kind === 'terminal' ? 'terminal' : 'claude', title, cwd: input.worktree ? input.cwd || ctx.board.projectRoot : cwd, worktree, claude }
      }
      if (input.prompt) pendingPrompts.set(id, input.prompt)
      sendToRenderer(ctx, IPC.boardAddNode, node)
      // register in main right away so a report line can be attached before the renderer echoes the node
      ctx.board.nodes.set(id, { id, data: { ...node.data } })
      if (input.report_to && ctx.board.nodes.has(input.report_to)) {
        createHandoffEdge(ctx, { source: id, target: input.report_to, mode: 'auto', template: REPORT_TEMPLATE })
      }
      return { id, cwd, worktree: worktree?.path }
    },
    removeAgent: async (id) => {
      if (!ctx.board.nodes.has(id)) return false
      ctx.ptys.kill(id)
      ctx.board.setPtyAlive(id, false)
      sendToRenderer(ctx, IPC.boardRemoveNode, id)
      return true
    },
    waitForAgents: (ids, statuses, timeoutMs) =>
      new Promise((resolve) => {
        const wanted = new Set(statuses)
        const targets = ids.length ? ids : [...ctx.board.nodes.keys()].filter((k) => ctx.board.nodes.get(k)?.data.kind === 'claude')
        const done = (): Array<{ id: string; status: string; lastAssistantMessage?: string }> =>
          targets
            .map((t) => ctx.board.nodes.get(t))
            .filter((n): n is NonNullable<typeof n> => Boolean(n))
            .filter((n) => wanted.has(n.data.status ?? ''))
            .map((n) => ({ id: n.id, status: n.data.status ?? '', lastAssistantMessage: n.data.lastAssistantMessage }))
        const finish = (timedOut: boolean): void => {
          ctx.board.off('status', onStatus)
          clearTimeout(timer)
          resolve({ timedOut, ready: done(), pending: targets.filter((t) => !done().some((d) => d.id === t)) })
        }
        const onStatus = (): void => {
          if (done().length > 0) finish(false)
        }
        const timer = setTimeout(() => finish(true), timeoutMs)
        if (done().length > 0) return finish(false)
        ctx.board.on('status', onStatus)
      })
  }
}

function notifyNeedsYou(ctx: MainContext, p: AgentStatusPayload): void {
  const settings = ctx.store.getSettings()
  if (!settings.notifications) return
  const n = ctx.board.nodes.get(p.nodeId)
  const title = n?.data.title ?? p.nodeId
  if (Notification.isSupported()) {
    const note = new Notification({ title: `${title} needs you`, body: p.statusDetail ?? 'Waiting for your input' })
    note.on('click', () => {
      const win = ctx.getWindow()
      if (win) {
        win.show()
        win.focus()
      }
    })
    note.show()
  }
  const win = ctx.getWindow()
  if (win && !win.isFocused()) win.flashFrame(true)
}

function installHandoffRunner(ctx: MainContext): void {
  const fired = new Map<string, number[]>()
  const fire = (edge: WorkspaceEdge, message: string, manual: boolean): { ok: boolean; error?: string } => {
    const src = ctx.board.nodes.get(edge.source)
    const dst = ctx.board.nodes.get(edge.target)
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
    if (!sendPrompt(ctx, edge.target, prompt)) return { ok: false, error: 'target terminal is not running' }
    edge.data.lastFiredAt = Date.now()
    const payload: HandoffFiredPayload = { edgeId: edge.id, sourceId: edge.source, targetId: edge.target, prompt, at: edge.data.lastFiredAt }
    sendToRenderer(ctx, IPC.handoffFired, payload)
    return { ok: true }
  }
  ctx.board.on('stop', (nodeId: string, message: string) => {
    for (const edge of selectHandoffs(ctx.board.edges, nodeId, message)) fire(edge, message, false)
  })
  // A card that needs a human (permission prompt, question) tells every conductor it reports to.
  const noticed = new Map<string, number>()
  ctx.board.on('status', (p: AgentStatusPayload) => {
    if (p.status !== 'needs-you') return
    const now = Date.now()
    if (now - (noticed.get(p.nodeId) ?? 0) < 60_000) return
    const src = ctx.board.nodes.get(p.nodeId)
    for (const edge of ctx.board.edges) {
      if (edge.source !== p.nodeId || edge.data.mode !== 'auto') continue
      const dst = ctx.board.nodes.get(edge.target)
      if (!dst || dst.data.kind !== 'conductor') continue
      noticed.set(p.nodeId, now)
      sendPrompt(ctx, edge.target, `[${src?.data.title ?? p.nodeId} needs input] ${p.statusDetail ?? 'waiting for a decision'} — use read_output to see the question, then answer it with send_prompt or ask the owner.`)
    }
  })
  ctx.fireHandoff = (edgeId, manual) => {
    const edge = ctx.board.edges.find((e) => e.id === edgeId)
    if (!edge) return { ok: false, error: 'unknown edge' }
    const src = ctx.board.nodes.get(edge.source)
    return fire(edge, src?.data.lastAssistantMessage ?? '', manual)
  }
  ipcMain.handle(IPC.handoffFire, (_e, edgeId: string) => ctx.fireHandoff!(edgeId, true))
}

export function registerIpc(ctx: MainContext): void {
  const { board, ptys, hookServer, store } = ctx

  ptys.on('data', (nodeId: string, data: string) => {
    board.appendOutput(nodeId, data)
    sendToRenderer(ctx, IPC.ptyData, { nodeId, data })
    const n = board.nodes.get(nodeId)
    if (n && (n.data.kind === 'claude' || n.data.kind === 'conductor') && n.data.status === 'starting' && detectClaudeReady(data)) {
      board.setStatus(nodeId, { status: 'idle', statusDetail: 'ready' })
    }
  })
  ptys.on('exit', (nodeId: string, code: number) => {
    board.setPtyAlive(nodeId, false)
    if (board.nodes.has(nodeId)) board.setStatus(nodeId, { status: 'ended', statusDetail: `exited (${code})` })
    sendToRenderer(ctx, IPC.ptyExit, { nodeId, code })
  })
  board.on('status', (p: AgentStatusPayload) => {
    sendToRenderer(ctx, IPC.agentStatus, p)
    if (p.status === 'needs-you') notifyNeedsYou(ctx, p)
  })
  board.on('hook', (p) => sendToRenderer(ctx, IPC.hookEvent, p))
  board.on('external', (p) => sendToRenderer(ctx, IPC.externalSession, p))
  installHandoffRunner(ctx)

  ipcMain.handle(IPC.ptySpawn, (_e, opts: PtySpawnOptions) => {
    try {
      ptys.spawn(opts)
      board.setPtyAlive(opts.nodeId, true)
      board.setStatus(opts.nodeId, { status: 'idle', statusDetail: 'shell' })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.on(IPC.ptyWrite, (_e, nodeId: string, data: string) => void ptys.write(nodeId, data))
  ipcMain.on(IPC.ptyResize, (_e, nodeId: string, cols: number, rows: number) => ptys.resize(nodeId, cols, rows))
  ipcMain.handle(IPC.ptyKill, (_e, nodeId: string) => {
    ptys.kill(nodeId)
    board.setPtyAlive(nodeId, false)
  })

  ipcMain.handle(IPC.claudeLaunch, (_e, opts: ClaudeLaunchOptions) => {
    try {
      const shell = opts.shell || store.getSettings().defaultShell || defaultShell()
      const prepared = prepareLaunch({
        nodeId: opts.nodeId,
        kind: opts.kind,
        claude: opts.claude,
        shell,
        baseUrl: hookServer.baseUrl,
        token: hookServer.token,
        tmpDir: ctx.tmpDir,
        execPath: process.execPath,
        nodeBin: findNodeBinary(),
        mcpScriptPath: ctx.mcpScriptPath,
        title: opts.title
      })
      ptys.spawn({ nodeId: opts.nodeId, cwd: opts.cwd, shell, cols: opts.cols, rows: opts.rows, initialCommand: prepared.command })
      board.setPtyAlive(opts.nodeId, true)
      board.setStatus(opts.nodeId, { status: 'starting', statusDetail: 'launching claude' })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.on(IPC.boardSync, (_e, payload: BoardSyncPayload) => board.sync(payload))
  ipcMain.handle(IPC.agentsList, () => board.snapshot())

  ipcMain.handle(IPC.workspaceLoad, (_e, projectRoot: string) => {
    store.pushRecent(projectRoot)
    return { workspace: loadWorkspace(projectRoot), projectRoot }
  })
  ipcMain.handle(IPC.workspaceSave, (_e, ws: Workspace) => saveWorkspace(ws))
  ipcMain.handle(IPC.projectOpen, async () => {
    const win = ctx.getWindow()
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'], title: 'Open project folder' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })
  ipcMain.handle(IPC.projectRecent, () => store.getRecent())
  ipcMain.handle(IPC.dialogFolder, async () => {
    const win = ctx.getWindow()
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
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

  ipcMain.on(IPC.browserRegister, (_e, nodeId: string, wcId: number) => ctx.browsers.register(nodeId, wcId))
  ipcMain.on(IPC.browserUnregister, (_e, nodeId: string) => ctx.browsers.unregister(nodeId))

  ipcMain.handle(IPC.historyList, (_e, rootFilter?: string) => listClaudeSessions(undefined, { rootFilter: rootFilter || undefined }))
  ipcMain.handle(IPC.foldersList, (_e, root: string) => listSubfolders(root))

  ipcMain.handle(IPC.appInfo, () => ({
    platform: process.platform,
    version: app.getVersion(),
    hookPort: hookServer.port,
    userData: app.getPath('userData'),
    initialProject: initialProjectArg(),
    mcpRunner: findNodeBinary() ?? `${process.execPath} (ELECTRON_RUN_AS_NODE)`,
    mcpScript: ctx.mcpScriptPath,
    hasUpdateToken: Boolean(decryptToken(store.getSettings().githubTokenEnc)),
    packaged: app.isPackaged
  }))

  ctx.updater.on('status', (st) => sendToRenderer(ctx, IPC.updateStatus, st))
  ipcMain.handle(IPC.updateCheck, () => ctx.updater.check())
  ipcMain.handle(IPC.updateDownload, () => ctx.updater.download())
  ipcMain.handle(IPC.updateInstall, () => ctx.updater.install())
  ipcMain.handle(IPC.updateSetToken, (_e, token: string) => {
    const enc = encryptToken(String(token ?? '').trim())
    store.setSettings({ githubTokenEnc: enc || undefined })
    return { ok: true, hasToken: Boolean(enc) }
  })
}

/** `Ouroboros.exe <folder>` or OUROBOROS_PROJECT=<folder> opens that project on start. */
export function initialProjectArg(): string | undefined {
  const fromEnv = process.env.OUROBOROS_PROJECT
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  const candidate = args[args.length - 1]
  if (candidate && existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  return undefined
}

export function resolveMcpScriptPath(): string {
  // out/main/mcp-server.js next to this file; when packaged in asar it is unpacked.
  return join(__dirname, 'mcp-server.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}
