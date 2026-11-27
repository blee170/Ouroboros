import { randomBytes } from 'node:crypto'
import { createWriteStream, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { PHONE_LIMITS, cleanUploadName } from '@shared/phone'

interface Upload {
  /** the paired phone that sent it: only that phone may attach it */
  device: string
  /** <id>.<ext>: no part of the phone's name for it */
  file: string
  /** the clean name, for the phone's chip and the log line only */
  name: string
  bytes: number
  at: number
  /** the card that took it with a message, its file now in that card's folder: never attachable again */
  sentTo?: string
}

/** where an upload waits for its message; never a card's folder (a card id has no dot) */
const PENDING = '.pending'
/** a card's folder is its id, as the prompt route takes it */
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/
const DAY_MS = 24 * 60 * 60_000

/** A real directory, made when missing if `make`: false for a link or a junction (Node reports a junction as a symlink) or a file. */
function realDir(path: string, make = false): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch (e) {
    if (!make || (e as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  mkdirSync(path, { recursive: true })
  return lstatSync(path).isDirectory()
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
 * Files a paired phone sent for its messages. An upload waits as <dir>/.pending/<id>.<ext> until a message takes it to
 * a card, then lives in that card's folder, <dir>/<card id>/<id>.<ext>, which only that card may read. No part of the
 * phone's name for a file is in a path: the name is for the phone's chip and the log. A file can be attached only by
 * the phone that sent it, and only until a card took it. A link or a junction in the folder (a card with a shell can
 * make one) is never followed: not written into, not swept. Swept on every call: an unsent file after 30 minutes, a
 * card's files after 7 days (an earlier run's too, by their time on disk). The index is in memory, so after a restart
 * the phone attaches its unsent files again.
 */
export class PhoneUploads {
  private index = new Map<string, Upload>()
  /** files still arriving, per phone: they count toward its unsent ones, each with the most it may take of its day */
  private arriving = new Map<string, { files: number; bytes: number }>()
  readonly maxBytes: number
  private dailyBytes: number
  private now: () => number
  private log: (line: string) => void

  constructor(
    private dir: string,
    opts: { now?: () => number; maxBytes?: number; dailyBytes?: number; log?: (line: string) => void } = {}
  ) {
    this.maxBytes = opts.maxBytes ?? PHONE_LIMITS.uploadBytes
    this.dailyBytes = opts.dailyBytes ?? PHONE_LIMITS.uploadDailyBytes
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  /** Stream one file from the phone to disk; `status` says why it was not kept. */
  async save(device: string, name: unknown, body: Readable): Promise<{ id: string; name: string; bytes: number } | { status: number; error: string }> {
    this.sweep()
    const mine = [...this.index.values()].filter((u) => u.device === device)
    const coming = this.arriving.get(device) ?? { files: 0, bytes: 0 }
    if (mine.filter((u) => u.sentTo === undefined).length + coming.files >= PHONE_LIMITS.uploadsPending) return { status: 429, error: `${PHONE_LIMITS.uploadsPending} attachments wait to be sent already; send or remove some first` }
    // sent files count too: a card's files stay uploadKeepMs, so this bounds the disk one phone fills
    const room = this.dailyBytes - mine.reduce((n, u) => n + u.bytes, 0) - coming.bytes
    const daily = { status: 429, error: `at most ${+(this.dailyBytes / 1073741824).toFixed(2)} GB of files from one phone in 24 hours; try again later` }
    if (room <= 0) return daily
    const max = Math.min(this.maxBytes, room)
    const id = randomBytes(8).toString('hex')
    const clean = cleanUploadName(name)
    const ext = /\.[a-z0-9]{1,8}$/.exec(clean)?.[0] ?? ''
    const pending = join(this.dir, PENDING)
    coming.files++
    coming.bytes += max
    this.arriving.set(device, coming)
    try {
      if (!this.folders(this.dir, pending)) return { status: 500, error: 'the PC could not save the file' }
      const r = await receive(body, join(pending, id + ext), max)
      if (r === 'too big') return max < this.maxBytes ? daily : { status: 413, error: `a file of at most ${+(this.maxBytes / 1048576).toFixed(2)} MB` }
      if (r === 'failed') return { status: 400, error: 'the file did not arrive whole; try again' }
      this.index.set(id, { device, file: id + ext, name: clean, bytes: r, at: this.now() })
      return { id, name: clean, bytes: r }
    } catch (e) {
      this.log(`[phone] could not save an upload: ${(e as Error).message}`)
      return { status: 500, error: 'the PC could not save the file' }
    } finally {
      coming.files--
      coming.bytes -= max
    }
  }

  /**
   * Hand these files to a card with a message from this phone: they move into the card's folder, `send` gets their
   * paths, and they count as sent only if it says ok. A refused message leaves them attachable again, to this card or
   * another; a file that cannot be moved means `send` is never called. `gone`: ids that are unknown, another phone's
   * or sent already.
   */
  deliver<R extends { ok: boolean }>(device: string, card: string, ids: readonly string[], send: (paths: string[]) => R): { gone: string[] } | { status: number; error: string } | { result: R; names: string[] } {
    this.sweep()
    const gone = ids.filter((id) => {
      const u = this.index.get(id)
      return !u || u.device !== device || u.sentTo !== undefined
    })
    if (gone.length) return { gone }
    const ups = ids.map((id) => [id, this.index.get(id)!] as const)
    const unmoved = { status: 500, error: 'the PC could not hand the files to the card; nothing was sent' }
    try {
      if (!CARD_ID.test(card)) throw new Error(`no folder for card ${JSON.stringify(card).slice(0, 80)}`)
      if (!this.folders(this.dir, join(this.dir, PENDING), join(this.dir, card))) return unmoved
    } catch (e) {
      this.log(`[phone] could not hand files to ${card}: ${(e as Error).message}`)
      return unmoved
    }
    for (let i = 0; i < ups.length; i++) {
      if (this.move(ups[i][1].file, PENDING, card)) continue
      for (const [id, u] of ups.slice(0, i)) this.putBack(id, u, card)
      return unmoved
    }
    let result: R | undefined
    try {
      result = send(ups.map(([, u]) => join(this.dir, card, u.file)))
      return { result, names: ups.map(([, u]) => u.name) }
    } finally {
      // settled before anyone sees the result, and when send threw too
      for (const [id, u] of ups) {
        if (result?.ok) u.sentTo = card
        else this.putBack(id, u, card)
      }
    }
  }

  /** The phone removed an attachment before sending it: the file goes now. */
  discard(device: string, id: string): boolean {
    this.sweep()
    const u = this.index.get(id)
    if (!u || u.device !== device || u.sentTo !== undefined) return false
    this.index.delete(id)
    this.removeIn(PENDING, u.file)
    return true
  }

  /** These folders as real directories, made when missing; false (logged) when one is a link, a junction or a file. */
  private folders(...paths: string[]): boolean {
    const bad = paths.find((p) => !realDir(p, true))
    if (bad) this.log(`[phone] ${bad} is not a real folder (a junction or a link?): not used`)
    return !bad
  }

  /** Rename a file from one folder of the store to another; false (logged) when it cannot. */
  private move(file: string, from: string, to: string): boolean {
    const src = join(this.dir, from, file)
    try {
      if (!lstatSync(src).isFile()) throw new Error('not a file')
      renameSync(src, join(this.dir, to, file))
      return true
    } catch (e) {
      this.log(`[phone] could not move ${src}: ${(e as Error).message}`)
      return false
    }
  }

  /** Back to .pending, attachable again; one that cannot go back is forgotten (the phone attaches it again). */
  private putBack(id: string, u: Upload, card: string): void {
    if (this.move(u.file, card, PENDING)) return
    this.index.delete(id)
    this.removeIn(card, u.file)
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, u] of this.index) {
      if (u.sentTo !== undefined) {
        // kept a day only to count toward its phone's bound: its file goes by its age on disk
        if (now - u.at > DAY_MS) this.index.delete(id)
      } else if (now - u.at > PHONE_LIMITS.uploadUnsentMs) {
        this.index.delete(id)
        this.removeIn(PENDING, u.file)
      }
    }
    // on disk, by age: an earlier run's unsent files (the index is in memory) and the files cards took
    let entries: Dirent[]
    try {
      entries = realDir(this.dir) ? readdirSync(this.dir, { withFileTypes: true }) : []
    } catch (e) {
      return this.log(`[phone] could not sweep ${this.dir}: ${(e as Error).message}`)
    }
    for (const e of entries) {
      // a junction or a link is never followed, and a name that is neither .pending nor a card's is not ours
      if (!e.isDirectory() || (e.name !== PENDING && !CARD_ID.test(e.name))) continue
      const folder = join(this.dir, e.name)
      const maxAge = e.name === PENDING ? PHONE_LIMITS.uploadUnsentMs : PHONE_LIMITS.uploadKeepMs
      try {
        let left = 0
        for (const f of readdirSync(folder, { withFileTypes: true })) {
          const p = join(folder, f.name)
          // an upload still arriving is not in the index yet, and its file is recent
          if (f.isFile() && !(e.name === PENDING && this.index.has(f.name.split('.')[0])) && now - lstatSync(p).mtimeMs > maxAge) rmSync(p)
          else left++
        }
        if (!left && e.name !== PENDING) rmdirSync(folder)
      } catch (err) {
        this.log(`[phone] could not sweep ${folder}: ${(err as Error).message}`)
      }
    }
  }

  /** Delete one file of the store: a real file in a real folder only, never through a link or a junction. */
  private removeIn(folder: string, file: string): void {
    const p = join(this.dir, folder, file)
    try {
      if (realDir(this.dir) && realDir(join(this.dir, folder)) && lstatSync(p).isFile()) rmSync(p)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[phone] could not delete ${p}: ${(e as Error).message}`)
    }
  }
}
