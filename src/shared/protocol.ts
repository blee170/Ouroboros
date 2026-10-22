import type { AgentEngine, AgentSnapshot, AgentStatus, AppSettings, HandoffEdgeData, HookEvent, NodeData, Workspace, WorkspaceEdge, WorkspaceNode } from './types'

/** IPC channel names shared by main, preload and renderer. */
export const IPC = {
  // renderer -> main (invoke)
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  claudeLaunch: 'claude:launch',
  boardSync: 'board:sync',
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  projectOpen: 'project:open',
  projectRecent: 'project:recent',
  dialogFolder: 'dialog:folder',
  windowOpen: 'window:open',
  shellOpenExternal: 'shell:openExternal',
  filesSaveImage: 'files:saveImage',
  changesSummary: 'changes:summary',
  changesDiff: 'changes:diff',
  changesRevert: 'changes:revert',
  sessionUsage: 'session:usage',
  enginesDetect: 'engines:detect',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  worktreeCreate: 'worktree:create',
  worktreeRemove: 'worktree:remove',
  handoffFire: 'handoff:fire',
  agentsList: 'agents:list',
  externalInstallHooks: 'external:installHooks',
  appInfo: 'app:info',
  historyList: 'history:list',
  foldersList: 'folders:list',
  browserRegister: 'browser:register',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateSetToken: 'update:setToken',
  updateStatus: 'update:status',
  tidyCandidates: 'tidy:candidates',
  bookmarksList: 'bookmarks:list',
  tidyApply: 'tidy:apply',
  browserUnregister: 'browser:unregister',
  // main -> renderer (send)
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  agentStatus: 'agent:status',
  hookEvent: 'hook:event',
  handoffFired: 'handoff:fired',
  boardAddNode: 'board:addNode',
  boardAddEdge: 'board:addEdge',
  boardRemoveNode: 'board:removeNode',
  boardRemoveEdge: 'board:removeEdge',
  boardSetNote: 'board:setNote',
  boardUpdateNode: 'board:updateNode',
  externalSession: 'external:session'
} as const

export interface PtySpawnOptions {
  nodeId: string
  cwd: string
  shell?: string
  cols: number
  rows: number
  /** Command text written to the shell right after spawn (followed by Enter). */
  initialCommand?: string
}

export interface ClaudeLaunchOptions {
  nodeId: string
  cwd: string
  cols: number
  rows: number
  shell?: string
  kind: 'claude' | 'conductor'
  engine?: AgentEngine
  claude: NonNullable<NodeData['claude']>
  /** Card title, used as the Claude session display name (--name). */
  title?: string
}

export interface BoardSyncPayload {
  projectRoot: string
  nodes: Array<Pick<WorkspaceNode, 'id'> & { data: NodeData }>
  edges: WorkspaceEdge[]
}

export interface AgentStatusPayload {
  nodeId: string
  status: AgentStatus
  statusDetail?: string
  sessionId?: string
  lastAssistantMessage?: string
  at: number
}

export interface HookEventPayload {
  nodeId: string
  event: HookEvent
}

export interface HandoffFiredPayload {
  edgeId: string
  sourceId: string
  targetId: string
  prompt: string
  at: number
}

export interface ExternalSessionPayload {
  sessionId: string
  cwd: string
  status: AgentStatus
  statusDetail?: string
  lastAssistantMessage?: string
  at: number
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error' | 'unavailable'
  currentVersion: string
  version?: string
  percent?: number
  notes?: string
  message?: string
}

export interface AppInfo {
  platform: string
  version: string
  hookPort: number
  userData: string
  /** Project folder given on the command line or via OUROBOROS_PROJECT, opened on start. */
  initialProject?: string
  /** How the board MCP server is launched for Claude cards. */
  mcpRunner?: string
  mcpScript?: string
  hasUpdateToken?: boolean
  packaged?: boolean
  /** userData/main.log — pty lifecycle, lost processes, uncaught errors */
  logFile?: string
  /** where Electron writes local crash dumps */
  crashDir?: string
}

export interface ClaudeSessionInfo {
  id: string
  cwd: string
  title: string
  /** mtime of the transcript, ms since epoch */
  lastAt: number
  branch?: string
  size: number
}

export interface ClaudeProjectHistory {
  cwd: string
  /** newest first */
  sessions: ClaudeSessionInfo[]
}

export interface FolderInfo {
  path: string
  name: string
  isGit: boolean
  hasClaudeMd: boolean
  packageName?: string
}

export interface ChangeFile {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'C'
  added: number
  deleted: number
}

export interface ChangesSummary {
  repo: boolean
  branch?: string
  files: ChangeFile[]
  added: number
  deleted: number
}

export interface SessionUsage {
  /** tokens in the context window at the last assistant turn (input + cache read + cache write) */
  contextTokens: number
  /** context window size assumed for the model */
  contextWindow: number
  model?: string
  outputTokens: number
  at: number
}

export interface EngineInfo {
  engine: AgentEngine
  label: string
  installed: boolean
  version?: string
  /** undefined = cannot tell from files */
  signedIn?: boolean
  installCommand: string
  loginCommand: string
  signupUrl: string
  needsNode: boolean
  nodeAvailable: boolean
}

export interface WorkspaceLoadResult {
  workspace: Workspace | null
  projectRoot: string
  /** The folder is already open in another window (which was focused instead). */
  alreadyOpen?: boolean
}

/** The API exposed to the renderer through contextBridge. */
export interface OuroborosApi {
  pty: {
    spawn(opts: PtySpawnOptions): Promise<{ ok: boolean; error?: string }>
    write(nodeId: string, data: string): void
    resize(nodeId: string, cols: number, rows: number): void
    kill(nodeId: string): Promise<void>
    onData(cb: (nodeId: string, data: string) => void): () => void
    onExit(cb: (nodeId: string, code: number) => void): () => void
  }
  claude: {
    launch(opts: ClaudeLaunchOptions): Promise<{ ok: boolean; error?: string }>
  }
  board: {
    sync(payload: BoardSyncPayload): void
    onAgentStatus(cb: (p: AgentStatusPayload) => void): () => void
    onHookEvent(cb: (p: HookEventPayload) => void): () => void
    onHandoffFired(cb: (p: HandoffFiredPayload) => void): () => void
    onAddNode(cb: (node: WorkspaceNode) => void): () => void
    onAddEdge(cb: (edge: WorkspaceEdge) => void): () => void
    onRemoveNode(cb: (nodeId: string) => void): () => void
    onRemoveEdge(cb: (edgeId: string) => void): () => void
    onSetNote(cb: (p: { nodeId: string; note: string }) => void): () => void
    /** Main changed a card's options (e.g. a conductor enabled board tools); restart=true relaunches it. */
    onUpdateNode(cb: (p: { nodeId: string; data: Partial<NodeData>; restart: boolean }) => void): () => void
    onExternalSession(cb: (p: ExternalSessionPayload) => void): () => void
    fireHandoff(edgeId: string): Promise<{ ok: boolean; error?: string }>
    listAgents(): Promise<AgentSnapshot[]>
  }
  workspace: {
    load(projectRoot: string): Promise<WorkspaceLoadResult>
    save(workspace: Workspace): Promise<void>
    openProject(): Promise<string | null>
    recent(): Promise<string[]>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  worktree: {
    create(projectRoot: string, name: string): Promise<{ ok: boolean; path?: string; branch?: string; error?: string }>
    remove(projectRoot: string, path: string): Promise<{ ok: boolean; error?: string }>
  }
  external: {
    installHooks(enable: boolean): Promise<{ ok: boolean; error?: string }>
  }
  app: {
    info(): Promise<AppInfo>
  }
  window: {
    /** Open the project in a new window (or focus the window that has it); no folder = empty window. */
    open(projectRoot?: string): Promise<void>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  changes: {
    summary(cwd: string): Promise<ChangesSummary>
    diff(cwd: string, file?: string): Promise<string>
    revert(cwd: string, file: string): Promise<{ ok: boolean; error?: string }>
  }
  session: {
    /** Context usage of the last turn, read from the Claude Code transcript. */
    usage(sessionId: string): Promise<SessionUsage | null>
  }
  engines: {
    /** Installed / signed-in state of claude, codex and gemini. */
    detect(): Promise<EngineInfo[]>
  }
  files: {
    /** Absolute path of a File dropped from the OS (empty for in-browser files). */
    pathFor(file: File): string
    /** Save pasted image bytes under the app's temp folder; returns the path. */
    saveImage(bytes: Uint8Array, ext: string): Promise<string>
  }
  history: {
    /** Claude Code sessions on this machine grouped by cwd (optionally only under rootFilter). */
    list(rootFilter?: string): Promise<ClaudeProjectHistory[]>
  }
  folders: {
    list(root: string): Promise<FolderInfo[]>
  }
  browser: {
    /** Called by a browser card once its <webview> is ready. */
    register(nodeId: string, webContentsId: number): void
    unregister(nodeId: string): void
  }
  bookmarks: {
    /** Bookmarks read from the user's Chrome/Edge profiles (title, url, folder path). */
    list(query?: string): Promise<Array<{ folder: string; title: string; url: string }>>
  }
  tidy: {
    candidates(olderThanMinutes: number): Promise<Array<{ id: string; title: string; reason: string }>>
    apply(ids: string[]): Promise<{ removed: number }>
  }
  update: {
    check(): Promise<UpdateStatus>
    download(): Promise<UpdateStatus>
    install(): Promise<void>
    /** Store (encrypted) the GitHub token used for update downloads; empty string clears it. */
    setToken(token: string): Promise<{ ok: boolean; hasToken: boolean }>
    onStatus(cb: (s: UpdateStatus) => void): () => void
  }
}

export type { HandoffEdgeData }
