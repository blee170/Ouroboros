import { describe, expect, it } from 'vitest'
import { groupRows, rosterOrder, type RosterNode } from '../src/shared/roster'

const card = (id: string, data: Partial<RosterNode['data']> = {}): RosterNode => ({ id, data: { kind: 'claude', ...data } })

describe('groupRows', () => {
  it('nests a worker under its Conductor and a worker under its team lead', () => {
    const rows = groupRows([card('w', { parentId: 't' }), card('c'), card('t', { parentId: 'c' }), card('solo')])
    expect(rows.map((r) => `${r.node.id}:${r.depth}`)).toEqual(['c:0', 't:1', 'w:2', 'solo:0'])
  })
  it('keeps a worker flat when its parent is not in the section', () => {
    const rows = groupRows([card('w', { parentId: 'elsewhere' })])
    expect(rows.map((r) => `${r.node.id}:${r.depth}`)).toEqual(['w:0'])
  })
  it('places every member once even with a parent cycle or a self-parent', () => {
    const rows = groupRows([card('a', { parentId: 'b' }), card('b', { parentId: 'a' }), card('me', { parentId: 'me' })])
    expect(rows.map((r) => r.node.id).sort()).toEqual(['a', 'b', 'me'])
    expect(rows.find((r) => r.node.id === 'me')?.depth).toBe(0)
  })
})

describe('rosterOrder', () => {
  it('orders by section, then nests, and leaves notes and browsers out', () => {
    const nodes = [card('note', { kind: 'note' }), card('idle', { status: 'idle' }), card('w', { status: 'working', parentId: 'c' }), card('c', { status: 'working' }), card('ask', { status: 'needs-you' }), card('web', { kind: 'browser' })]
    expect(rosterOrder(nodes).map((n) => n.id)).toEqual(['ask', 'c', 'w', 'idle'])
  })
  it('counts a card without a status as starting (the Working section)', () => {
    expect(rosterOrder([card('idle', { status: 'idle' }), card('fresh')]).map((n) => n.id)).toEqual(['fresh', 'idle'])
  })
  it('is stable: ordering its own output again changes nothing (the Ctrl+N chips and the canvas hotkeys agree)', () => {
    const nodes = [card('w2', { status: 'working', parentId: 'c' }), card('c', { status: 'working' }), card('w1', { status: 'working', parentId: 'c' }), card('x')]
    const once = rosterOrder(nodes)
    expect(rosterOrder(once).map((n) => n.id)).toEqual(once.map((n) => n.id))
  })
})
