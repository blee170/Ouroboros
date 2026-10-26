import { describe, expect, it } from 'vitest'
import { Relay, type RelayCardView, type RelayHost } from '../src/main/relay'
import { Board } from '../src/main/board'
import { NOTE_MARKER, relaySettings, RELAY_YES } from '@shared/relay'

const NOTE = 'HANDOFF NOTE\n' + 'Working on the booking fix; next step is the e2e run. '.repeat(10)
const TIMING = { noteMs: 400, clearMs: 1000, settleMs: 50, resumeMs: 20 }

type Opts = { reply?: string | null; clears?: boolean; prompts?: boolean; busyAfterNote?: boolean }

function setup(over: Partial<RelayCardView> = {}, opts: Opts = {}) {
  const card: RelayCardView = { id: 'c1', title: 'Worker', kind: 'claude', status: 'idle', sessionId: 's1', lastStopAt: Date.now() - 600_000, lastEventAt: 1, ...over }
  const typed: string[] = []
  const prompts: string[] = []
  const records: string[] = []
  const questions: string[] = []
  let take: ((n: string | undefined) => void) | undefined
  let onClear: (() => void) | undefined
  const host: RelayHost = {
    cards: () => [card],
    usage: () => ({ contextTokens: 300_000, contextWindow: 1_000_000 }),
    pending: () => false,
    settings: () => relaySettings({}),
    prompt: (_id, text) => {
      if (opts.prompts === false) return false
      prompts.push(text)
      if (text.startsWith(NOTE_MARKER) && take && opts.reply !== undefined) {
        const t = take
        setTimeout(() => {
          card.statusDetail = 'handoff note written'
          // null: the owner pressed Esc and sent another prompt, which cut the note turn
          t(opts.reply === null ? undefined : (opts.reply as string))
          if (opts.busyAfterNote) setTimeout(() => ((card.status = 'working'), (card.lastEventAt = 2)), 5)
        }, 10)
      }
      return true
    },
    type: (_id, text) => {
      typed.push(text)
      if (text === '\r' && opts.clears !== false) setTimeout(() => onClear?.(), 5)
    },
    captureStop: (_id, _marker, t) => (take = t),
    releaseStop: () => (take = undefined),
    watchClear: (_id, done) => (onClear = done),
    ask: (_c, q) => {
      questions.push(q)
      return 'D1'
    },
    saveNote: () => '/tmp/note.md',
    record: (_c, d) => records.push(d),
    log: () => {}
  }
  return { relay: new Relay(host, TIMING), card, typed, prompts, records, questions }
}

const settle = (ms = 2500) => new Promise((r) => setTimeout(r, ms))

describe('Relay', () => {
  it('asks for a note, clears, and gives the note back', async () => {
    const t = setup({}, { reply: NOTE })
    t.relay.tick()
    await settle()
    expect(t.typed).toEqual(['/clear', '\r'])
    expect(t.prompts).toHaveLength(2)
    expect(t.prompts[1]).toContain('Working on the booking fix')
    expect(t.records.at(-1)).toMatch(/^fresh start at 300k tokens/)
  })
  it('keeps the conversation when the note is too short', async () => {
    const t = setup({}, { reply: 'ok' })
    t.relay.tick()
    await settle(200)
    expect(t.typed).toEqual([])
    expect(t.records.at(-1)).toMatch(/too short/)
  })
  it('keeps the conversation when the note turn is cut', async () => {
    const t = setup({}, { reply: null })
    t.relay.tick()
    await settle(200)
    expect(t.typed).toEqual([])
    expect(t.records.at(-1)).toMatch(/no handoff note/)
  })
  it('does not type /clear when the card got busy after the note', async () => {
    const t = setup({}, { reply: NOTE, busyAfterNote: true })
    t.relay.tick()
    await settle(300)
    expect(t.typed).toEqual([])
    expect(t.records.at(-1)).toMatch(/got busy/)
  })
  it('does not send the note when /clear is not confirmed, and waits before trying again', async () => {
    const t = setup({}, { reply: NOTE, clears: false })
    t.relay.tick()
    await settle(1700)
    expect(t.typed).toEqual(['/clear', '\r'])
    expect(t.prompts).toHaveLength(1)
    expect(t.records.at(-1)).toMatch(/not confirmed.*note\.md/)
    t.relay.tick()
    expect(t.prompts).toHaveLength(1)
  })
  it('stops when the note prompt cannot be delivered', async () => {
    const t = setup({}, { prompts: false })
    t.relay.tick()
    await settle(50)
    expect(t.records.at(-1)).toMatch(/no handoff note/)
  })
  it('gives up when no note comes back in time', async () => {
    const t = setup({})
    t.relay.tick()
    await settle(600)
    expect(t.typed).toEqual([])
    expect(t.records.at(-1)).toMatch(/no handoff note/)
  })
  it('asks the owner for a Conductor, once, and relays after a yes', async () => {
    const t = setup({ kind: 'conductor', title: 'Conductor' }, { reply: NOTE })
    t.relay.tick()
    t.relay.tick()
    expect(t.questions).toHaveLength(1)
    expect(t.prompts).toHaveLength(0)
    expect(t.relay.owns('D1')).toBe(true)
    t.relay.answered('D1', RELAY_YES)
    expect(t.relay.owns('D1')).toBe(false)
    t.relay.tick()
    await settle()
    expect(t.typed).toEqual(['/clear', '\r'])
  })
  it('a no, or an expired question, leaves a Conductor alone', () => {
    const t = setup({ kind: 'conductor' })
    t.relay.tick()
    t.relay.answered('D1', undefined)
    t.relay.tick()
    expect(t.prompts).toHaveLength(0)
  })
})

describe('Board note capture', () => {
  const board = (): Board => {
    const b = new Board()
    b.sync({ projectRoot: '/p', nodes: [{ id: 'c1', data: { kind: 'claude', title: 'W', cwd: '/p', status: 'idle' } as never }], edges: [] } as never)
    return b
  }
  it('arms on the marked prompt and takes its Stop without firing lines', () => {
    const b = board()
    const got: (string | undefined)[] = []
    const stops: string[] = []
    b.on('stop', (_id: string, m: string) => stops.push(m))
    b.captureStop('c1', NOTE_MARKER, (n) => got.push(n))
    expect(b.capturing('c1')).toBe(false)
    b.applyHook('c1', { hook_event_name: 'UserPromptSubmit', prompt: `${NOTE_MARKER} write it` })
    expect(b.capturing('c1')).toBe(true)
    b.applyHook('c1', { hook_event_name: 'Stop', last_assistant_message: 'the note' })
    expect(got).toEqual(['the note'])
    expect(stops).toEqual([])
    expect(b.nodes.get('c1')?.data.statusDetail).toBe('handoff note written')
    b.applyHook('c1', { hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    b.applyHook('c1', { hook_event_name: 'Stop', last_assistant_message: 'normal' })
    expect(stops).toEqual(['normal'])
  })
  it('a different prompt while armed cuts the capture; that turn is normal', () => {
    const b = board()
    const got: (string | undefined)[] = []
    const stops: string[] = []
    b.on('stop', (_id: string, m: string) => stops.push(m))
    b.captureStop('c1', NOTE_MARKER, (n) => got.push(n))
    b.applyHook('c1', { hook_event_name: 'UserPromptSubmit', prompt: `${NOTE_MARKER} write it` })
    b.applyHook('c1', { hook_event_name: 'UserPromptSubmit', prompt: 'owner after Esc' })
    expect(got).toEqual([undefined])
    b.applyHook('c1', { hook_event_name: 'Stop', last_assistant_message: 'owner reply' })
    expect(stops).toEqual(['owner reply'])
  })
  it('a released armed capture swallows the late note until the next prompt', () => {
    const b = board()
    const stops: string[] = []
    b.on('stop', (_id: string, m: string) => stops.push(m))
    b.captureStop('c1', NOTE_MARKER, () => {})
    b.applyHook('c1', { hook_event_name: 'UserPromptSubmit', prompt: `${NOTE_MARKER} write it` })
    b.releaseStop('c1')
    b.applyHook('c1', { hook_event_name: 'Stop', last_assistant_message: 'late note' })
    expect(stops).toEqual([])
  })
  it('reports /clear from SessionEnd or SessionStart', () => {
    const b = board()
    let n = 0
    b.watchClear('c1', () => n++)
    b.applyHook('c1', { hook_event_name: 'SessionStart', source: 'clear', session_id: 's2' })
    expect(n).toBe(1)
    b.watchClear('c1', () => n++)
    b.applyHook('c1', { hook_event_name: 'SessionEnd', reason: 'clear' })
    expect(n).toBe(2)
    expect(b.nodes.get('c1')?.data.status).toBe('idle')
  })
})
