import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeOptions } from '@shared/types'
import { shellKind, type ShellKind } from './pty-manager'

const HOOK_EVENTS_WITH_MATCHER = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd'
]

/** Claude Code settings fragment that forwards lifecycle hooks to our local server. */
export function buildHookSettings(baseUrl: string, target: string, events: string[] = HOOK_EVENTS): Record<string, unknown> {
  const handler = { type: 'http', url: `${baseUrl}/hook/${encodeURIComponent(target)}`, timeout: 5 }
  const hooks: Record<string, unknown[]> = {}
  for (const ev of events) {
    hooks[ev] = [HOOK_EVENTS_WITH_MATCHER.includes(ev) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }]
  }
  return { hooks }
}

export function buildMcpConfig(opts: { execPath: string; scriptPath: string; baseUrl: string; token: string; nodeId: string }): Record<string, unknown> {
  return {
    mcpServers: {
      ouroboros: {
        command: opts.execPath,
        args: [opts.scriptPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          OUROBOROS_URL: opts.baseUrl,
          OUROBOROS_TOKEN: opts.token,
          OUROBOROS_SELF_ID: opts.nodeId
        }
      }
    }
  }
}

export function quoteArg(arg: string, kind: ShellKind): string {
  if (kind === 'powershell') {
    // Double-quoted PowerShell string: escape " and $ and backtick.
    return '"' + arg.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$') + '"'
  }
  if (kind === 'cmd') {
    return '"' + arg.replace(/"/g, '""') + '"'
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'"
}

/** Session display name safe for every shell: no quotes, no newlines, bounded length. */
export function safeSessionName(title: string): string {
  return title.replace(/["'`$\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

export function buildClaudeCommand(
  opts: ClaudeOptions,
  files: { settingsPath: string; mcpConfigPath?: string; systemPromptPath?: string; sessionName?: string },
  kind: ShellKind,
  claudeBin = 'claude'
): string {
  const args: string[] = [claudeBin, '--settings', files.settingsPath]
  if (opts.continue) args.push('--continue')
  if (opts.resume) args.push('--resume', opts.resume)
  if (opts.model) args.push('--model', opts.model)
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
  if (files.mcpConfigPath) args.push('--mcp-config', files.mcpConfigPath)
  if (files.systemPromptPath) {
    // The prompt itself never goes on the command line (Windows PowerShell mangles embedded quotes).
    args.push('--append-system-prompt-file', files.systemPromptPath)
    // Resumed conversations reuse their recorded system prompt; force a rebuild so the role text applies.
    if (opts.continue || opts.resume) args.push('--system-prompt-snapshot', 'off')
  }
  if (files.sessionName) args.push('--name', files.sessionName)
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  const [bin, ...rest] = args
  const quoted = rest.map((a) => (/^[A-Za-z0-9_./:\\-]+$/.test(a) ? a : quoteArg(a, kind)))
  const prefix = kind === 'powershell' ? '& ' : ''
  return `${prefix}${bin} ${quoted.join(' ')}`.trim()
}

export const CONDUCTOR_SYSTEM_PROMPT = `You are the Conductor of an Ouroboros board: a canvas of Claude Code sessions ("agents") running on this computer. You have MCP tools from the ouroboros MCP server: list_agents (every agent, its status and last message), read_output (an agent's recent terminal output), send_prompt (type a prompt into an agent), create_agent (start a new Claude Code agent in a folder), set_note (write a markdown note card). Your job: understand what the user wants, split it across the right agents, dispatch prompts, watch statuses (working / needs-you / done), relay questions an agent asks back to the user in one line, and report results briefly. Do not do the coding yourself when an agent for that folder exists; delegate. Never send destructive instructions (git reset --hard, rm -rf, force push) without the user's explicit confirmation.`

export interface PreparedLaunch {
  settingsPath: string
  mcpConfigPath?: string
  systemPromptPath?: string
  command: string
}

export function prepareLaunch(params: {
  nodeId: string
  kind: 'claude' | 'conductor'
  claude: ClaudeOptions
  shell: string
  baseUrl: string
  token: string
  tmpDir: string
  execPath: string
  mcpScriptPath: string
  claudeBin?: string
  /** Card title → `--name` session display name. */
  title?: string
}): PreparedLaunch {
  mkdirSync(params.tmpDir, { recursive: true })
  const settingsPath = join(params.tmpDir, `${params.nodeId}.settings.json`)
  writeFileSync(settingsPath, JSON.stringify(buildHookSettings(params.baseUrl, params.nodeId), null, 2))
  let mcpConfigPath: string | undefined
  const claude: ClaudeOptions = { ...params.claude }
  const mcpServers: Record<string, unknown> = { ...(claude.mcpServers ?? {}) }
  if (params.kind === 'conductor') {
    Object.assign(
      mcpServers,
      (buildMcpConfig({
        execPath: params.execPath,
        scriptPath: params.mcpScriptPath,
        baseUrl: params.baseUrl,
        token: params.token,
        nodeId: params.nodeId
      }).mcpServers as Record<string, unknown>)
    )
    claude.appendSystemPrompt = [CONDUCTOR_SYSTEM_PROMPT, claude.appendSystemPrompt].filter(Boolean).join(' ')
  }
  if (Object.keys(mcpServers).length > 0) {
    mcpConfigPath = join(params.tmpDir, `${params.nodeId}.mcp.json`)
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2))
  }
  let systemPromptPath: string | undefined
  if (claude.appendSystemPrompt && claude.appendSystemPrompt.trim()) {
    systemPromptPath = join(params.tmpDir, `${params.nodeId}.system.md`)
    writeFileSync(systemPromptPath, claude.appendSystemPrompt.trim() + '\n', 'utf8')
  }
  const sessionName = params.title ? safeSessionName(params.title) || undefined : undefined
  const command = buildClaudeCommand(claude, { settingsPath, mcpConfigPath, systemPromptPath, sessionName }, shellKind(params.shell), params.claudeBin)
  return { settingsPath, mcpConfigPath, systemPromptPath, command }
}
