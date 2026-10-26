/**
 * Claude Code's own inbox: the socket it gives the MCP servers it starts (CLAUDE_CODE_MESSAGING_SOCKET, a named pipe
 * on Windows) takes a `user` frame and puts the text in the conversation, between tool calls of a running turn or as
 * a new turn of an idle session (checked with Claude Code 2.1.310, also in auto mode). The card's board MCP server
 * registers it; text for the card then goes in here instead of being typed into its terminal.
 */
import { connect, type Socket } from 'node:net'

export interface InboxAddress {
  socket: string
  /** CLAUDE_CODE_MESSAGING_TOKEN, sent first as an `auth` frame */
  token?: string
}

/** Pure: an inbox path Claude Code would make (its named pipe on Windows, an absolute socket path elsewhere). */
export function validInbox(socket: unknown, platform: NodeJS.Platform = process.platform): socket is string {
  if (typeof socket !== 'string' || socket.length > 300) return false
  return platform === 'win32' ? /^\\\\\.\\pipe\\LOCAL\\cc-msg-[A-Za-z0-9_-]{8,128}$/.test(socket) : /^\/[^\0]+$/.test(socket)
}

/** Pure: the lines written to the inbox. */
export function inboxFrames(text: string, token?: string): string {
  const auth = token ? `${JSON.stringify({ type: 'auth', token })}\n` : ''
  return `${auth}${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
}

/** Write the text into the inbox; true once it was written and the inbox closed without an error, within 3 s. */
export function pushInbox(to: InboxAddress, text: string, open: (path: string) => Socket = (p) => connect(p)): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      c.destroy()
      finish(false)
    }, 3000)
    const c = open(to.socket)
    c.on('error', () => finish(false))
    c.on('connect', () => c.end(inboxFrames(text, to.token)))
    c.on('close', (hadError) => finish(!hadError))
  })
}
