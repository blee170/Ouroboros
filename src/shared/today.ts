/**
 * The "Today" tab: what needs the owner now, ranked, and what happened today. Pure: the renderer passes in its
 * store (cards, tasks, approvals, held cards) and draws the result.
 */
import type { Decision } from './decisions'
import { ownerMarker } from './announce'
import type { HeldCard } from './board-trust'
import type { Approval } from './gate'
import type { GrokHandoff } from './grokbot'
import type { Task } from './ledger'
import { failureOf } from './status'
import type { AgentStatus, NodeKind } from './types'

export interface TodayCard {
  id: string
  title: string
  kind: NodeKind
  status?: AgentStatus
  statusDetail?: string
  /** Claude cards: the conversation title and the current step (shared/doing.ts) */
  topic?: string
  doing?: string
  lastAssistantMessage?: string
  /** when its result arrived unseen (attention.unread), else undefined */
  unreadAt?: number
  workingSince?: number
}

/** Most urgent first: a gate that blocks a card, a card stopped on a prompt, then decisions, then the rest. */
export type NeedKind = 'approval' | 'handoff' | 'permission' | 'held' | 'decision' | 'failed' | 'blocked'
const RANK: Record<NeedKind, number> = { approval: 0, handoff: 1, permission: 2, held: 3, decision: 4, failed: 5, blocked: 6 }

export interface Need {
  key: string
  kind: NeedKind
  /** the card (or task) it is about */
  title: string
  /** what is asked, one line */
  text: string
  at?: number
  cardId?: string
  taskId?: string
  approvalId?: string
  /** a Grok Bot handoff waiting for Send / Discard */
  handoffId?: string
  /** a card's question (ask_owner) waiting for an answer */
  decisionId?: string
}

const APPROVAL_RE = /^\s*APPROVAL NEEDED\s*[:—–-]?\s*/i
const oneLine = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

export function needsYou(o: { cards: TodayCard[]; tasks: Task[]; approvals: Approval[]; held: HeldCard[]; handoffs?: GrokHandoff[]; decisions?: Decision[] }): Need[] {
  const out: Need[] = []
  for (const d of o.decisions ?? []) {
    if (d.state === 'pending') out.push({ key: `q:${d.id}`, kind: 'decision', title: d.title, text: oneLine(d.question).slice(0, 300), at: d.createdAt, cardId: d.card, decisionId: d.id })
  }
  for (const h of o.handoffs ?? []) {
    if (h.state !== 'pending') continue
    const text = oneLine(h.task).slice(0, 300)
    out.push({ key: `g:${h.id}`, kind: 'handoff', title: `${h.title} → Grok Bot`, text: h.error ? `${text} (last try: ${oneLine(h.error)})` : text, at: h.createdAt, cardId: h.card, handoffId: h.id })
  }
  for (const a of o.approvals) {
    if (a.state === 'pending') out.push({ key: `a:${a.id}`, kind: 'approval', title: a.title, text: oneLine(a.command), at: a.createdAt, cardId: a.card, approvalId: a.id })
  }
  // cards whose decision is already a blocked task: the same question once, as the task
  const taskDecision = new Set(o.tasks.filter((t) => t.state === 'blocked' && APPROVAL_RE.test(t.reason ?? '')).flatMap((t) => [t.owner, t.updatedBy]))
  for (const c of o.cards) {
    const failed = c.status !== 'working' ? failureOf(c.statusDetail) : undefined
    // a failure is news until the owner has looked at it (the card keeps its "failed:" detail until the next turn)
    if (failed) {
      if (c.unreadAt !== undefined) out.push({ key: `f:${c.id}`, kind: 'failed', title: c.title, text: oneLine(failed), at: c.unreadAt, cardId: c.id })
    } else if (c.status === 'needs-you') out.push({ key: `p:${c.id}`, kind: 'permission', title: c.title, text: oneLine(c.statusDetail) || 'waiting on you', at: c.unreadAt, cardId: c.id })
    // a decision the card's reply asked for, until the owner looks at the card
    const marker = c.unreadAt !== undefined && c.status !== 'working' && c.status !== 'needs-you' && !taskDecision.has(c.id) ? ownerMarker(c.lastAssistantMessage ?? '') : undefined
    if (marker?.kind === 'decision') out.push({ key: `d:${c.id}`, kind: 'decision', title: c.title, text: oneLine(marker.line) || 'needs your decision', at: c.unreadAt, cardId: c.id })
  }
  for (const h of o.held) out.push({ key: `h:${h.nodeId}`, kind: 'held', title: h.title, text: h.added ? 'new card from an outside edit of the board file' : 'board file changed outside Ouroboros', cardId: h.nodeId })
  for (const t of o.tasks) {
    if (t.state !== 'blocked') continue
    const approval = APPROVAL_RE.test(t.reason ?? '')
    const who = t.owner ?? (t.updatedBy !== 'owner' ? t.updatedBy : undefined)
    out.push({
      key: `t:${t.id}`,
      kind: approval ? 'decision' : 'blocked',
      title: `${t.id} ${t.title}`,
      text: oneLine((t.reason ?? '').replace(APPROVAL_RE, '')) || 'blocked',
      at: t.updatedAt,
      taskId: t.id,
      cardId: who && o.cards.some((c) => c.id === who) ? who : undefined
    })
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.at ?? 0) - (a.at ?? 0))
}

export interface TodayView {
  working: TodayCard[]
  /** tasks finished since local midnight, newest first */
  done: Task[]
  /** replies that handed over a report, not looked at yet */
  reports: Array<{ cardId: string; title: string; line: string; at: number }>
}

export function todayView(o: { cards: TodayCard[]; tasks: Task[]; now: number }): TodayView {
  const midnight = new Date(o.now)
  midnight.setHours(0, 0, 0, 0)
  const reports: TodayView['reports'] = []
  for (const c of o.cards) {
    if (c.unreadAt === undefined || c.status === 'working') continue
    const m = ownerMarker(c.lastAssistantMessage ?? '')
    if (m?.kind === 'report') reports.push({ cardId: c.id, title: c.title, line: oneLine(m.line), at: c.unreadAt })
  }
  return {
    working: o.cards.filter((c) => c.status === 'working').sort((a, b) => (a.workingSince ?? 0) - (b.workingSince ?? 0)),
    done: o.tasks.filter((t) => t.state === 'done' && t.updatedAt >= midnight.getTime()).sort((a, b) => b.updatedAt - a.updatedAt),
    reports: reports.sort((a, b) => b.at - a.at)
  }
}
