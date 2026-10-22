import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listClaudeSessions, listSubfolders, parseSessionHead } from '../src/main/claude-history'

const line = (o: unknown): string => JSON.stringify(o) + '\n'

describe('parseSessionHead', () => {
  it('prefers summary over the first user prompt and skips command tags', () => {
    const text =
      line({ type: 'queue-operation', sessionId: 's1' }) +
      line({ type: 'user', sessionId: 's1', cwd: '/p/a', gitBranch: 'main', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
      line({ type: 'user', sessionId: 's1', cwd: '/p/a', message: { role: 'user', content: '@"/x/file.md" 로스터 자동화 계획 짜줘\n두번째 줄' } }) +
      line({ type: 'summary', summary: 'Roster automation plan' }) +
      '{"type":"assistant","truncated'
    expect(parseSessionHead(text, 'fallback')).toEqual({ id: 's1', cwd: '/p/a', title: 'Roster automation plan', branch: 'main' })
  })
  it('uses a custom session title when present', () => {
    const text = line({ type: 'user', cwd: '/p/c', message: { content: 'first' } }) + line({ type: 'custom-title', customTitle: 'csbadminton 총괄' })
    expect(parseSessionHead(text, 'x').title).toBe('csbadminton 총괄')
  })
  it('falls back to the first user prompt (array content) and the file id', () => {
    const text = line({ type: 'user', cwd: '/p/b', message: { content: [{ type: 'text', text: 'fix login bug please' }] } })
    expect(parseSessionHead(text, 'file-id')).toEqual({ id: 'file-id', cwd: '/p/b', title: 'fix login bug please', branch: undefined })
  })
})

describe('listClaudeSessions / listSubfolders', () => {
  it('groups sessions by cwd newest first, reads only the head of big files, filters by root', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'ouro-hist-'))
    const projects = join(cfg, 'projects')
    const d1 = join(projects, '-p-a')
    const d2 = join(projects, '-p-b')
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    mkdirSync(join(d1, 'old', 'subagents'), { recursive: true }) // must be ignored
    writeFileSync(join(d1, 'old.jsonl'), line({ type: 'user', sessionId: 'old', cwd: '/p/a', message: { content: 'old task' } }))
    const big = line({ type: 'user', sessionId: 'big', cwd: '/p/a', message: { content: 'big task' } }) + 'x'.repeat(200_000) + '\n'
    writeFileSync(join(d1, 'big.jsonl'), big)
    writeFileSync(join(d2, 'other.jsonl'), line({ type: 'user', sessionId: 'other', cwd: '/p/b', message: { content: 'other project' } }))
    writeFileSync(join(d2, 'empty.jsonl'), '')
    const t0 = new Date('2026-01-01T00:00:00Z')
    const t1 = new Date('2026-02-01T00:00:00Z')
    utimesSync(join(d1, 'old.jsonl'), t0, t0)
    utimesSync(join(d1, 'big.jsonl'), t1, t1)
    utimesSync(join(d2, 'other.jsonl'), t0, t0)

    const all = listClaudeSessions(cfg)
    expect(all.map((p) => p.cwd)).toEqual(['/p/a', '/p/b'])
    expect(all[0].sessions.map((s) => s.id)).toEqual(['big', 'old'])
    expect(all[0].sessions[0].title).toBe('big task')
    expect(listClaudeSessions(cfg, { rootFilter: '/p/b' }).map((p) => p.cwd)).toEqual(['/p/b'])
    expect(listClaudeSessions(join(cfg, 'missing'))).toEqual([])

    const root = mkdtempSync(join(tmpdir(), 'ouro-folders-'))
    mkdirSync(join(root, 'api', '.git'), { recursive: true })
    writeFileSync(join(root, 'api', 'package.json'), '{"name":"csb-api"}')
    mkdirSync(join(root, 'web'))
    writeFileSync(join(root, 'web', 'CLAUDE.md'), '# web')
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(listSubfolders(root)).toEqual([
      { path: join(root, 'api'), name: 'api', isGit: true, hasClaudeMd: false, packageName: 'csb-api' },
      { path: join(root, 'web'), name: 'web', isGit: false, hasClaudeMd: true, packageName: undefined }
    ])
    rmSync(cfg, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
})
