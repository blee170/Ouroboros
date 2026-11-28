/**
 * Announcements: what the owner hears (or sees as a toast) when a card finishes a turn, when a card needs a
 * human and when a run of several cards settles. Pure: main decides, the renderer speaks.
 *
 * The spoken text is always a fixed sentence ("<card> needs your decision", "a report is ready"), never the reply
 * itself: a long report is on the canvas (briefs open in the 📄 card) and a short one is in the toast.
 *
 * By default only what needs the owner is announced (`mode: 'important'`): a reply that asks for a decision or
 * hands over a report, a card waiting on a permission prompt, a failed turn. Progress replies stay on the canvas.
 * `mode: 'every'` is the older behaviour: every finished turn of 10 s or more, and "all cards have finished".
 */
import type { AppSettings, NodeKind } from './types'
import { wholeStart } from './tts'

export type AnnounceTarget = 'off' | 'conductor' | 'all'
export type AnnounceMode = 'important' | 'every'
export type AnnounceKind = 'finished' | 'decision' | 'report' | 'needs-you' | 'failed' | 'all-done'
export type AnnounceLang = 'ko' | 'en'

export interface AnnouncePayload {
  kind: AnnounceKind
  title: string
  lang: AnnounceLang
  /** the card it is about (a decision: where a spoken answer goes) */
  nodeId?: string
  /** a decision: what is read out if the owner says yes to "shall I read it?" (readAloudText) */
  read?: string
}

/** A turn shorter than this is a quick exchange, not finished work: nothing is announced. */
export const MIN_TURN_MS = 10_000
/** Quiet time after the last status change before the board counts as settled. */
export const SETTLE_MS = 5_000
/** A card that keeps asking (permission after permission) is spoken once per this window. */
export const NEEDS_YOU_REPEAT_MS = 60_000
/** One card gets at most one toast per this window (a question right after a finish, a run of permission prompts). */
export const BURST_MS = 5_000

/** The per-card toast cooldown: `allow` says whether this card may make a sound now, and books the slot if so. */
export class Burst {
  private last = new Map<string, number>()
  constructor(private windowMs = BURST_MS) {}

  allow(id: string, now: number): boolean {
    const prev = this.last.get(id)
    if (prev !== undefined && now - prev < this.windowMs) return false
    this.last.set(id, now)
    return true
  }

  forget(id: string): void {
    this.last.delete(id)
  }
}

export interface AnnounceSettings {
  target: AnnounceTarget
  toast: boolean
  voice: boolean
  mode: AnnounceMode
  /** after a spoken decision, ask "shall I read it?" and listen for the answer (needs voice input on) */
  readAloud: boolean
}

export function announceSettings(s: Pick<AppSettings, 'announce' | 'announceToast' | 'announceVoice' | 'announceMode' | 'announceReadAloud'>): AnnounceSettings {
  return { target: s.announce ?? 'conductor', toast: s.announceToast ?? true, voice: s.announceVoice ?? true, mode: s.announceMode === 'every' ? 'every' : 'important', readAloud: s.announceReadAloud ?? true }
}

/**
 * The owner line a Conductor ends a reply with when it needs them: `OWNER: DECIDE — <question>` or
 * `OWNER: REPORT — <one line>` (the Conductor prompt asks for exactly these). Only the reply's last few lines count,
 * so a line quoted from a worker in the middle of a reply does not.
 */
export function ownerMarker(reply: string): { kind: 'decision' | 'report'; line: string } | undefined {
  // blank lines and a sign-off after the owner line must not push it out of the window
  const tail = reply.split(/\r?\n/).filter((l) => l.trim()).slice(-4)
  for (let i = tail.length - 1; i >= 0; i--) {
    // markdown around it is allowed: quote, bullet, numbered item, heading, **OWNER:** / **OWNER: DECIDE**, a full-width colon
    const m = /^[\s>*_`#•-]*(?:\d+[.)]\s*)?[*_`]*OWNER[*_`]*\s*[:：][\s*_`]*(DECIDE|DECISION|REPORT)\b[\s*_`]*[-—–:：]?\s*(.*)$/i.exec(tail[i])
    if (m) return { kind: /^REPORT$/i.test(m[1]) ? 'report' : 'decision', line: m[2].replace(/[\s*_`]+$/, '').trim() }
  }
  return undefined
}

/**
 * What a finished turn is announced as, or null for nothing. `important` mode: a decision (the owner line, or a
 * task the card blocked on the owner's approval during the turn), else a report (the owner line, or a report link
 * in the reply); anything else stays on the canvas. `every` mode: every turn of 10 s or more is "finished"
 * (`elapsedMs` undefined = the start was not seen: announced).
 */
export function stopAnnouncement(kind: NodeKind, elapsedMs: number | undefined, s: AnnounceSettings, o: { reply: string; reportLink: boolean; askedApproval: boolean }): 'finished' | 'decision' | 'report' | null {
  if (s.target === 'off' || (!s.toast && !s.voice)) return null
  if (!AGENT_KINDS.has(kind)) return null
  if (s.target === 'conductor' && kind !== 'conductor') return null
  const marker = ownerMarker(o.reply)
  if (s.mode === 'every') return elapsedMs === undefined || elapsedMs >= MIN_TURN_MS ? (marker?.kind ?? 'finished') : null
  if (marker?.kind === 'decision' || o.askedApproval) return 'decision'
  if (marker?.kind === 'report' || o.reportLink) return 'report'
  return null
}

export const hasHangul = (s: string): boolean => /[가-힣ᄀ-ᇿ㄰-㆏]/.test(s)

/** Korean when any of the texts (card title, reply) is Korean, else English. */
export function langFor(...texts: Array<string | undefined>): AnnounceLang {
  return texts.some((t) => t && hasHangul(t)) ? 'ko' : 'en'
}

/**
 * The most of a card title that is said aloud (cards have no title length limit). The longest sentence around a
 * title is 35 characters (" finished. Please check the report."), so every announcement fits one speech piece
 * (SPEECH_PIECE_MAX, 80) and is one request.
 */
const ANNOUNCE_TITLE_MAX = 45

/** A card title as said aloud: a longer one is cut at a word (whole characters if it has no space) and marked "…". */
function sayTitle(title: string): string {
  const t = title.trim()
  if (t.length <= ANNOUNCE_TITLE_MAX) return t
  const head = t.slice(0, wholeStart(t, ANNOUNCE_TITLE_MAX - 1))
  const space = head.lastIndexOf(' ')
  return `${(space >= ANNOUNCE_TITLE_MAX / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

export function phrase(p: AnnouncePayload, lang: AnnounceLang = p.lang): string {
  const t = sayTitle(p.title)
  switch (p.kind) {
    case 'finished':
      return lang === 'ko' ? `${t} 작업이 끝났습니다. 보고를 확인해 주세요.` : `${t} finished. Please check the report.`
    case 'decision':
      return lang === 'ko' ? `${t}: 결정이 필요합니다.` : `${t} needs your decision.`
    case 'report':
      return lang === 'ko' ? `${t}: 보고서가 올라왔습니다.` : `${t}: a report is ready.`
    case 'needs-you':
      return lang === 'ko' ? `${t} 카드가 기다리고 있습니다.` : `${t} needs you.`
    case 'failed':
      return lang === 'ko' ? `${t} 작업이 실패했습니다. 확인해 주세요.` : `${t} failed. Please take a look.`
    case 'all-done':
      return lang === 'ko' ? '모든 카드 작업이 끝났습니다.' : 'All cards have finished.'
  }
}

const AGENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['claude', 'conductor', 'terminal', 'command'])

/** First line of a reply for the toast body: list bullets, headings and emphasis stripped, capped. */
export function firstLine(reply: string, max = 140): string {
  const line =
    reply
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s#>*\-•]+/, '').replace(/[*_`]/g, '').trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * "All cards have finished": once a run that involved several turns settles. A single card's finish is its
 * own announcement, and a run whose last turn was just announced is not announced twice.
 */
export class BoardDone {
  private busy = false
  private stops = 0
  private lastAnnounced = false

  /** A card started working. */
  working(): void {
    if (this.busy) return
    this.busy = true
    this.stops = 0
    this.lastAnnounced = false
  }

  /** A card's turn ended; `announced` = its own "finished" went out. */
  stopped(announced: boolean): void {
    this.stops++
    this.lastAnnounced = announced
  }

  /** The board has been quiet for SETTLE_MS; `anyBusy` = a card is still working or waiting. */
  settle(anyBusy: boolean): boolean {
    if (anyBusy || !this.busy) return false
    this.busy = false
    const due = this.stops >= 2 && !this.lastAnnounced
    this.stops = 0
    return due
  }
}

/** The most a decision read-out says; longer, it keeps the end (where the question is) and says the rest is on screen. */
export const READ_ALOUD_MAX = 600

/**
 * What is read out when the owner says yes to "shall I read it?": the end of the reply, where a Conductor puts
 * the question and its options, as plain speech. Code blocks, links and markdown are dropped (a link is said as
 * "link"); the OWNER: DECIDE label goes, its question stays.
 */
export function readAloudText(reply: string, lang: AnnounceLang, max = READ_ALOUD_MAX): string {
  const noCode = reply.replace(/```[\s\S]*?(```|$)/g, '\n')
  const lines = noCode
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, lang === 'ko' ? '링크' : 'link')
        .replace(/^[\s>#*•-]*(?:\d+[.)]\s*)?[*_`]*OWNER[*_`]*\s*[:：][\s*_`]*(?:DECIDE|DECISION|REPORT)\b[\s*_`]*[-—–:：]?\s*/i, '')
        .replace(/^[\s>#•-]+/, '')
        .replace(/[*_`|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((l) => l && !/^[-=:\s]+$/.test(l))
  // whole lines from the end while they fit, so the question is never cut off
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (size + l.length + 1 > max) {
      if (!kept.length) kept.push(`…${l.slice(-(max - 1))}`)
      break
    }
    kept.unshift(l)
    size += l.length + 1
  }
  const text = kept.join('\n')
  const cut = kept.length < lines.length || kept[0]?.startsWith('…') === true
  if (!text) return ''
  return cut ? `${lang === 'ko' ? '앞부분은 화면에 있어요. ' : 'The start is on screen. '}${text}` : text
}

const NO_EN = /(^|\s)(no|nope|nah|don'?t|do not|stop|skip|later|cancel|not now|wait|hold on)(\s|$)/
const NO_KO = /(아니|아뇨|됐어|됐습니다|괜찮|나중|하지 ?마|읽지 ?마|보내지 ?마|그만|취소|싫어|잠깐|(^|\s)안(\s|$)|(^|\s)안 )/
const YES_EN = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|read it|send it|do it)( (yes|yeah|sure|ok|okay|please|it|now))?$/
const YES_KO = /^((응|네|예|그래|좋아|오케이|ㅇㅇ)(요)?( (읽어|보내|해)(줘|주세요|요)?)?|(읽어|보내)(줘|주세요)?)$/

/**
 * A spoken yes or no to "shall I read it?" / "send it?", or undefined when it is neither (then nothing is read or
 * sent). Strict on purpose: a yes is a short reply that is only a yes ("네", "응 읽어줘", "yes", "go ahead"), never a
 * sentence that happens to hold a yes word ("Please check the report", "안 보내", "어 잠깐만"), and a question
 * ("그래?") is neither.
 */
export function yesNo(said: string): 'yes' | 'no' | undefined {
  if (/[?？]/.test(said)) return undefined
  const t = said.toLowerCase().replace(/[.,!~…。"'“”]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  if (NO_EN.test(t) || NO_KO.test(t)) return 'no'
  if (t.split(' ').length > 4) return undefined
  return YES_EN.test(t) || YES_KO.test(t) ? 'yes' : undefined
}

export type ReadAloudStep = 'offer' | 'listen-answer' | 'confirm' | 'sent' | 'cancelled' | 'unclear' | 'gone' | 'busy'

/** The sentences of the read-aloud exchange. `text` is the answer read back (confirm) or the card's title (gone). */
export function readAloudLine(step: ReadAloudStep, lang: AnnounceLang, text = ''): string {
  const ko = lang === 'ko'
  switch (step) {
    case 'offer':
      return ko ? '내용을 읽어드릴까요?' : 'Shall I read it to you?'
    case 'listen-answer':
      return ko ? '답하실 말씀이 있으면 지금 말씀하세요.' : 'If you want to answer, say it now.'
    case 'confirm':
      return ko ? `"${text}" 이렇게 보낼까요?` : `Send "${text}"?`
    case 'sent':
      return ko ? '보냈어요.' : 'Sent.'
    case 'cancelled':
      return ko ? '보내지 않았어요.' : 'Not sent.'
    case 'unclear':
      return ko ? '잘 못 알아들었어요. 화면에서 확인해 주세요.' : 'I did not catch that. Please check the screen.'
    case 'busy':
      return ko ? `${sayTitle(text)} 카드가 이미 다른 일을 하고 있어서 안 보냈어요. 화면에서 확인해 주세요.` : `${sayTitle(text)} is busy with something else; not sent. Please check the screen.`
    case 'gone':
      return ko ? `${sayTitle(text)} 카드가 없어서 못 보냈어요.` : `${sayTitle(text)} is gone; not sent.`
  }
}

/** What `send` did with a spoken answer. */
export type ReadAloudSend = 'sent' | 'gone' | 'busy'

/** What a read-aloud exchange uses of the renderer: its speech queue, the composer's microphone and the card. */
export interface ReadAloudIO {
  /** says one text after everything asked before it; once `stop` aborts, what is left of it is dropped */
  say: (text: string, lang: AnnounceLang, stop?: AbortSignal) => Promise<void>
  /** one utterance from the composer's microphone */
  hear: () => Promise<string | undefined>
  /** types the answer into the card as the owner's words */
  send: (nodeId: string, text: string) => ReadAloudSend
  /** resolves once everything asked to be said so far has been said */
  settled: () => Promise<void>
  /** holds other announcements back; the returned function lets them go */
  hold: () => () => void
}

/**
 * One "shall I read it?" exchange about decision `p` (see useReadAloud). `stop` abandons it (the composer is gone):
 * nothing more is heard or sent, the reading stops after the piece playing, and the held announcements go.
 */
export async function readAloudExchange(p: AnnouncePayload, nodeId: string, read: string, io: ReadAloudIO, stop: AbortSignal): Promise<void> {
  const lang = p.lang
  /** One utterance, or undefined once the composer (and its microphone) is gone. */
  const hear = async (): Promise<string | undefined> => (stop.aborted ? undefined : io.hear())
  // the announcement (queued by App in the same emit) first, then the question; the mic opens after both
  await io.settled()
  const release = io.hold()
  try {
    await io.say(readAloudLine('offer', lang), lang)
    if (yesNo((await hear()) ?? '') !== 'yes') return
    await io.say(read, lang, stop)
    if (stop.aborted) return
    await io.say(readAloudLine('listen-answer', lang), lang)
    const answer = (await hear())?.trim()
    if (!answer || yesNo(answer) === 'no') return
    await io.say(readAloudLine('confirm', lang, answer), lang)
    const ok = yesNo((await hear()) ?? '')
    if (ok !== 'yes' || stop.aborted) return void (await io.say(readAloudLine(ok === 'no' ? 'cancelled' : 'unclear', lang), lang))
    const r = io.send(nodeId, answer)
    await io.say(r === 'sent' ? readAloudLine('sent', lang) : readAloudLine(r, lang, p.title), lang)
  } finally {
    release()
  }
}
