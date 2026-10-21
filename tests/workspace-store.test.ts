import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspace, sanitizeWorkspace, saveWorkspace } from '../src/main/workspace-store'
import type { Workspace } from '@shared/types'

describe('workspace store', () => {
  it('round-trips a workspace and drops runtime fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ouro-'))
    const ws: Workspace = {
      version: 1,
      projectRoot: dir,
      nodes: [{ id: 'n1', position: { x: 1, y: 2 }, width: 10, height: 20, data: { kind: 'claude', title: 't', cwd: dir, status: 'working', lastAssistantMessage: 'x', claude: { continue: true } } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n1', data: { mode: 'auto', template: 'tpl' } }]
    }
    saveWorkspace(ws)
    const loaded = loadWorkspace(dir)
    expect(loaded?.nodes[0].data.status).toBeUndefined()
    expect(loaded?.nodes[0].data.claude).toEqual({ continue: true })
    expect(loaded?.edges[0].data.template).toBe('tpl')
    expect(sanitizeWorkspace(ws).nodes[0].data.lastAssistantMessage).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
  it('returns null for a missing file', () => {
    expect(loadWorkspace(join(tmpdir(), 'definitely-missing-' + Date.now()))).toBeNull()
  })
})
