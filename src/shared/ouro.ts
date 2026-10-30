/**
 * Ouro: the owner talking to the board from the car through Discord direct messages, which Android Auto reads aloud
 * and answers by voice. Pure: what a message means, what Ouro says back, and text shaped for being heard.
 * Anything that decides something (an approval, an answer) is confirmed by a spoken yes first; everything else
 * goes to the Conductor.
 */

export type Lang = 'ko' | 'en'

/** Something on the board waiting on the owner, as Ouro reads it out. */
export interface OuroNeed {
  /** window-scoped id: `<window>-D3` (question), `<window>-A2` (gate approval), `<window>-T46` (task) or `<window>-P:<card>` */
  ref: string
  kind: 'question' | 'approval' | 'task-approve' | 'task-do' | 'task-either' | 'permission'
  /** the card (or task) it belongs to */
  title: string
  text: string
  /** question: the answers to pick from */
  answers?: string[]
  /** task: its updatedAt when read, so an answer to a changed task is refused */
  shownAt?: number
}

export interface OuroStatus {
  project: string
  working: number
  idle: number
  autonomous: boolean
  needs: OuroNeed[]
}

export type Intent =
  | { type: 'status' }
  | { type: 'next' }
  | { type: 'help' }
  | { type: 'yes' }
  | { type: 'no' }
  | { type: 'approve' }
  | { type: 'hold' }
  | { type: 'pick'; index: number }
  | { type: 'tell'; text: string }

export const OURO_LIMITS = {
  spokenChars: 350,
  messageChars: 1800,
  confirmMs: 3 * 60_000,
  noticeGapMs: 60_000,
  relayMs: 20 * 60_000,
  relays: 3,
  inChars: 2000,
  /** the car ready message waits past Discord's mobile-notification delay (the owner sets it to 1 minute): a DM sent while the PC still counts as active never reaches the phone */
  carDelayMs: 75_000,
  /**
   * Android Auto shows a messenger only the notifications that arrived during the current connection, so a car that
   * reconnects needs a fresh message (2026-10-30: the 18:12 greeting was gone from the car after an 18:18 reconnect).
   * The gap only absorbs a Bluetooth link that flaps for a moment.
   */
  carGapMs: 2 * 60_000,
  /** a card's post to a server channel (Discord takes 2000 per message; the bot splits it) */
  postChars: 4000,
  /** channels the owner may allow (Settings → Ouro → Channels) */
  channels: 20,
  /** posts per channel in a window, tries included: a card in a loop must not flood a channel people read */
  postsPerWindow: 10,
  postWindowMs: 10 * 60_000
} as const

/** Pure: Korean when the text has Hangul in it, else English. */
export function langOf(text: string): Lang {
  return /[가-힣]/.test(text) ? 'ko' : 'en'
}

// \b is an ASCII word boundary and never matches after a Hangul syllable: words end at a space, punctuation or the end
const END = '(?=$|[\\s.!?,~])'
const word = (alts: string): RegExp => new RegExp(`^(?:${alts})${END}`, 'i')
// "어" is left out: it is also the filler "uh"
const YES = word('응|네|넵|예|그래|좋아|맞아|오케이|ㅇㅇ|yes|yeah|yep|ok|okay|sure')
const NO = word('아니|아니요|아뇨|아냐|싫어|취소|no|nope|cancel')
// a read-back is confirmed only by a reply that is nothing but a yes: "응 아니 잠깐" or "어, 그거 말고" is not one
const ONLY_YES = new RegExp(`^(?:응|네|넵|예|그래|좋아|맞아|오케이|ㅇㅇ|yes|yeah|yep|ok|okay|sure)(?:\\s*(?:해|해줘|해 줘|please))?[\\s.!~]*$`, 'i')
// whole short phrases only: "다음 주에 배포하자고 전해줘" or "상태바 고쳐 달라고 해" goes to the Conductor
const STATUS = /^(?:(?:지금\s*)?(?:상황|상태)(?:\s*(?:어때|알려\s*줘|좀))?|어때|뭐\s*해|status|what'?s up|how'?s it going)[\s.!?~]*$/i
const NEXT = /^(?:다음|다음\s*(?:거|건|것)|next|next one)[\s.!?~]*$/i
const HELP = /^(도움|도움말|명령|help|\?)$/i
const APPROVE = word('허가|허가해|허가해줘|승인|승인해|해도\s*돼|진행해|approve|go ahead')
const HOLD = word('보류|나중에|기다려|하지\s*마|hold|not now|wait')
const ORDINAL: Record<string, number> = { 첫: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4 }

/** Pure: what a message from the owner asks for. */
export function intentOf(raw: string): Intent {
  const t = raw.trim().replace(/\s+/g, ' ')
  if (!t) return { type: 'help' }
  // a number first: "네 번째" is the fourth, not a yes
  const n = /^(\d)\s*(번|번째)?$/.exec(t) ?? /^(첫|하나|두|둘|세|셋|네|넷)\s*(번째|번)$/.exec(t) ?? /^(one|first|two|second|three|third|four|fourth)$/i.exec(t)
  if (n) return { type: 'pick', index: (Number(n[1]) || ORDINAL[n[1].toLowerCase()] || 0) - 1 }
  if (YES.test(t)) return { type: 'yes' }
  if (NO.test(t)) return { type: 'no' }
  if (HELP.test(t)) return { type: 'help' }
  if (STATUS.test(t)) return { type: 'status' }
  if (NEXT.test(t)) return { type: 'next' }
  if (APPROVE.test(t)) return { type: 'approve' }
  if (HOLD.test(t)) return { type: 'hold' }
  return { type: 'tell', text: t.slice(0, OURO_LIMITS.inChars) }
}

/** Pure: the whole reply is a yes (the only thing that confirms a read-back). */
export function isOnlyYes(raw: string): boolean {
  return ONLY_YES.test(raw.trim().replace(/\s+/g, ' '))
}

/** Pure: a no anywhere in the reply ("어 아니 하지 마", "ok wait"): while a read-back waits, it cancels it. */
export function soundsLikeNo(raw: string): boolean {
  return /아니|아뇨|아냐|하지\s*마|잠깐|취소|보류|싫어|(^|[^a-z])(no|nope|wait|hold|cancel|stop)([^a-z]|$)/i.test(raw)
}

/**
 * Pure: whether an approval can be read aloud as it is. A command or request that is long, or has a link or marks
 * that would not be heard, is not approved by voice: the owner reads it in full at the PC or on the phone.
 */
export function readableAloud(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 0 && t.length <= 160 && spoken(t, 160) === t
}

/** Pure: a card's or task's title, made safe to read out (no links or marks, short). */
export function titleOf(n: Pick<OuroNeed, 'title'>): string {
  return spoken(n.title, 80) || 'a card'
}

/** Pure: the answer to a question the owner meant: a number, the answer's own words, or the only answer containing them. */
export function matchAnswer(text: string, answers: readonly string[]): string | undefined {
  const t = text.trim().toLowerCase().replace(/[.!?~]+$/, '').replace(/(으로|로)\s*(해|해줘|할게|하자|가자)?$/, '').trim()
  const i = intentOf(text)
  if (i.type === 'pick' && i.index >= 0 && i.index < answers.length) return answers[i.index]
  // "응" to a question whose answers are Yes / No
  if (i.type === 'yes' || i.type === 'no') {
    const like = answers.filter((a) => (i.type === 'yes' ? YES : NO).test(a.trim()))
    if (like.length === 1) return like[0]
  }
  const exact = answers.find((a) => a.toLowerCase() === t)
  if (exact) return exact
  // part of an answer, or an answer said as whole words: "know" does not contain the answer "No"
  const words = ` ${t.replace(/[.,!?~]/g, ' ').replace(/\s+/g, ' ')} `
  const hits = answers.filter((a) => t.length >= 2 && (a.toLowerCase().includes(t) || words.includes(` ${a.toLowerCase()} `)))
  return hits.length === 1 ? hits[0] : undefined
}

/** Pure: text made for listening: no markdown, code, links or lists, cut at a sentence near the limit. */
export function spoken(text: string, max: number = OURO_LIMITS.spokenChars): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>|#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= max) return t
  t = t.slice(0, max)
  const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('다. '), t.lastIndexOf('요. '), t.lastIndexOf('? '), t.lastIndexOf('! '))
  return (cut > max / 2 ? t.slice(0, cut + 1) : t).trim() + ' …'
}

const KIND_KO: Record<OuroNeed['kind'], string> = {
  question: '질문',
  approval: '명령 허가 요청',
  'task-approve': '허가 요청',
  'task-do': '직접 하셔야 하는 일',
  'task-either': '결정 요청',
  permission: '권한 확인'
}
const KIND_EN: Record<OuroNeed['kind'], string> = {
  question: 'a question',
  approval: 'a command to approve',
  'task-approve': 'an approval',
  'task-do': 'something only you can do',
  'task-either': 'a decision',
  permission: 'a permission prompt'
}

/** Pure: how to answer a need, said after it. */
export function howTo(n: OuroNeed, lang: Lang): string {
  const ko = lang === 'ko'
  switch (n.kind) {
    case 'question':
      return ko ? `보기: ${(n.answers ?? []).join(', ')}. 고를 말을 하세요.` : `Choices: ${(n.answers ?? []).join(', ')}. Say the one you pick.`
    case 'approval':
    case 'task-approve':
    case 'task-either':
      if (!readableAloud(n.text)) return ko ? '길거나 링크가 있어서 음성으로는 허가할 수 없어요. PC나 폰 페이지에서 전체를 보고 하세요. 보류는 돼요.' : 'It is long or has a link, so it cannot be approved by voice: read it in full at the PC or on the phone. Hold works.'
      return ko ? '허가 또는 보류라고 하세요.' : 'Say approve or hold.'
    case 'task-do':
      return ko ? '이건 PC에서 직접 하셔야 해요.' : 'You have to do this one at the PC.'
    case 'permission':
      return ko ? '카드가 터미널 권한 확인을 기다려요. PC나 폰 페이지에서 답하세요.' : 'The card waits on a terminal prompt; answer it at the PC or on the phone page.'
  }
}

/** Pure: one need read out, with how to answer it. */
export function needLine(n: OuroNeed, lang: Lang): string {
  const kind = (lang === 'ko' ? KIND_KO : KIND_EN)[n.kind]
  const head = `${titleOf(n)}: ${kind}. ${spoken(n.text, 200)}`
  return `${head} ${howTo(n, lang)}`
}

/** Pure: the board in one or two sentences, then the first thing waiting. */
/** Pure: what Ouro says when the phone connects to the car, so there is a message to reply to by voice. */
export function carReadyLine(s: OuroStatus, lang: Lang): string {
  return lang === 'ko' ? `🚗 우로 준비됐어요. 이 메시지에 답장해서 일을 시켜 주세요. ${statusLine(s, 'ko')}` : `🚗 Ouro is ready. Reply to this message to give me work. ${statusLine(s, 'en')}`
}

export function statusLine(s: OuroStatus, lang: Lang): string {
  const ko = lang === 'ko'
  const run = s.autonomous ? (ko ? ' 자율 실행 중이에요.' : ' An autonomous run is on.') : ''
  const head = ko ? `${s.working}개 일하는 중, ${s.idle}개 쉬는 중이에요.${run}` : `${s.working} working, ${s.idle} idle.${run}`
  if (!s.needs.length) return `${head} ${ko ? '기다리는 건 없어요.' : 'Nothing is waiting on you.'}`
  const more = s.needs.length > 1 ? (ko ? ` 기다리는 게 ${s.needs.length}개예요. 첫 번째는` : ` ${s.needs.length} things wait on you. First:`) : ko ? ' 기다리는 게 하나 있어요.' : ' One thing waits on you.'
  return `${head}${more} ${needLine(s.needs[0], lang)}`
}

/** Pure: the read-back before Ouro acts on the owner's behalf. */
export function confirmLine(n: OuroNeed, action: 'approve' | 'hold' | string, lang: Lang): string {
  const ko = lang === 'ko'
  const title = titleOf(n)
  // the text exactly as it will be approved: Ouro refuses by voice what is not readableAloud()
  const text = n.text.replace(/\s+/g, ' ').trim()
  if (action === 'approve') return ko ? `${title}: "${text}" 허가할까요? 응이라고만 답하세요.` : `${title}: "${text}". Approve it? Say just yes.`
  if (action === 'hold') return ko ? `${title} 건을 보류할까요? 응이라고만 답하세요.` : `Put ${title} on hold? Say just yes.`
  return ko ? `${title}의 질문에 "${spoken(action, 120)}"(으)로 답할까요? 응이라고만 답하세요.` : `Answer ${title}'s question with "${spoken(action, 120)}"? Say just yes.`
}

export function helpLine(lang: Lang): string {
  return lang === 'ko'
    ? '말할 수 있는 것: "상황 어때", "다음", "허가", "보류", 질문의 보기 이름이나 번호. 그 밖의 말은 Conductor에게 전해요. 허가와 답은 제가 한 번 되물은 다음에만 해요.'
    : 'You can say: "status", "next", "approve", "hold", or a choice by name or number. Anything else goes to the Conductor. I always read an approval or an answer back before I act on it.'
}

/** Pure: what the Conductor gets with a message the owner spoke to Ouro. */
export function conductorPrompt(text: string, lang: Lang): string {
  return [
    '[Ouro] The owner is speaking to you from the car through Discord voice (Android Auto reads your reply aloud).',
    `Reply in one or two short spoken sentences in ${lang === 'ko' ? 'Korean' : 'English'}: no markdown, lists, code or links. If the work takes a while, say you started it and report when it is done.`,
    'The owner said:',
    ...text.split('\n').map((l) => `> ${l}`)
  ].join('\n')
}

export type OuroBotState = 'off' | 'connecting' | 'ready' | 'retrying' | 'failed'

/** A server channel the owner lets cards post to (Settings → Ouro → Channels). */
export interface OuroChannel {
  /** how a card names it: the channel's name without the # */
  name: string
  /** the channel's id (Developer Mode → right-click the channel → Copy Channel ID) */
  id: string
}

const CHANNEL_ID = /^\d{15,22}$/

/**
 * Pure: the stored channel list, cleaned: a name (the # dropped, at most 40 characters) and a channel id; a row
 * without either, or one that repeats a name or an id, is dropped; at most OURO_LIMITS.channels.
 */
export function ouroChannels(raw: unknown): OuroChannel[] {
  if (!Array.isArray(raw)) return []
  const out: OuroChannel[] = []
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue
    const { name, id } = c as Record<string, unknown>
    const n = typeof name === 'string' ? name.trim().replace(/^#+/, '').trim().slice(0, 40) : ''
    const i = typeof id === 'string' ? id.trim() : ''
    if (!n || !CHANNEL_ID.test(i)) continue
    if (out.some((x) => x.name.toLowerCase() === n.toLowerCase() || x.id === i)) continue
    out.push({ name: n, id: i })
    if (out.length >= OURO_LIMITS.channels) break
  }
  return out
}

/** Pure: the allowed channel a card named, by name (# optional, any case) or by id. */
export function ouroChannel(channels: OuroChannel[], nameOrId: string): OuroChannel | undefined {
  const want = nameOrId.trim().replace(/^#+/, '').trim().toLowerCase()
  if (!want) return undefined
  return channels.find((c) => c.name.toLowerCase() === want || c.id === want)
}

/** Pure: what a card hears with a refused channel: the names it may use. */
export function channelsLine(channels: OuroChannel[]): string {
  return channels.length ? `channels the owner allows: ${channels.map((c) => `#${c.name}`).join(', ')}` : 'the owner has allowed no channels (Settings → Ouro → Channels)'
}

/** Settings → Ouro, as stored (the bot token is kept apart, encrypted). */
export interface OuroSettingsView {
  enabled: boolean
  /** the owner's Discord user ID: only its direct messages are read */
  ownerId: string
  notify: boolean
  approvals: boolean
  /** server channels any agent card with board tools may post to without asking */
  channels: OuroChannel[]
}

export interface OuroStatusView extends OuroSettingsView {
  hasToken: boolean
  state: OuroBotState
  detail: string
  username: string
}

/** Pure: stored settings with the defaults filled in (notices and voice approvals on). */
export function ouroSettings(raw: Partial<OuroSettingsView> | undefined): OuroSettingsView {
  return {
    enabled: raw?.enabled === true,
    ownerId: typeof raw?.ownerId === 'string' ? raw.ownerId.trim().slice(0, 22) : '',
    notify: raw?.notify !== false,
    approvals: raw?.approvals !== false,
    channels: ouroChannels(raw?.channels)
  }
}
