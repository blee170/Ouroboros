/**
 * Announcements: what the owner hears (or sees as a toast) when a card finishes a turn, when a card needs a
 * human and when a run of several cards settles. Pure: main decides, the renderer speaks.
 *
 * The spoken text is always a fixed sentence ("<card> finished, please check the report"), never the reply
 * itself: a long report is on the canvas (briefs open in the 📄 card) and a short one is in the toast.
 */
import type { AppSettings, NodeKind } from './types'

export type AnnounceTarget = 'off' | 'conductor' | 'all'
export type AnnounceKind = 'finished' | 'needs-you' | 'failed' | 'all-done'
export type AnnounceLang = 'ko' | 'en'

export interface AnnouncePayload {
  kind: AnnounceKind
  title: string
  lang: AnnounceLang
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
}

export function announceSettings(s: Pick<AppSettings, 'announce' | 'announceToast' | 'announceVoice'>): AnnounceSettings {
  return { target: s.announce ?? 'conductor', toast: s.announceToast ?? true, voice: s.announceVoice ?? true }
}

export const hasHangul = (s: string): boolean => /[가-힣ᄀ-ᇿ㄰-㆏]/.test(s)

/** Korean when any of the texts (card title, reply) is Korean, else English. */
export function langFor(...texts: Array<string | undefined>): AnnounceLang {
  return texts.some((t) => t && hasHangul(t)) ? 'ko' : 'en'
}

export function phrase(p: AnnouncePayload, lang: AnnounceLang = p.lang): string {
  const t = p.title.trim()
  switch (p.kind) {
    case 'finished':
      return lang === 'ko' ? `${t} 작업이 끝났습니다. 보고를 확인해 주세요.` : `${t} finished. Please check the report.`
    case 'needs-you':
      return lang === 'ko' ? `${t} 카드가 기다리고 있습니다.` : `${t} needs you.`
    case 'failed':
      return lang === 'ko' ? `${t} 작업이 실패했습니다. 확인해 주세요.` : `${t} failed. Please take a look.`
    case 'all-done':
      return lang === 'ko' ? '모든 카드 작업이 끝났습니다.' : 'All cards have finished.'
  }
}

const AGENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['claude', 'conductor', 'terminal', 'command'])

/** Is a finished turn of this card announced? `elapsedMs` undefined = the start was not seen (announce). */
export function announcesStop(kind: NodeKind, elapsedMs: number | undefined, s: AnnounceSettings): boolean {
  if (s.target === 'off' || (!s.toast && !s.voice)) return false
  if (!AGENT_KINDS.has(kind)) return false
  if (s.target === 'conductor' && kind !== 'conductor') return false
  return elapsedMs === undefined || elapsedMs >= MIN_TURN_MS
}

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
