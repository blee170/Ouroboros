/**
 * Phone companion (RESEARCH §10.3): pure rules for the second, opt-in HTTP server a paired phone talks to.
 * Off by default; bound to one interface (Tailscale by default), never 0.0.0.0; a phone is paired once with a
 * one-use code shown as a QR and then holds a device token the app keeps only as a hash.
 */
import type { AgentEngine } from './types'

export const PHONE_LIMITS = {
  /** a pairing code is good once, for this long */
  pairTtlMs: 5 * 60_000,
  /** failed auths per source address per minute before it is refused outright */
  failuresPerMinute: 5,
  bodyBytes: 64 * 1024,
  promptChars: 16 * 1024,
  /** the last reply of a card, as the phone shows it */
  replyChars: 4096,
  maxDevices: 10,
  /** a file sent from the phone, at most */
  uploadBytes: 25 * 1024 * 1024,
  uploadsPerMessage: 6,
  /** files a phone uploaded and has not sent yet */
  uploadsPending: 12,
  /** what one phone may upload in a rolling 24 hours, sent files counted (they stay uploadKeepMs) */
  uploadDailyBytes: 2 * 1024 * 1024 * 1024,
  /** an upload never sent is deleted after this long, every upload after uploadKeepMs */
  uploadUnsentMs: 30 * 60_000,
  uploadKeepMs: 7 * 24 * 60 * 60_000,
  /** an upload may take minutes on mobile data; every other request is cut off after requestMs */
  uploadMs: 10 * 60_000,
  requestMs: 15_000
} as const

export const DEFAULT_PHONE_PORT = 47900

export interface PhoneDevice {
  id: string
  name: string
  /** sha256 hex of the device token; the token itself is never stored */
  tokenHash: string
  createdAt: number
  lastSeen?: number
  /** 'notify': a key for an automation app (MacroDroid) that may only call /m/api/notify, not a phone */
  scope?: 'notify'
}

export interface PhoneSettingsView {
  enabled: boolean
  host?: string
  port: number
  allowLan: boolean
}

export interface PhoneStatus extends PhoneSettingsView {
  /** listening now, at this URL */
  url?: string
  error?: string
  devices: Array<Omit<PhoneDevice, 'tokenHash'>>
}

/** An IPv4 address as 32 bits, or undefined (IPv6 other than ::ffff:a.b.c.d). */
export function ipv4(ip: string): number | undefined {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  // no leading zeros: `010.1.2.3` is octal to some resolvers and would bind another address than the one checked
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(v4)
  if (!m) return undefined
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return undefined
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4(ip)
  const b = ipv4(base)
  if (a === undefined || b === undefined) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((a & mask) >>> 0) === ((b & mask) >>> 0)
}

/** Tailscale addresses (CGNAT range). */
export const isTailscale = (ip: string): boolean => inCidr(ip, '100.64.0.0', 10)

/** Home-network addresses (RFC 1918). */
export const isPrivateLan = (ip: string): boolean => inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16)

/** Whether a request from this address is served at all. */
export function sourceAllowed(ip: string | undefined, allowLan: boolean): boolean {
  if (!ip) return false
  return isTailscale(ip) || (allowLan && isPrivateLan(ip))
}

/** Why the server must not listen on this address, or undefined. */
export function bindRefusal(host: string | undefined, allowLan: boolean): string | undefined {
  if (!host) return 'pick the network interface to listen on'
  if (host === '0.0.0.0' || host === '::' || host === '') return 'listening on every interface is not allowed; pick one'
  if (isTailscale(host)) return undefined
  if (isPrivateLan(host)) return allowLan ? undefined : 'this is a home-network address: tick "home network (no TLS)" to use it'
  return `${host} is neither a Tailscale (100.64.0.0/10) nor a home-network address`
}

/** Failed auths per source, a sliding minute. */
export class FailureLimiter {
  private hits = new Map<string, number[]>()
  constructor(private max: number = PHONE_LIMITS.failuresPerMinute) {}
  blocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= this.max
  }
  fail(ip: string, now = Date.now()): void {
    // forget addresses with nothing recent, so the map cannot grow without end
    if (this.hits.size > 1000) for (const [k] of this.hits) if (!this.recent(k, now).length) this.hits.delete(k)
    this.hits.set(ip, [...this.recent(ip, now), now])
  }
  private recent(ip: string, now: number): number[] {
    return (this.hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  }
}

/** The pairing link a QR carries; the code is in the fragment, so it never reaches a server log or a referrer. */
export function pairingUrl(host: string, port: number, code: string): string {
  return `http://${host}:${port}/m#pair=${encodeURIComponent(code)}`
}

/** What an automation app may report: the phone connected to the car. */
export const NOTIFY_EVENTS = ['car'] as const
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

/** The keys a phone may send to a card waiting on a permission prompt. */
// no "2" ("Yes, and don't ask again"): it writes a lasting allow rule, and the option set differs between prompts
export const ANSWER_KEYS: Record<string, string> = { '1': '1', '3': '3', esc: '\x1b' }

/** What a message from the phone does to a card, or why it is refused. */
export type PhoneSend = { how: 'send' | 'wake' } | { refusal: string }

/**
 * `ended` on a Claude Code card that is not asleep is its CLI stopped (/exit; /clear and /resume leave it idle): with
 * its process live, the CLI ended inside its shell. The other engines' SessionEnd carries no reason, so theirs may be a
 * cleared conversation in a CLI that still runs.
 */
function cliEnded(card: { status?: string; engine?: AgentEngine }): boolean {
  return card.status === 'ended' && (card.engine ?? 'claude') === 'claude'
}

/**
 * Pure: what a message from the phone would do to a card, from its facts. The board's message box and the prompt
 * route both ask this, so the page never offers what the server refuses. `alive`: its process runs (or it is waking);
 * `launchFailed`: its CLI never came up or has exited, so the live process is a shell. A CLI that ended inside its
 * shell (cliEnded) takes no message either: its inbox would come back gone and drop it.
 * `runRefusal`: why an Autonomous run refuses a prompt to it (sendPrompt asks the run first); `leadFull`: its lead is
 * at its live-card cap, so a wake would be refused (the owner's Wake on the PC is not capped). `launchRefused`: why
 * the PC refused the card's latest launch (it has no process, and its status may still say starting).
 */
export function phoneSend(card: { status?: string; statusDetail?: string; engine?: AgentEngine; asleep?: boolean; alive: boolean; launchFailed: boolean; launchRefused?: string; runRefusal?: string; leadFull?: boolean }): PhoneSend {
  if (card.runRefusal) return { refusal: card.runRefusal }
  if (card.asleep) return card.leadFull ? { refusal: "It stays asleep: its lead already has as many live cards as it may. Wake it on the PC, or close one of the lead's cards." } : { how: 'wake' }
  if (card.launchRefused) return { refusal: `The PC did not start it: ${card.launchRefused}` }
  if (!card.alive || card.launchFailed || cliEnded(card)) return { refusal: 'This card is not running, so it cannot take a message; Restart it first.' }
  // a failed turn leaves Claude Code at its prompt: a message starts a new turn
  if (card.status === 'needs-you' && !(card.statusDetail ?? '').startsWith('failed:')) return { refusal: 'It waits on a prompt in its terminal; answer that first.' }
  return { how: 'send' }
}

/** What a Restart from the phone does to a card's conversation, or why it is refused. */
export type PhoneRestart = { how: 'resume' | 'continue' | 'new' } | { refusal: string }

/**
 * Pure: whether the phone may restart a card. Only one whose CLI is not running: it never came up or exited
 * (`launchFailed`: the live process is its shell), it ended inside its shell (cliEnded), the PC refused its launch
 * (`launchRefused`: not starting, whatever its status says), or its process is gone. A running card is never cut off
 * from a phone, an asleep or waking card wakes on a message, a starting one is left to come up. `restarting`: a
 * restart was asked for and its launch has not run, so a second tap asks for nothing. The relaunch keeps the
 * conversation when the app knows the card's session (`sessionId`), as a wake does; without one it is the PC's
 * Restart, with the card's own launch options.
 */
export function phoneRestart(card: { status?: string; engine?: AgentEngine; asleep?: boolean; waking: boolean; restarting: boolean; alive: boolean; launchFailed: boolean; launchRefused?: string; sessionId?: string; claude?: { resume?: string; continue?: boolean } }): PhoneRestart {
  if (card.asleep) return { refusal: 'It is asleep: a message wakes it on its conversation.' }
  if (card.waking) return { refusal: 'It is waking up; wait a moment.' }
  if (card.restarting) return { refusal: 'It is restarting already.' }
  if (!card.launchFailed && !card.launchRefused && !cliEnded(card)) {
    if (card.status === 'starting') return { refusal: 'It is starting; wait for it to come up.' }
    if (card.alive) return { refusal: 'It is running: only a card whose CLI stopped is restarted from the phone.' }
  }
  return { how: card.sessionId || card.claude?.resume ? 'resume' : card.claude?.continue ? 'continue' : 'new' }
}

/** A device name as typed on the phone: one line, 40 characters. */
export function cleanDeviceName(name: unknown): string {
  return (typeof name === 'string' ? name : '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40) || 'Phone'
}

/** Windows opens the device, not a file, for these names (with any extension) */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i

/**
 * Pure: a file name from the phone, clean to show on the phone's chip and in the log line; only its extension (1 to 8
 * letters or digits, lower case) ever goes into a path on this PC. Letters (Korean too), digits and a few marks are
 * kept: no path, no control or bidi character, nothing Windows reserves, nothing a shell expands inside quotes ($ `
 * ') or reads as a wildcard ([ ]). At most 80 characters.
 */
export function cleanUploadName(name: unknown): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop() ?? ''
  const kept = base.replace(/[^\p{L}\p{N}\p{M} ._()+,=@#&!~-]/gu, '').replace(/ +/g, ' ').replace(/[. ]+$/, '')
  const dot = /\.([a-z0-9]{1,8})$/i.exec(kept)
  const ext = dot ? dot[1].toLowerCase() : ''
  let stem = Array.from((dot ? kept.slice(0, dot.index) : kept).replace(/^[. ]+/, ''))
    .slice(0, 80 - (ext ? ext.length + 1 : 0))
    .join('')
    .replace(/[. ]+$/, '')
  if (DEVICE_NAME.test(stem)) stem = `_${stem}`
  return `${stem || 'file'}${ext ? `.${ext}` : ''}`
}

/**
 * Pure: the Claude Code permission rule that lets a card read the files in a folder: the card's own folder of the files
 * a phone sent to it, never the folder of them all. The folder is outside every project, so without the rule a card
 * stops on a permission prompt at the first attached file (checked on 2.1.332: no rule asks, `Read(//c/…/**)` reads).
 * `//` starts an absolute path in a rule; a Windows drive goes in as `//c/`.
 */
export function phoneFilesReadRule(dir: string): string {
  const p = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):\//.exec(p)
  return `Read(${drive ? `//${drive[1].toLowerCase()}${p.slice(2)}` : `/${p}`}/**)`
}

/** The line above the paths of the files a message from the phone carries. */
export const PHONE_FILES_NOTE = "These files were attached from the owner's phone and are saved on this PC:"

/** Pure: the prompt a message from the phone becomes, its text and then its files' paths, one per line. */
export function withPhoneFiles(text: string, paths: readonly string[]): string {
  if (!paths.length) return text
  const note = [PHONE_FILES_NOTE, ...paths].join('\n')
  return text ? `${text}\n\n${note}` : note
}
