import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { approvalNeeded, decide, expireApprovals, findApproval, findPending, type Approval } from '@shared/gate'
import type { GateInput, GateReply } from './hook-server'

/** One line of the audit log per gated call. */
export interface AuditLine {
  ts: string
  card: string
  title: string
  command: string
  cwd?: string
  decision: 'auto' | 'ask' | 'never' | 'approved' | 'denied' | 'expired'
  by: 'policy' | 'owner'
  reason: string
}

export function auditFile(userData: string, projectRoot: string): string {
  return join(userData, 'audit', `${createHash('sha1').update(projectRoot.toLowerCase()).digest('hex').slice(0, 16)}.jsonl`)
}

export interface GateCard {
  id: string
  title: string
  /** the card's folder (its worktree, else its cwd), recorded when the hook gives no cwd */
  folder: string
}

/**
 * The action gate of one window: decides a card's push / PR command by the policy in @shared/gate, keeps the
 * owner's approvals ("ask"), and writes every gated call to the project's audit log. Emits 'change' (approvals).
 */
export class GateKeeper extends EventEmitter {
  approvals: Approval[] = []
  private file?: string
  private next = 1

  constructor(private log: (line: string) => void = () => {}) {
    super()
  }

  /** Switch to a project's audit log; approvals belong to a project and are dropped. */
  load(file: string | undefined): void {
    this.file = file
    this.approvals = []
    this.emit('change', this.approvals)
  }

  async decide(card: GateCard, input: GateInput, now = Date.now()): Promise<GateReply & { audit?: AuditLine }> {
    const cwd = input.cwd || card.folder
    const verdict = decide(input.command)
    if (!verdict.decision) return { decision: 'none', reason: '' }
    const line = (decision: AuditLine['decision'], by: AuditLine['by'], reason: string): AuditLine => ({ ts: new Date(now).toISOString(), card: card.id, title: card.title, command: input.command.slice(0, 2000), cwd, decision, by, reason })
    if (verdict.decision === 'never') return this.answer('deny', `Ouroboros action gate (autonomous run): ${verdict.reason}. Commit to your claude/*, card/* or wt/* branch and push that; the owner merges.`, line('never', 'policy', verdict.reason))
    if (verdict.decision === 'auto') {
      // an allow skips every other check for the whole command line: given only when the line is nothing but gated actions
      if (!verdict.onlyGated) return this.answer('none', '', line('auto', 'policy', `${verdict.reason} (left to the normal permission flow: the command does more than that)`))
      return this.answer('allow', `Ouroboros action gate: ${verdict.reason} is allowed during the run`, line('auto', 'policy', verdict.reason))
    }
    // ask
    this.approvals = expireApprovals(this.approvals, now)
    const ok = findApproval(this.approvals, card.id, input.command, now)
    if (ok) {
      if (!verdict.onlyGated) return this.answer('deny', 'Ouroboros action gate: the owner approved this command on its own; run it as a separate command, with nothing chained to it.', line('ask', 'policy', 'approved command chained to others'))
      this.approvals = this.approvals.map((a) => (a.id === ok.id ? { ...a, state: 'used' as const } : a))
      this.emit('change', this.approvals)
      return this.answer('allow', `Ouroboros action gate: approved by the owner (${ok.id})`, line('approved', 'owner', `${verdict.reason} (${ok.id})`))
    }
    if (!findPending(this.approvals, card.id, input.command)) {
      const a: Approval = { id: `A${this.next++}`, card: card.id, title: card.title, command: input.command.slice(0, 2000), cwd, createdAt: now, state: 'pending' }
      this.approvals = [...this.approvals, a]
      this.emit('change', this.approvals)
      this.emit('asked', a)
    }
    return this.answer('deny', approvalNeeded(input.command), line('ask', 'policy', verdict.reason))
  }

  /** The owner's answer; returns the approval (or why not). */
  resolve(id: string, approve: boolean, now = Date.now()): { ok: true; approval: Approval } | { ok: false; error: string } {
    const a = this.approvals.find((x) => x.id === id)
    if (!a) return { ok: false, error: `no approval ${id}` }
    if (a.state !== 'pending') return { ok: false, error: `${id} is already ${a.state}` }
    const decided: Approval = { ...a, state: approve ? 'approved' : 'denied', decidedAt: now }
    this.approvals = this.approvals.map((x) => (x.id === id ? decided : x))
    this.audit({ ts: new Date(now).toISOString(), card: a.card, title: a.title, command: a.command, cwd: a.cwd, decision: approve ? 'approved' : 'denied', by: 'owner', reason: approve ? 'the owner approved it (one use, 30 minutes)' : 'the owner denied it' })
    this.emit('change', this.approvals)
    return { ok: true, approval: decided }
  }

  pending(): Approval[] {
    return this.approvals.filter((a) => a.state === 'pending')
  }

  private answer(decision: GateReply['decision'], reason: string, audit: AuditLine): GateReply & { audit: AuditLine } {
    this.audit(audit)
    return { decision, reason, audit }
  }

  private audit(line: AuditLine): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(line) + '\n')
    } catch (e) {
      this.log(`[gate] audit write failed: ${(e as Error).message}`)
    }
  }
}
