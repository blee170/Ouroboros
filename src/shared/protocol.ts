import type { VoiceSettings } from './voice'
import type { AgentEngine, AgentSnapshot, AgentStatus, AppSettings, HandoffEdgeData, HookEvent, NodeData, Workspace, WorkspaceEdge, WorkspaceNode } from './types'
import type { AnnouncePayload } from './announce'
import type { AutonomyConfig, AutonomyPublic } from './autonomy'
import type { RolesListing } from './roles'
import type { LedgerApiResult, Task, TaskInput, TaskPatch } from './ledger'
import type { UsageSnapshot } from './usage'
import type { HeldCard, PrivilegeView } from './board-trust'
import type { Mail } from './mail'
import type { Approval } from './gate'
import type { PhoneSettingsView, PhoneStatus } from './phone'

/** IPC channel names shared by main, preload and renderer. */
export const IPC = {
  // renderer -> main (invoke)
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyPasteImage: 'pty:pasteImage',
  claudeLaunch: 'claude:launch',
  boardSync: 'board:sync',
  boardSelected: 'board:selected',
  workspaceLoad: 'workspace:load',
  workspaceTrust: 'workspace:trust',
  workspaceSave: 'workspace:save',
  projectOpen: 'project:open',
  projectRecent: 'project:recent',
  dialogFolder: 'dialog:folder',
  windowOpen: 'window:open',
  shellOpenExternal: 'shell:openExternal',
  shellOpenPath: 'shell:openPath',
  briefOpen: 'brief:open',
  filesSaveImage: 'files:saveImage',
  filesPasteClipboard: 'files:pasteClipboard',
  skillsList: 'skills:list',
  rolesList: 'roles:list',
  rolesFetch: 'roles:fetch',
  rolesRead: 'roles:read',
  tasksList: 'tasks:list',
  tasksCreate: 'tasks:create',
  tasksUpdate: 'tasks:update',
  tasksChanged: 'tasks:changed',
  mailList: 'mail:list',
  mailSend: 'mail:send',
  mailChanged: 'mail:changed',
  gateList: 'gate:list',
  gateResolve: 'gate:resolve',
  gateChanged: 'gate:changed',
  phoneStatus: 'phone:status',
  phoneInterfaces: 'phone:interfaces',
  phoneConfigure: 'phone:configure',
  phonePair: 'phone:pair',
  phoneRevoke: 'phone:revoke',
  changesSummary: 'changes:summary',
  changesDiff: 'changes:diff',
  changesRevert: 'changes:revert',
  checkpointsList: 'checkpoints:list',
  checkpointsCreate: 'checkpoints:create',
  checkpointsRestore: 'checkpoints:restore',
  checkpointsDelete: 'checkpoints:delete',
  sessionUsage: 'session:usage',
  usageGet: 'usage:get',
  usageRefresh: 'usage:refresh',
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
  ttsSynthesize: 'tts:synthesize',
  ttsSetKey: 'tts:setKey',
  ttsKeys: 'tts:keys',
  notionSetToken: 'notion:setToken',
  notionStatus: 'notion:status',
  notionTest: 'notion:test',
  voiceTranscribe: 'voice:transcribe',
  voiceListening: 'voice:listening',
  voiceHotkey: 'voice:hotkey',
  tidyCandidates: 'tidy:candidates',
  bookmarksList: 'bookmarks:list',
  tidyApply: 'tidy:apply',
  browserUnregister: 'browser:unregister',
  autonomyStart: 'autonomy:start',
  autonomyStop: 'autonomy:stop',
  autonomyState: 'autonomy:state',
  // main -> renderer (send)
  autonomyChanged: 'autonomy:changed',
  usageChanged: 'usage:changed',
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
  externalSession: 'external:session',
  announce: 'announce'
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

/** A card added by main (Conductor tools, browser_open): without a position the renderer puts it in the first free grid cell. */
export type AddNodePayload = Omit<WorkspaceNode, 'position'> & { position?: WorkspaceNode['position']; /** placed right of this card when it has no position */ near?: string }

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

/** A git snapshot of a folder (every non-gitignored file, committed or not), kept under refs/ouroboros/checkpoints/<id>. */
/** A slash command the composer can complete: `name` without the leading slash. */
export interface SkillEntry {
  name: string
  description?: string
  source: 'builtin' | 'user' | 'project' | 'plugin'
}

export interface Checkpoint {
  /** `<unix ms>-<4 hex>`; also the ref name's last segment */
  id: string
  label: string
  createdAt: number
  /** the snapshot commit and its tree */
  commit: string
  tree: string
  /** HEAD when the snapshot was taken (null before the first commit) */
  head: string | null
  branch: string | null
  cardId?: string
  /** HEAD is no longer `head`: restoring needs move_head to put the branch back too */
  headMoved: boolean
}

export type CheckpointResult<T> = ({ ok: true } & T) | { ok: false; error: string }
export type CheckpointRestoreResult = CheckpointResult<{ restored: Checkpoint; safety: Checkpoint; movedHead: boolean }> & { ahead?: number; behind?: number; safety?: Checkpoint }

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
  /** Cards whose launch fields were changed outside Ouroboros since the app last wrote the file: not launched until the owner decides. */
  held?: HeldCard[]
}

/** The API exposed to the renderer through contextBridge. */
export type NotionDatabaseKind = 'reports' | 'tasks' | 'updates'

export interface OuroborosApi {
  pty: {
    spawn(opts: PtySpawnOptions): Promise<{ ok: boolean; error?: string }>
    write(nodeId: string, data: string): void
    resize(nodeId: string, cols: number, rows: number): void
    kill(nodeId: string): Promise<void>
    /**
     * Attach an image file to a Claude Code card's prompt as an [Image #N] chip: the image is put on the
     * clipboard and the card gets Claude Code's own paste key (Alt+V). Resolves once the chip shows.
     */
    pasteImage(nodeId: string, path: string): Promise<{ ok: boolean; error?: string }>
    onData(cb: (nodeId: string, data: string) => void): () => void
    onExit(cb: (nodeId: string, code: number) => void): () => void
  }
  claude: {
    launch(opts: ClaudeLaunchOptions): Promise<{ ok: boolean; error?: string }>
  }
  board: {
    sync(payload: BoardSyncPayload): void
    /** The selected card: main holds back the toast and the voice for the card the owner is looking at. */
    setSelected(nodeId: string | null): void
    onAgentStatus(cb: (p: AgentStatusPayload) => void): () => void
    onHookEvent(cb: (p: HookEventPayload) => void): () => void
    onHandoffFired(cb: (p: HandoffFiredPayload) => void): () => void
    onAddNode(cb: (node: AddNodePayload) => void): () => void
    onAddEdge(cb: (edge: WorkspaceEdge) => void): () => void
    onRemoveNode(cb: (nodeId: string) => void): () => void
    onRemoveEdge(cb: (edgeId: string) => void): () => void
    onSetNote(cb: (p: { nodeId: string; note: string }) => void): () => void
    /** Main changed a card's options (e.g. a conductor enabled board tools); restart=true relaunches it. */
    onUpdateNode(cb: (p: { nodeId: string; data: Partial<NodeData>; restart: boolean }) => void): () => void
    onExternalSession(cb: (p: ExternalSessionPayload) => void): () => void
    /** Main decided something is worth saying out loud (a card finished, needs you, the board settled). */
    onAnnounce(cb: (p: AnnouncePayload) => void): () => void
    fireHandoff(edgeId: string): Promise<{ ok: boolean; error?: string }>
    listAgents(): Promise<AgentSnapshot[]>
  }
  workspace: {
    load(projectRoot: string): Promise<WorkspaceLoadResult>
    /** Release held cards (Trust keeps the change, Revert gets the trusted views back to put in place). */
    trust(nodeIds: string[], revert: boolean): Promise<Record<string, PrivilegeView>>
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
    /**
     * Open a file or folder a card wrote about: folders and plain file types with their app, anything that
     * could run (scripts, installers, shortcuts, unknown types) only revealed in its folder. A relative path
     * resolves against `cwd`, `~` against the home folder; URLs, UNC and device paths are refused.
     */
    openPath(path: string, cwd?: string): Promise<{ ok: boolean; path: string; error?: string; revealed?: boolean }>
  }
  brief: {
    /** Show a URL in this window's "📄 Briefs" browser card (created on first use). */
    /** `near`: the card whose brief it is; a new Briefs card goes to its right */
    open(url: string, near?: string): Promise<void>
  }
  autonomy: {
    /** Start a run (keep-awake, deadline, caps, deny rules, parking, report); live Claude cards are relaunched in auto mode. */
    start(config: AutonomyConfig): Promise<AutonomyPublic | null>
    /** End the run now: the report lands on the canvas as a note and in the user-data folder. */
    stop(): Promise<AutonomyPublic | null>
    state(): Promise<AutonomyPublic | null>
    onChange(cb: (p: AutonomyPublic) => void): () => void
  }
  changes: {
    summary(cwd: string): Promise<ChangesSummary>
    diff(cwd: string, file?: string): Promise<string>
    revert(cwd: string, file: string): Promise<{ ok: boolean; error?: string }>
  }
  /** Git snapshots of a folder; see Checkpoint. */
  checkpoints: {
    list(cwd: string): Promise<CheckpointResult<{ checkpoints: Checkpoint[] }>>
    create(cwd: string, label?: string): Promise<CheckpointResult<{ checkpoint: Checkpoint }>>
    restore(cwd: string, id: string, moveHead?: boolean): Promise<CheckpointRestoreResult>
    delete(cwd: string, id: string): Promise<CheckpointResult<{ id: string }>>
  }
  session: {
    /** Context usage of the last turn, read from the Claude Code transcript. */
    usage(sessionId: string): Promise<SessionUsage | null>
  }
  /** Account usage per engine: plan windows (5-hour, weekly, per model), token totals; see shared/usage.ts. */
  usage: {
    /** The current picture (cheap: files and cached values). */
    get(): Promise<UsageSnapshot>
    /** Read again now, asking the Claude usage endpoint when no card is reporting and its interval allows. */
    refresh(): Promise<UsageSnapshot>
    /** A Claude card's status line brought new numbers. */
    onChange(cb: (s: UsageSnapshot) => void): () => void
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
    /**
     * What Ctrl+V should paste: the clipboard text, else its image saved to a file (`path`) — or, with
     * saveImage=false, just `image: true` so the card can let Claude Code paste the image itself.
     */
    pasteClipboard(saveImage?: boolean): Promise<{ path?: string; text?: string; image?: boolean }>
  }
  skills: {
    /** Slash commands a Claude Code card in `cwd` offers (built-ins, user, project, plugins). */
    list(cwd: string): Promise<SkillEntry[]>
  }
  roles: {
    /** Specialist roles for cards (project and user `.claude/agents`, the agency catalog) and the catalog's runbooks. */
    list(cwd: string): Promise<RolesListing>
    /** Clone or update the agency catalog (msitarzewski/agency-agents) with git. */
    fetch(): Promise<{ ok: true; version: string } | { ok: false; error: string }>
    /** The extra system prompt a role gives a card, or undefined for an unknown id. */
    read(cwd: string, id: string): Promise<string | undefined>
  }
  tasks: {
    /** The project's task ledger, every task (done and dropped included). */
    list(): Promise<Task[]>
    create(input: TaskInput): Promise<LedgerApiResult>
    update(id: string, patch: TaskPatch): Promise<LedgerApiResult>
    /** Main pushes the full list after every change (tools, the owner, a card that ended). */
    onChange(cb: (tasks: Task[]) => void): () => void
  }
  mail: {
    /** The project mailbox (unacknowledged messages of the last week). */
    list(): Promise<Mail[]>
    /** The owner messages a card (the Inspector). */
    send(to: string, body: string): Promise<{ ok: boolean; error?: string }>
    onChange(cb: (messages: Mail[]) => void): () => void
  }
  voice: {
    /** One take (16 kHz mono WAV) to text with the engine in Settings → Voice, or `override` (the Test button). */
    transcribe(wav: Uint8Array, override?: Partial<VoiceSettings>): Promise<{ ok: true; text: string } | { ok: false; error: string }>
    /** The wake word is listening: keep this window's audio and timers running while it is hidden. */
    setListening(on: boolean): Promise<void>
    /** The global push-to-talk hotkey was pressed with this window as the target. */
    onHotkey(cb: () => void): () => void
  }
  phone: {
    status(): Promise<PhoneStatus>
    interfaces(): Promise<Array<{ name: string; address: string; kind: 'tailscale' | 'lan' | 'other' }>>
    configure(view: PhoneSettingsView): Promise<PhoneStatus>
    /** a fresh one-use pairing link for the QR */
    pair(): Promise<{ url: string; expiresAt: number } | { error: string }>
    revoke(id: string): Promise<PhoneStatus>
  }
  gate: {
    /** Autonomous runs: what cards asked the owner to allow (gh pr merge), and what was decided. */
    list(): Promise<Approval[]>
    resolve(id: string, approve: boolean): Promise<{ ok: boolean; error?: string; warning?: string }>
    onChange(cb: (approvals: Approval[]) => void): () => void
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
    /** Cards that can be closed: dispatched ones whose job is over; with includeOwn also the owner's own idle cards. */
    candidates(olderThanMinutes: number, includeOwn?: boolean): Promise<Array<{ id: string; title: string; reason: string }>>
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
  tts: {
    /** Audio for `text` from the engine chosen in Settings (cached per sentence); `ok: false` for Windows voices or an engine error. */
    synthesize(text: string): Promise<TtsResult>
    /** Store (encrypted) an engine's API key; empty string clears it. */
    setKey(engine: TtsKeyEngine, key: string): Promise<{ ok: boolean; hasKey: boolean }>
    /** Which engines have a key saved. */
    keys(): Promise<Record<TtsKeyEngine, boolean>>
  }
  notion: {
    /** Store (encrypted) the Notion integration token; empty string clears it. */
    setToken(token: string): Promise<{ ok: boolean; hasToken: boolean }>
    /** Whether a token is saved, and the database id as stored. */
    status(): Promise<{ hasToken: boolean; databaseId?: string }>
    /** Fetch one of the databases (Reports by default) with the saved token: its title, or why not. */
    test(which?: NotionDatabaseKind): Promise<{ ok: true; title: string } | { ok: false; error: string }>
  }
}

export type TtsKeyEngine = 'gemini' | 'openai' | 'elevenlabs'
export type TtsResult = { ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string }

export type { HandoffEdgeData }
