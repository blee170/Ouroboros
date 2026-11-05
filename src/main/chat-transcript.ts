/**
 * Chat view: read what a Claude card's transcript gained since the renderer's last read and hand it over as chat
 * events (shared/chat.ts). Reads are bounded: a first read starts at most 2 MB before the end, a later one takes
 * at most 2 MB and says there is more; a line still being written waits for the next read. Only files under the
 * Claude Code config dir are read (the caller resolves the path with transcriptPath).
 */
import { open } from 'node:fs/promises'
import { CHAT_LIMITS, parseChatLines, type ChatRead } from '@shared/chat'

export interface ChatCursor {
  key?: string
  offset?: number
}

const NEWLINE = 10

/**
 * Read `path` from the cursor. A cursor for another file, or one past the file's end (the file was replaced),
 * starts over at the conversation's end; the result then says `reset`. Never throws: an unreadable transcript is
 * ok=false with the reason.
 */
export async function readChat(path: string, cursor: ChatCursor | undefined, cap: number = CHAT_LIMITS.readBytes): Promise<ChatRead> {
  try {
    const fh = await open(path, 'r')
    try {
      const { size } = await fh.stat()
      const sameFile = cursor?.key === path && typeof cursor.offset === 'number' && Number.isInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= size
      // a first read that starts inside the file leaves the older turns out, and starts inside a line unless the byte
      // before it is a line break: so it starts one byte early and drops everything up to the first break
      const clipped = !sameFile && size > cap
      const start = sameFile ? (cursor.offset as number) : clipped ? size - cap - 1 : 0
      const reset = !sameFile
      const head = { ok: true, key: path, reset, clipped: clipped || undefined } as const
      if (size <= start) return { ...head, offset: start, events: [] }
      const buf = Buffer.alloc(Math.min(size - start, clipped ? cap + 1 : cap))
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      const got = buf.subarray(0, bytesRead)
      const more = start + bytesRead < size
      const firstBreak = got.indexOf(NEWLINE)
      if (firstBreak === -1) {
        // no line ends in here. With more behind it, this is the middle of one entry larger than a read (a pasted
        // image, a huge tool result): step over it and say so. At the file's end it is a line still being written.
        if (!more) return { ...head, offset: start, events: [] }
        return { ...head, offset: start + bytesRead, more: true, events: [{ type: 'note', id: `skipped:${start}`, text: 'A very large entry (an image or a long tool result) is not shown here. It is in the terminal.' }] }
      }
      const from = clipped ? firstBreak + 1 : 0
      // up to the last full line; a line still being written is read next time
      const end = got.lastIndexOf(NEWLINE) + 1
      return { ...head, offset: start + end, more: more || undefined, events: end > from ? parseChatLines(got.subarray(from, end).toString('utf8')) : [] }
    } finally {
      await fh.close()
    }
  } catch (err) {
    return { ok: false, error: `The conversation file could not be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`, events: [] }
  }
}
