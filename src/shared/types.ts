import type { VoiceSettings } from './voice'
import type { Task } from './ledger'

/** Which CLI a Claude/Conductor card runs. Codex, Gemini and Grok get the same hooks, lines and board tools. */
export type AgentEngine = 'claude' | 'codex' | 'gemini' | 'grok'

/** Stored engine value: claude is the implicit default and is kept as undefined. */
export function normalizeEngine(e: string | undefined | null): 'codex' | 'gemini' | 'grok' | undefined {
  return e === 'codex' || e === 'gemini' || e === 'grok' ? e : undefined
}

/** Node kinds shown on the canvas. */
export type NodeKind = 'terminal' | 'claude' | 'conductor' | 'note' | 'external' | 'browser' | 'command'

/** Lifecycle status of an agent/terminal node, derived from Claude Code hooks (or PTY exit). */
export type AgentStatus = 'starting' | 'idle' | 'working' | 'needs-you' | 'done' | 'ended'

export interface ClaudeOptions {
  /** `claude --continue` on launch (resume most recent conversation in cwd). */
  continue?: boolean
  /** `claude --resume <id>` on launch. */
  resume?: string
  model?: string
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'
  /** Extra text appended to the system prompt (conductor preset uses this). */
  appendSystemPrompt?: string
  /** Free-form extra CLI args. */
  extraArgs?: string[]
  /** Extra MCP servers attached to this card via --mcp-config (same shape as .mcp.json "mcpServers"). */
  mcpServers?: Record<string, McpServerSpec>
  /** Attach the board's own MCP server (agents + browser cards) to a plain Claude card. Conductors always have it. */
  boardTools?: boolean
}

export interface McpServerSpec {
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** For remote servers */
  type?: 'stdio' | 'http' | 'sse'
  url?: string
  headers?: Record<string, string>
}

/** Ready-made MCP server entries the Inspector can add with one click. */
export const MCP_PRESETS: Record<string, { label: string; hint: string; spec: McpServerSpec }> = {
  aside: {
    label: 'Aside browser',
    hint: 'Requires the Aside app + CLI (aside.com → Developer settings). Gives the card a logged-in browser it can drive.',
    spec: { command: 'aside', args: ['mcp'] }
  },
  'ego-lite': {
    label: 'ego lite browser',
    hint: 'Requires ego lite (citrolabs/ego-lite). The ego-browser CLI must be on PATH; this runs its MCP mode if available.',
    spec: { command: 'ego-browser', args: ['mcp'] }
  },
  playwright: {
    label: 'Playwright MCP',
    hint: 'Microsoft Playwright MCP (needs Node). Drives a separate Chromium profile; add --extension to attach to your Chrome/Edge tabs.',
    spec: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
  }
}

export interface WorktreeInfo {
  path: string
  branch: string
}

/** Data carried by every canvas node (serialised into the workspace file). */
export interface NodeData {
  kind: NodeKind
  /** claude (default) | codex | gemini | grok — for claude/conductor cards */
  engine?: AgentEngine
  title: string
  /** Working directory the shell/claude is started in. */
  cwd: string
  /** Shell executable for terminal nodes; undefined = platform default. */
  shell?: string
  /** A command to type into the shell right after spawn (terminal nodes). */
  initialCommand?: string
  claude?: ClaudeOptions
  worktree?: WorktreeInfo
  /** Markdown body for note nodes. */
  note?: string
  /** Browser cards: last/home URL. */
  url?: string
  /**
   * Command cards: shell command run for every prompt the card receives (send_prompt / handoff lines).
   * Placeholders: {{prompt}} (shell-quoted, single line), {{prompt_file}} (path to a temp file holding the full prompt).
   * The command's output until it exits becomes the card's "reply", so outgoing lines fire when it finishes.
   */
  commandTemplate?: string
  /** Sent once to the card's Claude session as soon as it is ready, then cleared. */
  initialPrompt?: string
  /** Specialist role id (an agent file in .claude/agents or the agency catalog) whose body is the extra system prompt. */
  role?: string
  /** Claude Code session id once known (SessionStart hook). */
  sessionId?: string
  /** Conductor cards: the last brief (claude.ai artifact, report URL) they published; the 📄 button reopens it. */
  lastBriefUrl?: string
  /** The card that dispatched this one with create_agent. Dispatched cards are retired once their report is in; owner-made cards never are. */
  parentId?: string
  /** Owner's pin: never retired or tidied, dispatched or not. */
  keep?: boolean
  /** When the card was made; a card whose process has not started yet counts as starting, not exited, for a minute. */
  createdAt?: number
  // --- runtime-only fields (not persisted) ---
  status?: AgentStatus
  statusDetail?: string
  lastAssistantMessage?: string
  lastEventAt?: number
  /** When the last turn ended (Stop); unlike lastEventAt it does not move on idle notifications. */
  lastStopAt?: number
  /** When the process was seen exiting in this app run. */
  endedAt?: number
  ptyAlive?: boolean
  [key: string]: unknown
}

export type HandoffMode = 'auto' | 'manual'

/** Data carried by a handoff edge (A -> B). */
export interface HandoffEdgeData {
  mode: HandoffMode
  /** Prompt template; `{{last_assistant_message}}`, `{{source_title}}`, `{{source_cwd}}` are substituted. */
  template: string
  /** Optional condition: fire only if the source's last message matches (substring, or /regex/flags). */
  condition?: string
  lastFiredAt?: number
  [key: string]: unknown
}

export interface WorkspaceNode {
  id: string
  position: { x: number; y: number }
  width?: number
  height?: number
  data: NodeData
}

export interface WorkspaceEdge {
  id: string
  source: string
  target: string
  data: HandoffEdgeData
}

export interface Workspace {
  version: 1
  projectRoot: string
  viewport?: { x: number; y: number; zoom: number }
  nodes: WorkspaceNode[]
  edges: WorkspaceEdge[]
  /** The task ledger (main owns it; the renderer never writes these two). */
  tasks?: Task[]
  nextTaskId?: number
}

/** Subset of a Claude Code hook payload that we care about. */
export interface HookEvent {
  hook_event_name: string
  session_id?: string
  cwd?: string
  transcript_path?: string
  tool_name?: string
  tool_input?: unknown
  /** Notification hook: permission_prompt | idle_prompt | agent_needs_input | ... */
  notification_type?: string
  message?: string
  /** Stop hook */
  last_assistant_message?: string
  /** SessionStart */
  source?: string
  /** Set when the hook fires inside a subagent (absent for the main agent) */
  agent_id?: string
  [key: string]: unknown
}

/** Snapshot of one agent as seen by the roster / MCP server. */
export interface AgentSnapshot {
  id: string
  kind: NodeKind
  engine?: AgentEngine
  title: string
  cwd: string
  status: AgentStatus
  statusDetail?: string
  sessionId?: string
  lastAssistantMessage?: string
  lastEventAt?: number
  ptyAlive: boolean
  parentId?: string
  keep?: boolean
  lastStopAt?: number
  endedAt?: number
}

export interface AppSettings {
  notifications: boolean
  minimizeToTray: boolean
  trackExternalSessions: boolean
  defaultShell?: string
  /** Home page for new browser cards. */
  browserHome?: string
  /** Optional GitHub token (stored encrypted) for update downloads from a private fork. */
  githubTokenEnc?: string
  /** Legacy (≤ 0.3): idle threshold for auto-tidy; now only the fallback for dispatched cards that never report. */
  autoTidyMinutes?: number
  /** Dispatched cards are retired this many minutes after their report reached the card that made them (default 5; 0 = never automatically). */
  retireMinutes?: number
  /** Stall watchdog: a card Working with no activity, or waiting on a person, this long is reported to its Conductor (default 15; 0 = off). */
  stallMinutes?: number
  /** create_agent refuses when a card already has this many live dispatched cards (default 6). */
  maxWorkersPerLead?: number
  /** Open claude.ai links (briefs) in the system browser instead of a browser card. Default false: briefs stay on the canvas. */
  claudeLinksExternal?: boolean
  /** Engine new agent/conductor cards use when none is chosen (claude by default). */
  defaultEngine?: AgentEngine
  /** Pass an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the environment into Claude cards even when `claude` is signed in (default false: a signed-in owner's cards use the sign-in). */
  keepEnvApiKey?: boolean
  /** Pass deploy / database / cloud tokens (GITHUB_TOKEN, SUPABASE_ACCESS_TOKEN, …) and the other engines' keys from the environment into agent cards (default false: dropped). */
  passCredentialEnv?: boolean
  /** Phone companion server (Settings → Phone): off by default, one interface, Tailscale unless the home LAN is allowed. */
  phone?: { enabled: boolean; host?: string; port: number; allowLan: boolean }
  /** The first-run guide (? in the toolbar) was shown once; it opens by itself only while this is unset. */
  tourSeen?: boolean
  /** Whose finished turns are announced: off | conductor (default) | all agent cards. */
  announce?: 'off' | 'conductor' | 'all'
  /** Which finished turns: important (default: a decision or a report for the owner) | every (any turn of 10 s or more). */
  announceMode?: 'important' | 'every'
  /** Desktop toast with the first line of the reply (default on). */
  announceToast?: boolean
  /** Speak the announcement with a Windows voice (default on). */
  announceVoice?: boolean
  /** Voice engine for spoken announcements: windows (default, offline) | gemini | openai | elevenlabs. */
  ttsEngine?: 'windows' | 'gemini' | 'openai' | 'elevenlabs'
  /** Voice name / id for the chosen engine (empty = the engine's default). */
  ttsVoice?: string
  /** Delivery hint for engines that take one (Gemini style, OpenAI instructions). */
  ttsStyle?: string
  /** Per-engine API keys, stored encrypted (same scheme as githubTokenEnc). */
  ttsKeysEnc?: Partial<Record<'gemini' | 'openai' | 'elevenlabs', string>>
  /** Publish the morning report of every autonomous run to the Notion database below (default off). */
  notionPublish?: boolean
  /** Notion internal-integration token, stored encrypted (same scheme as githubTokenEnc). */
  notionTokenEnc?: string
  /** The Reports database (dashed id; the Settings field also takes its URL). */
  notionDatabaseId?: string
  /** The Tasks database the ledger is mirrored into (empty: tasks are not synced). */
  notionTasksDatabaseId?: string
  /** The Updates database a release-notes page goes into on the first start of each version (empty: none). */
  notionUpdatesDatabaseId?: string
  /** The version whose release notes were last published, so each goes up once. */
  notionLastUpdate?: string
  /** Voice input for the left composer (see shared/voice.ts; read through voiceSettings()). */
  voice?: Partial<VoiceSettings>
}

export const DEFAULT_SETTINGS: AppSettings = {
  notifications: true,
  minimizeToTray: true,
  trackExternalSessions: false
}
