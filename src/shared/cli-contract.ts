/**
 * What Ouroboros assumes about each agent CLI, in one table: the flags its launchers pass, and the strings (hook
 * names, payload fields, environment names, screen text) its hooks and detectors read. `npm run compat` checks the
 * table against the CLIs installed on this machine (scripts/cli-compat.mjs); tests/cli-contract.test.ts checks that
 * the launchers emit no flag and register no hook event the table leaves out.
 *
 * No imports: the script loads this file with Node's own type stripping, without the build's path aliases.
 */

export interface CliCheck {
  /** a flag, or a string to find in the installed CLI */
  text: string
  /** where Ouroboros relies on it */
  why: string
  /** a flag documented in another help screen than `<bin> --help` (Codex `resume --last`) */
  helpArgs?: string[]
}

export interface CliContract {
  engine: 'claude' | 'codex' | 'gemini' | 'grok'
  bin: string
  /** npm package to search when `bin` is an npm shim rather than a native binary */
  npmPackage?: string
  /** flags: found in `--help` = ok; only in the installed files = hidden (works today, may go without notice) */
  flags: CliCheck[]
  /** strings that must still be in the installed files */
  strings: CliCheck[]
}

/** The lifecycle hooks a Claude card registers (buildHookSettings); the live probe registers the same ones. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd'
] as const

/**
 * Hook payload keys Ouroboros reads, per event, that a plain `claude -p` turn with one Read call sends (live probe).
 * Not SessionStart: Claude Code never sends it to http hooks (2.1.316 still does not), which is why a card's readiness
 * comes from its inbox registration; the probe reports it as news if it ever arrives.
 */
export const CLAUDE_PAYLOAD_KEYS: Record<string, string[]> = {
  UserPromptSubmit: ['hook_event_name', 'session_id', 'transcript_path', 'cwd'],
  PreToolUse: ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'tool_name', 'tool_input'],
  PostToolUse: ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'tool_name', 'tool_input'],
  Stop: ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'last_assistant_message'],
  SessionEnd: ['hook_event_name', 'session_id', 'transcript_path', 'cwd', 'reason']
}

const hook = (name: string): CliCheck => ({ text: name, why: 'hook event (claude-launcher HOOK_EVENTS, status.ts reduceHook)' })

export const CLI_CONTRACTS: CliContract[] = [
  {
    engine: 'claude',
    bin: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    flags: [
      { text: '--settings', why: 'card hooks, status line and deny rules (buildClaudeCommand)' },
      { text: '--continue', why: 'Continue a card' },
      { text: '--resume', why: 'Resume a session' },
      { text: '--model', why: 'card model' },
      { text: '--effort', why: 'card effort level' },
      { text: '--permission-mode', why: 'card permission mode' },
      { text: '--mcp-config', why: 'board MCP server' },
      { text: '--append-system-prompt-file', why: 'role and Conductor prompt' },
      { text: '--system-prompt-snapshot', why: 'role text on resumed sessions' },
      { text: '--name', why: 'session display name' },
      { text: '--setting-sources', why: 'live compat probe keeps user hooks out' },
      { text: '--no-session-persistence', why: 'live compat probe leaves no session in the history' }
    ],
    strings: [
      ...CLAUDE_HOOK_EVENTS.map(hook),
      { text: 'allowedEnvVars', why: 'http hook header reads the card token from the environment' },
      { text: 'last_assistant_message', why: 'Stop payload: the card reply that lines forward' },
      { text: 'notification_type', why: 'Notification payload (status.ts)' },
      { text: 'permission_prompt', why: 'notification type: card needs you' },
      { text: 'idle_prompt', why: 'notification type: idle reminder' },
      { text: 'elicitation_dialog', why: 'notification type: card needs you' },
      { text: 'agent_needs_input', why: 'notification type: card needs you' },
      { text: 'permissionDecision', why: 'action gate answer (agent-hook.ts)' },
      { text: 'used_percentage', why: 'status line plan windows (shared/usage.ts)' },
      { text: 'five_hour', why: 'status line plan windows (shared/usage.ts)' },
      { text: 'CLAUDE_CODE_MESSAGING_SOCKET', why: 'card inbox (mcp-server.ts, claude-inbox.ts)' },
      { text: 'CLAUDE_CODE_MESSAGING_TOKEN', why: 'card inbox auth frame' },
      { text: 'cc-msg-', why: 'inbox pipe name (claude-inbox.ts validInbox)' },
      { text: 'Quick safety check', why: 'trust question (status.ts detectTrustQuestion)' },
      { text: 'Yes, I trust this folder', why: 'trust question and its needs-you hint (ipc.ts)' },
      { text: '? for shortcuts', why: 'ready banner (status.ts detectClaudeReady)' },
      { text: 'Claude Code v', why: 'ready banner (status.ts detectClaudeReady)' },
      { text: 'What should Claude do instead?', why: 'interrupt line (doing.ts showsInterrupt)' },
      { text: '[Image #', why: 'pasted image chip (ipc.ts ptyPasteImage)' }
    ]
  },
  {
    engine: 'codex',
    bin: 'codex',
    npmPackage: '@openai/codex',
    flags: [
      { text: '-c', why: 'notify hook, board MCP server, effort and sandbox overrides (buildCodexLaunch)' },
      { text: '-m', why: 'card model' },
      { text: '-s', why: 'sandbox mode' },
      { text: '-a', why: 'approval policy' },
      { text: '--dangerously-bypass-approvals-and-sandbox', why: 'bypass permission mode' },
      { text: 'resume', why: 'Resume / Continue a card' },
      { text: '--last', why: 'Continue a card', helpArgs: ['resume', '--help'] }
    ],
    strings: [
      { text: 'agent-turn-complete', why: 'notify payload type (agent-hook.ts mapCodexNotify)' },
      { text: 'last-assistant-message', why: 'notify payload: the card reply' },
      { text: 'thread-id', why: 'notify payload: session id' },
      { text: 'model_reasoning_effort', why: 'effort override' },
      { text: 'developer_instructions', why: 'role on posix shells' },
      { text: 'sandbox_workspace_write', why: 'autonomous sandbox overrides' }
    ]
  },
  {
    engine: 'gemini',
    bin: 'gemini',
    npmPackage: '@google/gemini-cli',
    flags: [
      { text: '-m', why: 'card model (buildGeminiLaunch)' },
      { text: '--approval-mode', why: 'permission mode' },
      { text: 'auto_edit', why: 'approval mode for accept edits' },
      { text: 'yolo', why: 'approval mode for bypass' },
      { text: 'plan', why: 'approval mode for plan' },
      { text: '-r', why: 'Resume / Continue a card' }
    ],
    strings: [
      { text: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', why: 'per-card settings file (hooks, MCP server)' },
      { text: 'SessionStart', why: 'hook event (agent-hook.ts mapGeminiHook)' },
      { text: 'BeforeAgent', why: 'hook event' },
      { text: 'BeforeTool', why: 'hook event' },
      { text: 'AfterAgent', why: 'hook event' },
      { text: 'Notification', why: 'hook event' },
      { text: 'SessionEnd', why: 'hook event' },
      { text: 'prompt_response', why: 'AfterAgent payload: the card reply' },
      { text: 'hooksConfig', why: 'settings key that turns hooks on (buildGeminiSettings)' }
    ]
  },
  {
    engine: 'grok',
    bin: 'grok',
    flags: [
      { text: '--agent', why: 'per-card agent file with hooks, MCP server and role (buildGrokLaunch)' },
      { text: '-m', why: 'card model' },
      { text: '--always-approve', why: 'bypass permission mode' },
      { text: '-r', why: 'Resume a card' },
      { text: '-c', why: 'Continue a card' }
    ],
    strings: [
      { text: 'hookEventName', why: 'hook payload (agent-hook.ts mapGrokHook)' },
      { text: 'GROK_CLAUDE_HOOKS_ENABLED', why: 'keeps ~/.claude hooks out of a card (GROK_CARD_ENV)' },
      { text: 'GROK_CLAUDE_MCPS_ENABLED', why: 'keeps ~/.claude MCP servers out of a card (GROK_CARD_ENV)' },
      { text: 'Do you trust the contents of this directory', why: 'trust question (status.ts detectTrustQuestion)' }
    ]
  }
]
