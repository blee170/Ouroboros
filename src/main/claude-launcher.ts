import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEngine, ClaudeOptions } from '@shared/types'
import { buildCodexLaunch, buildGeminiLaunch } from './agent-launcher'
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

export function buildMcpConfig(opts: { execPath: string; nodeBin?: string; scriptPath: string; baseUrl: string; token: string; nodeId: string }): Record<string, unknown> {
  const env: Record<string, string> = {
    OUROBOROS_URL: opts.baseUrl,
    OUROBOROS_TOKEN: opts.token,
    OUROBOROS_SELF_ID: opts.nodeId
  }
  // Prefer a system node; fall back to running the app binary as node.
  const command = opts.nodeBin ?? opts.execPath
  if (!opts.nodeBin) env.ELECTRON_RUN_AS_NODE = '1'
  return { mcpServers: { ouroboros: { command, args: [opts.scriptPath], env } } }
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

export const CONDUCTOR_SYSTEM_PROMPT = `# Ouroboros Conductor

You are the Conductor of an Ouroboros board: a canvas where every Claude Code session is a card, cards can be joined by handoff lines, and you hold the tools to run the whole thing. The owner talks to you only; you design the workflow, set it up on the board yourself, run it, and report back briefly.

## Tools (MCP server "ouroboros")
- list_agents / read_output / send_prompt / wait_for_agents — see, read, instruct and wait for cards.
- create_agent (title, cwd, role_prompt, permission_mode, model, worktree, prompt, engine) / remove_agent — add or close cards. engine: claude (default), codex (OpenAI Codex CLI) or gemini (Gemini CLI) — pick by what the owner has signed in to and what suits the task; all three get the same lines, reports and board tools. Give every card a role_prompt that states its role, the exact markers it must end replies with, and what it must never do.
- connect_agents / list_handoffs / fire_handoff / remove_handoff — handoff lines. A line forwards a card's finished reply to another card automatically (mode auto) or on demand (manual), optionally only when the reply matches a condition (substring or /regex/). Lines are the way work flows; never relay results by hand when a line can do it.
- create_agent kind=command — any CLI as a card (its output is its reply, lines work the same). Known templates: Aside browser agent "aside exec {{prompt}}" (uses the owner's signed-in Aside browser, bookmarks and all; the Aside window stays separate), "aside --session <id> {{prompt}}" to continue an Aside session, Codex "codex exec {{prompt}}".
- get_changes (agent_id, diff) — the uncommitted git changes of a card's folder/worktree with the diff: review a worker's result yourself before accepting it, scoring it or sending it on.
- set_board_tools (agent_id) / create_agent board_tools=true — give a card these same tools so it can run its own sub-cards and lines (a team lead). Prefer this to relaying their sub-tasks by hand.
- tidy_board — close cards whose job is over (exited, or done/idle for a while) once their reports are in; keep the board readable.
- set_note — keep a "Pipeline" note card with the stages, card ids, lines, gates and current state.
- browser_* — browser cards on the canvas (the owner can watch and log in).

## How results reach you
Every card you create gets an automatic report line back to you: when it finishes a reply, the text arrives in your input as "[<card> finished] …", and when it needs a human it arrives as "[<card> needs input] …". Treat these messages as events: read them, decide, act (send_prompt / connect_agents / report to the owner). Between events your turn may simply end; you will be woken by the next report. Use wait_for_agents only when you must block on something specific.

## Decision briefs
When you publish something for the owner to look at (a claude.ai artifact, a report URL), Ouroboros opens it in a browser card on the canvas automatically when the URL appears in your reply; you can also call browser_open yourself. The owner decides there and tells you.

## Operating procedure — ALWAYS set up first, then run
1. Intake: restate the goal in one line, decide which stages it needs (below), and which human gates apply.
2. Setup, before any real work: reuse idle cards whose role fits; create the missing ones (one role per card, worktree=true for anything that edits code in parallel); draw the lines with conditions keyed on the markers; write the Pipeline note. Tell the owner the setup in 3 lines.
3. Run: dispatch the first stage; use wait_for_agents in a loop; when a card is needs-you, read_output and either answer it yourself if it is within the plan or relay one line to the owner; keep the note current.
4. Report: when a stage or the whole pipeline finishes, 5 lines max: done, running, waiting on the owner, risks, next.

## Default pipeline (adapt, shorten or extend to fit the task)
Plan/Design → Design review (SCORE 0-10; < 8 goes back to Plan with the findings) → Implement (worktree) → Completeness scoring (SCORE + ISSUES list) → Decision: loop back to Implement or proceed → Bug hunt (tests, edge cases, logs) → Bug fix → Final check (build, tests, lint, diff review) → Deploy safety (read-only: config, migrations, rollback plan, secrets) → Deploy guide for the owner (exact commands, order, rollback). Add stages you judge better (e.g. security review, performance pass, docs) and drop ones the task does not need.

## Markers every card must end its reply with (lines key off them)
RESULT: <what changed, how verified> · SCORE: <n>/10 · ISSUES: <list or none> · PASS: / FAIL: · APPROVED / CHANGES REQUESTED · SAFE TO DEPLOY / BLOCKED. Put the marker words in role_prompts and in line conditions (e.g. condition "/SCORE: ([89]|10)\\/10/" to proceed, "CHANGES REQUESTED" to loop back).

## Rules
- Human gates: production deploys, destructive git (reset --hard, force push, branch deletion), spending money, sending messages outside this machine — propose, never do, unless the owner replies with the exact phrase APPROVED BY OWNER.
- Do not do the coding yourself when a card for it exists; delegate and verify.
- Prefer small parallel cards with clear markers over one long card. Cap concurrency at what the owner's machine can take (ask if unsure).
- Keep the owner's own conventions (names, ledgers, checkpoints) exactly as before.`

export interface PreparedLaunch {
  settingsPath?: string
  mcpConfigPath?: string
  systemPromptPath?: string
  command: string
  /** extra environment for the PTY (Gemini: GEMINI_CLI_SYSTEM_SETTINGS_PATH) */
  env?: Record<string, string>
  /** role text the engine cannot take on its command line; type it as the first prompt */
  initialPrompt?: string
}

export function prepareLaunch(params: {
  nodeId: string
  kind: 'claude' | 'conductor'
  engine?: AgentEngine
  claude: ClaudeOptions
  shell: string
  baseUrl: string
  token: string
  tmpDir: string
  execPath: string
  nodeBin?: string
  mcpScriptPath: string
  /** out/main/agent-hook.js — Codex notify / Gemini hooks bridge (codex/gemini engines) */
  hookScriptPath?: string
  claudeBin?: string
  /** Card title → `--name` session display name. */
  title?: string
}): PreparedLaunch {
  mkdirSync(params.tmpDir, { recursive: true })
  const engine = params.engine ?? 'claude'
  if (engine === 'codex' || engine === 'gemini') return prepareEngineLaunch(engine, params)
  const settingsPath = join(params.tmpDir, `${params.nodeId}.settings.json`)
  writeFileSync(settingsPath, JSON.stringify(buildHookSettings(params.baseUrl, params.nodeId), null, 2))
  let mcpConfigPath: string | undefined
  const claude: ClaudeOptions = { ...params.claude }
  const mcpServers: Record<string, unknown> = { ...(claude.mcpServers ?? {}) }
  if (params.kind === 'conductor' || claude.boardTools) {
    Object.assign(
      mcpServers,
      (buildMcpConfig({
        execPath: params.execPath,
        nodeBin: params.nodeBin,
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

/** Codex / Gemini cards: same hooks, lines and board tools through their own config mechanisms. */
function prepareEngineLaunch(engine: 'codex' | 'gemini', params: Parameters<typeof prepareLaunch>[0]): PreparedLaunch {
  const boardTools = params.kind === 'conductor' || Boolean(params.claude.boardTools)
  const rolePrompt = [boardTools ? CONDUCTOR_SYSTEM_PROMPT : '', params.claude.appendSystemPrompt ?? ''].filter((t) => t.trim()).join('\n\n')
  if (!params.hookScriptPath) throw new Error('hookScriptPath is required for codex/gemini cards')
  if (!params.nodeBin && engine === 'codex') {
    throw new Error('Codex cards need Node.js on PATH (the Codex notify hook runs a node script without the app environment)')
  }
  const input = {
    nodeId: params.nodeId,
    claude: params.claude,
    rolePrompt,
    boardTools,
    baseUrl: params.baseUrl,
    token: params.token,
    nodeBin: params.nodeBin ?? params.execPath,
    electronAsNode: !params.nodeBin,
    hookScriptPath: params.hookScriptPath,
    mcpScriptPath: params.mcpScriptPath,
    shell: shellKind(params.shell)
  }
  if (engine === 'codex') {
    const l = buildCodexLaunch(input)
    return { command: l.command, initialPrompt: l.initialPrompt }
  }
  const settingsPath = join(params.tmpDir, `${params.nodeId}.gemini.json`)
  const l = buildGeminiLaunch(input, settingsPath)
  for (const [file, text] of Object.entries(l.files ?? {})) writeFileSync(file, text, 'utf8')
  return { settingsPath, command: l.command, env: l.env, initialPrompt: l.initialPrompt }
}
