import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getChanges, getDiff, parseNumstat, parseStatus, revertFile } from '../src/main/git-changes'

describe('parseStatus / parseNumstat (pure)', () => {
  it('reads porcelain -z entries including renames and untracked files', () => {
    const raw = ' M src/a.ts\0?? new.txt\0R  dst.ts\0src.ts\0A  added.ts\0 D gone.ts\0UU conflict.ts\0'
    expect(parseStatus(raw)).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'new.txt', status: '?' },
      { path: 'src.ts → dst.ts', status: 'R' },
      { path: 'added.ts', status: 'A' },
      { path: 'gone.ts', status: 'D' },
      { path: 'conflict.ts', status: 'C' }
    ])
  })
  it('reads numstat -z with binary and renamed entries', () => {
    const raw = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '5\t0\t', 'src.ts', 'dst.ts', ''].join('\0')
    const m = parseNumstat(raw)
    expect(m.get('src/a.ts')).toEqual({ added: 3, deleted: 1 })
    expect(m.get('img.png')).toEqual({ added: 0, deleted: 0 })
    expect(m.get('src.ts → dst.ts')).toEqual({ added: 5, deleted: 0 })
  })
})

describe('getChanges / getDiff / revertFile (real git)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-git-'))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reports a non-repo folder as repo=false', async () => {
    expect((await getChanges(dir)).repo).toBe(false)
  })

  it('counts modified and untracked files and diffs them', async () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(dir, 'b.txt'), 'x\ny\n')
    const c = await getChanges(dir)
    expect(c.repo).toBe(true)
    expect(c.branch).toBe('main')
    expect(c.files).toEqual([
      { path: 'a.txt', status: 'M', added: 1, deleted: 0 },
      { path: 'b.txt', status: '?', added: 2, deleted: 0 }
    ])
    expect(c.added).toBe(3)
    expect(await getDiff(dir, 'a.txt')).toContain('+three')
    const all = await getDiff(dir)
    expect(all).toContain('+three')
    expect(all).toContain('+y') // untracked shown as additions
    // staged-new file (A): revert must delete it, not fail with "pathspec did not match"
    writeFileSync(join(dir, 'c.txt'), 'new\n')
    git('add', 'c.txt')
    await new Promise((r) => setTimeout(r, 2100)) // summary cache ttl
    expect((await getChanges(dir)).files.find((f) => f.path === 'c.txt')?.status).toBe('A')
    expect(await getDiff(dir, 'c.txt')).toContain('+new')
    await revertFile(dir, 'a.txt')
    await revertFile(dir, 'b.txt')
    await revertFile(dir, 'c.txt')
    await new Promise((r) => setTimeout(r, 2100))
    expect((await getChanges(dir)).files).toEqual([])
  })
})
