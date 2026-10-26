/**
 * Launch recipes for the non-Claude engines a card can run.
 *
 * Codex CLI:   lifecycle via the legacy `notify` command (JSON as last argv, fires on turn completion),
 *              MCP + instructions via `-c key=value` overrides (value parsed as TOML; highest precedence).
 * Gemini CLI:  lifecycle via `hooks` and the board MCP via `mcpServers`, both written to a per-card
 *              settings file pointed at by GEMINI_CLI_SYSTEM_SETTINGS_PATH (merged with the user's own:
 *              hook arrays concat, mcpServers shallow-merge); role prompt via `-i` (first message).
 * Grok Build:  lifecycle hooks and the board MCP from a per-card plugin folder passed with `--plugin-dir`;
 *              role prompt via `--rules` (posix) or as the first message.
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
  /** file holding the token the card's MCP server sends: its API token with board tools, else its mail token */
  mcpTokenFile: string
  nodeBin: string
  /** nodeBin is the app binary: helper processes need ELECTRON_RUN_AS_NODE=1 in *their* env */
  electronAsNode?: boolean
  hookScriptPath: string
  mcpScriptPath: string
  shell: ShellKind
  /** launched during an autonomous run: Codex gets its sandbox forced (see buildCodexLaunch) */
  autonomous?: boolean
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
  // every card gets the board MCP server: the full tool set with board tools, otherwise the mail tools only
  overrides.push(`mcp_servers.ouroboros.command=${tomlString(input.nodeBin)}`)
  overrides.push(`mcp_servers.ouroboros.args=${JSON.stringify([input.mcpScriptPath])}`)
  const tools = input.boardTools ? '' : `,OUROBOROS_TOOLS=${tomlString('mail')}`
  overrides.push(`mcp_servers.ouroboros.env={OUROBOROS_URL=${tomlString(input.baseUrl)},OUROBOROS_TOKEN_FILE=${tomlString(input.mcpTokenFile)},OUROBOROS_SELF_ID=${tomlString(input.nodeId)}${tools}}`)
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
  if (input.autonomous) {
    // Autonomous run (Type 1 (d)): the sandbox is the rail. workspace-write keeps .git read-only and the network off;
    // the overrides beat a config.toml that opened either, and nothing the card or its options add can widen it.
    if (claude.permissionMode === 'plan') args.push('-s', 'read-only', '-a', 'never')
    else args.push('-s', 'workspace-write', '-a', 'never', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]')
  } else switch (claude.permissionMode) {
    case 'plan':
      args.push('-s', 'read-only')
      break
    case 'acceptEdits':
    case 'auto':
      // the documented Auto preset (current docs no longer list --full-auto)
      args.push('-s', 'workspace-write', '-a', 'on-request')
      break
    case 'bypassPermissions':
    case 'dontAsk':
      args.push('--dangerously-bypass-approvals-and-sandbox')
      break
    default:
      break
  }
  if (claude.extraArgs?.length && !input.autonomous) args.push(...claude.extraArgs)
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
  mcpServers.ouroboros = {
    command: input.nodeBin,
    args: [input.mcpScriptPath],
    env: { OUROBOROS_URL: input.baseUrl, OUROBOROS_TOKEN_FILE: input.mcpTokenFile, OUROBOROS_SELF_ID: input.nodeId, ...(input.boardTools ? {} : { OUROBOROS_TOOLS: 'mail' }), ...asNode },
    trust: true
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

/** Per-card plugin folder for Grok Build: name → contents (relative paths). */
export function buildGrokPlugin(input: EngineLaunchInput): Record<string, string> {
  // Which shell Grok runs a hook command in is not documented. A line whose first word is unquoted reads the same in
  // sh, cmd.exe and PowerShell (a leading quote is a string in PowerShell, and cmd /c strips the outer quotes of a line
  // that starts with one); later words are double-quoted only when they need it, with forward slashes.
  const fwd = (p: string): string => p.split(String.fromCharCode(92)).join('/')
  const plain = (p: string): boolean => /^[A-Za-z0-9_./:-]+$/.test(fwd(p))
  const arg = (p: string): string => (plain(p) ? fwd(p) : `"${fwd(p)}"`)
  // a node path with a space (C:/Program Files/nodejs) goes by name: the card's PATH is the app's, where node is found
  const node = plain(input.nodeBin) ? fwd(input.nodeBin) : 'node'
  const hookCommand = `${node} ${arg(input.hookScriptPath)} grok --url ${input.baseUrl} --node ${input.nodeId} --token-file ${arg(input.tokenFile)}`
  // seconds: node start-up + reading stdin + the POST (3 s timeout) can pass Grok's 5 s default
  const handler = { type: 'command', command: hookCommand, timeout: 10 }
  const hooks: Record<string, unknown[]> = {}
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']) hooks[ev] = [{ hooks: [handler] }]
  const mcpServers: Record<string, unknown> = {
    ouroboros: {
      command: input.nodeBin,
      args: [input.mcpScriptPath],
      env: { OUROBOROS_URL: input.baseUrl, OUROBOROS_TOKEN_FILE: input.mcpTokenFile, OUROBOROS_SELF_ID: input.nodeId, ...(input.boardTools ? {} : { OUROBOROS_TOOLS: 'mail' }) }
    }
  }
  for (const [name, spec] of Object.entries(input.claude.mcpServers ?? {})) mcpServers[name] = spec
  const manifest = JSON.stringify({ name: 'ouroboros-card', version: '1.0.0', description: 'Ouroboros card lifecycle hooks and board tools' }, null, 2)
  // Grok reads both its own and Claude Code's plugin layout; both manifests point at the same hooks and MCP files
  return {
    '.grok-plugin/plugin.json': manifest,
    '.claude-plugin/plugin.json': manifest,
    'hooks/hooks.json': JSON.stringify({ hooks }, null, 2),
    '.mcp.json': JSON.stringify({ mcpServers }, null, 2)
  }
}

/**
 * Grok Build: lifecycle hooks and the board MCP from a per-card plugin folder (`--plugin-dir`), so ~/.grok stays
 * untouched; the role prompt goes in with `--rules` where the shell can carry it, else as the first message.
 */
export function buildGrokLaunch(input: EngineLaunchInput, pluginDir: string): EngineLaunch {
  const { claude, shell } = input
  const args: string[] = ['--plugin-dir', pluginDir]
  if (claude.model) args.push('-m', claude.model)
  switch (claude.permissionMode) {
    case 'auto':
    case 'bypassPermissions':
    case 'dontAsk':
      args.push('--always-approve')
      break
    default:
      break
  }
  if (claude.resume) args.push('-r', claude.resume)
  else if (claude.continue) args.push('-c')
  if (claude.extraArgs?.length) args.push(...claude.extraArgs)
  const role = input.rolePrompt?.trim()
  // same rule as Codex: only posix single quotes carry a long multi-line role exactly
  const inlineRole = Boolean(role) && shell === 'posix'
  const prefix = shell === 'powershell' ? '& grok ' : 'grok '
  const line = (a: string[]): string => (prefix + a.map((x) => quoteFor(x, shell, false)).join(' ')).trim()
  let command = line(inlineRole && role ? [...args, '--rules', role] : args)
  let roleInline = inlineRole
  if (roleInline && command.length > MAX_COMMAND_LINE[shell]) {
    roleInline = false
    command = line(args)
  }
  const files: Record<string, string> = {}
  for (const [rel, text] of Object.entries(buildGrokPlugin(input))) files[`${pluginDir}/${rel}`] = text
  return { command, initialPrompt: role && !roleInline ? roleAsMessage(role) : undefined, files }
}
