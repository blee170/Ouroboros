import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { PHONE_LIMITS, cleanUploadName } from '@shared/phone'

interface Upload {
  /** the paired phone that sent it: only that phone may attach it */
  device: string
  path: string
  name: string
  bytes: number
  at: number
  /** went with a message the card took: never attachable again */
  sentAt?: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const pad = (n: number): string => String(n).padStart(2, '0')
const dayOf = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Stream a body into a new file, at most `max` bytes; the file is removed again unless all of it arrived. */
function receive(body: Readable, path: string, max: number): Promise<number | 'too big' | 'failed'> {
  return new Promise((resolve) => {
    const out = createWriteStream(path, { flags: 'wx' })
    let bytes = 0
    let opened = false
    let failure: 'too big' | 'failed' | undefined
    const fail = (why: 'too big' | 'failed'): void => {
      if (failure) return
      failure = why
      // the rest of the body is left unread: the server answers and closes the connection
      body.off('data', onData)
      body.pause()
      out.destroy()
    }
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > max) return fail('too big')
      if (!out.write(chunk)) {
        body.pause()
        out.once('drain', () => {
          if (!failure) body.resume()
        })
      }
    }
    out.once('open', () => (opened = true))
    out.once('error', () => fail('failed'))
    // settled once the file is closed: Windows cannot remove a file that is still open
    out.once('close', () => {
      if (!failure) return resolve(bytes)
      try {
        if (opened) rmSync(path, { force: true })
      } catch {
        /* left for the sweep, by its age */
      }
      resolve(failure)
    })
    body.on('data', onData)
    body.once('end', () => {
      if (!failure) out.end()
    })
    body.once('error', () => fail('failed'))
    // the phone went away in the middle of the file
    body.once('close', () => {
      if (!body.readableEnded) fail('failed')
    })
  })
}

/**
 * Files a paired phone sent for its messages, saved as <dir>/<yyyy-mm-dd>/<name>-<id>.<ext>. A file can be attached
 * only by the phone that sent it, and only until a card took it with a message. Swept on every call: a file never
 * sent after 30 minutes, every file after 7 days (an earlier run's too, by its time on disk). The index is in memory,
 * so after a restart the phone attaches its unsent files again.
 */
export class PhoneUploads {
  private index = new Map<string, Upload>()
  /** files still arriving, per phone: they count toward its unsent ones */
  private arriving = new Map<string, number>()
  readonly maxBytes: number
  private now: () => number
  private log: (line: string) => void

  constructor(
    private dir: string,
    opts: { now?: () => number; maxBytes?: number; log?: (line: string) => void } = {}
  ) {
    this.maxBytes = opts.maxBytes ?? PHONE_LIMITS.uploadBytes
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  /** Stream one file from the phone to disk; `status` says why it was not kept. */
  async save(device: string, name: unknown, body: Readable): Promise<{ id: string; name: string; bytes: number } | { status: number; error: string }> {
    this.sweep()
    const waiting = [...this.index.values()].filter((u) => u.device === device && u.sentAt === undefined).length + (this.arriving.get(device) ?? 0)
    if (waiting >= PHONE_LIMITS.uploadsPending) return { status: 429, error: `${PHONE_LIMITS.uploadsPending} attachments wait to be sent already; send or remove some first` }
    const id = randomBytes(8).toString('hex')
    const clean = cleanUploadName(name)
    const dot = /\.[a-z0-9]{1,8}$/i.exec(clean)
    const path = join(this.dir, dayOf(this.now()), `${dot ? clean.slice(0, dot.index) : clean}-${id.slice(0, 8)}${dot ? dot[0] : ''}`)
    this.arriving.set(device, (this.arriving.get(device) ?? 0) + 1)
    try {
      mkdirSync(dirname(path), { recursive: true })
      const r = await receive(body, path, this.maxBytes)
      if (r === 'too big') return { status: 413, error: `a file of at most ${+(this.maxBytes / 1048576).toFixed(2)} MB` }
      if (r === 'failed') return { status: 400, error: 'the file did not arrive whole; try again' }
      this.index.set(id, { device, path, name: clean, bytes: r, at: this.now() })
      return { id, name: clean, bytes: r }
    } catch (e) {
      this.log(`[phone] could not save an upload: ${(e as Error).message}`)
      return { status: 500, error: 'the PC could not save the file' }
    } finally {
      this.arriving.set(device, (this.arriving.get(device) ?? 1) - 1)
    }
  }

  /** The files these ids stand for, for a message from this phone; or the ids that are gone (unknown, another phone's, sent already). */
  attach(device: string, ids: readonly string[]): { files: Array<{ path: string; name: string }> } | { gone: string[] } {
    this.sweep()
    const gone = ids.filter((id) => {
      const u = this.index.get(id)
      return !u || u.device !== device || u.sentAt !== undefined
    })
    if (gone.length) return { gone }
    return { files: ids.map((id) => ({ path: this.index.get(id)!.path, name: this.index.get(id)!.name })) }
  }

  /** The card took the message: its files stay on disk for the card to read, never attachable again. */
  sent(ids: readonly string[]): void {
    const now = this.now()
    for (const id of ids) {
      const u = this.index.get(id)
      if (u) u.sentAt = now
    }
  }

  /** The phone removed an attachment before sending it: the file goes now. */
  discard(device: string, id: string): boolean {
    this.sweep()
    const u = this.index.get(id)
    if (!u || u.device !== device || u.sentAt !== undefined) return false
    this.index.delete(id)
    this.remove(u.path)
    return true
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, u] of this.index) {
      if (now - u.at > PHONE_LIMITS.uploadKeepMs || (u.sentAt === undefined && now - u.at > PHONE_LIMITS.uploadUnsentMs)) {
        this.index.delete(id)
        this.remove(u.path)
      }
    }
    // an earlier run's files (not in the index): by their time on disk
    let days: string[]
    try {
      days = readdirSync(this.dir).filter((d) => DAY.test(d))
    } catch {
      return // nothing uploaded yet
    }
    const today = dayOf(now)
    for (const day of days) {
      const folder = join(this.dir, day)
      try {
        let left = 0
        for (const f of readdirSync(folder)) {
          const p = join(folder, f)
          const st = statSync(p)
          if (st.isFile() && now - st.mtimeMs > PHONE_LIMITS.uploadKeepMs) this.remove(p)
          else left++
        }
        // today's folder stays: an upload may have made it and not opened its file yet
        if (!left && day !== today) rmdirSync(folder)
      } catch (e) {
        this.log(`[phone] could not sweep ${folder}: ${(e as Error).message}`)
      }
    }
  }

  private remove(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch (e) {
      this.log(`[phone] could not delete ${path}: ${(e as Error).message}`)
    }
  }
}
