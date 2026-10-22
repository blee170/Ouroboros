import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCheckpoint, deleteCheckpoint, listCheckpoints, parseCheckpointRefs, restoreCheckpoint } from '../src/main/checkpoints'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

type Git = (...args: string[]) => string
/** A fresh temp repository: `init` false = plain folder; `commit` false = unborn; a.txt + .gitignore committed otherwise. */
function repo(opts: { init?: boolean; commit?: boolean; autocrlf?: boolean } = {}): { dir: string; git: Git } {
  const dir = mkdtempSync(join(tmpdir(), 'ouro-ckpt-test-'))
  dirs.push(dir)
  const git: Git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  if (opts.init !== false) {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('config', 'core.autocrlf', opts.autocrlf ? 'true' : 'false')
    if (opts.commit !== false) {
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\nbuild/\n')
      git('add', '.')
      git('commit', '-qm', 'init')
    }
  }
  return { dir, git }
}
const read = (p: string): string => readFileSync(p, 'utf8')
const refs = (git: Git): string[] => git('for-each-ref', '--format=%(refname)', 'refs/ouroboros/checkpoints/').split('\n').filter(Boolean)
const treeFiles = (git: Git, commit: string): string[] => git('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean)
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error((r as { error?: string }).error)
  return r as Extract<T, { ok: true }>
}
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 5)) // ids carry a ms timestamp
const T = 30_000 // several git spawns per test; Windows runners are slow

describe('parseCheckpointRefs (pure)', () => {
  it('parses records newest first and skips foreign refs', () => {
    const rec = (id: string, parent: string, body: string): string => [`refs/ouroboros/checkpoints/${id}`, 'c' + id, 't' + id, parent, body].join('\0') + '\0\n'
    const raw =
      rec('1700000000000-abcd', 'p1', 'label one\n\nOuroboros-Checkpoint: 1\nOuroboros-Folder: C:/x\nOuroboros-Branch: main\nOuroboros-Card: n1\n') +
      rec('1700000000001-0000', '', 'unborn\n\nOuroboros-Checkpoint: 1\nOuroboros-Folder: C:/x\nOuroboros-Branch: -\nOuroboros-Card: -\n') +
      rec('1700000000002-ffff', 'p3', 'not ours\n\nSomething: else\n')
    const out = parseCheckpointRefs(raw)
    expect(out.map((r) => r.id)).toEqual(['1700000000001-0000', '1700000000000-abcd'])
    expect(out[1]).toEqual({ id: '1700000000000-abcd', label: 'label one', createdAt: 1700000000000, commit: 'c1700000000000-abcd', tree: 't1700000000000-abcd', head: 'p1', branch: 'main', cardId: 'n1', folder: 'C:/x' })
    expect(out[0]).toMatchObject({ label: 'unborn', head: null, branch: null, cardId: undefined })
    expect(parseCheckpointRefs('')).toEqual([])
  })
})

describe('checkpoints (real git)', () => {
  it('refuses a folder that is not a repository', async () => {
    const { dir } = repo({ init: false })
    expect((await createCheckpoint(dir)).ok).toBe(false)
    expect((await listCheckpoints(dir)).ok).toBe(false)
    expect((await restoreCheckpoint(dir, '1700000000000-abcd')).ok).toBe(false)
    expect((await deleteCheckpoint(dir, '1700000000000-abcd')).ok).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  }, T)

  it('create captures every non-ignored file and changes nothing else', async () => {
    const { dir, git } = repo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 's.txt'), 'staged\n')
    git('add', 's.txt')
    writeFileSync(join(dir, 'u.txt'), 'untracked\n')
    writeFileSync(join(dir, 'ignored.txt'), 'ig\n')
    mkdirSync(join(dir, 'build'))
    writeFileSync(join(dir, 'build', 'forced.txt'), 'forced\n')
    git('add', '-f', 'build/forced.txt')
    writeFileSync(join(dir, '.ouroboros.json'), '{"v":1}')
    writeFileSync(join(dir, '.ouroboros.json.tmp'), '{"v":2}')
    const before = { index: readFileSync(join(dir, '.git', 'index')), head: git('rev-parse', 'HEAD'), status: git('status', '-z', '--untracked-files=all'), heads: git('for-each-ref', 'refs/heads') }
    const r = ok(await createCheckpoint(dir, { label: '리팩터 전\nx', cardId: 'n1' }))
    expect(readFileSync(join(dir, '.git', 'index')).equals(before.index)).toBe(true)
    expect(git('rev-parse', 'HEAD')).toBe(before.head)
    expect(git('status', '-z', '--untracked-files=all')).toBe(before.status)
    expect(git('for-each-ref', 'refs/heads')).toBe(before.heads)
    expect(refs(git)).toEqual([`refs/ouroboros/checkpoints/${r.checkpoint.id}`])
    const files = treeFiles(git, r.checkpoint.commit)
    expect(files).toEqual(['.gitignore', 'a.txt', 'build/forced.txt', 's.txt', 'u.txt'])
    expect(git('show', `${r.checkpoint.commit}:a.txt`)).toBe('one\ntwo\n')
    expect(git('log', '-1', '--format=%an %P', r.checkpoint.commit).trim()).toBe(`Ouroboros ${before.head.trim()}`)
    expect(r.checkpoint).toMatchObject({ label: '리팩터 전 x', head: before.head.trim(), branch: 'main', cardId: 'n1', headMoved: false })
    expect(existsSync(join(tmpdir(), 'ouro-ckpt-', 'index'))).toBe(false)
  }, T)

  it('lists newest first, per folder, with headMoved', async () => {
    const { dir, git } = repo()
    const one = ok(await createCheckpoint(dir, { label: 'one' })).checkpoint
    await pause()
    const two = ok(await createCheckpoint(dir, { label: 'two' })).checkpoint
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 's.txt'), 's\n')
    const sub = ok(await createCheckpoint(join(dir, 'sub'), { label: 'sub' })).checkpoint
    let list = ok(await listCheckpoints(dir)).checkpoints
    expect(list.map((c) => c.id)).toEqual([two.id, one.id])
    expect(list.every((c) => !c.headMoved)).toBe(true)
    expect(ok(await listCheckpoints(join(dir, 'sub'))).checkpoints.map((c) => c.id)).toEqual([sub.id])
    git('commit', '-q', '--allow-empty', '-m', 'move')
    list = ok(await listCheckpoints(dir)).checkpoints
    expect(list.every((c) => c.headMoved)).toBe(true)
  }, T)

  it('restore puts the files back, leaves ignored and board files alone, and can be undone', async () => {
    const { dir, git } = repo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    mkdirSync(join(dir, 'd'))
    writeFileSync(join(dir, 'd', 'x.txt'), 'x\n')
    writeFileSync(join(dir, 'ignored.txt'), 'ig1\n')
    writeFileSync(join(dir, '.ouroboros.json'), '{"v":1}')
    const cp = ok(await createCheckpoint(dir, { label: 'before implement' })).checkpoint
    // the "implement" stage goes wrong
    writeFileSync(join(dir, 'a.txt'), 'three\n')
    git('add', 'a.txt')
    rmSync(join(dir, 'b.txt'))
    writeFileSync(join(dir, 'c.txt'), 'c\n')
    mkdirSync(join(dir, 'newdir'))
    writeFileSync(join(dir, 'newdir', 'n.txt'), 'n\n')
    writeFileSync(join(dir, 'ignored.txt'), 'ig2\n')
    writeFileSync(join(dir, '.ouroboros.json'), '{"v":2}')
    const head = git('rev-parse', 'HEAD')
    const r = ok(await restoreCheckpoint(dir, cp.id))
    expect(r.movedHead).toBe(false)
    expect(r.restored.id).toBe(cp.id)
    expect(r.safety.label).toBe('before restore: before implement')
    expect(read(join(dir, 'a.txt'))).toBe('two\n')
    expect(read(join(dir, 'b.txt'))).toBe('b\n')
    expect(read(join(dir, 'd', 'x.txt'))).toBe('x\n')
    expect(existsSync(join(dir, 'c.txt'))).toBe(false)
    expect(existsSync(join(dir, 'newdir'))).toBe(false)
    expect(read(join(dir, 'ignored.txt'))).toBe('ig2\n')
    expect(read(join(dir, '.ouroboros.json'))).toBe('{"v":2}')
    expect(git('diff', '--cached', '--name-only')).toBe('') // nothing staged
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(ok(await createCheckpoint(dir, { label: 'after' })).checkpoint.tree).toBe(cp.tree)
    // undo through the safety snapshot
    ok(await restoreCheckpoint(dir, r.safety.id))
    expect(read(join(dir, 'a.txt'))).toBe('three\n')
    expect(read(join(dir, 'c.txt'))).toBe('c\n')
    expect(read(join(dir, 'newdir', 'n.txt'))).toBe('n\n')
    expect(existsSync(join(dir, 'b.txt'))).toBe(false)
    expect(ok(await createCheckpoint(dir, { label: 'after undo' })).checkpoint.tree).toBe(r.safety.tree)
  }, T)

  it('never touches a tracked board file', async () => {
    const { dir, git } = repo()
    writeFileSync(join(dir, '.ouroboros.json'), '{"v":1}')
    git('add', '.ouroboros.json')
    git('commit', '-qm', 'board')
    const cp = ok(await createCheckpoint(dir)).checkpoint
    expect(treeFiles(git, cp.commit)).toContain('.ouroboros.json') // from the index copy, not from the add
    writeFileSync(join(dir, '.ouroboros.json'), '{"v":2}')
    ok(await restoreCheckpoint(dir, cp.id))
    expect(read(join(dir, '.ouroboros.json'))).toBe('{"v":2}')
  }, T)

  it('refuses when HEAD moved, and moves the branch back with moveHead', async () => {
    const { dir, git } = repo()
    const cp = ok(await createCheckpoint(dir, { label: 'cp' })).checkpoint
    writeFileSync(join(dir, 'a.txt'), 'committed later\n')
    git('commit', '-qam', 'later')
    const later = git('rev-parse', 'HEAD').trim()
    const refused = await restoreCheckpoint(dir, cp.id)
    expect(refused.ok).toBe(false)
    expect(refused).toMatchObject({ ahead: 0, behind: 1 })
    expect((refused as { error: string }).error).toContain('1 new')
    expect(refs(git)).toHaveLength(1)
    expect(read(join(dir, 'a.txt'))).toBe('committed later\n')
    const r = ok(await restoreCheckpoint(dir, cp.id, { moveHead: true }))
    expect(r.movedHead).toBe(true)
    expect(git('rev-parse', 'HEAD').trim()).toBe(cp.head)
    expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('main')
    expect(read(join(dir, 'a.txt'))).toBe('one\n')
    expect(git('diff', '--cached', '--name-only')).toBe('')
    expect(git('rev-parse', `${r.safety.commit}^`).trim()).toBe(later) // the dropped commit is kept as the safety snapshot's parent
    expect(r.restored.headMoved).toBe(false)
  }, T)

  it('refuses moveHead after a branch switch and any restore during a merge', async () => {
    const { dir, git } = repo()
    const cp = ok(await createCheckpoint(dir)).checkpoint
    git('checkout', '-qb', 'other')
    writeFileSync(join(dir, 'a.txt'), 'other\n')
    git('commit', '-qam', 'other')
    const r = await restoreCheckpoint(dir, cp.id, { moveHead: true })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('branch changed')
    // a conflicting merge in progress
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'a.txt'), 'main\n')
    git('commit', '-qam', 'main')
    const cp2 = ok(await createCheckpoint(dir)).checkpoint
    expect(() => git('merge', 'other')).toThrow()
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true)
    const r2 = await restoreCheckpoint(dir, cp2.id)
    expect(r2.ok).toBe(false)
    expect((r2 as { error: string }).error).toContain('merge is in progress')
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true)
    git('merge', '--abort')
  }, T)

  it('a snapshot taken in a subfolder restores only that subfolder', async () => {
    const { dir, git } = repo()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 's.txt'), 'v1\n')
    writeFileSync(join(dir, 'r.txt'), 'r1\n')
    git('add', '.')
    git('commit', '-qm', 'sub')
    const sub = join(dir, 'sub')
    const cp = ok(await createCheckpoint(sub, { label: 'sub' })).checkpoint
    writeFileSync(join(sub, 's.txt'), 'v2\n')
    writeFileSync(join(sub, 'new.txt'), 'new\n')
    writeFileSync(join(dir, 'r.txt'), 'r2\n')
    writeFileSync(join(dir, 'root-new.txt'), 'rn\n')
    ok(await restoreCheckpoint(sub, cp.id))
    expect(read(join(sub, 's.txt'))).toBe('v1\n')
    expect(existsSync(join(sub, 'new.txt'))).toBe(false)
    expect(read(join(dir, 'r.txt'))).toBe('r2\n')
    expect(read(join(dir, 'root-new.txt'))).toBe('rn\n')
    expect(read(join(dir, 'a.txt'))).toBe('one\n')
    expect(git('ls-files').split('\n').filter(Boolean)).toEqual(['.gitignore', 'a.txt', 'r.txt', 'sub/s.txt'])
    // the root's own checkpoint from another folder is refused
    const root = ok(await createCheckpoint(dir)).checkpoint
    expect((await restoreCheckpoint(sub, root.id)).ok).toBe(false)
  }, T)

  it('works in a linked worktree without touching the main checkout', async () => {
    const { dir, git } = repo()
    const wt = `${dir}-wt`
    dirs.push(wt)
    git('worktree', 'add', '-q', '-b', 'wt', wt)
    writeFileSync(join(wt, 'a.txt'), 'wt\n')
    const cp = ok(await createCheckpoint(wt, { label: 'in wt' })).checkpoint
    expect(refs(git)).toEqual([`refs/ouroboros/checkpoints/${cp.id}`]) // the ref lives in the shared .git
    expect(ok(await listCheckpoints(dir)).checkpoints).toEqual([])
    expect(ok(await listCheckpoints(wt)).checkpoints.map((c) => c.id)).toEqual([cp.id])
    writeFileSync(join(wt, 'a.txt'), 'wt2\n')
    writeFileSync(join(dir, 'a.txt'), 'main2\n')
    ok(await restoreCheckpoint(wt, cp.id))
    expect(read(join(wt, 'a.txt'))).toBe('wt\n')
    expect(read(join(dir, 'a.txt'))).toBe('main2\n')
  }, T)

  it('handles a repository before its first commit', async () => {
    const { dir, git } = repo({ commit: false })
    writeFileSync(join(dir, 'a.txt'), 'first\n')
    const cp = ok(await createCheckpoint(dir)).checkpoint
    expect(cp.head).toBeNull()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    ok(await restoreCheckpoint(dir, cp.id))
    expect(read(join(dir, 'a.txt'))).toBe('first\n')
    git('add', '.')
    git('commit', '-qm', 'first')
    expect((await restoreCheckpoint(dir, cp.id)).ok).toBe(false)
    const r = await restoreCheckpoint(dir, cp.id, { moveHead: true })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('first commit')
  }, T)

  it('restores a case-only rename to its original name', async () => {
    const { dir, git } = repo()
    writeFileSync(join(dir, 'Name.txt'), 'N\n')
    git('add', 'Name.txt')
    git('commit', '-qm', 'Name')
    const cp = ok(await createCheckpoint(dir)).checkpoint
    git('mv', 'Name.txt', 'tmp.txt')
    git('mv', 'tmp.txt', 'NAME.txt')
    ok(await restoreCheckpoint(dir, cp.id))
    const names = readdirSync(dir).filter((n) => n.toLowerCase() === 'name.txt')
    expect(names).toEqual(['Name.txt'])
    expect(read(join(dir, 'Name.txt'))).toBe('N\n')
    expect(git('status', '--porcelain')).toBe('')
  }, T)

  it('with core.autocrlf the restored files match git\'s checkout convention', async () => {
    const { dir, git } = repo({ autocrlf: true })
    writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n')
    git('add', 'crlf.txt')
    git('commit', '-qm', 'crlf')
    writeFileSync(join(dir, 'lf.txt'), 'l\n')
    const cp = ok(await createCheckpoint(dir)).checkpoint
    writeFileSync(join(dir, 'crlf.txt'), 'x')
    rmSync(join(dir, 'lf.txt'))
    ok(await restoreCheckpoint(dir, cp.id))
    expect(read(join(dir, 'crlf.txt'))).toBe('one\r\ntwo\r\n')
    expect(read(join(dir, 'lf.txt'))).toBe('l\r\n') // normalised on the way back: documented
    expect(ok(await createCheckpoint(dir)).checkpoint.tree).toBe(cp.tree)
  }, T)

  it('delete removes the ref and rejects ids that could leave the namespace', async () => {
    const { dir, git } = repo()
    const cp = ok(await createCheckpoint(dir)).checkpoint
    expect(ok(await deleteCheckpoint(dir, cp.id)).id).toBe(cp.id)
    expect(refs(git)).toEqual([])
    expect((await deleteCheckpoint(dir, cp.id)).ok).toBe(false)
    expect((await deleteCheckpoint(dir, '../../heads/main')).ok).toBe(false)
    expect((await restoreCheckpoint(dir, '../../heads/main')).ok).toBe(false)
    expect(git('rev-parse', '--verify', 'refs/heads/main').trim()).toHaveLength(40)
  }, T)

  it('serialises parallel creates and copes with folders that hold only ignored files', async () => {
    const { dir, git } = repo()
    const [a, b] = await Promise.all([createCheckpoint(dir, { label: 'a' }), createCheckpoint(dir, { label: 'b' })])
    expect(ok(a).checkpoint.id).not.toBe(ok(b).checkpoint.id)
    // a folder that is ignored as a whole, and one that only contains ignored files
    mkdirSync(join(dir, 'build'))
    writeFileSync(join(dir, 'build', 'out.txt'), 'o\n')
    mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, 'logs', 'x.ignored.txt'), 'x\n')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\nbuild/\n*.ignored.txt\n')
    for (const sub of [join(dir, 'build'), join(dir, 'logs')]) {
      const cp = ok(await createCheckpoint(sub)).checkpoint
      expect(treeFiles(git, cp.commit).some((f) => f.startsWith('build/') || f.startsWith('logs/'))).toBe(false)
      ok(await restoreCheckpoint(sub, cp.id))
    }
    expect(read(join(dir, 'build', 'out.txt'))).toBe('o\n')
    expect(read(join(dir, 'logs', 'x.ignored.txt'))).toBe('x\n')
  }, T)
})
