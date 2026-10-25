/**
 * Phone companion (RESEARCH §10.3): pure rules for the second, opt-in HTTP server a paired phone talks to.
 * Off by default; bound to one interface (Tailscale by default), never 0.0.0.0; a phone is paired once with a
 * one-use code shown as a QR and then holds a device token the app keeps only as a hash.
 */

export const PHONE_LIMITS = {
  /** a pairing code is good once, for this long */
  pairTtlMs: 5 * 60_000,
  /** failed auths per source address per minute before it is refused outright */
  failuresPerMinute: 5,
  bodyBytes: 64 * 1024,
  promptChars: 16 * 1024,
  /** the last reply of a card, as the phone shows it */
  replyChars: 4096,
  maxDevices: 10
} as const

export const DEFAULT_PHONE_PORT = 47900

export interface PhoneDevice {
  id: string
  name: string
  /** sha256 hex of the device token; the token itself is never stored */
  tokenHash: string
  createdAt: number
  lastSeen?: number
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

/** The keys a phone may send to a card waiting on a permission prompt. */
// no "2" ("Yes, and don't ask again"): it writes a lasting allow rule, and the option set differs between prompts
export const ANSWER_KEYS: Record<string, string> = { '1': '1', '3': '3', esc: '\x1b' }

/** A device name as typed on the phone: one line, 40 characters. */
export function cleanDeviceName(name: unknown): string {
  return (typeof name === 'string' ? name : '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40) || 'Phone'
}
