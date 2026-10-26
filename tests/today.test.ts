import { describe, expect, it } from 'vitest'
import { needsYou, todayView, type TodayCard } from '@shared/today'
import type { Task } from '@shared/ledger'
import type { Approval } from '@shared/gate'

const task = (p: Partial<Task> & { id: string }): Task => ({ title: p.id, state: 'todo', deps: [], createdBy: 'owner', createdAt: 0, updatedAt: 0, ...p })
const card = (p: Partial<TodayCard> & { id: string }): TodayCard => ({ title: p.id, kind: 'claude', ...p })

describe('needsYou', () => {
  it('ranks approvals, prompts, held cards, decisions, failures, then blocked tasks', () => {
    const approvals: Approval[] = [
      { id: 'A1', card: 'c1', title: 'Dev', command: 'gh pr merge 3', createdAt: 5, state: 'pending' },
      { id: 'A2', card: 'c1', title: 'Dev', command: 'gh pr merge 4', createdAt: 6, state: 'used' }
    ]
    const cards = [
      card({ id: 'c1', title: 'Dev', status: 'needs-you', statusDetail: 'permission: Bash', unreadAt: 9 }),
      card({ id: 'c2', title: 'QA', status: 'needs-you', statusDetail: 'failed: API error', unreadAt: 8 }),
      card({ id: 'cond', title: 'Conductor', kind: 'conductor', status: 'idle', unreadAt: 7, lastAssistantMessage: 'Plan\nOWNER: DECIDE — ship now?' })
    ]
    const tasks = [
      task({ id: 'T1', state: 'blocked', reason: 'waiting on T2', updatedAt: 3 }),
      task({ id: 'T2', state: 'blocked', reason: 'APPROVAL NEEDED: deploy to prod', updatedAt: 2, updatedBy: 'owner' }),
      task({ id: 'T3', state: 'done', updatedAt: 4 })
    ]
    const held = [{ nodeId: 'c9', title: 'Odd', added: true, changes: [] }]
    const got = needsYou({ cards, tasks, approvals, held }).map((n) => [n.kind, n.key, n.text])
    expect(got).toEqual([
      ['approval', 'a:A1', 'gh pr merge 3'],
      ['permission', 'p:c1', 'permission: Bash'],
      ['held', 'h:c9', 'new card from an outside edit of the board file'],
      ['decision', 'd:cond', 'ship now?'],
      ['decision', 't:T2', 'deploy to prod'],
      ['failed', 'f:c2', 'API error'],
      ['blocked', 't:T1', 'waiting on T2']
    ])
  })

  it('drops a reply decision once the card was looked at or started again', () => {
    const reply = 'OWNER: DECIDE — x'
    expect(needsYou({ cards: [card({ id: 'c', status: 'idle', lastAssistantMessage: reply })], tasks: [], approvals: [], held: [] })).toEqual([])
    expect(needsYou({ cards: [card({ id: 'c', status: 'working', unreadAt: 1, lastAssistantMessage: reply })], tasks: [], approvals: [], held: [] })).toEqual([])
  })

  it('says one question once: a reply decision that is also a blocked task, or from a card on a prompt', () => {
    const reply = 'OWNER: DECIDE — deploy?'
    const tasks = [task({ id: 'T1', state: 'blocked', reason: 'APPROVAL NEEDED: deploy', updatedBy: 'cond' })]
    const cards = [card({ id: 'cond', status: 'idle', unreadAt: 1, lastAssistantMessage: reply }), card({ id: 'c2', status: 'needs-you', statusDetail: 'permission: Bash', unreadAt: 1, lastAssistantMessage: reply })]
    expect(needsYou({ cards, tasks, approvals: [], held: [] }).map((n) => n.key)).toEqual(['p:c2', 't:T1'])
  })

  it('a failure waits only until the owner has looked at the card', () => {
    const failed = card({ id: 'c', status: 'needs-you', statusDetail: 'failed: usage limit' })
    expect(needsYou({ cards: [{ ...failed, unreadAt: 5 }], tasks: [], approvals: [], held: [] }).map((n) => n.kind)).toEqual(['failed'])
    expect(needsYou({ cards: [failed], tasks: [], approvals: [], held: [] })).toEqual([])
  })

  it('links a blocked task to a live card only', () => {
    const tasks = [task({ id: 'T1', state: 'blocked', reason: 'r', owner: 'c1' }), task({ id: 'T2', state: 'blocked', reason: 'r', owner: 'gone' })]
    const got = needsYou({ cards: [card({ id: 'c1' })], tasks, approvals: [], held: [] })
    expect(got.map((n) => n.cardId)).toEqual(['c1', undefined])
  })
})

describe('todayView', () => {
  it('lists working cards oldest first, tasks done since midnight, and unread reports', () => {
    const now = new Date(2026, 9, 26, 15, 0).getTime()
    const yesterday = new Date(2026, 9, 25, 23, 0).getTime()
    const v = todayView({
      now,
      cards: [
        card({ id: 'w2', status: 'working', workingSince: 20 }),
        card({ id: 'w1', status: 'working', workingSince: 10 }),
        card({ id: 'r', title: 'Conductor', status: 'idle', unreadAt: now - 60_000, lastAssistantMessage: 'Done.\n\n**OWNER: REPORT** — brief is up' }),
        card({ id: 'seen', status: 'idle', lastAssistantMessage: 'OWNER: REPORT — old' })
      ],
      tasks: [task({ id: 'T1', state: 'done', updatedAt: now - 1000 }), task({ id: 'T2', state: 'done', updatedAt: yesterday }), task({ id: 'T3', state: 'done', updatedAt: now - 10 })]
    })
    expect(v.working.map((c) => c.id)).toEqual(['w1', 'w2'])
    expect(v.done.map((t) => t.id)).toEqual(['T3', 'T1'])
    expect(v.reports).toEqual([{ cardId: 'r', title: 'Conductor', line: 'brief is up', at: now - 60_000 }])
  })
})
