import { describe, expect, it } from 'vitest'
import { GROK_BOT_LIMITS, botMenu, botOf, botViews, grokBots, grokBotUrl, handoffPayload, newHandoff, pickBot, saveBots, scrubKey, type GrokBot, type GrokHandoff } from '@shared/grokbot'
import { sendToGrokBot } from '../src/main/grokbot'
import { needsYou } from '@shared/today'

const URL_OK = 'https://api2.cursor.sh/automations/webhook/rt_AbC-123'
const KEY = 'crsr_SECRETKEY123'

describe('grokBotUrl', () => {
  it('takes a routine webhook only', () => {
    expect(grokBotUrl(` ${URL_OK} `)).toBe(URL_OK)
    for (const bad of [
      'http://api2.cursor.sh/automations/webhook/x',
      'https://evil.example/automations/webhook/x',
      'https://api2.cursor.sh.evil.example/automations/webhook/x',
      'https://user:pw@api2.cursor.sh/automations/webhook/x',
      'https://api2.cursor.sh:8443/automations/webhook/x',
      'https://api2.cursor.sh/automations/webhook/x?to=evil',
      'https://api2.cursor.sh/automations/webhook/../../x',
      'https://api2.cursor.sh/other/x',
      'not a url',
      ''
    ])
      expect(grokBotUrl(bad)).toBeUndefined()
  })
})

describe('Grok Bot list', () => {
  const URL2 = 'https://api2.cursor.sh/automations/webhook/rt_two'
  const two: GrokBot[] = [
    { id: 'b1', name: 'Personal', purpose: 'email, vendor replies, calendar', url: URL_OK, keyEnc: 'enc1' },
    { id: 'b2', name: 'CSB', purpose: 'marketing research', url: URL2 }
  ]
  it('reads the single bot of an older version as the first entry, and an empty list as none', () => {
    expect(grokBots({ grokBotUrl: URL_OK, grokBotKeyEnc: 'enc' })).toEqual([{ id: 'b1', name: 'Grok Bot', url: URL_OK, keyEnc: 'enc' }])
    expect(grokBots({})).toEqual([])
    // once saved as a list, the old fields no longer count (even an empty list)
    expect(grokBots({ grokBots: [], grokBotUrl: URL_OK })).toEqual([])
  })
  it('saves names, purposes and webhooks; a bot keeps its key by id, a new row gets a free id', () => {
    const r = saveBots(two, [
      { id: 'b2', name: ' CSB ', purpose: ' marketing   research ', url: URL2, keyEnc: 'forged' },
      { name: 'Parents', url: '' },
      { id: 'b1', name: 'Personal', url: URL_OK }
    ])
    expect(r).toEqual({
      ok: true,
      bots: [
        { id: 'b2', name: 'CSB', purpose: 'marketing research', url: URL2 },
        { id: 'b3', name: 'Parents' },
        { id: 'b1', name: 'Personal', url: URL_OK, keyEnc: 'enc1' }
      ]
    })
    // an id the owner never had is a new bot, not someone's key
    expect(saveBots(two, [{ id: 'b9', name: 'X' }])).toEqual({ ok: true, bots: [{ id: 'b3', name: 'X' }] })
  })
  it('refuses a missing or duplicate name, a bad webhook, a twice-listed bot and too many', () => {
    const err = (input: unknown): string => {
      const r = saveBots(two, input)
      return r.ok ? '' : r.error
    }
    expect(err('x')).toMatch(/list/)
    expect(err([{ name: ' ' }])).toMatch(/name/)
    expect(err([{ name: 'A' }, { name: 'a' }])).toMatch(/two bots/)
    expect(err([{ name: 'A', url: 'https://evil.example/automations/webhook/x' }])).toMatch(/not a routine webhook/)
    expect(err([{ id: 'b1', name: 'A' }, { id: 'b1', name: 'B' }])).toMatch(/twice/)
    expect(err([{ name: 'A‮' }])).toMatch(/invisible/)
    expect(err([{ name: 'x'.repeat(41) }])).toMatch(/over 40/)
    expect(err(Array.from({ length: 9 }, (_, i) => ({ name: `n${i}` })))).toMatch(/at most 8/)
  })
  it('picks a bot by name or id in any case; with none named, the only one, else it lists them', () => {
    expect(pickBot(two, 'csb')).toEqual({ ok: true, bot: two[1] })
    expect(pickBot(two, 'B1')).toEqual({ ok: true, bot: two[0] })
    expect(pickBot([two[0]], undefined)).toEqual({ ok: true, bot: two[0] })
    const none = pickBot(two, '')
    expect(none.ok).toBe(false)
    expect(!none.ok && none.error).toContain('- Personal — email, vendor replies, calendar')
    expect(!none.ok && none.error).toContain('- CSB — marketing research (not set up yet: no webhook or key)')
    expect(pickBot(two, 'Work')).toMatchObject({ ok: false, error: expect.stringContaining('no bot "Work"') })
    expect(pickBot([], 'x')).toMatchObject({ ok: false, error: expect.stringContaining('not set up a Grok Bot') })
  })
  it('never shows a key to Settings, and sends an older handoff to the first bot', () => {
    expect(botViews(two)[0]).toEqual({ id: 'b1', name: 'Personal', purpose: 'email, vendor replies, calendar', url: URL_OK, hasKey: true })
    expect(JSON.stringify(botViews(two))).not.toContain('enc1')
    expect(botOf(two, {})).toBe(two[0])
    expect(botOf(two, { bot: 'b2' })).toBe(two[1])
    expect(botOf(two, { bot: 'gone' })).toBeUndefined()
    // the id now belongs to another bot, or the bot was renamed: not the one the owner reviewed
    expect(botOf(two, { bot: 'b2', botName: 'CSB' })).toBe(two[1])
    expect(botOf(two, { bot: 'b2', botName: 'Notes' })).toBeUndefined()
    // a name wins over another bot's id
    expect(pickBot([...two, { id: 'b3', name: 'b1' }], 'b1')).toMatchObject({ ok: true, bot: { id: 'b3' } })
    expect(botMenu(two).split('\n')).toHaveLength(2)
  })
  it('a handoff carries its bot; the same task to another bot is not a duplicate', () => {
    const a = newHandoff({ card: 'c1', title: 'Conductor', task: 'find venues', bot: two[0] }, [], 'G1', 1)
    expect(a).toMatchObject({ ok: true, handoff: { bot: 'b1', botName: 'Personal' } })
    const list = a.ok ? [a.handoff] : []
    expect(newHandoff({ card: 'c1', title: 'Conductor', task: 'find venues', bot: two[0] }, list, 'G2', 2).ok).toBe(false)
    expect(newHandoff({ card: 'c1', title: 'Conductor', task: 'find venues', bot: two[1] }, list, 'G2', 2).ok).toBe(true)
  })
})

describe('newHandoff', () => {
  const base = { card: 'c1', title: 'Conductor' }
  it('makes a pending handoff, trimmed', () => {
    const r = newHandoff({ ...base, task: '  research X  ', context: ' links ' }, [], 'G1', 5)
    expect(r).toEqual({ ok: true, handoff: { id: 'G1', card: 'c1', title: 'Conductor', task: 'research X', context: 'links', createdAt: 5, state: 'pending' } })
  })
  it('refuses empty, oversized, duplicate, and too many waiting', () => {
    expect(newHandoff({ ...base, task: ' ' }, [], 'G1', 0).ok).toBe(false)
    expect(newHandoff({ ...base, task: 7 }, [], 'G1', 0).ok).toBe(false)
    expect(newHandoff({ ...base, task: 'x'.repeat(GROK_BOT_LIMITS.task + 1) }, [], 'G1', 0).ok).toBe(false)
    expect(newHandoff({ ...base, task: 'x', context: 'y'.repeat(GROK_BOT_LIMITS.context + 1) }, [], 'G1', 0).ok).toBe(false)
    const pending = (id: string, task = id): GrokHandoff => ({ id, card: 'c1', title: 'C', task, createdAt: 0, state: 'pending' })
    expect(newHandoff({ ...base, task: 'same' }, [pending('G1', 'same')], 'G2', 0)).toEqual({ ok: false, error: 'the same handoff already waits for the owner' })
    expect(newHandoff({ ...base, task: 'same' }, [{ ...pending('G1', 'same'), state: 'sent' }], 'G2', 0).ok).toBe(true)
    const full = Array.from({ length: GROK_BOT_LIMITS.pending }, (_, i) => ({ ...pending(`G${i}`), card: `c${i}` }))
    expect(newHandoff({ ...base, task: 'new' }, full, 'GX', 0).ok).toBe(false)
    // one card cannot fill the queue for the others
    const mine = Array.from({ length: GROK_BOT_LIMITS.pendingPerCard }, (_, i) => pending(`G${i}`))
    expect(newHandoff({ ...base, task: 'new' }, mine, 'GX', 0)).toMatchObject({ ok: false, error: expect.stringMatching(/of your handoffs already wait/) })
    expect(newHandoff({ ...base, card: 'c2', task: 'new' }, mine, 'GX', 0).ok).toBe(true)
  })
  it('refuses text that could hide or reorder what the owner reads', () => {
    for (const ch of [0x202e, 0x2066, 0x200b, 0xfeff, 0x07, 0x1b])
      expect(newHandoff({ ...base, task: `look here${String.fromCharCode(ch)}hidden` }, [], 'G1', 0)).toMatchObject({ ok: false, error: expect.stringMatching(/invisible/) })
    expect(newHandoff({ ...base, task: 'ok', context: `a${String.fromCharCode(0x202e)}b` }, [], 'G1', 0).ok).toBe(false)
    expect(newHandoff({ ...base, task: 'line one\n\tline two · 한글 ✓' }, [], 'G1', 0).ok).toBe(true)
  })
  it('builds the body the routine receives', () => {
    const h: GrokHandoff = { id: 'G3', card: 'c1', title: 'Conductor', task: 't', createdAt: 0, state: 'pending' }
    expect(handoffPayload(h, 'Ouroboros', Date.UTC(2026, 9, 26))).toEqual({ source: 'ouroboros', kind: 'handoff', task: 't', from: 'Conductor', project: 'Ouroboros', handoffId: 'G3', sentAt: '2026-10-26T00:00:00.000Z' })
  })
  it('lists a pending handoff in Today, ranked right after approvals', () => {
    const h: GrokHandoff = { id: 'G1', card: 'c1', title: 'Conductor', task: 'research\nmore', createdAt: 9, state: 'pending', error: 'Grok Bot refused the key (401)' }
    const needs = needsYou({ cards: [{ id: 'c1', title: 'Conductor', kind: 'conductor', status: 'needs-you', statusDetail: 'permission: Bash' }], tasks: [], approvals: [], held: [], handoffs: [h, { ...h, id: 'G2', state: 'sent' }] })
    expect(needs.map((n) => [n.kind, n.handoffId, n.text])).toEqual([
      ['handoff', 'G1', 'research more (last try: Grok Bot refused the key (401))'],
      ['permission', undefined, 'permission: Bash']
    ])
  })
})

type Call = { url: string; init: RequestInit }
const fake = (status: number, body: unknown | Error): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (body instanceof Error) throw body
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

describe('sendToGrokBot', () => {
  it('posts JSON with the key as a Bearer token and returns the run id', async () => {
    const { fetch, calls } = fake(200, { success: true, runUuid: 'run-1' })
    expect(await sendToGrokBot({ url: URL_OK, key: KEY, payload: { a: 1 }, fetch })).toEqual({ ok: true, runUuid: 'run-1' })
    expect(calls[0].url).toBe(URL_OK)
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].init.redirect).toBe('error')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ a: 1 })
  })
  it('a 200 without success:true is no run; 400, 401 and others say why, without the key', async () => {
    expect((await sendToGrokBot({ url: URL_OK, key: KEY, payload: {}, fetch: fake(200, { ok: 1 }).fetch })).ok).toBe(false)
    expect(await sendToGrokBot({ url: URL_OK, key: KEY, payload: {}, fetch: fake(401, { code: 'unauthorized', message: `bad ${KEY}` }).fetch })).toMatchObject({ ok: false, status: 401, error: expect.stringMatching(/refused the key/) })
    const off = await sendToGrokBot({ url: URL_OK, key: KEY, payload: {}, fetch: fake(400, { success: false, error: `Routine "x" is not active; key ${KEY}` }).fetch })
    expect(off).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/Active switch/) })
    expect(!off.ok && off.error).not.toContain(KEY)
    expect(await sendToGrokBot({ url: URL_OK, key: KEY, payload: {}, fetch: fake(502, '<html>').fetch })).toEqual({ ok: false, status: 502, error: 'Grok Bot 502: no run started' })
    const down = await sendToGrokBot({ url: URL_OK, key: KEY, payload: {}, fetch: fake(0, new TypeError(`fetch failed Bearer ${KEY}`)).fetch })
    expect(down).toEqual({ ok: false, error: 'Grok Bot unreachable: fetch failed Bearer [key]' })
  })
  it('never sends to anything but a routine webhook, nor without a key', async () => {
    const { fetch, calls } = fake(200, { success: true })
    expect((await sendToGrokBot({ url: 'https://evil.example/automations/webhook/x', key: KEY, payload: {}, fetch })).ok).toBe(false)
    expect((await sendToGrokBot({ url: URL_OK, key: '', payload: {}, fetch })).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('scrubs Cursor keys and Bearer values', () => {
    expect(scrubKey('k=crsr_abc-1 Authorization: Bearer xyz other', 'other')).toBe('k=[key] Authorization: Bearer [key] [key]')
  })
})
