import { EventEmitter } from 'node:events'
import { answersOf, DECISION_LIMITS, expireDecisions, trimDecisions, type Decision } from '@shared/decisions'

/**
 * The owner's questions from the cards of one window (ask_owner), in memory: one pending question per card. A card's
 * ask_owner call waits on its question for a while (wait); an answer given while it waits goes back as the tool
 * result, a later one as a board message. Emits 'change' (the list), 'asked' (a new question) and 'expired'.
 */
export class DecisionDesk extends EventEmitter {
  decisions: Decision[] = []
  private next = 1
  private waiters = new Map<string, (d: Decision | undefined) => void>()

  /** A project switch: questions belong to the board they were asked on. */
  load(): void {
    for (const resolve of this.waiters.values()) resolve(undefined)
    this.waiters.clear()
    this.decisions = []
    this.emit('change', this.decisions)
  }

  ask(card: { id: string; title: string }, question: string, choices: string[] | undefined, now = Date.now()): { ok: true; decision: Decision } | { ok: false; error: string } {
    this.sweep(now)
    const open = this.decisions.find((d) => d.card === card.id && d.state === 'pending')
    if (open) return { ok: false, error: `you already asked the owner ${open.id} and it is not answered yet: one question at a time. Its answer comes as a board message headed [owner decision ${open.id}].` }
    const decision: Decision = { id: `D${this.next++}`, card: card.id, title: card.title, question, ...(choices ? { choices } : {}), createdAt: now, state: 'pending' }
    this.decisions = trimDecisions([...this.decisions, decision])
    this.emit('change', this.decisions)
    this.emit('asked', decision)
    return { ok: true, decision }
  }

  /** The question once it is settled, or undefined when ms pass first (or it is gone). One waiter per question. */
  wait(id: string, ms: number): Promise<Decision | undefined> {
    const d = this.decisions.find((x) => x.id === id)
    if (!d) return Promise.resolve(undefined)
    if (d.state !== 'pending') return Promise.resolve(d)
    this.waiters.get(id)?.(undefined)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(id) === done) this.waiters.delete(id)
        resolve(undefined)
      }, ms)
      const done = (x: Decision | undefined): void => {
        clearTimeout(timer)
        resolve(x)
      }
      this.waiters.set(id, done)
    })
  }

  /** The owner's answer. `waited` says whether the card's ask_owner call was still waiting and gets it as its result. */
  answer(id: string, answer: string, note: string | undefined, by: string, now = Date.now()): { ok: true; decision: Decision; waited: boolean } | { ok: false; error: string } {
    this.sweep(now)
    const d = this.decisions.find((x) => x.id === id)
    if (!d) return { ok: false, error: `no question ${id}` }
    if (d.state !== 'pending') return { ok: false, error: `${id} is already ${d.state}` }
    if (!answersOf(d).includes(answer)) return { ok: false, error: `answer with one of: ${answersOf(d).join(', ')}` }
    const text = (note ?? '').trim()
    if (text.length > DECISION_LIMITS.noteChars) return { ok: false, error: `the note is longer than ${DECISION_LIMITS.noteChars} characters` }
    return { ok: true, decision: this.settle(d, { state: 'answered', answer, ...(text ? { note: text } : {}), decidedAt: now, by }), waited: this.release(id) }
  }

  /** A card that leaves the board takes its question with it. */
  withdraw(card: string, now = Date.now()): void {
    for (const d of this.decisions.filter((x) => x.card === card && x.state === 'pending')) {
      this.settle(d, { state: 'withdrawn', decidedAt: now })
      this.release(d.id)
    }
  }

  /** Expire day-old questions; each one that expires now is emitted as 'expired' (its card is told). */
  sweep(now = Date.now()): Decision[] {
    const before = this.decisions
    const after = expireDecisions(before, now)
    if (after === before) return []
    this.decisions = after
    const expired = after.filter((d, i) => d.state === 'expired' && before[i].state === 'pending')
    for (const d of expired) {
      this.release(d.id)
      this.emit('expired', d)
    }
    this.emit('change', this.decisions)
    return expired
  }

  pending(): Decision[] {
    return this.decisions.filter((d) => d.state === 'pending')
  }

  private settle(d: Decision, patch: Partial<Decision>): Decision {
    const next = { ...d, ...patch }
    this.decisions = this.decisions.map((x) => (x.id === d.id ? next : x))
    this.emit('change', this.decisions)
    return next
  }

  /** Hand the settled question to a waiting ask_owner call; true when one was waiting. */
  private release(id: string): boolean {
    const resolve = this.waiters.get(id)
    if (!resolve) return false
    this.waiters.delete(id)
    resolve(this.decisions.find((x) => x.id === id))
    return true
  }
}
