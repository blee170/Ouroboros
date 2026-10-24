import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/board'
import { Ledger, RELEASE_GRACE_MS } from '../src/main/ledger'
import { loadWorkspace, saveLedger, saveWorkspace, sanitizeWorkspace } from '../src/main/workspace-store'
import type { LedgerData, Task } from '@shared/ledger'
import type { Workspace } from '@shared/types'

describe('Ledger (main)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('emits every change and saves once after the debounce', () => {
    const saves: LedgerData[] = []
    const changes: Task[][] = []
    const l = new Ledger((d) => saves.push(d))
    l.on('change', (t: Task[]) => changes.push(t))
    expect(l.create({ title: 'a' }, 'cond').ok).toBe(true)
    expect(l.create({ title: 'b', deps: ['T1'] }, 'cond').ok).toBe(true)
    expect(l.claim('T2', 'c1', new Set(['c1'])).ok).toBe(false) // T1 not done
    expect(changes).toHaveLength(2)
    expect(saves).toHaveLength(0)
    vi.advanceTimersByTime(400)
    expect(saves).toHaveLength(1)
    expect(saves[0].tasks.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(saves[0].nextTaskId).toBe(3)
    l.flush() // nothing pending
    expect(saves).toHaveLength(1)
    expect(l.update('T1', { state: 'done', result: 'x' }, 'cond').ok).toBe(true)
    l.flush()
    expect(saves).toHaveLength(2)
  })

  it('load replaces the ledger without saving; a bad file gives an empty ledger', () => {
    const saves: LedgerData[] = []
    const l = new Ledger((d) => saves.push(d))
    l.load({ tasks: [{ id: 'T4', title: 'kept', state: 'blocked', reason: 'r' }], nextTaskId: 9 })
    expect(l.list().map((t) => t.id)).toEqual(['T4'])
    expect(l.data.nextTaskId).toBe(9)
    l.load('garbage')
    expect(l.list()).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(saves).toHaveLength(0)
  })

  it('releases the doing tasks of a card that stays ended, not of one that restarts', () => {
    const b = new Board()
    b.sync({ projectRoot: '/p', nodes: [{ id: 'c1', data: { kind: 'claude', title: '🛠 Implementer', cwd: '/p' } }, { id: 'c2', data: { kind: 'claude', title: 'Other', cwd: '/p' } }], edges: [] })
    const l = new Ledger(() => {})
    l.attach(b)
    l.create({ title: 'a', owner: 'c1' }, 'cond')
    l.create({ title: 'b', owner: 'c2' }, 'cond')
    // c2 ends and comes back within the grace period: keeps its task
    b.setStatus('c2', { status: 'ended' })
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2)
    b.setPtyAlive('c2', true) // a relaunch: the process is back before the status says starting
    b.setStatus('c2', { status: 'starting' })
    vi.advanceTimersByTime(RELEASE_GRACE_MS)
    expect(l.get('T2')).toMatchObject({ state: 'doing', owner: 'c2' })
    // c1 ends for good
    b.setStatus('c1', { status: 'ended' })
    b.setStatus('c1', { status: 'ended' }) // a second ended (SessionEnd then PTY exit) does not double the timer
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    expect(l.get('T1')).toMatchObject({ state: 'todo', reason: 'card 🛠 Implementer ended before it finished' })
    expect(l.get('T1')?.owner).toBeUndefined()
    // Claude exits inside a shell that stays open: the process is alive but the card is ended, so the task is released
    l.claim('T1', 'c1', new Set(['c1']))
    b.setPtyAlive('c1', true)
    b.setStatus('c1', { status: 'ended' })
    b.setStatus('c1', { status: 'working' }) // a stray hook after the end does not cancel the hand-back
    b.setStatus('c1', { status: 'ended' })
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    expect(l.get('T1')?.state).toBe('todo')
    b.setPtyAlive('c1', false)
    // an explicit kill (no status event) that is followed by a respawn keeps the task; one that is not releases it
    l.cardStopped(b, 'c2')
    b.setPtyAlive('c2', true)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    expect(l.get('T2')?.state).toBe('doing')
    b.setPtyAlive('c2', false)
    l.cardStopped(b, 'c2')
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    expect(l.get('T2')?.state).toBe('todo')
    expect(l.claim('T2', 'c2', new Set(['c2'])).ok).toBe(true)
    // an explicit release (card removed) is immediate
    expect(l.release('c2', 'Other')).toEqual(['T2'])
    expect(l.get('T2')?.state).toBe('todo')
    expect(l.release('c2', 'Other')).toEqual([])
    // a ledger loaded from the board file: doing tasks of cards that never come up are handed back
    l.load({ tasks: [{ id: 'T7', title: 'restored', state: 'doing', owner: 'c1', deps: [] }], nextTaskId: 8 })
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    expect(l.get('T7')).toMatchObject({ state: 'todo', reason: 'card 🛠 Implementer ended before it finished' })
  })
})

describe('ledger in the board file', () => {
  it('round-trips tasks through sanitize / save / load and saveLedger keeps the board', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ouro-ledger-'))
    const ws: Workspace = {
      version: 1,
      projectRoot: dir,
      nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: { kind: 'note', title: 'n', cwd: dir, note: 'hi' } }],
      edges: [],
      tasks: [{ id: 'T1', title: 'a', state: 'todo', deps: [], createdBy: 'owner', createdAt: 1, updatedAt: 1 }],
      nextTaskId: 2
    }
    expect(sanitizeWorkspace(ws).tasks).toHaveLength(1)
    saveWorkspace(ws)
    expect(loadWorkspace(dir)?.tasks?.[0].id).toBe('T1')
    saveLedger(dir, { tasks: [...ws.tasks!, { id: 'T2', title: 'b', state: 'done', deps: [], result: 'r', createdBy: 'c1', createdAt: 2, updatedAt: 2 }], nextTaskId: 3 })
    const again = loadWorkspace(dir)
    expect(again?.nodes).toHaveLength(1) // the board survived the ledger write
    expect(again?.tasks?.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(again?.nextTaskId).toBe(3)
    // no board file yet: a minimal one is written around the ledger
    const fresh = mkdtempSync(join(tmpdir(), 'ouro-ledger-'))
    saveLedger(fresh, { tasks: [], nextTaskId: 1 })
    expect(loadWorkspace(fresh)).toMatchObject({ version: 1, nodes: [], edges: [], nextTaskId: 1 })
    // an unreadable board file is left alone (no copy aside, no overwrite)
    writeFileSync(join(fresh, '.ouroboros.json'), '{ not json')
    saveLedger(fresh, { tasks: [], nextTaskId: 5 })
    expect(readFileSync(join(fresh, '.ouroboros.json'), 'utf8')).toBe('{ not json')
    rmSync(dir, { recursive: true, force: true })
    rmSync(fresh, { recursive: true, force: true })
  })
})
