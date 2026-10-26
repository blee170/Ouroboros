/**
 * Questions a card asks the owner (the ask_owner tool): one pending question per card, answered in Today or on the
 * phone with one of the card's choices (or Approve / Deny when it gave none) and an optional note. Pure: the rules,
 * the input checks and the text the card gets back.
 */

export interface Decision {
  /** D<n>, per window */
  id: string
  card: string
  title: string
  question: string
  /** what the owner picks from; none means Approve / Deny */
  choices?: string[]
  createdAt: number
  state: 'pending' | 'answered' | 'expired' | 'withdrawn'
  /** a choice, or 'Approve' / 'Deny' */
  answer?: string
  note?: string
  decidedAt?: number
  /** 'owner', or 'phone <device>' */
  by?: string
}

export const DECISION_LIMITS = {
  questionChars: 2000,
  choices: 4,
  choiceChars: 80,
  noteChars: 1000,
  /** how long ask_owner waits for an answer before it returns "pending" */
  waitMs: 45_000,
  /** a question nobody answered within a day expires */
  expiryMs: 24 * 60 * 60 * 1000,
  /** at most one desktop notification a minute per card */
  notifyGapMs: 60_000,
  /** answered questions kept for Today and the report */
  keep: 50
} as const

export const APPROVE = 'Approve'
export const DENY = 'Deny'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Pure: a card's question and choices as given to ask_owner, checked. */
export function askInput(raw: { question?: unknown; choices?: unknown }): { ok: true; question: string; choices?: string[] } | { ok: false; error: string } {
  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  if (!question || question.length > DECISION_LIMITS.questionChars) return { ok: false, error: `question: 1 to ${DECISION_LIMITS.questionChars} characters` }
  if (raw.choices === undefined || raw.choices === null) return { ok: true, question }
  if (!Array.isArray(raw.choices) || raw.choices.some((c) => typeof c !== 'string')) return { ok: false, error: 'choices: a list of short strings' }
  const choices = (raw.choices as string[]).map(oneLine)
  if (choices.length < 2 || choices.length > DECISION_LIMITS.choices) return { ok: false, error: `choices: 2 to ${DECISION_LIMITS.choices}, or none for Approve / Deny` }
  if (choices.some((c) => !c || c.length > DECISION_LIMITS.choiceChars)) return { ok: false, error: `choices: each 1 to ${DECISION_LIMITS.choiceChars} characters` }
  if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) return { ok: false, error: 'choices: each one different' }
  return { ok: true, question, choices }
}

/** Pure: the answers the owner may give to this question. */
export function answersOf(d: Pick<Decision, 'choices'>): string[] {
  return d.choices?.length ? d.choices : [APPROVE, DENY]
}

/** Pure: questions still pending after a day become expired. */
export function expireDecisions(list: Decision[], now: number): Decision[] {
  return list.some((d) => d.state === 'pending' && now - d.createdAt >= DECISION_LIMITS.expiryMs)
    ? list.map((d) => (d.state === 'pending' && now - d.createdAt >= DECISION_LIMITS.expiryMs ? { ...d, state: 'expired' as const, decidedAt: now } : d))
    : list
}

/** Pure: the list kept: every pending question, and the newest answered ones up to the limit. */
export function trimDecisions(list: Decision[]): Decision[] {
  const done = list.filter((d) => d.state !== 'pending')
  if (done.length <= DECISION_LIMITS.keep) return list
  const drop = new Set(done.slice(0, done.length - DECISION_LIMITS.keep).map((d) => d.id))
  return list.filter((d) => !drop.has(d.id))
}

/** Pure: what the card gets once the question is settled (as the tool result, or as a board message from the owner). */
export function decisionMessage(d: Decision): string {
  const head = `[owner decision ${d.id}] Your question: ${oneLine(d.question).slice(0, 200)}`
  if (d.state === 'expired') return `${head}\nNo answer within 24 hours: the question expired. Carry on without it, or ask again if it still matters.`
  if (d.state === 'withdrawn') return `${head}\nThe question was withdrawn.`
  return `${head}\nAnswer: ${d.answer ?? '(none)'}${d.note ? `\nNote from the owner: ${d.note}` : ''}`
}

/** Pure: what ask_owner returns when the owner has not answered within the wait. */
export function pendingMessage(id: string, autonomous: boolean): string {
  const why = autonomous ? 'An autonomous run is on, so the owner is probably away; it is listed for them in the morning report.' : 'The owner has not answered yet.'
  return `pending ${id}: ${why} Carry on with work that does not depend on it. The answer comes as a board message headed [owner decision ${id}]; do not ask the same question again.`
}
