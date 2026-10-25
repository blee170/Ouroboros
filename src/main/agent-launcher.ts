/**
 * Launch recipes for the non-Claude engines a card can run.
 *
 * Codex CLI:   lifecycle via the legacy `notify` command (JSON as last argv, fires on turn completion),
 *              MCP + instructions via `-c key=value` overrides (value parsed as TOML; highest precedence).
 * Gemini CLI:  lifecycle via `hooks` and the board MCP via `mcpServers`, both written to a per-card
 *              settings file pointed at by GEMINI_CLI_SYSTEM_SETTINGS_PATH (merged with the user's own:
 *              hook arrays concat, mcpServers shallow-merge); role prompt via `-i` (first message).
 */
import type { ClaudeOptions } from '@shared/types'
import type { ShellKind } from './pty-manager'
import { quoteArg } from './claude-launcher'

/** First line of a role prompt typed as a message (so a relaunch can recognise and replace it). */
export const ROLE_PROMPT_PREFIX = 'Role instructions for this session'

export interface EngineLaunchInput {
  nodeId: string
  claude: ClaudeOptions
  /** text that should act as the card's system/role prompt (may be long) */
  rolePrompt?: string
  boardTools: boolean
  baseUrl: string
  /** file holding the card's hook token (the hook helper reads it; it never goes on a command line) */
  tokenFile: string
  /** file holding the card's API token, for the board MCP server (board tools only) */
  apiTokenFile?: string
  nodeBin: string
  /** nodeBin is the app binary: helper processes need ELECTRON_RUN_AS_NODE=1 in *their* env */
  electronAsNode?: boolean
  hookScriptPath: string
  mcpScriptPath: string
  shell: ShellKind
}

export interface EngineLaunch {
  command: string
  env?: Record<string, string>
  /** role text that could not go on the command line; typed as the first prompt instead */
  initialPrompt?: string
  /** files to write before launching: path → contents */
  files?: Record<string, string>
}

/** TOML basic string (JSON string syntax is a valid TOML basic string). */
export function tomlString(s: string): string {
  return JSON.stringify(s)
}

/** Quote one argument for the Windows C runtime (what a native exe sees after cmd.exe / `--%`). */
export function quoteWinCrt(arg: string): string {
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

const BARE_TOKEN = /^[A-Za-z0-9_./:\\=-]+$/

/**
 * Quote one argument for the launch line. `crt` = the native program parses it with Windows C-runtime
 * rules (Codex `-c` values after PowerShell's `--%`, or any Windows command); otherwise the shell's own.
 */
function quoteFor(arg: string, shell: ShellKind, crt: boolean): string {
  if (BARE_TOKEN.test(arg)) return arg
  if (shell === 'posix') return quoteArg(arg, 'posix')
  return crt ? quoteWinCrt(arg) : quoteArg(arg, shell)
}

/** Whole-line budget: cmd.exe stops at 8191 chars, PowerShell at 32767, posix far above. */
const MAX_COMMAND_LINE = { cmd: 7500, powershell: 30000, posix: 100000 } as const

export function roleAsMessage(role: string): string {
  return `${ROLE_PROMPT_PREFIX} (follow them for every reply, then answer "ready"):\n\n${role}`
}

export function buildCodexLaunch(input: EngineLaunchInput): EngineLaunch {
  const { claude, shell } = input
  const overrides: string[] = []
  overrides.push(`notify=${JSON.stringify([input.nodeBin, input.hookScriptPath, 'codex', '--url', input.baseUrl, '--node', input.nodeId, '--token-file', input.tokenFile])}`)
  if (input.boardTools) {
    overrides.push(`mcp_servers.ouroboros.command=${tomlString(input.nodeBin)}`)
    overrides.push(`mcp_servers.ouroboros.args=${JSON.stringify([input.mcpScriptPath])}`)
    overrides.push(`mcp_servers.ouroboros.env={OUROBOROS_URL=${tomlString(input.baseUrl)},OUROBOROS_TOKEN_FILE=${tomlString(input.apiTokenFile ?? '')},OUROBOROS_SELF_ID=${tomlString(input.nodeId)}}`)
  }
  const role = input.rolePrompt?.trim()
  // Inline instructions are only safe where the shell quotes them exactly (posix single quotes).
  // cmd.exe re-parses \" as quote toggles and `--%` expands %VAR% through the npm shim, so on
  // Windows the role is typed as the first message instead (its reply never fires lines).
  const inlineRole = Boolean(role) && shell === 'posix'
  const build = (withRole: boolean): string[] => {
    const args: string[] = []
    for (const o of overrides) args.push('-c', o)
    if (withRole && role) args.push('-c', `developer_instructions=${tomlString(role)}`)
    return args
  }
  let args = build(inlineRole)
  if (claude.model) args.push('-m', claude.model)
  switch (claude.permissionMode) {
    case 'plan':
      args.push('-s', 'read-only')
      break
    case 'acceptEdits':
    case 'auto':
      args.push('--full-auto')
      break
    case 'bypassPermissions':
    case 'dontAsk':
      args.push('--dangerously-bypass-approvals-and-sandbox')
      break
    default:
      break
  }
  if (claude.extraArgs?.length) args.push(...claude.extraArgs)
  if (claude.resume) args.push('resume', claude.resume)
  else if (claude.continue) args.push('resume', '--last')
  const prefix = shell === 'powershell' ? '& codex --% ' : 'codex '
  const line = (a: string[]): string => (prefix + a.map((x) => quoteFor(x, shell, true)).join(' ')).trim()
  let command = line(args)
  let roleInline = inlineRole
  if (roleInline && command.length > MAX_COMMAND_LINE[shell]) {
    // the escaped line would not fit: keep everything but the role on the command line
    roleInline = false
    const tail = args.slice(build(true).length)
    args = [...build(false), ...tail]
    command = line(args)
  }
  return { command, initialPrompt: role && !roleInline ? roleAsMessage(role) : undefined }
}

export function buildGeminiSettings(input: EngineLaunchInput): Record<string, unknown> {
  const hookCommand = `${quoteFor(input.nodeBin, input.shell, true)} ${quoteFor(input.hookScriptPath, input.shell, true)} gemini`
  const asNode = input.electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const env = { OUROBOROS_URL: input.baseUrl, OUROBOROS_NODE_ID: input.nodeId, OUROBOROS_TOKEN_FILE: input.tokenFile, ...asNode }
  const hook = (name: string, matcher?: string): Record<string, unknown> => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ name: `ouroboros-${name.toLowerCase()}`, type: 'command', command: hookCommand, timeout: 5000, env }]
  })
  const settings: Record<string, unknown> = {
    hooksConfig: { enabled: true },
    hooks: {
      SessionStart: [hook('SessionStart')],
      BeforeAgent: [hook('BeforeAgent')],
      BeforeTool: [hook('BeforeTool', '*')],
      AfterAgent: [hook('AfterAgent')],
      Notification: [hook('Notification')],
      SessionEnd: [hook('SessionEnd')]
    }
  }
  const mcpServers: Record<string, unknown> = {}
  if (input.boardTools) {
    mcpServers.ouroboros = {
      command: input.nodeBin,
      args: [input.mcpScriptPath],
      env: { OUROBOROS_URL: input.baseUrl, OUROBOROS_TOKEN_FILE: input.apiTokenFile ?? '', OUROBOROS_SELF_ID: input.nodeId, ...asNode },
      trust: true
    }
  }
  for (const [name, spec] of Object.entries(input.claude.mcpServers ?? {})) mcpServers[name] = spec
  if (Object.keys(mcpServers).length) settings.mcpServers = mcpServers
  return settings
}

export function buildGeminiLaunch(input: EngineLaunchInput, settingsPath: string): EngineLaunch {
  const { claude, shell } = input
  const args: string[] = []
  if (claude.model) args.push('-m', claude.model)
  switch (claude.permissionMode) {
    case 'plan':
      args.push('--approval-mode', 'plan')
      break
    case 'acceptEdits':
      args.push('--approval-mode', 'auto_edit')
      break
    case 'auto':
    case 'bypassPermissions':
    case 'dontAsk':
      args.push('--approval-mode', 'yolo')
      break
    default:
      break
  }
  if (claude.resume) args.push('-r', claude.resume)
  else if (claude.continue) args.push('-r', 'latest')
  const role = input.rolePrompt?.trim()
  // No system-prompt flag exists and a shell line cannot carry newlines: the role becomes the first message.
  const initialPrompt = role ? roleAsMessage(role) : undefined
  if (claude.extraArgs?.length) args.push(...claude.extraArgs)
  const quoted = args.map((a) => quoteFor(a, shell, false))
  const prefix = shell === 'powershell' ? '& gemini ' : 'gemini '
  return {
    command: (prefix + quoted.join(' ')).trim(),
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath },
    initialPrompt,
    files: { [settingsPath]: JSON.stringify(buildGeminiSettings(input), null, 2) }
  }
}
