/**
 * Board file trust (RESEARCH §11 step 1): `.ouroboros.json` sits in the project folder, where any card can edit it.
 * The app remembers what it last wrote; at the next open a card whose launch-relevant fields were changed by someone
 * else (a worker giving itself board tools, bypass permissions or a startup command) is held until the owner looks.
 */
import type { NodeData } from './types'

/**
 * Fields that decide what a card runs, with which rights, and what is typed into it. Title, position, notes and
 * tasks are not among them. `handoffs` is the card's incoming handoff lines (an auto line types into the card).
 */
export const PRIVILEGE_FIELDS = [
  'kind',
  'engine',
  'shell',
  'initialCommand',
  'commandTemplate',
  'cwd',
  'worktree.path',
  'role',
  'initialPrompt',
  'sessionId',
  'parentId',
  'claude.permissionMode',
  'claude.extraArgs',
  'claude.boardTools',
  'claude.mcpServers',
  'claude.appendSystemPrompt',
  'claude.resume',
  'claude.continue',
  'claude.model',
  'claude.wsl',
  'handoffs'
] as const
export type PrivilegeField = (typeof PRIVILEGE_FIELDS)[number]

/** One card's privilege fields as JSON text (null = unset), so views compare and travel over IPC unchanged. */
export type PrivilegeView = Partial<Record<PrivilegeField, string | null>>

export interface HeldChange {
  field: PrivilegeField
  before: string | null
  after: string | null
}
export interface HeldCard {
  nodeId: string
  title: string
  /** The card was not in the board the app last wrote. */
  added: boolean
  changes: HeldChange[]
}

export interface TrustNode {
  id: string
  data: Partial<NodeData> | null | undefined
}
export interface TrustEdge {
  source: string
  target: string
  data?: { mode?: string; template?: string } | null
}

function pick(d: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), d)
}

function isUnset(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
}

/** Incoming handoff lines of `nodeId`, in a stable order. */
function incomingOf(nodeId: string, edges: readonly TrustEdge[] | undefined): unknown {
  const lines = (edges ?? [])
    .filter((e) => e && e.target === nodeId)
    .map((e) => ({ from: String(e.source), mode: e.data?.mode ?? 'auto', template: e.data?.template ?? '' }))
    .sort((a, b) => (a.from + a.mode + a.template).localeCompare(b.from + b.mode + b.template))
  return lines
}

export function privilegeView(data: Partial<NodeData> | null | undefined, nodeId?: string, edges?: readonly TrustEdge[]): PrivilegeView {
  const view: PrivilegeView = {}
  const src = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  for (const f of PRIVILEGE_FIELDS) {
    const v = f === 'handoffs' ? (nodeId === undefined ? undefined : incomingOf(nodeId, edges)) : pick(src, f)
    view[f] = isUnset(v) ? null : JSON.stringify(v)
  }
  return view
}

/** For a card the owner never saw: fields that are fine on a new card (what kind it is, where it works). */
export const BENIGN_ON_NEW: ReadonlySet<PrivilegeField> = new Set(['kind', 'engine', 'cwd', 'worktree.path', 'parentId'])

/**
 * Pure: the cards to hold. A known card is held when any privilege field differs from the trusted view; a card the app
 * never wrote is held only when it carries something that raises rights (board tools, a permission mode, extra
 * arguments, MCP servers, a role, a startup command or prompt, a session to resume, an incoming handoff line, or the
 * Conductor kind).
 */
export function diffPrivileges(trusted: Record<string, PrivilegeView>, nodes: readonly TrustNode[], edges?: readonly TrustEdge[]): HeldCard[] {
  const held: HeldCard[] = []
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') continue
    const data = n.data && typeof n.data === 'object' ? n.data : {}
    const now = privilegeView(data, n.id, edges)
    const before = Object.prototype.hasOwnProperty.call(trusted, n.id) ? trusted[n.id] : undefined
    const changes: HeldChange[] = []
    for (const f of PRIVILEGE_FIELDS) {
      const was = before ? (before[f] ?? null) : null
      const is = now[f] ?? null
      if (was === is) continue
      if (!before && BENIGN_ON_NEW.has(f) && !(f === 'kind' && data.kind === 'conductor')) continue
      changes.push({ field: f, before: was, after: is })
    }
    if (changes.length) held.push({ nodeId: n.id, title: String(data.title ?? n.id).slice(0, 120), added: !before, changes })
  }
  return held
}

/**
 * Pure: node data with the trusted values put back (the owner chose Revert). Handoff lines are not node data: the
 * caller drops the untrusted incoming lines. A card the app never wrote has no trusted values: the caller removes it.
 */
export function revertPrivileges<T extends Partial<NodeData>>(data: T, trusted: PrivilegeView): T {
  const out = { ...data, claude: data.claude ? { ...data.claude } : undefined } as Record<string, unknown>
  for (const f of PRIVILEGE_FIELDS) {
    if (f === 'handoffs') continue
    const raw = trusted[f] ?? null
    const value = raw === null ? undefined : (JSON.parse(raw) as unknown)
    const [head, tail] = f.split('.') as [string, string | undefined]
    if (!tail) out[head] = value
    else if (head === 'worktree') {
      // a worktree is either the trusted one or none: a forged path never survives a revert
      if (value === undefined || (out.worktree as { path?: string } | undefined)?.path !== value) out.worktree = undefined
    } else {
      const obj = { ...((out[head] as Record<string, unknown> | undefined) ?? {}) }
      if (value === undefined) delete obj[tail]
      else obj[tail] = value
      out[head] = obj
    }
  }
  return out as T
}

/** Pure: which incoming handoff lines of a reverted card to keep (those in its trusted view). */
export function trustedIncoming(trusted: PrivilegeView): Array<{ from: string; mode: string; template: string }> {
  try {
    return trusted.handoffs ? (JSON.parse(trusted.handoffs) as Array<{ from: string; mode: string; template: string }>) : []
  } catch {
    return []
  }
}
