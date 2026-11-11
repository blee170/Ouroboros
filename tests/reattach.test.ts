import { describe, expect, it } from 'vitest'
import { RELOAD_LIMIT, RELOAD_WINDOW_MS, ReloadGuard, launchMode, reattachWorkspace, replayInput, type LiveNode } from '../src/shared/reattach'
import { GRID, defaultSize } from '../src/shared/layout'
import type { NodeData, Workspace, WorkspaceEdge } from '../src/shared/types'
import { Board } from '../src/main/board'

const data = (p: Partial<NodeData> = {}): NodeData => ({ kind: 'claude', title: 't', cwd: 'C:/p', ...p }) as NodeData

describe('ReloadGuard (crash loop)', () => {
  it('allows RELOAD_LIMIT automatic reloads in the window, then refuses', () => {
    const g = new ReloadGuard()
    for (let i = 0; i < RELOAD_LIMIT; i++) expect(g.allow(1000 + i)).toBe(true)
    expect(g.allow(2000)).toBe(false)
    expect(g.allow(2000)).toBe(false) // a refused reload is not counted, but the window stays full
  })
  it('allows again once the oldest reload is RELOAD_WINDOW_MS old', () => {
    const g = new ReloadGuard()
    for (let i = 0; i < RELOAD_LIMIT; i++) g.allow(i * 1000)
    expect(g.allow(RELOAD_WINDOW_MS - 1)).toBe(false)
    expect(g.allow(RELOAD_WINDOW_MS)).toBe(true)
    expect(g.allow(RELOAD_WINDOW_MS + 1)).toBe(false)
  })
  it('one guard per window: another window is not limited by this one', () => {
    const a = new ReloadGuard()
    const b = new ReloadGuard()
    for (let i = 0; i < RELOAD_LIMIT; i++) a.allow(i)
    expect(a.allow(10)).toBe(false)
    expect(b.allow(10)).toBe(true)
  })
})

describe('launchMode (attach or spawn)', () => {
  it('attaches only on the first launch of a card main still runs', () => {
    expect(launchMode({ first: true, live: true, asleep: false })).toBe('attach')
    expect(launchMode({ first: true, live: false, asleep: false })).toBe('spawn') // not running in main: a plain open
    expect(launchMode({ first: false, live: true, asleep: false })).toBe('spawn') // a later Restart (launchSeq bumped) restarts it
    expect(launchMode({ first: false, live: false, asleep: false })).toBe('spawn')
  })
  it('an asleep card waits for its wake', () => {
    expect(launchMode({ first: true, live: false, asleep: true })).toBe('wait')
    expect(launchMode({ first: false, live: false, asleep: true })).toBe('wait')
  })
})

describe('reattachWorkspace (what main returns to a reloaded window)', () => {
  const edge: WorkspaceEdge = { id: 'e1', source: 'a', target: 'b', data: { mode: 'auto', template: 'x' } }
  const file: Workspace = {
    version: 1,
    projectRoot: 'C:/p',
    viewport: { x: 1, y: 2, zoom: 0.5 },
    nodes: [
      { id: 'a', position: { x: 10, y: 20 }, width: 700, height: 500, data: data({ title: 'stale title', status: 'starting', sessionId: 'old' }) },
      { id: 'gone', position: { x: 0, y: 0 }, data: data() }
    ],
    edges: []
  }

  it("takes main's cards and state, the file's layout and viewport, and lists the running cards", () => {
    const nodes: LiveNode[] = [
      { id: 'a', data: data({ title: 'Worker', status: 'working', statusDetail: 'Bash', sessionId: 'new', lastAssistantMessage: 'hi' }), pos: { x: 999, y: 999 } },
      { id: 'b', data: data({ title: 'Asleep', asleep: true, status: 'ended', sessionId: 's2' }) },
      { id: 'c', data: data({ title: 'Ended', status: 'ended', statusDetail: 'exited (0)' }) },
      { id: 'n', data: data({ kind: 'note', title: 'Note' }) }
    ]
    const alive = new Set(['a', 'b']) // b's process can not be running: an asleep card has none, it is never attached
    const { workspace, live } = reattachWorkspace('C:/p', nodes, [edge], (id) => alive.has(id), file)
    expect(live).toEqual(['a'])
    expect(workspace.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'n']) // 'gone' was closed after the last save
    const a = workspace.nodes[0]
    expect(a.position).toEqual({ x: 10, y: 20 })
    expect([a.width, a.height]).toEqual([700, 500])
    expect(a.data).toMatchObject({ title: 'Worker', status: 'working', statusDetail: 'Bash', sessionId: 'new', lastAssistantMessage: 'hi' })
    expect(workspace.nodes[1].data.asleep).toBe(true)
    expect(workspace.nodes[2].data.status).toBe('ended')
    expect(workspace.edges).toEqual([edge])
    expect(workspace.edges[0]).not.toBe(edge)
    expect(workspace.viewport).toEqual(file.viewport)
  })

  it('a running card with no event yet is idle; one never synced and not running keeps no status', () => {
    const { workspace, live } = reattachWorkspace('C:/p', [{ id: 'x', data: data() }, { id: 'y', data: data() }], [], (id) => id === 'x', null)
    expect(live).toEqual(['x'])
    expect(workspace.nodes[0].data.status).toBe('idle')
    expect(workspace.nodes[1].data.status).toBeUndefined()
  })

  it('places a card the file does not have: around its synced centre, else in the first free grid cell', () => {
    const size = defaultSize('claude')
    const nodes: LiveNode[] = [
      { id: 'a', data: data() }, // in the file, at the grid origin cell
      { id: 'synced', data: data(), pos: { x: 2000, y: 1000 } },
      { id: 'conductor-made', data: data() } // made by main while the page was dead: never synced, no centre
    ]
    const f: Workspace = { ...file, nodes: [{ id: 'a', position: { x: GRID.originX, y: GRID.originY }, data: data() }] }
    const { workspace } = reattachWorkspace('C:/p', nodes, [], () => false, f)
    expect(workspace.nodes[1].position).toEqual({ x: 2000 - size.width / 2, y: 1000 - size.height / 2 })
    expect([workspace.nodes[1].width, workspace.nodes[1].height]).toEqual([size.width, size.height])
    // the origin cell is taken by 'a': the next cell to its right
    expect(workspace.nodes[2].position).toEqual({ x: GRID.originX + GRID.pitchX, y: GRID.originY })
  })

  it("the reloaded page's first sync keeps main's cards and their live state", () => {
    const b = new Board()
    b.sync({ projectRoot: 'C:/p', nodes: [{ id: 'a', data: data({ title: 'A' }), pos: { x: 300, y: 300 } }, { id: 'z', data: data({ title: 'Z' }) }], edges: [] })
    b.setStatus('a', { status: 'working', statusDetail: 'Bash', sessionId: 's-new' })
    b.nodes.get('z')!.data.asleep = true
    b.nodes.set('made', { id: 'made', data: data({ title: 'by the Conductor' }) }) // createAgent while the page was dead
    b.appendOutput('a', 'hello')
    const { workspace } = reattachWorkspace('C:/p', b.nodes.values(), b.edges, (id) => id === 'a', null)
    // what the page sends back (toBoardNode resets launchSeq; scheduleSync sends every card)
    b.sync({ projectRoot: 'C:/p', nodes: workspace.nodes.map((n) => ({ id: n.id, data: { ...n.data, launchSeq: 0 }, pos: n.position })), edges: workspace.edges })
    expect([...b.nodes.keys()]).toEqual(['a', 'z', 'made'])
    expect(b.nodes.get('a')!.data).toMatchObject({ status: 'working', statusDetail: 'Bash', sessionId: 's-new' })
    expect(b.nodes.get('z')!.data.asleep).toBe(true)
    expect(b.getOutput('a')).toBe('hello')
  })

  it('does not hand out main state by reference', () => {
    const n: LiveNode = { id: 'a', data: data({ status: 'idle' }) }
    const { workspace } = reattachWorkspace('C:/p', [n], [], () => true, null)
    workspace.nodes[0].data.title = 'changed'
    expect(n.data.title).toBe('t')
  })
})

describe('Board.getReplay (repaint of a reattached card)', () => {
  const ESC = String.fromCharCode(27)
  it('is the output itself while all of it is kept', () => {
    const b = new Board()
    b.appendOutput('a', `${ESC}[?2004hprompt`)
    expect(b.getReplay('a')).toBe(`${ESC}[?2004hprompt`)
  })
  it('starts with the modes set in the output trimmed off the front, the last word of each winning', () => {
    const b = new Board()
    const head = `${ESC}[?2004h${ESC}[?1;25l${ESC}[?25h${ESC}[?25l`
    b.appendOutput('a', head + 'x'.repeat(200_000))
    b.appendOutput('a', 'tail')
    const r = b.getReplay('a')
    expect(r.startsWith(`${ESC}[?2004h${ESC}[?1l${ESC}[?25lxxx`)).toBe(true)
    expect(r.endsWith('xtail')).toBe(true)
    expect(b.getOutput('a').length).toBe(200_000)
    expect(b.getReplay('b')).toBe('')
  })
})

describe('replayInput (xterm answers to replayed queries stay out of the process)', () => {
  const ESC = String.fromCharCode(27)
  /** xterm as far as this matters: it answers DA1 / CPR while it parses, and calls back once a write is parsed (later, in order). */
  function fakeTerm(onData: (d: string) => void) {
    const queue: Array<() => void> = []
    return {
      write(data: string, parsed?: () => void) {
        queue.push(() => {
          if (data.includes(`${ESC}[c`)) onData(`${ESC}[?1;2c`)
          if (data.includes(`${ESC}[6n`)) onData(`${ESC}[12;1R`)
          parsed?.()
        })
      },
      parse() {
        while (queue.length) queue.shift()!()
      }
    }
  }

  it('drops the answers made while the replay is parsed, then forwards again (live queries, keys)', () => {
    const sent: string[] = []
    const keys = replayInput((d) => sent.push(d))
    const term = fakeTerm(keys.input)
    let done = 0
    keys.replay(term, `${ESC}c${ESC}[c${ESC}[6nprompt`, () => done++)
    term.write(`${ESC}[6n`) // live output after the reply: CLI asks again
    term.parse()
    expect(done).toBe(1)
    expect(sent).toEqual([`${ESC}[12;1R`]) // only the live query's answer
    keys.input('a')
    expect(sent).toEqual([`${ESC}[12;1R`, 'a'])
  })

  it('forwards everything when nothing is replayed', () => {
    const sent: string[] = []
    const keys = replayInput((d) => sent.push(d))
    const term = fakeTerm(keys.input)
    term.write(`${ESC}[c`)
    term.parse()
    expect(sent).toEqual([`${ESC}[?1;2c`])
  })
})
