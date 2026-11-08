/**
 * Ouro calls the owner: the app's side of the phone. Twilio places the call (the Calls API, with the owner's number
 * pinned in Settings), an ElevenLabs agent (Claude) holds it in Korean, and this module answers the webhooks both of
 * them post to the loopback reply server behind Tailscale Funnel: Twilio's "answered" (TwiML from ElevenLabs'
 * register-call), the agent's one tool, Twilio's call status, ElevenLabs' post-call transcript, and the owner calling
 * in. It also provisions the agent and keeps the call log with the daily cap. No Electron: fetch, the clock, timers
 * and the PC's idle time are passed in, so it runs under vitest. Secrets never reach a log line.
 * Design: docs/DESIGN-2026-11-08-ouro-call.md.
 */
import type http from 'node:http'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Lang, OuroNeed } from '@shared/ouro'
import {
  CALL_LIMITS,
  CALL_PATHS,
  CALL_PATH_LIST,
  TWIML_HANGUP,
  TWIML_REJECT,
  agentConfig,
  callMenu,
  callMissing,
  callVariables,
  callbackMenu,
  callsToday,
  inQuietHours,
  ouroCallSettings,
  parseToolCall,
  toolConfig,
  twimlSayHangup,
  type CallAction,
  type CallDirection,
  type CallMenu,
  type CallOutcome,
  type CallRecord,
  type OuroCallSettingsView,
  type OuroCallStatusView
} from '@shared/ouro-call'
import { readRawBody, sendJson } from './grok-reply'
import type { OuroResult } from './ouro'

const TWILIO_API = 'https://api.twilio.com/2010-04-01'
const ELEVEN_API = 'https://api.elevenlabs.io/v1'
/** the ring before Twilio gives up (seconds) */
const RING_SECONDS = 25

/** What the call reaches in the app: Ouro's board and its rules (main/ouro.ts). */
export interface VoiceBridge {
  needs(): OuroNeed[]
  status(lang: Lang): string
  /** acts under the Discord dialogue's rules; returns the line the agent says */
  act(ref: string, action: Exclude<CallAction, 'status'>, answer: string | undefined, lang: Lang): Promise<string>
  /** the owner picked up (or called): whatever waited for a reaction has it */
  reached(): void
  /** a Discord DM to the owner: the fallback when the phone cannot */
  tell(text: string): void
  note(line: string): void
  log(line: string): void
}

export interface VoiceSecrets {
  twilioToken?: string
  elevenKey?: string
  /** the header the agent's tool sends; made at Provision */
  toolKey?: string
  /** ElevenLabs' post-call webhook secret */
  webhookSecret?: string
}

export interface VoiceDeps {
  fetch?: typeof fetch
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
  /** seconds since the last key or mouse at the PC (Electron's powerMonitor); Infinity when unknown */
  idleSeconds?: () => number
  randomHex?: (bytes: number) => string
}

/** The calls placed and taken, kept in userData (the daily cap survives a restart). */
export class CallLog {
  calls: CallRecord[] = []

  constructor(
    private file: string,
    private log: (line: string) => void = () => {}
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { calls?: unknown }
      this.calls = Array.isArray(raw.calls) ? raw.calls.filter((c): c is CallRecord => !!c && typeof c === 'object' && typeof (c as CallRecord).id === 'string' && typeof (c as CallRecord).at === 'number').slice(-CALL_LIMITS.logKeep) : []
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          renameSync(file, `${file}.unreadable-${Date.now()}`)
        } catch {
          /* left in place: the next save overwrites it */
        }
        log(`[ouro-call] could not read ${file}: ${(e as Error).message}; started empty`)
      }
    }
  }

  add(rec: CallRecord): void {
    this.calls = [...this.calls, rec].slice(-CALL_LIMITS.logKeep)
    this.save()
  }

  update(id: string, patch: Partial<CallRecord>): CallRecord | undefined {
    let out: CallRecord | undefined
    this.calls = this.calls.map((c) => (c.id === id ? (out = { ...c, ...patch }) : c))
    if (out) this.save()
    return out
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ calls: this.calls }))
      renameSync(tmp, this.file)
    } catch (e) {
      this.log(`[ouro-call] could not save ${this.file}: ${(e as Error).message}`)
    }
  }
}

interface Session {
  token: string
  at: number
  /** the https origin the call's webhooks were addressed to: Twilio signs them with it, even if the setting moves later */
  base: string
  menu: CallMenu
  lang: Lang
  direction: CallDirection
  answered: boolean
  done: boolean
  /** the post-call summary was told once */
  summarized: boolean
  conversationId?: string
  /** no Twilio callback at all after the dial */
  watchdog?: unknown
  /** the end Twilio must report by the time limit; the app closes the call itself when it does not */
  ender?: unknown
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest()
const same = (a: string, b: string): boolean => timingSafeEqual(sha(a), sha(b))
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const ko = (lang: Lang): boolean => lang === 'ko'
/** a number for a log line: the last digits only */
const tail = (phone: string): string => `…${phone.slice(-4)}`

function sendXml(res: http.ServerResponse, body: string): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' }).end(body)
}

/**
 * Twilio's X-Twilio-Signature: base64(HMAC-SHA1(auth token, URL + the POST parameters sorted by name, each name
 * then value)). Twilio documents that voice webhooks over https are signed with the URL *without* its port, so both
 * spellings are tried. Pure apart from the crypto.
 */
export function twilioSignatureOk(authToken: string, url: string, form: URLSearchParams, header: string | undefined): boolean {
  if (!authToken || !header) return false
  const keys = [...new Set(form.keys())].sort()
  const suffix = keys.map((k) => k + form.getAll(k).sort().join('')).join('')
  const variants = new Set<string>([url])
  try {
    const u = new URL(url)
    if (u.port) {
      u.port = ''
      variants.add(u.toString())
    }
  } catch {
    return false
  }
  const given = Buffer.from(header, 'utf8')
  for (const v of variants) {
    const expected = Buffer.from(createHmac('sha1', authToken).update(v + suffix).digest('base64'), 'utf8')
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true
  }
  return false
}

/**
 * ElevenLabs' `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>`: v0 is HMAC-SHA256(secret, `${t}.${body}`); a
 * timestamp further than the tolerance from now, either way, is refused (their SDK uses 30 minutes).
 */
export function elevenSignatureOk(secret: string, raw: string, header: string | undefined, now: number, toleranceMs = CALL_LIMITS.signatureToleranceMs): boolean {
  if (!secret || !header) return false
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]))
  const t = Number(parts.t)
  const v0 = parts.v0 ?? ''
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(v0)) return false
  if (Math.abs(now - t * 1000) > toleranceMs) return false
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  return same(expected, v0.toLowerCase())
}

/** A status callback's outcome, as the owner is told it. */
const MISS_LINE: Partial<Record<CallOutcome, { ko: string; en: string }>> = {
  'no-answer': { ko: '전화를 받지 않으셨어요. 기다리는 건 디스코드에 그대로 있어요.', en: 'You did not pick up; what waits is still in Discord.' },
  busy: { ko: '통화 중이라 연결되지 않았어요. 기다리는 건 디스코드에 있어요.', en: 'The line was busy; what waits is in Discord.' },
  failed: { ko: '전화 연결에 실패했어요 (Twilio). 기다리는 건 디스코드에 있어요.', en: 'The call failed (Twilio); what waits is in Discord.' },
  canceled: { ko: '전화가 연결 전에 끊겼어요. 기다리는 건 디스코드에 있어요.', en: 'The call was dropped before it connected; what waits is in Discord.' },
  machine: { ko: '자동응답기가 받아서 끊었어요. 기다리는 건 디스코드에 있어요.', en: 'Voicemail answered, so I hung up; what waits is in Discord.' },
  dropped: { ko: '전화가 연결됐지만 우로가 말하기 전에 끊겼어요. 기다리는 건 디스코드에 있어요.', en: 'The call connected but ended before Ouro could speak; what waits is in Discord.' },
  unconfirmed: { ko: '전화를 걸었는데 연결 확인이 오지 않아요. Funnel과 Twilio 설정을 확인해 주세요. 기다리는 건 디스코드에 있어요.', en: 'I placed the call but got no confirmation back; check Funnel and the Twilio settings. What waits is in Discord.' }
}

export class VoiceCaller {
  private view: OuroCallSettingsView = ouroCallSettings(undefined)
  private secrets: VoiceSecrets = {}
  private base = ''
  private sessions = new Map<string, Session>()
  private readonly d: Required<VoiceDeps>

  constructor(
    private readonly store: CallLog,
    private readonly bridge: VoiceBridge,
    deps: VoiceDeps = {}
  ) {
    this.d = {
      fetch: deps.fetch ?? fetch,
      now: deps.now ?? Date.now,
      setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
      idleSeconds: deps.idleSeconds ?? (() => Infinity),
      randomHex: deps.randomHex ?? ((n) => randomBytes(n).toString('hex'))
    }
  }

  /** Settings → Ouro → Phone calls onto the caller; base is the https origin the webhooks are reachable at. */
  configure(view: OuroCallSettingsView, secrets: VoiceSecrets, base: string): void {
    this.view = view
    this.secrets = secrets
    this.base = base
  }

  get enabled(): boolean {
    return this.view.enabled
  }

  /** What still has to be set before a call can go out. */
  missing(): string[] {
    return callMissing(this.view, { twilioToken: Boolean(this.secrets.twilioToken), elevenKey: Boolean(this.secrets.elevenKey), toolKey: Boolean(this.secrets.toolKey) }, this.base)
  }

  status(): Pick<OuroCallStatusView, 'missing' | 'todayCalls' | 'active' | 'last'> {
    const active = [...this.sessions.values()].find((s) => !s.done)
    const rec = active && this.store.calls.find((c) => c.id === active.token)
    return {
      missing: this.missing(),
      todayCalls: callsToday(this.store.calls, this.d.now()),
      active: rec ? { at: rec.at, outcome: rec.outcome, reason: rec.reason } : undefined,
      last: this.store.calls[this.store.calls.length - 1]
    }
  }

  /** Ouro's Caller: the ladder fired for these needs. */
  readonly call = (needs: OuroNeed[], lang: Lang): Promise<OuroResult> => this.place('ladder', lang, needs)

  /** Settings → Test call: rings the owner and says it is a test. */
  test(): Promise<OuroResult> {
    return this.place('test', 'ko', [])
  }

  private async place(reason: CallRecord['reason'], lang: Lang, needs: OuroNeed[]): Promise<OuroResult> {
    if (!this.view.enabled) return { ok: false, error: 'phone calls are off (Settings → Ouro → Phone calls)' }
    const missing = this.missing()
    if (missing.length) return { ok: false, error: `not set yet: ${missing.join(', ')}` }
    const now = this.d.now()
    for (const [k, s] of this.sessions) if (s.done && now - s.at > CALL_LIMITS.sessionKeepMs) this.sessions.delete(k)
    if (reason === 'ladder') {
      // someone typing at the PC has the board in front of them
      if (this.d.idleSeconds() < CALL_LIMITS.idleSeconds) return { ok: true, warning: 'the owner is at the PC' }
      if (inQuietHours(new Date(now), this.view.quietFrom, this.view.quietTo)) return { ok: true, warning: `quiet hours (${this.view.quietFrom}–${this.view.quietTo})` }
    }
    if ([...this.sessions.values()].some((s) => !s.done)) return { ok: true, warning: 'a call is under way' }
    if (callsToday(this.store.calls, now) >= this.view.maxPerDay) return { ok: false, error: `today's ${this.view.maxPerDay} calls are used up (Settings → Ouro → Phone calls)` }
    const token = this.d.randomHex(16)
    const menu: CallMenu =
      reason === 'test'
        ? { situation: ko(lang) ? '연결 테스트예요. 잘 들리면 "끝"이라고 해 주세요.' : 'This is a connection test. Say "bye" if you hear me.', options: '', items: [], needs: [] }
        : reason === 'callback'
          ? callbackMenu(this.bridge.needs(), this.bridge.status(lang), lang)
          : callMenu(needs, lang)
    const base = this.base
    const session: Session = { token, at: now, base, menu, lang, direction: reason === 'callback' ? 'callback' : 'outbound', answered: false, done: false, summarized: false }
    this.sessions.set(token, session)
    this.store.add({ id: token, at: now, direction: 'outbound', reason, outcome: 'placed', refs: menu.needs.map((n) => n.ref) })
    const form = new URLSearchParams({
      To: this.view.ownerPhone,
      From: this.view.fromNumber,
      Url: `${base}${CALL_PATHS.answer}?c=${token}`,
      Method: 'POST',
      StatusCallback: `${base}${CALL_PATHS.status}?c=${token}`,
      StatusCallbackMethod: 'POST',
      Timeout: String(RING_SECONDS),
      TimeLimit: String(this.view.maxMinutes * 60),
      // voicemail gets a hang-up, not a conversation with the greeting
      MachineDetection: 'Enable'
    })
    // every step of the call is reported, so the first one (initiated) already proves Twilio can reach this PC
    for (const ev of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', ev)
    let res: Response
    try {
      res = await this.d.fetch(`${TWILIO_API}/Accounts/${this.view.twilioSid}/Calls.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${b64(`${this.view.twilioSid}:${this.secrets.twilioToken}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(CALL_LIMITS.twilioTimeoutMs)
      })
    } catch (err) {
      return this.notPlaced(session, `Twilio could not be reached: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) return this.notPlaced(session, `Twilio refused the call (${res.status}): ${await apiError(res)}`)
    const body = (await res.json().catch(() => ({}))) as { sid?: string }
    this.store.update(token, { callSid: typeof body.sid === 'string' ? body.sid : undefined })
    this.bridge.note(`${reason === 'test' ? 'test call' : reason === 'callback' ? 'called the owner back' : 'called the owner'}${menu.needs.length ? ` about ${menu.needs.map((n) => n.ref.replace(/^\d+-/, '')).join(', ')}` : ''}`)
    this.bridge.log(`[ouro-call] placed ${token.slice(0, 8)} to ${tail(this.view.ownerPhone)}`)
    // Funnel down or the PC asleep: Twilio never reaches this PC at all, and silence must not pass for "nothing urgent"
    session.watchdog = this.d.setTimeout(() => {
      session.watchdog = undefined
      if (session.answered || session.done) return
      this.finish(session, 'unconfirmed')
    }, CALL_LIMITS.callbackWaitMs)
    return { ok: true }
  }

  private notPlaced(session: Session, error: string): OuroResult {
    this.sessions.delete(session.token)
    this.store.update(session.token, { outcome: 'failed' })
    this.bridge.log(`[ouro-call] not placed: ${error}`)
    return { ok: false, error }
  }

  /** The call is over, one way or another: the log, and a DM when the owner did not get to talk (unless the caller tells them itself). */
  private finish(session: Session, outcome: CallOutcome, patch: Partial<CallRecord> = {}, quiet = false): void {
    if (session.watchdog !== undefined) this.d.clearTimeout(session.watchdog)
    if (session.ender !== undefined) this.d.clearTimeout(session.ender)
    session.watchdog = session.ender = undefined
    session.done = true
    this.store.update(session.token, { outcome, ...patch })
    this.bridge.log(`[ouro-call] ${session.token.slice(0, 8)} ${outcome}`)
    const miss = MISS_LINE[outcome]
    if (miss && !quiet) this.bridge.tell(miss[session.lang])
  }

  /** The routes on the reply server: true when the path was one of Ouro's call webhooks. */
  readonly handle = async (req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> => {
    if (!CALL_PATH_LIST.includes(path)) return false
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' })
      return true
    }
    switch (path) {
      case CALL_PATHS.tool:
        await this.onTool(req, res)
        return true
      case CALL_PATHS.post:
        await this.onPostCall(req, res)
        return true
      default:
        await this.onTwilio(req, res, path)
        return true
    }
  }

  /**
   * Twilio's three webhooks share the form body and the signature check. The URL Twilio signed is the one the call
   * was placed with (kept on the session), so the setting moving mid-call does not turn the owner's call into 403s.
   * A refused voice webhook gets TwiML that ends the call unanswered or at once, not an error page Twilio would
   * answer the call to read out (billed).
   */
  private async onTwilio(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const body = await readRawBody(req, CALL_LIMITS.formBody)
    if (!body.ok) return sendJson(res, body.status, { ok: false, error: 'bad body' })
    const form = new URLSearchParams(body.raw)
    const token = new URL(req.url ?? path, 'http://x').searchParams.get('c') ?? ''
    const session = token ? this.sessions.get(token) : undefined
    const base = session?.base || this.base
    const sig = req.headers['x-twilio-signature']
    if (!base || !this.secrets.twilioToken || !twilioSignatureOk(this.secrets.twilioToken, `${base}${req.url ?? path}`, form, typeof sig === 'string' ? sig : undefined)) {
      this.bridge.log(`[ouro-call] refused ${path}: bad or missing Twilio signature`)
      if (path === CALL_PATHS.inbound) return sendXml(res, TWIML_REJECT)
      if (path === CALL_PATHS.answer) return sendXml(res, TWIML_HANGUP)
      return sendJson(res, 403, { ok: false, error: 'bad signature' })
    }
    if (path === CALL_PATHS.inbound) return this.onInbound(res, form)
    if (path === CALL_PATHS.status) return this.onStatus(res, session, form)
    // answered
    if (!session || session.done) return sendXml(res, TWIML_HANGUP)
    const by = form.get('AnsweredBy') ?? ''
    if (/^(machine|fax)/.test(by)) {
      sendXml(res, TWIML_HANGUP)
      return this.finish(session, 'machine')
    }
    const joined = await this.agentTwiml(session)
    if (joined.ok) {
      // the owner hears Ouro from here; a call whose end Twilio never reports is closed by the app after the time limit
      session.answered = true
      this.store.update(token, { outcome: 'answered' })
      this.bridge.reached()
      session.ender = this.d.setTimeout(() => {
        session.ender = undefined
        if (session.done) return
        this.bridge.log(`[ouro-call] ${session.token.slice(0, 8)} closed by the app: Twilio never reported its end`)
        this.finish(session, 'completed')
      }, this.view.maxMinutes * 60_000 + CALL_LIMITS.endSlackMs)
    }
    sendXml(res, joined.xml)
  }

  /**
   * Someone rang the Twilio number. Caller ID is not proof of anything (it is set by the caller), so no call is ever
   * answered: every caller is rejected unanswered (not billed), and when the number shown is the owner's, Ouro calls
   * the owner's real number back with the board. A spoofed call at worst rings the owner, within the daily cap.
   */
  private onInbound(res: http.ServerResponse, form: URLSearchParams): void {
    sendXml(res, TWIML_REJECT)
    const from = (form.get('From') ?? '').replace(/[\s\-().]/g, '')
    if (!this.view.enabled || !from || from !== this.view.ownerPhone) {
      this.bridge.log(`[ouro-call] rejected an inbound call from ${from ? tail(from) : 'an unknown number'}`)
      return
    }
    this.bridge.log(`[ouro-call] the owner's number rang in: calling back`)
    void this.place('callback', 'ko', []).then(
      (r) => {
        if (r.ok && !r.warning) return
        this.bridge.tell(`다시 걸지 못했어요: ${r.ok ? r.warning : r.error}`)
      },
      (err) => this.bridge.log(`[ouro-call] call back failed: ${err instanceof Error ? err.message : String(err)}`)
    )
  }

  /**
   * ElevenLabs' register-call: the TwiML that joins the Twilio leg to the agent, with this call's facts. It has to
   * answer inside Twilio's 15 s webhook timeout; when it cannot, Twilio says one sentence and hangs up, and the
   * owner is told in Discord (the call log says failed, without the generic miss line).
   */
  private async agentTwiml(session: Session): Promise<{ ok: boolean; xml: string }> {
    const body = {
      agent_id: this.view.agentId,
      from_number: this.view.fromNumber,
      to_number: this.view.ownerPhone,
      direction: 'outbound',
      conversation_initiation_client_data: { dynamic_variables: callVariables(session.menu, session.token, this.view.ownerName, session.lang, session.direction) }
    }
    try {
      const res = await this.d.fetch(`${ELEVEN_API}/convai/twilio/register-call`, {
        method: 'POST',
        headers: { 'xi-api-key': this.secrets.elevenKey ?? '', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_LIMITS.registerTimeoutMs)
      })
      if (!res.ok) throw new Error(`ElevenLabs refused register-call (${res.status}): ${await apiError(res)}`)
      let xml = await res.text()
      // the OpenAPI example shows the TwiML as a JSON string
      if (xml.startsWith('"')) xml = JSON.parse(xml) as string
      if (!/<Response/i.test(xml)) throw new Error('ElevenLabs returned no TwiML')
      return { ok: true, xml }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.bridge.log(`[ouro-call] ${m}`)
      // the phone rang and was picked up, so the call counts; the owner is told below, not with the generic miss line
      this.finish(session, 'dropped', {}, true)
      this.bridge.tell(ko(session.lang) ? `전화는 연결됐지만 우로의 목소리를 못 붙였어요: ${m}` : `The call connected but Ouro's voice could not join: ${m}`)
      return { ok: false, xml: twimlSayHangup(ko(session.lang) ? '연결에 문제가 있어서 통화를 못 해요. 디스코드를 확인해 주세요.' : 'Something went wrong; please check Discord.') }
    }
  }

  private onStatus(res: http.ServerResponse, session: Session | undefined, form: URLSearchParams): void {
    sendJson(res, 200, { ok: true })
    if (!session) return
    const st = form.get('CallStatus') ?? ''
    const duration = Number(form.get('CallDuration'))
    const patch = Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}
    if (session.done) {
      // a call given up on (no confirmation in time) that Twilio reports after all: the log says what really happened
      const rec = this.store.calls.find((c) => c.id === session.token)
      if (rec?.outcome === 'unconfirmed' && st === 'completed') this.store.update(session.token, { outcome: 'completed', ...patch })
      return
    }
    // over before Ouro's voice joined (the answer webhook timed out, or was never reached): the owner heard nothing
    if (st === 'completed') return this.finish(session, session.answered ? 'completed' : 'dropped', patch)
    if (st === 'no-answer' || st === 'busy' || st === 'failed' || st === 'canceled') return this.finish(session, st, patch)
    // initiated, ringing, in-progress: Twilio reaches this PC, the watchdog may stand down
    if (session.watchdog !== undefined) this.d.clearTimeout(session.watchdog)
    session.watchdog = undefined
  }

  /** The agent's tool: acts on the board for the owner, under Ouro's rules; the reply is the line the agent says. */
  private async onTool(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const key = req.headers['x-ouro-call-key']
    if (!this.secrets.toolKey || typeof key !== 'string' || !same(key, this.secrets.toolKey)) {
      this.bridge.log('[ouro-call] refused a tool call: bad or missing key')
      return sendJson(res, 403, { error: 'bad key' })
    }
    const body = await readRawBody(req, CALL_LIMITS.toolBody)
    if (!body.ok) return sendJson(res, body.status, { error: 'bad body' })
    let parsed: unknown
    try {
      parsed = JSON.parse(body.raw)
    } catch {
      return sendJson(res, 400, { error: 'body is not JSON' })
    }
    const p = parseToolCall(parsed)
    if (!p.ok) return sendJson(res, 400, { error: p.error })
    const session = this.sessions.get(p.call.callToken)
    if (!session || session.done || !session.answered) return sendJson(res, 404, { error: 'no such call' })
    if (p.call.conversationId && !session.conversationId) session.conversationId = p.call.conversationId
    const lang = session.lang
    const reply = (result: string): void => sendJson(res, 200, { result })
    if (p.call.action === 'status') return reply(this.bridge.status(lang))
    const items = session.menu.items
    // the numbered choice the owner confirmed decides; the action word only helps when there is one need
    const item = p.call.item !== undefined ? items[p.call.item - 1] : items.length && session.menu.needs.length === 1 ? items.find((i) => i.action === p.call.action && (i.action !== 'answer' || i.answer === p.call.answer)) : undefined
    if (!item) return reply(ko(lang) ? '몇 번인지 말해 주세요.' : 'Which number is it?')
    try {
      reply(await this.bridge.act(item.ref, item.action, item.answer, lang))
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.bridge.log(`[ouro-call] tool: ${m}`)
      reply(ko(lang) ? '처리 중에 문제가 생겼어요. 디스코드에서 확인해 주세요.' : 'Something went wrong; check Discord.')
    }
  }

  /** ElevenLabs' post-call webhook: the transcript's summary goes to the run log and a DM. */
  private async onPostCall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRawBody(req, CALL_LIMITS.postBody)
    if (!body.ok) return sendJson(res, body.status, { ok: false })
    const sig = req.headers['elevenlabs-signature']
    if (!this.secrets.webhookSecret || !elevenSignatureOk(this.secrets.webhookSecret, body.raw, typeof sig === 'string' ? sig : undefined, this.d.now())) {
      this.bridge.log('[ouro-call] refused a post-call webhook: bad or missing signature')
      return sendJson(res, 403, { ok: false, error: 'bad signature' })
    }
    sendJson(res, 200, { ok: true })
    let ev: { type?: string; data?: Record<string, unknown> }
    try {
      ev = JSON.parse(body.raw)
    } catch {
      return
    }
    if (ev.type !== 'post_call_transcription' || !ev.data) return
    const data = ev.data
    const vars = ((data.conversation_initiation_client_data as { dynamic_variables?: Record<string, unknown> } | undefined)?.dynamic_variables ?? {}) as Record<string, unknown>
    const token = typeof vars.call_token === 'string' ? vars.call_token : ''
    const session = this.sessions.get(token) ?? [...this.sessions.values()].find((s) => s.conversationId && s.conversationId === data.conversation_id)
    if (!session) return
    const analysis = (data.analysis ?? {}) as { transcript_summary?: unknown }
    const transcript = Array.isArray(data.transcript) ? (data.transcript as { role?: string; message?: unknown }[]) : []
    const lastAgent = [...transcript].reverse().find((t) => t.role === 'agent' && typeof t.message === 'string' && t.message)
    const summary = (typeof analysis.transcript_summary === 'string' && analysis.transcript_summary ? analysis.transcript_summary : typeof lastAgent?.message === 'string' ? lastAgent.message : '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const meta = (data.metadata ?? {}) as { call_duration_secs?: unknown }
    const patch: Partial<CallRecord> = { conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : session.conversationId, ...(summary ? { summary } : {}), ...(typeof meta.call_duration_secs === 'number' ? { durationSec: meta.call_duration_secs } : {}) }
    this.store.update(session.token, patch)
    if (!session.done) this.finish(session, 'completed')
    // a webhook delivered twice (ElevenLabs retries, or a replay within the tolerance) is told once
    if (summary && !session.summarized) {
      session.summarized = true
      this.bridge.note(`call summary: ${summary}`)
      this.bridge.tell(ko(session.lang) ? `📞 통화 요약: ${summary}` : `📞 Call summary: ${summary}`)
    }
  }

  /**
   * Settings → Provision: the agent's tool and the agent itself, made or updated at ElevenLabs from the app's
   * definitions (the persona lives in code, not in their dashboard). Returns the ids to keep.
   */
  async provision(): Promise<{ ok: true; agentId: string; toolId: string } | { ok: false; error: string }> {
    if (!this.secrets.elevenKey) return { ok: false, error: 'the ElevenLabs API key is not set' }
    if (!this.base) return { ok: false, error: 'the public address is not known yet (Tailscale Funnel)' }
    if (!this.secrets.toolKey) return { ok: false, error: 'no tool key' }
    const headers = { 'xi-api-key': this.secrets.elevenKey, 'content-type': 'application/json' }
    const send = async (method: string, path: string, body: unknown): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; status: number; error: string }> => {
      try {
        const res = await this.d.fetch(`${ELEVEN_API}${path}`, { method, headers, body: JSON.stringify(body) })
        if (!res.ok) return { ok: false, status: res.status, error: `ElevenLabs ${method} ${path} failed (${res.status}): ${await apiError(res)}` }
        return { ok: true, json: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> }
      } catch (err) {
        return { ok: false, status: 0, error: `ElevenLabs could not be reached: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    const tool = toolConfig(this.base, this.secrets.toolKey)
    let toolId = this.view.toolId
    if (toolId) {
      const r = await send('PATCH', `/convai/tools/${encodeURIComponent(toolId)}`, tool)
      if (!r.ok && r.status !== 404) return r
      if (!r.ok) toolId = ''
    }
    if (!toolId) {
      const r = await send('POST', '/convai/tools', tool)
      if (!r.ok) return r
      toolId = String(r.json.id ?? r.json.tool_id ?? '')
      if (!toolId) return { ok: false, error: 'ElevenLabs made the tool but returned no id' }
    }
    const agent = agentConfig(this.view, toolId)
    let agentId = this.view.agentId
    if (agentId) {
      const r = await send('PATCH', `/convai/agents/${encodeURIComponent(agentId)}`, agent)
      if (!r.ok && r.status !== 404) return r
      if (!r.ok) agentId = ''
    }
    if (!agentId) {
      const r = await send('POST', '/convai/agents/create', agent)
      if (!r.ok) return r
      agentId = String(r.json.agent_id ?? '')
      if (!agentId) return { ok: false, error: 'ElevenLabs made the agent but returned no id' }
    }
    this.bridge.log(`[ouro-call] provisioned agent ${agentId} with tool ${toolId}`)
    return { ok: true, agentId, toolId }
  }
}

/** The message in an API error body (Twilio: message; ElevenLabs: detail.message or detail), never the request. */
async function apiError(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 2000)
  try {
    const j = JSON.parse(text) as { message?: unknown; detail?: unknown }
    if (typeof j.message === 'string') return j.message.slice(0, 300)
    if (typeof j.detail === 'string') return j.detail.slice(0, 300)
    const d = j.detail as { message?: unknown } | undefined
    if (d && typeof d.message === 'string') return d.message.slice(0, 300)
  } catch {
    /* not JSON */
  }
  return text.replace(/\s+/g, ' ').slice(0, 300) || res.statusText || 'no detail'
}
