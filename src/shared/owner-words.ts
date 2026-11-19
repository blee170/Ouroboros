/**
 * The owner's own words, as typed into a Claude card: so a card the owner talks to (the chief) can pass an approval
 * on to another card in the owner's exact words, which that card can trust, instead of in its own words, which it
 * rightly cannot. Pure: the keystroke reader, the match between a submitted prompt and what the owner typed or sent,
 * and the texts the cards see.
 *
 * A prompt counts as the owner's only when it equals, character for character, a line the owner typed on the card's
 * keyboard (Enter ending it, no cursor keys or history recall in between), or a text the owner sent to that card from
 * the composer, the chat view or the phone. Anything Ouroboros or another card typed is never in either list, and a
 * forged hook event cannot match a line the owner did not type.
 */

export const OWNER_WORDS = {
  /** a word can be relayed for this long after the owner typed it */
  keepMs: 60 * 60_000,
  /** the newest words kept per card */
  perCard: 10,
  /** longer prompts are not kept: a pasted log is not an approval */
  maxChars: 2000,
  /** a typed line matches the prompt submitted within this long after its Enter (a prompt typed while the card works is submitted when its turn ends) */
  typedMs: 5 * 60_000,
  /** a composer or phone text matches the prompt submitted within this long (an asleep card wakes first) */
  sentMs: 5 * 60_000,
  /** typed lines and sent texts waiting for their prompt, per card */
  pendingPerCard: 8
} as const

export type OwnerVia = 'keyboard' | 'composer' | 'phone'

export interface OwnerWord {
  /** W<n>, per app run */
  id: string
  card: string
  text: string
  at: number
  via: OwnerVia
}

/** What the owner typed or sent and the card has not submitted yet. */
export interface OwnerPending {
  text: string
  at: number
  via: OwnerVia
}

/** The line being typed on a card's keyboard; null once it cannot be known (a cursor key, history, an escape). */
export type KeyLine = string | null

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** focus in/out, SGR mouse reports, cursor position and device attribute replies (anything else empties the line: safe, never wrong) */
// eslint-disable-next-line no-control-regex
const TERMINAL_SIGNAL = /^\x1b\[(?:I|O|<[\d;]*[Mm]|\d+;\d+R|\?[\d;]*[cn]|>[\d;]*c|\d*n)$/

/**
 * Pure: feed keyboard data (what the terminal sends for keys and pastes) into the line being typed. Returns the line
 * after it and each line an Enter ended (null when it could not be followed: the card then has no owner word for it).
 * `pasting` is carried between calls: a paste may arrive in pieces.
 */
export function feedKeys(line: KeyLine, data: string, pasting = false): { line: KeyLine; ended: KeyLine[]; pasting: boolean } {
  const ended: KeyLine[] = []
  let i = 0
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      // pasted text is the clipboard's, not typed: any card can put text there, and Claude Code shows a long paste as
      // a chip the owner never reads. A line with a paste in it is never the owner's word.
      pasting = true
      line = null
      i += PASTE_START.length
      continue
    }
    if (data.startsWith(PASTE_END, i)) {
      pasting = false
      i += PASTE_END.length
      continue
    }
    const c = data[i]
    if (pasting) {
      // a pasted newline is part of the text, not an Enter
      i++
      continue
    }
    if (c === '\r') {
      // an Enter that may not submit (a "\" line continuation, picking an @file or a /command from the menu) leaves
      // the prompt going on out of sight: neither this line nor the rest of that prompt is kept
      const open = line !== null && (line.endsWith('\\') || /(^|\s)@\S*$/.test(line) || /^\/\S*$/.test(line))
      ended.push(open ? null : line)
      line = open ? null : ''
    } else if (c === '\x7f' || c === '\b') {
      if (line) line = Array.from(line).slice(0, -1).join('')
    } else if (c === '\x15' || c === '\x03') {
      line = '' // Ctrl+U, Ctrl+C: the input is cleared
    } else if (c === '\x1b') {
      // skip the whole sequence: ESC [ params final, ESC O x, or ESC x
      let j = i + 1
      let seq = ''
      if (data[j] === '[') {
        j++
        while (j < data.length && !/[@-~]/.test(data[j])) j++
        j++
        seq = data.slice(i, j)
      } else if (data[j] === 'O') {
        j += 2
        seq = data.slice(i, j)
      } else if (j < data.length) j++
      // the terminal's own signals (focus in or out, mouse, replies to queries) are no keys: the line stays known;
      // anything else (a cursor key, Delete, Home, Esc, Alt+key) may change it out of sight
      if (!TERMINAL_SIGNAL.test(seq)) line = null
      i = j
      continue
    } else if (c < ' ') {
      // Tab completion or another control key: what is on the input line is no longer known
      line = null
    } else if (line !== null) line += c
    i++
  }
  return { line, ended, pasting }
}

/** Pure: a prompt or a typed text compared as the owner sees it (line breaks unified, ends trimmed). */
export function normalizeWords(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** Pure: which pending entry (index) the submitted prompt is, or -1 when it is none of the owner's. */
export function matchOwnerPrompt(prompt: string, pending: readonly OwnerPending[], now: number): number {
  const p = normalizeWords(prompt)
  if (!p || p.length > OWNER_WORDS.maxChars) return -1
  for (let i = pending.length - 1; i >= 0; i--) {
    const e = pending[i]
    const window = e.via === 'keyboard' ? OWNER_WORDS.typedMs : OWNER_WORDS.sentMs
    if (now - e.at > window || now < e.at) continue
    if (normalizeWords(e.text) === p) return i
  }
  return -1
}

/** Pure: the newest words first, only the ones still young enough to relay. */
export function freshWords(words: readonly OwnerWord[], card: string, now: number): OwnerWord[] {
  return words.filter((w) => w.card === card && now - w.at <= OWNER_WORDS.keepMs && now >= w.at).sort((a, b) => b.at - a.at)
}

/** Pure: what owner_words shows a card. */
export function ownerWordsText(words: readonly OwnerWord[], now: number): string {
  if (!words.length) return `No words from the owner in this card in the last ${OWNER_WORDS.keepMs / 60_000} minutes that Ouroboros could check (only text the owner typed or sent to this card counts; a prompt Ouroboros or another card typed never does).`
  const lines = words.map((w) => {
    const min = Math.max(0, Math.round((now - w.at) / 60_000))
    return `${w.id} (${min} min ago, ${w.via}):\n${w.text.split('\n').map((l) => `> ${l}`).join('\n')}`
  })
  return `The owner's own words in this card, newest first. relay_owner_words(id, to) passes one on to another card exactly as written:\n\n${lines.join('\n\n')}`
}
