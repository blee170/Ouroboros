/**
 * Ouro: the owner works the board from the car through Discord direct messages (Android Auto reads them aloud and
 * takes a spoken reply). No Electron here: the board is reached through OuroHandlers built in ipc.ts, the bot is
 * made by a factory, and time is passed in, so the whole conversation runs under vitest.
 *
 * Nothing is decided without a spoken yes: an approval, a hold or an answer is read back first and done only on
 * "응" within three minutes. Anything that is not a command goes to the Conductor, and its next replies come back.
 */
import { DiscordBot, type DiscordMessage, type DiscordState } from './discord'
import { OURO_LIMITS, confirmLine, conductorPrompt, helpLine, howTo, intentOf, isOnlyYes, langOf, matchAnswer, needLine, readableAloud, soundsLikeNo, spoken, statusLine, titleOf, type Lang, type OuroNeed, type OuroStatus } from '@shared/ouro'

export type OuroResult = { ok: boolean; error?: string; warning?: string }

export interface OuroHandlers {
  /** every window: cards working and idle, and what waits on the owner */
  status(): OuroStatus
  approve(need: OuroNeed): OuroResult
  hold(need: OuroNeed): OuroResult
  answer(need: OuroNeed, answer: string): OuroResult
  /** Gives the owner's words to the Conductor; the card id lets its next replies come back. */
  tell(text: string, lang: Lang): { ok: true; card: string } | { ok: false; error: string }
  /** the run log and the morning report */
  note(line: string): void
  log(line: string): void
}

export interface OuroConfig {
  enabled: boolean
  token?: string
  ownerId?: string
  /** a DM when something new waits on the owner (default on) */
  notify: boolean
  /** approvals and answers by voice (default on); off: Ouro reads them out and sends the owner to the PC */
  approvals: boolean
}

interface Bot {
  readonly state: DiscordState
  readonly detail: string
  readonly username: string
  start(): void
  stop(): void
  send(text: string): Promise<void>
  on(event: string, fn: (...args: any[]) => void): unknown
}
type Action = { kind: 'approve' } | { kind: 'hold' } | { kind: 'answer'; answer: string }

export interface OuroDeps {
  makeBot?: (token: string, ownerId: string) => Bot
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
}

const NOTICE_DEBOUNCE_MS = 3000
// told once per request: a progress note on a task that is still blocked is not news, a new request is
const keyOf = (n: OuroNeed): string => `${n.ref}:${n.text}`
const ACTIONABLE = new Set<OuroNeed['kind']>(['question', 'approval', 'task-approve', 'task-either', 'task-do'])

export class Ouro {
  private bot?: Bot
  private cfg: OuroConfig = { enabled: false, notify: true, approvals: true }
  private botKey = ''
  private lang: Lang = 'ko'
  /** the need the owner last heard: approve / hold / an answer go to it */
  private focus?: OuroNeed
  private pending?: { need: OuroNeed; action: Action; at: number }
  private relay?: { card: string; until: number; left: number }
  /** needs the owner was already told about (ref + when it was read) */
  private known = new Set<string>()
  private lastNotice = 0
  private greeted = false
  private noticeTimer?: unknown
  private queue: Promise<void> = Promise.resolve()
  private readonly d: Required<OuroDeps>

  constructor(
    private readonly h: OuroHandlers,
    deps: OuroDeps = {}
  ) {
    this.d = {
      makeBot: deps.makeBot ?? ((token, owner) => new DiscordBot(token, owner)),
      now: deps.now ?? Date.now,
      setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
    }
  }

  /** Starts, restarts or stops the bot to match the settings; a new token or owner starts it over. */
  configure(cfg: OuroConfig): void {
    this.cfg = cfg
    const want = cfg.enabled && cfg.token && /^\d{15,22}$/.test(cfg.ownerId ?? '') ? `${cfg.ownerId}\0${cfg.token}` : ''
    if (want === this.botKey) return
    this.bot?.stop()
    this.bot = undefined
    this.botKey = want
    this.pending = this.relay = this.focus = undefined
    this.greeted = false
    if (!want) return
    const bot = this.d.makeBot(cfg.token!, cfg.ownerId!)
    this.bot = bot
    bot.on('ready', () => {
      // a reconnect (Discord asks for one now and then) is not news: the greeting is said once per start
      if (this.bot !== bot || this.greeted) return
      this.greeted = true
      // what already waits is said once in the greeting, then only what is new
      const st = this.h.status()
      for (const n of st.needs) this.known.add(keyOf(n))
      this.focus = st.needs[0]
      this.lastNotice = this.d.now()
      this.say(this.lang === 'ko' ? `우로 연결됐어요. ${statusLine(st, 'ko')}` : `Ouro is connected. ${statusLine(st, 'en')}`)
    })
    bot.on('message', (m: DiscordMessage) => {
      if (this.bot !== bot) return
      this.queue = this.queue
        .then(() => this.onMessage(m.text))
        .catch((err) => {
          this.h.log(`[ouro] ${err instanceof Error ? err.message : String(err)}`)
          // the owner in the car hears that it failed instead of nothing
          this.say(this.lang === 'ko' ? '문제가 생겨서 처리하지 못했어요. PC에서 확인해 주세요.' : 'Something went wrong; check it at the PC.')
        })
    })
    bot.on('state', (s: DiscordState, detail: string) => {
      if (this.bot === bot) this.h.log(`[ouro] discord ${s}${detail && s !== 'ready' ? `: ${detail}` : ''}`)
    })
    bot.start()
  }

  stop(): void {
    this.configure({ ...this.cfg, enabled: false })
  }

  status(): { state: DiscordState; detail: string; username: string } {
    return this.bot ? { state: this.bot.state, detail: this.bot.detail, username: this.bot.username } : { state: 'off', detail: '', username: '' }
  }

  /** Settings → Ouro → Test: a DM to the owner. */
  async test(): Promise<OuroResult> {
    if (!this.bot) return { ok: false, error: 'Ouro is off, or the token or your Discord user ID is missing' }
    try {
      await this.bot.send(this.lang === 'ko' ? '우로 연결 테스트예요. "상황 어때"라고 답해 보세요.' : 'Ouro connection test. Reply "status".')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Something on the board changed (a question, an approval, a task): new needs are told, at most once a minute. */
  boardChanged(): void {
    if (!this.bot || !this.cfg.notify || this.noticeTimer !== undefined) return
    const wait = Math.max(NOTICE_DEBOUNCE_MS, this.lastNotice + OURO_LIMITS.noticeGapMs - this.d.now())
    this.noticeTimer = this.d.setTimeout(() => {
      this.noticeTimer = undefined
      this.notice()
    }, wait)
  }

  /** A card finished a turn: the Conductor's reply to something the owner said comes back, a few times. */
  stopped(card: string, message: string): void {
    const r = this.relay
    if (!r || r.card !== card || this.d.now() > r.until || r.left <= 0 || !message.trim()) return
    r.left--
    this.say(spoken(message))
  }

  private notice(): void {
    if (!this.bot || this.bot.state !== 'ready' || !this.cfg.notify) return
    const needs = this.h.status().needs
    const fresh = needs.filter((n) => !this.known.has(keyOf(n)))
    // what was answered elsewhere is forgotten, so a task blocked again later is told again
    this.known = new Set(needs.map(keyOf).filter((k) => this.known.has(k)))
    if (!fresh.length) return
    for (const n of fresh) this.known.add(keyOf(n))
    this.lastNotice = this.d.now()
    this.focus = fresh[0]
    const ko = this.lang === 'ko'
    const head = fresh.length > 1 ? (ko ? `새로 기다리는 게 ${fresh.length}개예요. 첫 번째, ` : `${fresh.length} new things wait on you. First, `) : ko ? '새로 기다리는 게 있어요. ' : 'Something new waits on you. '
    this.say(head + needLine(fresh[0], this.lang))
  }

  /** Anything Ouro says other than a read-back drops the read-back: a yes is for what the owner heard last. */
  private say(text: string, readBack = false): void {
    const bot = this.bot
    if (!readBack) this.pending = undefined
    if (!bot) return
    bot.send(text.slice(0, OURO_LIMITS.messageChars)).catch((err) => this.h.log(`[ouro] not sent: ${err instanceof Error ? err.message : String(err)}`))
  }

  private async onMessage(raw: string): Promise<void> {
    const text = raw.slice(0, OURO_LIMITS.inChars)
    const lang = langOf(text)
    this.lang = lang
    const ko = lang === 'ko'
    const i = intentOf(text)
    const p = this.pending
    this.pending = undefined
    if (p && this.d.now() - p.at <= OURO_LIMITS.confirmMs) {
      // only a reply that is nothing but a yes acts: "응 아니 잠깐" or "ok wait, hold it" cancels
      if (isOnlyYes(text)) return this.act(p.need, p.action, lang)
      if (i.type === 'yes' || i.type === 'no' || i.type === 'hold' || soundsLikeNo(text)) return this.say(ko ? '알겠어요, 안 할게요.' : 'OK, I will not.')
    } else if (p && i.type === 'yes') {
      return this.say(ko ? '시간이 지나서 취소했어요. 다시 말해 주세요.' : 'That timed out; say it again.')
    }
    switch (i.type) {
      case 'help':
        return this.say(helpLine(lang))
      case 'status': {
        const st = this.h.status()
        this.focus = st.needs[0]
        return this.say(statusLine(st, lang))
      }
      case 'next': {
        const needs = this.h.status().needs
        const at = this.focus ? needs.findIndex((n) => n.ref === this.focus!.ref) + 1 : 0
        if (!needs.length || at >= needs.length) {
          this.focus = undefined
          return this.say(ko ? '더 기다리는 건 없어요.' : 'Nothing else waits on you.')
        }
        this.focus = needs[at]
        return this.say(`${ko ? `${at + 1}/${needs.length}. ` : `${at + 1} of ${needs.length}. `}${needLine(needs[at], lang)}`)
      }
      case 'approve':
      case 'hold':
        return this.ask(this.target(), i.type, lang)
    }
    // a choice to the question the owner just heard
    const f = this.focus
    if (f?.kind === 'question' && f.answers?.length) {
      const a = matchAnswer(text, f.answers)
      if (a) return this.ask(f, { kind: 'answer', answer: a }, lang)
    }
    if (i.type !== 'tell') return this.say(ko ? '무엇에 대한 답인지 모르겠어요. "상황 어때"라고 물어보세요.' : 'I am not sure what that answers. Ask "status" first.')
    const r = this.h.tell(i.text, lang)
    if (!r.ok) return this.say(ko ? `Conductor에게 못 전했어요: ${r.error}` : `Not delivered to the Conductor: ${r.error}`)
    this.relay = { card: r.card, until: this.d.now() + OURO_LIMITS.relayMs, left: OURO_LIMITS.relays }
    this.h.note(`told the Conductor: ${i.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    this.say(ko ? 'Conductor에게 전했어요. 답이 오면 읽어 드릴게요.' : 'Passed to the Conductor. I will read you its answer.')
  }

  /** what "approve" or "hold" is about: the need the owner last heard, else the first one that can be decided */
  private target(): OuroNeed | undefined {
    if (this.focus) return this.focus
    return this.h.status().needs.find((n) => ACTIONABLE.has(n.kind))
  }

  /** Reads the decision back and waits for a yes; refuses what Ouro may not decide. */
  private ask(need: OuroNeed | undefined, action: Action | 'approve' | 'hold', lang: Lang): void {
    const ko = lang === 'ko'
    if (!need) return this.say(ko ? '지금 결정할 건 없어요.' : 'Nothing waits on a decision.')
    let a: Action = typeof action === 'string' ? { kind: action } : action
    if (need.kind === 'question' && a.kind !== 'answer') {
      // a question without choices takes Approve / Deny
      const pick = (need.answers ?? []).find((x) => x === (a.kind === 'approve' ? 'Approve' : 'Deny'))
      if (!pick) return this.say(`${titleOf(need)}: ${howTo(need, lang)}`)
      a = { kind: 'answer', answer: pick }
    }
    if (need.kind === 'permission' || (need.kind === 'task-do' && a.kind === 'approve')) return this.say(`${titleOf(need)}: ${howTo(need, lang)}`)
    // what is approved is read back word for word: a long command or one with a link is approved at the PC or phone
    if (a.kind === 'approve' && !readableAloud(need.text)) return this.say(`${titleOf(need)}: ${howTo(need, lang)}`)
    if (!this.cfg.approvals) return this.say(ko ? '설정에서 우로의 허가와 답이 꺼져 있어요. PC에서 해 주세요.' : 'Approvals by Ouro are off in Settings; answer it at the PC.')
    this.focus = need
    this.pending = { need, action: a, at: this.d.now() }
    this.say(confirmLine(need, a.kind === 'answer' ? a.answer : a.kind, lang), true)
  }

  private act(need: OuroNeed, a: Action, lang: Lang): void {
    const ko = lang === 'ko'
    // switched off at the PC while the read-back waited
    if (!this.cfg.approvals) return this.say(ko ? '설정에서 우로의 허가와 답이 꺼져 있어요. PC에서 해 주세요.' : 'Approvals by Ouro are off in Settings; answer it at the PC.')
    const r = a.kind === 'approve' ? this.h.approve(need) : a.kind === 'hold' ? this.h.hold(need) : this.h.answer(need, a.answer)
    const what = a.kind === 'approve' ? 'approved' : a.kind === 'hold' ? (need.kind === 'approval' ? 'denied' : 'put on hold') : `answered "${a.answer}" to`
    this.h.note(`${r.ok ? what : `could not ${what.replace(/ to$/, '')}`} ${need.ref.replace(/^\d+-/, '')} (${need.title})${r.ok ? '' : `: ${r.error}`}`)
    if (!r.ok) return this.say(ko ? `못 했어요: ${r.error}` : `Not done: ${r.error}`)
    if (this.focus?.ref === need.ref) this.focus = undefined
    this.known.add(keyOf(need))
    const done = a.kind === 'approve' ? (ko ? '허가했어요. 카드에 전했어요.' : 'Approved; the card was told.') : a.kind === 'hold' ? (ko ? '보류했어요.' : 'Put on hold.') : ko ? `"${a.answer}"(으)로 답했어요.` : `Answered "${a.answer}".`
    this.say(r.warning ? `${done} ${r.warning}` : done)
  }
}
