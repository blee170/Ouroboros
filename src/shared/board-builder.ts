import type { ClaudeOptions, NodeData, WorkspaceEdge, WorkspaceNode } from './types'
import { REPORT_TEMPLATE } from './handoff'

export type RoleKind = 'implementer' | 'tester' | 'reviewer' | 'ops'

export interface RolePreset {
  title: string
  icon: string
  prompt: string
  permissionMode?: ClaudeOptions['permissionMode']
}

export const ROLE_PRESETS: Record<RoleKind, RolePreset> = {
  implementer: {
    title: 'Implementer',
    icon: '🛠',
    permissionMode: 'acceptEdits',
    prompt:
      'Role: Implementer card on an Ouroboros board. You receive tasks from the Conductor or from a human. Work in small, reviewable commits; run the relevant tests before you report. When you finish a task, end your reply with a short RESULT: section listing changed files, how you verified, and anything left open — that text is handed to the Tester card automatically.'
  },
  tester: {
    title: 'Tester',
    icon: '🧪',
    permissionMode: 'acceptEdits',
    prompt:
      'Role: Tester card on an Ouroboros board. You receive the Implementer\'s result via handoff. Reproduce the change, write or extend tests, run the full relevant suite. Report only failures with a minimal reproduction and the suspected cause; if everything passes, reply with a line starting with PASS: followed by what you ran — that word triggers the handoff to the Reviewer.'
  },
  reviewer: {
    title: 'Reviewer',
    icon: '🔍',
    permissionMode: 'plan',
    prompt:
      'Role: Reviewer card on an Ouroboros board. Review the diff for correctness, security and consistency with CLAUDE.md. Do not edit code. Produce: (1) blocking findings with file:line, (2) nits, (3) a PR title and description ready to paste. If there are blocking findings, start your reply with CHANGES REQUESTED: so the Conductor sends them back to the Implementer.'
  },
  ops: {
    title: 'Ops',
    icon: '🚀',
    prompt:
      'Role: Ops card on an Ouroboros board. You own deploys, environment and service health (e.g. Cloudflare, Supabase, CI). Prefer read-only checks (status, logs, health endpoints) and report findings concisely. Never deploy to production, rotate secrets or run destructive commands unless the prompt contains the exact phrase APPROVED BY OWNER.'
  }
}

export const ROLE_ORDER: RoleKind[] = ['implementer', 'tester', 'reviewer', 'ops']

export interface BuildBoardInput {
  projectRoot: string
  conductor: { cwd: string; title?: string; mode: 'continue' | 'resume' | 'fresh'; sessionId?: string; initialPrompt?: string }
  roles: RoleKind[]
  /** Other folders to put on the board as Claude cards that resume their latest session. */
  extraFolders: Array<{ cwd: string; title: string; sessionId?: string }>
  /** Shared worktree/role folder; defaults to conductor.cwd */
  roleCwd?: string
  /** Specialist cards (a role from the library each): the file's body is the card's extra system prompt. */
  specialists?: Array<{ id: string; name: string; prompt: string; emoji?: string }>
  /** Add a browser card (default true). */
  browser?: boolean
  browserUrl?: string
}

export interface BuiltBoard {
  nodes: WorkspaceNode[]
  edges: WorkspaceEdge[]
}

const CARD_W = 580
const CARD_H = 400
const GAP_X = 40
const GAP_Y = 100

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function conductorPrompt(input: BuildBoardInput): string {
  const roleLines = input.roles.map((r) => `- "${ROLE_PRESETS[r].title}": ${ROLE_PRESETS[r].prompt.split('.')[0].replace(/^Role: /, '')}`)
  const extras = input.extraFolders.map((f) => `- "${f.title}": folder ${f.cwd}`)
  const specialists = (input.specialists ?? []).map((sp) => `- "${specialistTitle(sp)}": specialist card (role ${sp.id}); give it the work its title says, with the markers you expect`)
  return [
    `Board for project ${basename(input.conductor.cwd)} (${input.conductor.cwd}).`,
    'Cards available on this board (use list_agents for live ids and statuses):',
    ...roleLines,
    ...specialists,
    ...extras,
    'Routing rules: implementation work goes to the Implementer; after it reports RESULT the Tester runs automatically through a handoff line and the Reviewer follows when tests PASS. If the Reviewer says CHANGES REQUESTED, send the findings back to the Implementer with send_prompt. Ops handles deploys and health checks only. Keep your own replies to the human short: what was dispatched, what is waiting on them, what finished.'
  ].join('\n')
}

/** Specialist cards sit in rows of this many under the role row. */
const SPECIALISTS_PER_ROW = 4

export function specialistTitle(sp: { name: string; emoji?: string }): string {
  return `${sp.emoji ?? '🎭'} ${sp.name}`
}

/**
 * Pure board generator. `makeId` supplies ids so the renderer can use nanoid and tests can be deterministic.
 */
export function buildBoard(input: BuildBoardInput, makeId: () => string): BuiltBoard {
  const nodes: WorkspaceNode[] = []
  const edges: WorkspaceEdge[] = []
  const roleCwd = input.roleCwd ?? input.conductor.cwd
  const roles = ROLE_ORDER.filter((r) => input.roles.includes(r))
  const specialists = input.specialists ?? []
  const specialistRows = Math.ceil(specialists.length / SPECIALISTS_PER_ROW)
  const columns = Math.max(roles.length, input.extraFolders.length, Math.min(SPECIALISTS_PER_ROW, specialists.length), 2)
  const rowWidth = columns * CARD_W + (columns - 1) * GAP_X

  // Row 0: note + conductor
  const noteId = makeId()
  nodes.push({
    id: noteId,
    position: { x: 0, y: 0 },
    width: 420,
    height: CARD_H,
    data: {
      kind: 'note',
      title: 'How this board works',
      cwd: input.projectRoot,
      note: [
        `# ${basename(input.conductor.cwd)} board`,
        '',
        '1. Talk to **Conductor** only; it dispatches to the role cards with MCP tools. Every worker card reports back to it through a line when it finishes.',
        '2. Implementer → Tester fires automatically when the Implementer finishes a reply.',
        '3. Tester → Reviewer fires only when the Tester\'s reply contains PASS.',
        '4. Reviewer → Implementer is manual: press ▶ on the line to send review findings back.',
        '5. Ops never deploys without the phrase APPROVED BY OWNER in its prompt.',
        '6. The Browser card is a real browser: log in there once and agents can use it (browser_* tools).',
        '',
        'Edit any card\'s prompt or any line\'s template in the Inspector.'
      ].join('\n')
    }
  })
  const conductorId = makeId()
  const conductorClaude: ClaudeOptions = { appendSystemPrompt: conductorPrompt(input) }
  if (input.conductor.mode === 'continue') conductorClaude.continue = true
  if (input.conductor.mode === 'resume' && input.conductor.sessionId) conductorClaude.resume = input.conductor.sessionId
  nodes.push({
    id: conductorId,
    position: { x: 420 + GAP_X, y: 0 },
    width: Math.max(CARD_W, rowWidth - 420 - GAP_X),
    height: CARD_H,
    data: {
      kind: 'conductor',
      title: input.conductor.title ?? `Conductor · ${basename(input.conductor.cwd)}`,
      cwd: input.conductor.cwd,
      claude: conductorClaude,
      initialPrompt: input.conductor.initialPrompt?.trim() || undefined
    }
  })

  // Row 1: role cards
  const roleIds: Partial<Record<RoleKind, string>> = {}
  roles.forEach((role, i) => {
    const preset = ROLE_PRESETS[role]
    const id = makeId()
    roleIds[role] = id
    const data: NodeData = {
      kind: 'claude',
      title: `${preset.icon} ${preset.title}`,
      cwd: roleCwd,
      claude: { appendSystemPrompt: preset.prompt, permissionMode: preset.permissionMode }
    }
    nodes.push({ id, position: { x: i * (CARD_W + GAP_X), y: CARD_H + GAP_Y }, width: CARD_W, height: CARD_H, data })
  })

  // Row 1, after the roles: a browser card the agents can drive
  if (input.browser !== false) {
    nodes.push({
      id: makeId(),
      position: { x: roles.length * (CARD_W + GAP_X), y: CARD_H + GAP_Y },
      width: 640,
      height: CARD_H,
      data: { kind: 'browser', title: '🌐 Browser', cwd: input.projectRoot, url: input.browserUrl ?? 'https://www.google.com' }
    })
  }

  // Rows 2…: specialist cards, four per row, each with its role file as the system prompt
  specialists.forEach((sp, i) => {
    const data: NodeData = { kind: 'claude', title: specialistTitle(sp), cwd: roleCwd, claude: { appendSystemPrompt: sp.prompt }, role: sp.id }
    nodes.push({
      id: makeId(),
      position: { x: (i % SPECIALISTS_PER_ROW) * (CARD_W + GAP_X), y: (2 + Math.floor(i / SPECIALISTS_PER_ROW)) * (CARD_H + GAP_Y) },
      width: CARD_W,
      height: CARD_H,
      data
    })
  })

  // Last row: extra folders resuming their latest session
  input.extraFolders.forEach((f, i) => {
    const id = makeId()
    nodes.push({
      id,
      position: { x: i * (CARD_W + GAP_X), y: (2 + specialistRows) * (CARD_H + GAP_Y) },
      width: CARD_W,
      height: CARD_H,
      // resume the folder's latest session when we know one; otherwise start fresh (--continue would fail)
      data: { kind: 'claude', title: f.title, cwd: f.cwd, claude: f.sessionId ? { resume: f.sessionId } : {} }
    })
  })

  // Report lines: every worker card tells the Conductor when it finishes
  for (const n of nodes) {
    if (n.id === conductorId || n.data.kind !== 'claude') continue
    edges.push({ id: makeId(), source: n.id, target: conductorId, data: { mode: 'auto', template: REPORT_TEMPLATE } })
  }

  // Lines
  if (roleIds.implementer && roleIds.tester) {
    edges.push({
      id: makeId(),
      source: roleIds.implementer,
      target: roleIds.tester,
      data: {
        mode: 'auto',
        template: 'The Implementer ("{{source_title}}") just finished. Their report:\n\n{{last_assistant_message}}\n\nReproduce the change, write/extend tests and run the relevant suite. Report failures only; if all green, reply starting with "PASS:".'
      }
    })
  }
  if (roleIds.tester && roleIds.reviewer) {
    edges.push({
      id: makeId(),
      source: roleIds.tester,
      target: roleIds.reviewer,
      data: {
        mode: 'auto',
        condition: '/\\bPASS\\b|통과|all tests pass/i',
        template: 'Tests passed ({{source_title}} report below). Review the current diff and write the PR description.\n\n{{last_assistant_message}}'
      }
    })
  }
  if (roleIds.reviewer && roleIds.implementer) {
    edges.push({
      id: makeId(),
      source: roleIds.reviewer,
      target: roleIds.implementer,
      data: {
        mode: 'manual',
        template: 'Review findings from "{{source_title}}" — address the blocking items first, then the nits, and report with a RESULT section:\n\n{{last_assistant_message}}'
      }
    })
  }
  return { nodes, edges }
}

/** Default first instruction for a Conductor that resumes an existing orchestration session. */
export const RESUME_CONDUCTOR_PROMPT = `You have been resumed inside Ouroboros, a canvas where each Claude Code session is a card and you have MCP tools (list_agents, create_agent, send_prompt, read_output, task_create/task_claim/task_update/task_list, set_note, browser_*). Do this now, in order: (1) read your latest checkpoint/ledger and memory so you know the current lanes, their state and what the owner asked, and call task_list for what the board already tracks; (2) call list_agents; (3) for every lane that should be active, create_agent in the right folder with a self-contained prompt that restates the lane's goal, current state and next step — one card per lane, titled like the lane — and task_create / task_claim its work; (4) write a short summary with set_note into the note card; (5) reply to the owner with a 5-line status: cards created, what is running, what is waiting on them. Keep the owner's own conventions (names, ledger format, approval rules) exactly as before.`
