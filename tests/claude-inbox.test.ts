import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboxFrames, pushInbox, validInbox } from '../src/main/claude-inbox'

describe('validInbox', () => {
  it("takes Claude Code's own inbox paths only", () => {
    expect(validInbox(String.raw`\\.\pipe\LOCAL\cc-msg-fb93f83cdd0fadc39f`, 'win32')).toBe(true)
    for (const bad of [String.raw`\\.\pipe\other`, String.raw`C:\x\cc-msg-1`, String.raw`\\.\pipe\LOCAL\cc-msg-../x`, 7, undefined]) expect(validInbox(bad, 'win32')).toBe(false)
    expect(validInbox('/tmp/claude/cc-msg.sock', 'linux')).toBe(true)
    expect(validInbox('relative.sock', 'linux')).toBe(false)
    expect(validInbox('/var/run/docker.sock', 'linux')).toBe(false)
  })
})

describe('pushInbox', () => {
  it('writes the auth frame, then the user frame', () => {
    expect(inboxFrames('hi', 't')).toBe('{"type":"auth","token":"t"}\n{"type":"user","message":{"role":"user","content":"hi"}}\n')
    expect(inboxFrames('hi')).toBe('{"type":"user","message":{"role":"user","content":"hi"}}\n')
  })
  it('delivers into a listening inbox and fails fast when nobody listens', async () => {
    const path = process.platform === 'win32' ? String.raw`\\.\pipe\LOCAL\cc-msg-test` + `${process.pid}${Date.now()}` : join(tmpdir(), `cc-msg-${process.pid}.sock`)
    let got = ''
    const server = createServer((c) => c.on('data', (d) => (got += d)))
    await new Promise<void>((r) => server.listen(path, r))
    expect(await pushInbox({ socket: path, token: 'tok' }, 'line one\nline two')).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    const frames = got.trim().split('\n').map((l) => JSON.parse(l))
    expect(frames).toEqual([{ type: 'auth', token: 'tok' }, { type: 'user', message: { role: 'user', content: 'line one\nline two' } }])
    await new Promise<void>((r) => server.close(() => r()))
    expect(await pushInbox({ socket: path }, 'x')).toBe(false)
  })
})
