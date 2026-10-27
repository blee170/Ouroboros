import { NOTE_MARKER, NOTE_PROMPT, noteUsable, relayDecision, relayQuestion, resumePrompt, RELAY_ASK_AGAIN_MS, RELAY_NO, RELAY_YES, type RelaySettings } from '@shared/relay'

export interface RelayCardView {
  id: string
  title: string
  kind: string
  engine?: string
  status: string
  statusDetail?: string
  sessionId?: string
  lastStopAt?: number
  lastEventAt?: number
}

export interface RelayHost {
  cards(): RelayCardView[]
  usage(sessionId: string): { contextTokens: number; contextWindow: number } | null
  /** a question, approval or permission prompt is open for the card */
  pending(id: string): boolean
  settings(): RelaySettings
  /** a prompt into the card's session (inbox or typed); false when it could not be given */
  prompt(id: string, text: string): boolean
  /** raw keystrokes into the card's terminal */
  type(id: string, text: string): void
  /** the Stop of the turn whose prompt carries `marker` is the note; undefined when another prompt cut that turn */
  captureStop(id: string, marker: string, take: (note: string | undefined) => void): void
  releaseStop(id: string): void
  /** `done` runs when the card's /clear lands; undefined stops watching */
  watchClear(id: string, done: (() => void) | undefined): void
  ask(card: { id: string; title: string }, question: string, choices: string[]): string | undefined
  saveNote(card: RelayCardView, note: string): string | undefined
  /** a line for the run log and the report */
  record(card: RelayCardView, detail: string): void
  log(line: string): void
  now?(): number
}

const NOTE_MS = 5 * 60_000
const CLEAR_MS = 30_000
/** after the note: a prompt queued meanwhile shows up within this, and then /clear is not typed */
const SETTLE_MS = 2500
/** an owner's yes holds this long while the card is busy */
const APPROVAL_MS = 2 * 60 * 60_000
/** a card whose fresh start did not happen is left alone this long */
const RETRY_MS = 30 * 60_000

/**
 * Fresh starts for one window: once a minute, an idle Claude card past the context threshold writes a handoff note,
 * its conversation is cleared, and the note is its first prompt in the new one. A Conductor asks the owner first by
 * default. A step that does not happen before /clear stops the relay and leaves the conversation as it was.
 */
export class Relay {
  private history = new Map<string, number[]>()
  private running = new Set<string>()
  private failedAt = new Map<string, number>()
  private askedAt = new Map<string, number>()
  /** relay questions to the owner: decision id -> card */
  private asks = new Map<string, string>()
  private approved = new Map<string, number>()

  constructor(
    private host: RelayHost,
    private timing = { noteMs: NOTE_MS, clearMs: CLEAR_MS, settleMs: SETTLE_MS, resumeMs: 1500 }
  ) {}

  private now(): number {
    return this.host.now ? this.host.now() : Date.now()
  }

  /** Whether a decision is one of the relay's questions (its answer is not mailed to the card). */
  owns(decisionId: string): boolean {
    return this.asks.has(decisionId)
  }

  /** The owner answered a relay question (undefined: it expired). */
  answered(decisionId: string, answer: string | undefined): void {
    const card = this.asks.get(decisionId)
    if (!card) return
    this.asks.delete(decisionId)
    if (answer === RELAY_YES) this.approved.set(card, this.now() + APPROVAL_MS)
    this.host.log(`[relay] ${card}: ${answer ? `owner said ${answer}` : 'the question expired'} (${decisionId})`)
  }

  tick(): void {
    const settings = this.host.settings()
    const now = this.now()
    for (const c of this.host.cards()) {
      if (this.running.has(c.id) || !c.sessionId) continue
      if (now - (this.failedAt.get(c.id) ?? 0) < RETRY_MS) continue
      const usage = this.host.usage(c.sessionId)
      if (!usage) continue
      const want = relayDecision({ ...c, ...usage, pending: this.host.pending(c.id) }, settings, this.history.get(c.id), now)
      if (!want) continue
      if (want === 'auto' || (this.approved.get(c.id) ?? 0) > now) {
        this.approved.delete(c.id)
        void this.run(c, usage.contextTokens)
        continue
      }
      // one question per card per RELAY_ASK_AGAIN_MS, answered or not
      if (now - (this.askedAt.get(c.id) ?? 0) < RELAY_ASK_AGAIN_MS) continue
      this.askedAt.set(c.id, now)
      for (const [d, card] of this.asks) if (card === c.id) this.asks.delete(d)
      const id = this.host.ask({ id: c.id, title: c.title }, relayQuestion(c.title, usage.contextTokens), [RELAY_YES, RELAY_NO])
      if (id) {
        this.asks.set(id, c.id)
        this.host.record(c, `asked the owner (${id}) at ${Math.round(usage.contextTokens / 1000)}k tokens`)
      }
    }
  }

  private async run(c: RelayCardView, tokens: number): Promise<void> {
    this.running.add(c.id)
    this.history.set(c.id, [...(this.history.get(c.id) ?? []), this.now()])
    const stop = (why: string): void => {
      this.failedAt.set(c.id, this.now())
      this.host.log(`[relay] ${c.id} stopped: ${why}; the conversation is kept`)
      this.host.record(c, `not started: ${why}`)
    }
    try {
      this.host.log(`[relay] ${c.id} at ${tokens} tokens: asking for a handoff note`)
      const note = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.host.releaseStop(c.id)
          resolve(undefined)
        }, this.timing.noteMs)
        this.host.captureStop(c.id, NOTE_MARKER, (text) => {
          clearTimeout(timer)
          resolve(text)
        })
        if (!this.host.prompt(c.id, NOTE_PROMPT)) {
          clearTimeout(timer)
          this.host.releaseStop(c.id)
          resolve(undefined)
        }
      })
      if (note === undefined) return stop('no handoff note came back (the turn was cut, or it took too long)')
      if (!noteUsable(note)) return stop(`the note was too short (${note.trim().length} characters)`)
      const file = this.host.saveNote(c, note)
      // a prompt queued during the note turn starts right after its Stop: then the card is busy and /clear waits
      const noted = this.host.cards().find((x) => x.id === c.id)
      await sleep(this.timing.settleMs)
      const card = this.host.cards().find((x) => x.id === c.id)
      if (!card || card.status !== 'idle' || card.statusDetail !== 'handoff note written' || card.lastEventAt !== noted?.lastEventAt || this.host.pending(c.id)) {
        return stop('the card got busy after writing the note')
      }
      const cleared = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.host.watchClear(c.id, undefined)
          resolve(false)
        }, this.timing.clearMs)
        this.host.watchClear(c.id, () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      this.host.type(c.id, '/clear')
      await sleep(300)
      this.host.type(c.id, '\r')
      if (!(await cleared)) {
        // the TUI may still run it later: say where the note is in case it does
        this.failedAt.set(c.id, this.now())
        this.host.log(`[relay] ${c.id}: /clear was not confirmed in ${this.timing.clearMs / 1000}s; the note is in ${file ?? '(not saved)'}`)
        this.host.record(c, `/clear not confirmed${file ? `; the note is saved at ${file}` : ''}`)
        return
      }
      // the new conversation is up before its first prompt
      await sleep(this.timing.resumeMs)
      if (!this.host.prompt(c.id, resumePrompt(note, c.title))) {
        this.host.log(`[relay] ${c.id} cleared, but the resume prompt was not delivered; the note is in ${file ?? '(not saved)'}`)
        this.host.record(c, `cleared, but the note could not be given back${file ? ` (saved at ${file})` : ''}`)
        return
      }
      this.host.log(`[relay] ${c.id} started fresh from a ${note.trim().length}-character note${file ? ` (${file})` : ''}`)
      this.host.record(c, `fresh start at ${Math.round(tokens / 1000)}k tokens, note ${note.trim().length} characters`)
    } catch (e) {
      stop(`error: ${(e as Error).message}`)
    } finally {
      this.running.delete(c.id)
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
