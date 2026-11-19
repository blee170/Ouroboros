import { OWNER_WORDS, feedKeys, freshWords, matchOwnerPrompt, normalizeWords, type KeyLine, type OwnerPending, type OwnerVia, type OwnerWord } from '@shared/owner-words'

/** a paste whose end marker never came is over after this long without keys */
const PASTE_STALE_MS = 2000

/**
 * The owner's words per card, in memory only (an app restart forgets them): the line being typed on each card's
 * keyboard, what the owner typed or sent and the card has not submitted yet, and the prompts that turned out to be
 * the owner's (the ones a card may relay).
 */
export class OwnerWordsLog {
  private lines = new Map<string, { line: KeyLine; pasting: boolean; at: number }>()
  private pending = new Map<string, OwnerPending[]>()
  private words: OwnerWord[] = []
  private next = 1
  /** word>card pairs already relayed, with when: kept as long as the word itself could be relayed */
  private relayed = new Map<string, number>()

  /** Keyboard data the owner typed into a card's terminal. */
  keys(card: string, data: string, now = Date.now()): void {
    const cur = this.lines.get(card) ?? { line: '', pasting: false, at: now }
    const r = feedKeys(cur.line, data, cur.pasting && now - cur.at < PASTE_STALE_MS)
    this.lines.set(card, { line: r.line, pasting: r.pasting, at: now })
    for (const l of r.ended) if (l !== null && normalizeWords(l)) this.add(card, { text: l, at: now, via: 'keyboard' })
  }

  /** Something else was written into the card's input (a file path, a pasted image, the composer): the typed line is no longer known. */
  untracked(card: string): void {
    const cur = this.lines.get(card)
    this.lines.set(card, { line: null, pasting: cur?.pasting ?? false, at: cur?.at ?? 0 })
  }

  /** A text the owner sent to a card from the composer, the chat view or the phone. */
  sent(card: string, text: string, via: Exclude<OwnerVia, 'keyboard'>, now = Date.now()): void {
    if (normalizeWords(text)) this.add(card, { text, at: now, via })
  }

  /** A prompt the card submitted (its UserPromptSubmit hook): kept as the owner's word when it is one. */
  submitted(card: string, prompt: unknown, now = Date.now()): OwnerWord | undefined {
    if (typeof prompt !== 'string') return undefined
    const list = this.pending.get(card)
    if (!list?.length) return undefined
    const i = matchOwnerPrompt(prompt, list, now)
    if (i < 0) return undefined
    const [hit] = list.splice(i, 1)
    const word: OwnerWord = { id: `W${this.next++}`, card, text: normalizeWords(prompt), at: now, via: hit.via }
    this.words = [...this.words.filter((w) => now - w.at <= OWNER_WORDS.keepMs), word]
    const mine = this.words.filter((w) => w.card === card)
    if (mine.length > OWNER_WORDS.perCard) {
      const drop = new Set(mine.slice(0, mine.length - OWNER_WORDS.perCard).map((w) => w.id))
      this.words = this.words.filter((w) => !drop.has(w.id))
    }
    return word
  }

  /** The card's words young enough to relay, newest first. */
  of(card: string, now = Date.now()): OwnerWord[] {
    return freshWords(this.words, card, now)
  }

  /** One of the card's words by id, if still young enough. */
  get(card: string, id: string, now = Date.now()): OwnerWord | undefined {
    return this.of(card, now).find((w) => w.id === id)
  }

  /** Note that a word went to a card; false when it already had. Pairs are dropped only once the word is too old to relay. */
  markRelayed(id: string, to: string, now = Date.now()): boolean {
    for (const [k, at] of this.relayed) if (now - at > OWNER_WORDS.keepMs * 2) this.relayed.delete(k)
    const key = `${id}>${to}`
    if (this.relayed.has(key)) return false
    this.relayed.set(key, now)
    return true
  }

  unmarkRelayed(id: string, to: string): void {
    this.relayed.delete(`${id}>${to}`)
  }

  /** A card left the board, or its board was closed: what was typed into it no longer applies. */
  forget(card: string): void {
    this.lines.delete(card)
    this.pending.delete(card)
    this.words = this.words.filter((w) => w.card !== card)
  }

  private add(card: string, e: OwnerPending): void {
    const list = (this.pending.get(card) ?? []).filter((x) => e.at - x.at <= Math.max(OWNER_WORDS.typedMs, OWNER_WORDS.sentMs))
    list.push(e)
    this.pending.set(card, list.slice(-OWNER_WORDS.pendingPerCard))
  }
}
