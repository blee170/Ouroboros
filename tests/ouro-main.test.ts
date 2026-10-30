import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Ouro, type OuroHandlers, type OuroResult } from '../src/main/ouro'
import type { OuroNeed, OuroStatus } from '../src/shared/ouro'

const OWNER = '281821501458743298'

class FakeBot extends EventEmitter {
  state: 'off' | 'ready' | 'failed' = 'off'
  detail = ''
  username = 'Ouro'
  sent: string[] = []
  posts: Array<[string, string]> = []
  refuse = ''
  started = 0
  stopped = 0
  start(): void {
    this.started++
  }
  stop(): void {
    this.stopped++
  }
  async send(t: string): Promise<void> {
    this.sent.push(t)
  }
  async post(id: string, t: string): Promise<void> {
    if (this.refuse) throw new Error(this.refuse)
    this.posts.push([id, t])
  }
  ready(): void {
    this.state = 'ready'
    this.emit('ready', 'Ouro')
  }
}

const q: OuroNeed = { ref: '1-D1', kind: 'question', title: 'Conductor', text: 'Which cache?', answers: ['Redis', 'SQLite'] }
const task: OuroNeed = { ref: '1-T4', kind: 'task-approve', title: 'Deposit', text: 'Merge PR 12 into main?', shownAt: 100 }
const doTask: OuroNeed = { ref: '1-T5', kind: 'task-do', title: 'Migration', text: 'Apply the SQL on production', shownAt: 101 }
const gate: OuroNeed = { ref: '1-A1', kind: 'approval', title: 'Worker', text: 'gh pr merge 3 --squash' }

function harness(needs: OuroNeed[] = []) {
  const st: OuroStatus = { project: 'p', working: 1, idle: 2, autonomous: false, needs: [...needs] }
  const calls: string[] = []
  const notes: string[] = []
  let now = 1_000_000
  const timers: { fn: () => void; at: number }[] = []
  let tellResult: ReturnType<OuroHandlers['tell']> = { ok: true, card: 'cond' }
  // a decided need leaves the board, as it does in the app
  const res = (s: string, n: OuroNeed): OuroResult => {
    calls.push(s)
    st.needs = st.needs.filter((x) => x.ref !== n.ref)
    return { ok: true }
  }
  const h: OuroHandlers = {
    status: () => ({ ...st, needs: [...st.needs] }),
    approve: (n) => res(`approve ${n.ref} ${n.shownAt ?? ''}`, n),
    hold: (n) => res(`hold ${n.ref}`, n),
    answer: (n, a) => res(`answer ${n.ref} ${a}`, n),
    tell: (t, lang) => {
      calls.push(`tell ${lang} ${t}`)
      return tellResult
    },
    note: (l) => notes.push(l),
    log: () => {}
  }
  const bots: FakeBot[] = []
  const ouro = new Ouro(h, {
    makeBot: () => {
      const b = new FakeBot()
      bots.push(b)
      return b
    },
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.push({ fn, at: now + ms })
      return timers.length
    },
    clearTimeout: () => {}
  })
  ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: true, approvals: true })
  const bot = bots[0]
  bot.ready()
  const say = async (text: string): Promise<string> => {
    const before = bot.sent.length
    bot.emit('message', { id: 'm', channelId: 'c', text })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    return bot.sent.slice(before).join(' | ')
  }
  const advance = (ms: number): void => {
    now += ms
    const due = timers.filter((x) => x.at <= now)
    timers.splice(0, timers.length, ...timers.filter((x) => x.at > now))
    for (const t of due) t.fn()
  }
  return { ouro, bot, bots, st, calls, notes, say, advance, setTell: (r: typeof tellResult) => (tellResult = r) }
}

describe('Ouro conversation', () => {
  it('greets with the board when it connects', () => {
    const h = harness([q])
    expect(h.bot.sent[0]).toContain('우로 연결됐어요')
    expect(h.bot.sent[0]).toContain('Redis, SQLite')
  })
  it('approves only after the read-back and a yes, with the shownAt the owner heard', async () => {
    const h = harness([task])
    expect(await h.say('허가')).toContain('"Merge PR 12 into main?" 허가할까요?')
    expect(h.calls).toEqual([])
    expect(await h.say('응')).toBe('허가했어요. 카드에 전했어요.')
    expect(h.calls).toEqual(['approve 1-T4 100'])
    expect(h.notes[0]).toBe('approved T4 (Deposit)')
  })
  it('a no, an expired yes, or another message cancels the read-back', async () => {
    const h = harness([task])
    await h.say('허가')
    expect(await h.say('아니')).toBe('알겠어요, 안 할게요.')
    await h.say('허가')
    h.advance(4 * 60_000)
    expect(await h.say('응')).toContain('시간이 지나서')
    await h.say('approve')
    await h.say('status')
    expect(await h.say('yes')).toContain('not sure')
    expect(h.calls).toEqual([])
  })
  it('answers the question the owner heard by name or number, after a yes', async () => {
    const h = harness([q, task])
    await h.say('상황 어때')
    expect(await h.say('2번')).toBe('Conductor의 질문에 "SQLite"(으)로 답할까요? 응이라고만 답하세요.')
    await h.say('네')
    expect(h.calls).toEqual(['answer 1-D1 SQLite'])
  })
  it('walks the needs with next, and approve goes to the one just heard', async () => {
    const h = harness([q, task, gate])
    await h.say('상황')
    expect(await h.say('다음')).toContain('2/3. Deposit')
    expect(await h.say('다음')).toContain('3/3. Worker')
    expect(await h.say('보류')).toContain('Worker 건을 보류할까요?')
    await h.say('응')
    expect(h.calls).toEqual(['hold 1-A1'])
    expect(h.notes[0]).toBe('denied A1 (Worker)')
    // next goes on with what is left
    expect(await h.say('다음')).toContain('1/2. Conductor')
    expect(await h.say('다음')).toContain('2/2. Deposit')
    expect(await h.say('다음')).toBe('더 기다리는 건 없어요.')
  })
  it('sends a do task to the PC, and refuses approvals when they are switched off', async () => {
    const h = harness([doTask])
    expect(await h.say('허가')).toContain('PC에서 직접')
    h.ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: true, approvals: false })
    const h2 = harness([task])
    h2.ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: true, approvals: false })
    expect(await h2.say('허가')).toContain('설정에서')
    expect(h2.calls).toEqual([])
  })
  it('passes anything else to the Conductor and reads its next replies back, three at most', async () => {
    const h = harness()
    expect(await h.say('결제 페이지 고쳐줘')).toContain('Conductor에게 전했어요')
    expect(h.calls).toEqual(['tell ko 결제 페이지 고쳐줘'])
    h.ouro.stopped('other', 'not this one')
    for (let i = 0; i < 4; i++) h.ouro.stopped('cond', `## 시작했어요 ${i}\n- **곧** 끝나요`)
    const relayed = h.bot.sent.filter((t) => t.startsWith('시작했어요'))
    expect(relayed).toEqual(['시작했어요 0 곧 끝나요', '시작했어요 1 곧 끝나요', '시작했어요 2 곧 끝나요'])
    h.setTell({ ok: false, error: 'no Conductor on the board' })
    expect(await h.say('하나 더')).toContain('못 전했어요: no Conductor')
  })
  it('stops relaying after 20 minutes', async () => {
    const h = harness()
    await h.say('tell me when the deploy is done')
    h.advance(21 * 60_000)
    const n = h.bot.sent.length
    h.ouro.stopped('cond', 'done')
    expect(h.bot.sent.length).toBe(n)
  })
})

describe('Ouro notices', () => {
  it('tells only new needs, batched, at most once a minute', () => {
    const h = harness([q])
    const n0 = h.bot.sent.length
    h.st.needs.push(task, gate)
    h.ouro.boardChanged()
    h.ouro.boardChanged()
    h.advance(3000)
    expect(h.bot.sent.length).toBe(n0) // within a minute of the greeting
    h.advance(60_000)
    expect(h.bot.sent.slice(n0)).toHaveLength(1)
    expect(h.bot.sent.at(-1)).toContain('새로 기다리는 게 2개예요. 첫 번째, Deposit')
    h.ouro.boardChanged()
    h.advance(61_000)
    expect(h.bot.sent.slice(n0)).toHaveLength(1)
  })
  it('tells again a task blocked again later', () => {
    const h = harness([task])
    h.st.needs.length = 0
    h.ouro.boardChanged()
    h.advance(61_000)
    h.st.needs.push({ ...task, shownAt: 200 })
    h.ouro.boardChanged()
    h.advance(61_000)
    expect(h.bot.sent.at(-1)).toContain('새로 기다리는 게 있어요. Deposit')
  })
  it('stays quiet when notices are off', () => {
    const h = harness()
    h.ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: false, approvals: true })
    const n = h.bot.sent.length
    h.st.needs.push(task)
    h.ouro.boardChanged()
    h.advance(120_000)
    expect(h.bot.sent.length).toBe(n)
  })
})

describe('Ouro configure', () => {
  it('starts once, restarts on a new token, and stops when turned off or the owner id is bad', () => {
    const h = harness()
    expect(h.bots).toHaveLength(1)
    h.ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: false, approvals: true })
    expect(h.bots).toHaveLength(1)
    h.ouro.configure({ enabled: true, token: 'tok2', ownerId: OWNER, notify: true, approvals: true })
    expect(h.bots).toHaveLength(2)
    expect(h.bots[0].stopped).toBe(1)
    h.ouro.configure({ enabled: true, token: 'tok2', ownerId: 'me', notify: true, approvals: true })
    expect(h.bots[1].stopped).toBe(1)
    expect(h.ouro.status().state).toBe('off')
  })
  it('ignores a message from a bot it replaced', async () => {
    const h = harness([task])
    h.ouro.configure({ enabled: true, token: 'tok2', ownerId: OWNER, notify: true, approvals: true })
    h.bot.emit('message', { id: 'x', channelId: 'c', text: '허가' })
    await Promise.resolve()
    expect(h.bots[1].sent).toEqual([])
  })
})

describe('bug-hunt regressions (bridge)', () => {
  it('a hedged yes cancels the read-back instead of acting', async () => {
    const h = harness([task])
    await h.say('허가')
    expect(await h.say('어 아니 하지 마')).toBe('알겠어요, 안 할게요.')
    await h.say('허가')
    expect(await h.say('응 근데 잠깐')).toBe('알겠어요, 안 할게요.')
    expect(h.calls).toEqual([])
  })
  it('a notice or a relayed reply in between drops the read-back', async () => {
    const h = harness([task, gate])
    await h.say('한번 물어봐줘') // to the Conductor: starts a relay
    await h.say('허가') // reads back T4
    h.ouro.stopped('cond', '계속할까요?')
    expect(await h.say('응')).toContain('모르겠어요')
    expect(h.calls.filter((c) => c.startsWith('approve'))).toEqual([])
  })
  it('refuses a voice approval of a command it cannot read word for word', async () => {
    const h = harness([{ ...gate, text: 'gh pr merge https://github.com/other/repo/pull/7 --admin' }])
    expect(await h.say('허가')).toContain('음성으로는 허가할 수 없어요')
    expect(await h.say('응')).not.toContain('허가했어요')
    expect(h.calls).toEqual([])
  })
  it('does not act when approvals were switched off while the read-back waited', async () => {
    const h = harness([task])
    await h.say('허가')
    h.ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: true, approvals: false })
    expect(await h.say('응')).toContain('설정에서')
    expect(h.calls).toEqual([])
  })
  it('tells the owner when a handler fails instead of going silent', async () => {
    const h = harness()
    h.setTell(undefined as never) // tell() then returns undefined and the bridge throws reading it
    expect(await h.say('배포해줘')).toContain('문제가 생겨서')
  })
  it('greets once, not on every reconnect, and a progress note is not news', () => {
    const h = harness([task])
    const n = h.bot.sent.length
    h.bot.ready() // Discord asked for a reconnect
    expect(h.bot.sent.length).toBe(n)
    h.st.needs = [{ ...task, shownAt: 999 }] // the task was edited but asks the same
    h.ouro.boardChanged()
    h.advance(61_000)
    expect(h.bot.sent.length).toBe(n)
  })
})

describe('Ouro car ready', () => {
  it('says ready with the board after the mobile-notification delay, again on a reconnect 2 minutes later', async () => {
    const h = harness([q])
    const n = h.bot.sent.length
    expect(h.ouro.carReady()).toEqual({ ok: true, queued: true, inMs: 75_000 })
    // a reconnect while it waits, or soon after, schedules nothing new
    expect(h.ouro.carReady()).toMatchObject({ ok: true, queued: false })
    h.advance(74_000)
    expect(h.bot.sent.length).toBe(n)
    h.advance(2_000)
    expect(h.bot.sent.length).toBe(n + 1)
    expect(h.bot.sent.at(-1)).toContain('🚗 우로 준비됐어요')
    expect(h.bot.sent.at(-1)).toContain('Redis, SQLite')
    expect(h.ouro.carReady()).toMatchObject({ ok: true, queued: false })
    // what it listed is the focus: a yes-path answer goes to it
    expect(await h.say('Redis')).toContain('Redis')
    // a Bluetooth link that flaps right after the greeting is not greeted again
    h.advance(100_000)
    expect(h.ouro.carReady()).toMatchObject({ ok: true, queued: false })
    // a reconnect later is a new Android Auto connection, which shows only what arrives from now on: greeted again
    h.advance(21_000)
    const m = h.bot.sent.length
    expect(h.ouro.carReady()).toMatchObject({ ok: true, queued: true })
    h.advance(76_000)
    expect(h.bot.sent.length).toBe(m + 1)
    // in English: the owner's last word ("Redis") set the language
    expect(h.bot.sent.at(-1)).toContain('🚗 Ouro is ready')
  })
  it('says nothing when the bot is off or not connected', () => {
    const h = harness()
    h.ouro.stop()
    expect(h.ouro.carReady()).toEqual({ ok: false, error: 'Ouro is off (Settings → Ouro)' })
    const g = harness()
    g.ouro.carReady()
    g.bot.state = 'off'
    const n = g.bot.sent.length
    g.advance(80_000)
    expect(g.bot.sent.length).toBe(n)
    // nothing was said, so the next car event may try again at once
    g.bot.state = 'ready'
    expect(g.ouro.carReady()).toMatchObject({ ok: true, queued: true })
  })
  it('announces later needs as new, and leaves a waiting read-back alone', async () => {
    const h = harness([task, q])
    expect(await h.say('허가')).toContain('허가할까요?')
    h.ouro.carReady()
    h.advance(76_000)
    expect(h.bot.sent.at(-1)).toContain('🚗')
    // the read-back still waits: the yes goes to what the owner heard
    expect(await h.say('응')).toBeTruthy()
    expect(h.calls.some((c) => c.startsWith('approve 1-T4'))).toBe(true)
  })
})

describe('posting to a channel', () => {
  const CH = '123456789012345678'
  const withChannels = (h: ReturnType<typeof harness>): void => h.ouro.configure({ enabled: true, token: 'tok', ownerId: OWNER, notify: true, approvals: true, channels: [{ name: '공지', id: CH }] })
  it('posts to an allowed channel by name or id, as the bot, and notes it', async () => {
    const h = harness()
    withChannels(h)
    // the same token and owner: the bot is kept, only the channels change
    expect(h.bots).toHaveLength(1)
    expect(await h.ouro.post('#공지', '  배포 끝났어요.  ', 'Conductor')).toEqual({ ok: true, channel: '공지' })
    expect(await h.ouro.post(CH, 'x'.repeat(5000), 'Conductor')).toEqual({ ok: true, channel: '공지' })
    expect(h.bot.posts).toEqual([
      [CH, '배포 끝났어요.'],
      [CH, 'x'.repeat(4000)]
    ])
    expect(h.notes).toContain('Conductor posted to Discord #공지: 배포 끝났어요.')
    expect(h.notes.at(-1)).toMatch(/^Conductor posted to Discord #공지: x{80}…$/)
    // a post is not a DM: nothing was said to the owner
    expect(h.bot.sent).toHaveLength(1)
  })
  it('refuses a channel the owner did not allow, naming the allowed ones, and an empty text', async () => {
    const h = harness()
    expect(await h.ouro.post('general', 'hi', 'Conductor')).toEqual({ ok: false, error: 'no allowed channel "general": the owner has allowed no channels (Settings → Ouro → Channels)' })
    withChannels(h)
    expect(await h.ouro.post('general', 'hi', 'Conductor')).toEqual({ ok: false, error: 'no allowed channel "general": channels the owner allows: #공지' })
    expect(await h.ouro.post('공지', ' ', 'Conductor')).toEqual({ ok: false, error: 'nothing to post' })
    expect(h.bot.posts).toEqual([])
  })
  it('says when Ouro is off or Discord refused the post', async () => {
    const h = harness()
    withChannels(h)
    h.bot.refuse = 'Discord POST /channels/…/messages → 403'
    const r = await h.ouro.post('공지', 'hi', 'Conductor')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Discord refused the post to #공지: Discord POST /channels/…/messages → 403')
    // a part that went out is said as such, without the permissions hint
    h.bot.refuse = 'Discord POST /channels/…/messages → 500; 1 of 2 parts were posted'
    expect(await h.ouro.post('공지', 'hi', 'Conductor')).toEqual({ ok: false, error: 'Discord refused the post to #공지: Discord POST /channels/…/messages → 500; 1 of 2 parts were posted' })
    h.bot.refuse = ''
    h.bot.state = 'failed'
    h.bot.detail = 'Discord refused the bot token (4004)'
    expect(await h.ouro.post('공지', 'hi', 'Conductor')).toEqual({ ok: false, error: "Ouro's bot is stopped: Discord refused the bot token (4004)" })
    h.ouro.configure({ enabled: false, notify: true, approvals: true, channels: [{ name: '공지', id: CH }] })
    expect(await h.ouro.post('공지', 'hi', 'Conductor')).toEqual({ ok: false, error: 'Ouro is off (Settings → Ouro)' })
  })
  it('caps a channel at 10 posts in 10 minutes, tries included, and posts one at a time', async () => {
    const h = harness()
    withChannels(h)
    for (let i = 0; i < 10; i++) expect((await h.ouro.post('공지', `post ${i}`, 'Conductor')).ok).toBe(true)
    expect(await h.ouro.post('공지', 'one more', 'Conductor')).toEqual({ ok: false, error: '#공지 had 10 posts in the last 10 minutes: wait before posting there again' })
    h.advance(10 * 60_000 + 1)
    expect((await h.ouro.post('공지', 'later', 'Conductor')).ok).toBe(true)
    expect(h.bot.posts.map(([, t]) => t)).toEqual([...Array.from({ length: 10 }, (_, i) => `post ${i}`), 'later'])
    // two posts at once go out in order, whole
    h.advance(10 * 60_000 + 1)
    const [a, b] = await Promise.all([h.ouro.post('공지', 'A', 'c1'), h.ouro.post('공지', 'B', 'c2')])
    expect([a.ok, b.ok]).toEqual([true, true])
    expect(h.bot.posts.slice(-2).map(([, t]) => t)).toEqual(['A', 'B'])
  })
})
