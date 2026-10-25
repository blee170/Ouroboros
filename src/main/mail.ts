import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ackMail, deliveryBatch, EMPTY_MAIL, inbox, markDelivered, pruneMail, sanitizeMail, sendMail, undelivered, type Mail, type MailData, type MailResult, type MailTopology } from '@shared/mail'

const SAVE_DELAY_MS = 300

/** Where a project's mailbox lives: the app's data folder, not the project (a card cannot rewrite its inbox). */
export function mailFile(userData: string, projectRoot: string): string {
  const key = createHash('sha1').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16)
  return join(userData, 'mail', `${key}.json`)
}

/**
 * The live mailbox of one window. Every change is pushed as 'change' (the full list) and saved a moment later.
 * 'mail' fires with each new message so the window can nudge an idle recipient.
 */
export class Mailbox extends EventEmitter {
  data: MailData = EMPTY_MAIL
  private file?: string
  private saveTimer?: NodeJS.Timeout

  constructor(
    private log: (line: string) => void = () => {},
    private saveDelayMs = SAVE_DELAY_MS
  ) {
    super()
  }

  /** Switch to a project's mailbox (the previous one is written first). */
  load(file: string | undefined, now = Date.now()): void {
    this.flush()
    this.file = file
    let raw: unknown
    if (file) {
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          // never overwrite a mailbox we could not read: set it aside and say so
          const aside = `${file}.unreadable-${now}`
          try {
            renameSync(file, aside)
            this.log(`mail: could not read ${file} (${(e as Error).message}); kept it as ${aside} and started an empty mailbox`)
          } catch (e2) {
            this.log(`mail: could not read ${file} (${(e as Error).message}) nor set it aside (${(e2 as Error).message}); mail is not saved this session`)
            this.file = undefined
          }
        }
      }
    }
    this.data = pruneMail(sanitizeMail(raw), now)
    this.emit('change', this.data.messages)
  }

  send(input: { from: string; to: string; body: string; kind?: string; replyTo?: string }, topo: MailTopology, now = Date.now()): MailResult {
    if (!this.file) return { ok: false, error: 'no project open' }
    const r = sendMail(this.data, input, now, topo)
    if (r.ok) {
      this.set(r.data)
      this.emit('mail', r.mail)
    }
    return r
  }

  /** Hand messages back as not yet shown (a delivery the card never received). */
  undeliver(ids: readonly string[]): void {
    const set = new Set(ids)
    if (!this.data.messages.some((m) => set.has(m.id) && m.deliveredAt && !m.ackedAt)) return
    this.set({ ...this.data, messages: this.data.messages.map((m) => (set.has(m.id) && !m.ackedAt ? { ...m, deliveredAt: undefined } : m)) })
  }

  inbox(to: string, unreadOnly: boolean, now = Date.now()): Mail[] {
    const list = inbox(this.data, to, unreadOnly)
    const fresh = list.filter((m) => !m.deliveredAt).map((m) => m.id)
    if (fresh.length) this.set(markDelivered(this.data, fresh, now))
    return list
  }

  ack(id: string, by: string, now = Date.now()): MailResult {
    const r = ackMail(this.data, id, by, now)
    if (r.ok && r.data !== this.data) this.set(r.data)
    return r
  }

  hasUndelivered(to: string): boolean {
    return undelivered(this.data, to).length > 0
  }

  /** Take the next delivery for a card (marked delivered), or nothing. */
  takeDelivery(to: string, titleOf: (id: string) => string, now = Date.now()): { ids: string[]; text: string } | undefined {
    const mails = undelivered(this.data, to)
    if (!mails.length) return undefined
    const batch = deliveryBatch(mails, titleOf)
    this.set(markDelivered(this.data, batch.ids, now))
    return batch
  }

  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.write()
  }

  dispose(): void {
    this.flush()
    this.removeAllListeners()
  }

  private set(data: MailData): void {
    this.data = data
    this.emit('change', this.data.messages)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.write()
    }, this.saveDelayMs)
  }

  private write(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(pruneMail(this.data, Date.now())), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      this.log(`mailbox not saved: ${(err as Error).message}`)
    }
  }
}
