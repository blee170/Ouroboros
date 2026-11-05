/**
 * What a Claude card did, read from the hooks it already sends (no mod in the card, nothing asked of the card):
 * the file edits of its recent turns with their diffs (a replay), the files it read and wrote, and its subagents.
 * Kept in memory per card while the app runs. Hook payload shapes are Claude Code's (checked on 2.1.316):
 * `prompt_id` names the turn; a PostToolUse of Edit/Write carries `tool_response.structuredPatch`; SubagentStart
 * carries `agent_id` + `agent_type`; Stop carries `background_tasks`.
 */
import type { HookEvent } from './types'

export const ACTIVITY_LIMITS = { turns: 5, editsPerTurn: 200, linesPerEdit: 400, linesPerTurn: 4000, lineLength: 500, files: 300, subagents: 40, pending: 20, text: 200, id: 200, path: 1024 }

/** One line of a diff: context, added, removed, or a hunk header. */
export interface DiffLine {
  op: ' ' | '+' | '-' | '@'
  text: string
}

export interface TurnEdit {
  at: number
  /** Edit | Write | MultiEdit | NotebookEdit */
  tool: string
  /** the path as the tool was given it (absolute) */
  path: string
  kind: 'create' | 'update'
  added: number
  removed: number
  lines: DiffLine[]
  /** the diff was longer than what is kept */
  truncated?: boolean
  /** made by a subagent of the card */
  agentId?: string
}

/** The edits of one turn (one prompt), oldest first. */
export interface EditTurn {
  id: string
  startedAt: number
  edits: TurnEdit[]
  /** edits past the cap, counted only */
  dropped?: number
}

export interface TouchedFile {
  path: string
  reads: number
  writes: number
  lastAt: number
}

export interface SubagentRun {
  id: string
  type: string
  description?: string
  startedAt: number
  endedAt?: number
  /** the first words of its report */
  result?: string
  /** ended without its own SubagentStop (a turn end that did not list it, a session end): a late stop corrects it */
  assumed?: boolean
}

export interface CardActivity {
  /** turns that edited files, oldest first (the last one is "the last turn's edits") */
  turns: EditTurn[]
  /** most recently touched first */
  files: TouchedFile[]
  /** oldest first */
  subagents: SubagentRun[]
  /** Agent tool calls announced and not yet matched to a SubagentStart */
  pending: Array<{ type: string; description: string }>
  /** counts prompts, for a turn id when the payload has no prompt_id */
  turnSeq: number
}

/** What the board shows without asking: the running subagents and how much there is to look at. */
export interface ActivitySummary {
  nodeId: string
  running: SubagentRun[]
  /** edits in the last turn that edited files */
  edits: number
  files: number
  /** goes up with every change: the Inspector reads the full record again */
  rev: number
}

export function emptyActivity(): CardActivity {
  return { turns: [], files: [], subagents: [], pending: [], turnSeq: 0 }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
// control characters (tabs kept), bidi marks and overrides, zero-width characters
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
// an id or a type name: a hook body is the card's own to write, so nothing of it is kept at the length it was sent
const ident = (v: unknown): string => text(v).slice(0, ACTIVITY_LIMITS.id)
const oneLine = (s: string): string => {
  const t = s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  return t.length > ACTIVITY_LIMITS.text ? `${t.slice(0, ACTIVITY_LIMITS.text - 1)}…` : t
}
const diffLine = (op: DiffLine['op'], s: string): DiffLine => {
  const t = s.replace(UNSAFE, ' ')
  return { op, text: t.length > ACTIVITY_LIMITS.lineLength ? `${t.slice(0, ACTIVITY_LIMITS.lineLength - 1)}…` : t }
}
const splitLines = (s: string): string[] => {
  const lines = s.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Pure: the diff of one file edit, from the tool's own patch when it sent one, else from what the tool was asked. */
export function editDiff(tool: string, input: Record<string, unknown>, response: Record<string, unknown>): Pick<TurnEdit, 'kind' | 'added' | 'removed' | 'lines' | 'truncated'> {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let truncated = false
  const push = (op: DiffLine['op'], s: string): void => {
    if (op === '+') added++
    else if (op === '-') removed++
    if (lines.length < ACTIVITY_LIMITS.linesPerEdit) lines.push(diffLine(op, s))
    else truncated = true
  }
  const patch = Array.isArray(response.structuredPatch) ? response.structuredPatch : []
  for (const h of patch) {
    const hunk = obj(h)
    if (!Array.isArray(hunk.lines)) continue
    push('@', `@@ -${Number(hunk.oldStart) || 0},${Number(hunk.oldLines) || 0} +${Number(hunk.newStart) || 0},${Number(hunk.newLines) || 0} @@`)
    for (const l of hunk.lines) {
      if (typeof l !== 'string') continue
      const op = l[0] === '+' || l[0] === '-' ? l[0] : ' '
      push(op, l.slice(1))
    }
  }
  let kind: TurnEdit['kind'] = response.type === 'create' ? 'create' : 'update'
  // a Write that left the file as it was answers "update" with an empty patch: no lines, not the whole file as added
  const unchanged = tool === 'Write' && response.type === 'update' && Array.isArray(response.structuredPatch)
  if (lines.length === 0 && !unchanged) {
    // no patch: a new file (Write sends none for it), or a payload without tool_response
    const pairs: Array<[string, string]> = []
    if (Array.isArray(input.edits)) for (const e of input.edits) pairs.push([text(obj(e).old_string), text(obj(e).new_string)])
    else if (tool === 'Edit') pairs.push([text(input.old_string), text(input.new_string)])
    else {
      pairs.push(['', text(input.content) || text(input.new_source)])
      if (response.type !== 'update' && tool === 'Write') kind = 'create'
    }
    for (const [before, after] of pairs) {
      if (before) for (const l of splitLines(before)) push('-', l)
      if (after) for (const l of splitLines(after)) push('+', l)
    }
  }
  return { kind, added, removed, lines, ...(truncated ? { truncated } : {}) }
}

function touch(a: CardActivity, path: string, write: boolean, now: number): void {
  const i = a.files.findIndex((f) => f.path === path)
  const f = i >= 0 ? a.files.splice(i, 1)[0] : { path, reads: 0, writes: 0, lastAt: now }
  if (write) f.writes++
  else f.reads++
  f.lastAt = now
  a.files.unshift(f)
  if (a.files.length > ACTIVITY_LIMITS.files) a.files.length = ACTIVITY_LIMITS.files
}

function endSubagent(run: SubagentRun, now: number, result?: string, assumed = false): void {
  run.endedAt = now
  if (result) run.result = oneLine(result)
  if (assumed) run.assumed = true
  else delete run.assumed
}

/** Every subagent still marked running ends now (the card's process exited, its session ended). True when one did. */
export function endRunningSubagents(a: CardActivity, now: number): boolean {
  let changed = false
  for (const r of a.subagents) {
    if (r.endedAt !== undefined) continue
    endSubagent(r, now, undefined, true)
    changed = true
  }
  a.pending = []
  return changed
}

/**
 * Record one hook event of a Claude card into its activity (changed in place). Returns true when something the
 * board shows changed. `now` is the time the event arrived.
 */
export function recordActivity(a: CardActivity, event: HookEvent, now: number): boolean {
  const name = event.hook_event_name
  const tool = text(event.tool_name)
  const input = obj(event.tool_input)
  const agentId = ident(event.agent_id) || undefined
  switch (name) {
    case 'UserPromptSubmit':
      a.turnSeq++
      return false
    case 'PreToolUse':
      if (!AGENT_TOOLS.has(tool)) return false
      a.pending.push({ type: ident(input.subagent_type), description: oneLine(text(input.description)) })
      if (a.pending.length > ACTIVITY_LIMITS.pending) a.pending.shift()
      return false
    case 'PostToolUseFailure': {
      if (!AGENT_TOOLS.has(tool)) return false
      // the launch failed: its announcement must not name a later subagent
      const d = oneLine(text(input.description))
      const i = a.pending.findIndex((p) => p.description === d)
      if (i >= 0) a.pending.splice(i, 1)
      return false
    }
    case 'PostToolUse': {
      if (AGENT_TOOLS.has(tool)) {
        // the tool's answer names the subagent it started: the description is certain here
        const res = obj(event.tool_response)
        const run = a.subagents.find((r) => r.id === ident(res.agentId))
        const d = oneLine(text(res.description) || text(input.description))
        if (!run || !d || run.description === d) return false
        run.description = d
        return true
      }
      const path = text(input.file_path) || text(input.notebook_path)
      // no real path is that long: such an event is not recorded at all
      if (!path || path.length > ACTIVITY_LIMITS.path) return false
      if (tool === 'Read') {
        touch(a, path, false, now)
        return true
      }
      if (!EDIT_TOOLS.has(tool)) return false
      touch(a, path, true, now)
      const id = ident(event.prompt_id) || `t${a.turnSeq}`
      let turn = a.turns.find((t) => t.id === id)
      if (!turn) {
        turn = { id, startedAt: now, edits: [] }
        a.turns.push(turn)
        if (a.turns.length > ACTIVITY_LIMITS.turns) a.turns.shift()
      }
      if (turn.edits.length >= ACTIVITY_LIMITS.editsPerTurn) turn.dropped = (turn.dropped ?? 0) + 1
      else {
        const diff = editDiff(tool, input, obj(event.tool_response))
        // a long turn keeps every edit's counts but not every line
        const room = Math.max(0, ACTIVITY_LIMITS.linesPerTurn - turn.edits.reduce((n, e) => n + e.lines.length, 0))
        if (diff.lines.length > room) {
          diff.lines = diff.lines.slice(0, room)
          diff.truncated = true
        }
        turn.edits.push({ at: now, tool, path, ...diff, ...(agentId ? { agentId } : {}) })
      }
      return true
    }
    case 'SubagentStart': {
      if (!agentId || a.subagents.some((r) => r.id === agentId)) return false
      const type = ident(event.agent_type)
      // the Agent call that announced it: the oldest one of this type (calls made together start in order), else the
      // oldest call that named no type (it starts the default one)
      let i = a.pending.findIndex((p) => p.type === type)
      if (i < 0) i = a.pending.findIndex((p) => !p.type)
      if (i < 0 && !type) i = a.pending.length ? 0 : -1
      const description = i >= 0 ? a.pending.splice(i, 1)[0].description : ''
      a.subagents.push({ id: agentId, type: type || 'subagent', ...(description ? { description } : {}), startedAt: now })
      // past the cap the oldest finished one goes, and the oldest of all when every one still runs: the list never grows
      while (a.subagents.length > ACTIVITY_LIMITS.subagents) {
        const old = a.subagents.findIndex((r) => r.endedAt !== undefined)
        a.subagents.splice(Math.max(0, old), 1)
      }
      return true
    }
    case 'SubagentStop': {
      const run = a.subagents.find((r) => r.id === agentId)
      // an end that was only assumed is corrected by the real one: its time and its report
      if (!run || (run.endedAt !== undefined && !run.assumed)) return false
      endSubagent(run, now, text(event.last_assistant_message))
      return true
    }
    case 'Stop': {
      // the turn's end lists what still runs in the background: a subagent we hold as running and it does not
      // list has ended without a SubagentStop reaching us (an interrupt, a crash)
      if (!Array.isArray(event.background_tasks)) return false
      const live = new Set(event.background_tasks.filter((t) => !text(obj(t).status) || obj(t).status === 'running').map((t) => ident(obj(t).id)))
      let changed = false
      for (const r of a.subagents) {
        if (r.endedAt !== undefined || live.has(r.id)) continue
        endSubagent(r, now, undefined, true)
        changed = true
      }
      a.pending = []
      return changed
    }
    case 'SessionEnd':
      return endRunningSubagents(a, now)
    default:
      return false
  }
}

export function summarize(nodeId: string, a: CardActivity, rev: number): ActivitySummary {
  const last = a.turns[a.turns.length - 1]
  return { nodeId, running: a.subagents.filter((r) => r.endedAt === undefined), edits: last ? last.edits.length + (last.dropped ?? 0) : 0, files: a.files.length, rev }
}

/** Pure: a path as a card's row shows it: relative to the card's folder when it is inside it, with forward slashes. */
export function shownPath(path: string, cwd: string | undefined): string {
  const p = path.replace(/\\/g, '/')
  const base = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && p.length > base.length && p.slice(0, base.length).toLowerCase() === base.toLowerCase() && p[base.length] === '/') return p.slice(base.length + 1)
  return p
}

/** Pure: seconds as "42s", "3m 05s" or "1h 12m". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
