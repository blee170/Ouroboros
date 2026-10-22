/**
 * Checkpoints: git snapshots of a folder (every non-gitignored file, committed or not) that can be
 * restored later. A snapshot is a commit object kept under refs/ouroboros/checkpoints/<id>. Taking one
 * never touches the working tree or the real index: all index work happens in a temporary copy of it.
 * Refs are shared by every worktree of a repository, so each record carries the folder it was taken in
 * and listing filters on that. Board files (.ouroboros.json*) are never captured or touched.
 *
 * Restoring puts the files of the folder back exactly as they were in the snapshot (gitignored files
 * untouched), after saving the current state as a "before restore" snapshot so a restore can be undone.
 * It refuses to run while a merge/rebase/cherry-pick/revert is in progress, and when HEAD has moved
 * since the snapshot unless `moveHead` is set, in which case the branch is moved back as well (mixed
 * reset; the dropped commits stay in the reflog and are the parent of the safety snapshot).
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Checkpoint, CheckpointRestoreResult, CheckpointResult } from '@shared/protocol'
import { git, headCommit } from './git'
import { invalidateChanges } from './git-changes'
import { WORKSPACE_FILE } from './workspace-store'
export type { Checkpoint, CheckpointRestoreResult, CheckpointResult }

const REF_PREFIX = 'refs/ouroboros/checkpoints/'
const ID_RE = /^\d{13}-[0-9a-f]{4}$/
const MARKER = 'Ouroboros-Checkpoint'
const FORMAT = '%(refname)%00%(objectname)%00%(tree)%00%(parent)%00%(contents)%00'
/** everything in the folder except board files (and their .tmp), at any depth */
const SCOPE = ['.', `:(exclude,glob)**/${WORKSPACE_FILE}*`]
const IDENTITY = { GIT_AUTHOR_NAME: 'Ouroboros', GIT_AUTHOR_EMAIL: 'ouroboros@localhost', GIT_COMMITTER_NAME: 'Ouroboros', GIT_COMMITTER_EMAIL: 'ouroboros@localhost' }
const SNAPSHOT_TIMEOUT_MS = 60_000
/** a restore killed halfway leaves a half-restored folder, so this one is generous */
const RESTORE_TIMEOUT_MS = 300_000
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** A parsed ref: a Checkpoint plus the folder it was taken in (before `headMoved` is known). */
export type CheckpointRecord = Omit<Checkpoint, 'headMoved'> & { folder: string }
type Fail = { ok: false; error: string }
interface FolderKey {
  /** repository top level (absolute, forward slashes, as git prints it) */
  top: string
  /** top + subfolder prefix: identifies the folder across worktrees and spellings */
  key: string
}

const fail = (error: string): Fail => ({ ok: false, error })
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const sameKey = (a: string, b: string): boolean => (CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b)

/** Parse `for-each-ref` output in FORMAT (pure). Records without the marker trailer or a valid id are skipped; newest first. */
export function parseCheckpointRefs(raw: string): CheckpointRecord[] {
  const out: CheckpointRecord[] = []
  for (const rec of raw.split('\0\n')) {
    if (!rec.trim()) continue
    const [refname, commit, tree, parent, contents = ''] = rec.split('\0')
    if (!refname || !refname.startsWith(REF_PREFIX) || !commit || !tree) continue
    const id = refname.slice(REF_PREFIX.length)
    if (!ID_RE.test(id)) continue
    const lines = contents.split(/\r?\n/)
    // trailers live in the body: the label (line 0) must not be able to spoof one
    const body = lines.slice(1)
    const trailer = (key: string): string | undefined => body.find((l) => l.startsWith(key + ': '))?.slice(key.length + 2).trim()
    if (trailer(MARKER) !== '1') continue
    const folder = trailer('Ouroboros-Folder')
    if (!folder) continue
    const branch = trailer('Ouroboros-Branch')
    const card = trailer('Ouroboros-Card')
    out.push({
      id,
      label: lines[0]?.trim() ?? '',
      createdAt: Number(id.slice(0, 13)),
      commit: commit.trim(),
      tree: tree.trim(),
      head: (parent ?? '').trim().split(/\s+/)[0] || null,
      branch: branch && branch !== '-' ? branch : null,
      cardId: card && card !== '-' ? card : undefined,
      folder
    })
  }
  // ids share one shape (13 digits, dash, 4 hex), so string order is time order
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

function cleanLabel(label: string | undefined): string {
  const s = (label ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return s || 'checkpoint'
}

async function repoKey(folder: string): Promise<FolderKey | Fail> {
  if (!existsSync(folder)) return fail(`folder does not exist: ${folder}`)
  try {
    const [top = '', prefix = ''] = (await git(folder, ['rev-parse', '--show-toplevel', '--show-prefix'])).split(/\r?\n/)
    if (!top) return fail('not a git repository')
    const sub = prefix.trim().replace(/\/+$/, '')
    return { top, key: sub ? `${top}/${sub}` : top }
  } catch (err) {
    // anything but "not a git repository" (git missing, dubious ownership, …) is passed on as it is
    return fail(/not a git repository/i.test(errorText(err)) ? 'not a git repository' : errorText(err))
  }
}

const BOARD_FILE_RE = new RegExp(`(^|/)${WORKSPACE_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
const isBoardFile = (p: string): boolean => BOARD_FILE_RE.test(p)

/** Files git would put in a snapshot of the folder (tracked + untracked, not ignored), relative to the folder. */
async function scopeFiles(folder: string): Promise<string[]> {
  return (await git(folder, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCOPE])).split('\0').filter(Boolean)
}

/** Files of a snapshot under the folder, relative to it. */
async function snapshotFiles(folder: string, commit: string): Promise<string[]> {
  return (await git(folder, ['ls-tree', '-r', '-z', '--name-only', commit, '--', '.'])).split('\0').filter(Boolean)
}

/**
 * The first directory between the folder and one of `files` that is a symlink or (on Windows) a junction,
 * or null. Git for Windows follows junctions, so a snapshot would capture, and a restore delete, files
 * outside the repository through it.
 */
async function linkedDirIn(folder: string, files: string[]): Promise<string | null> {
  const seen = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    let dir = folder
    for (let i = 0; i < parts.length - 1; i++) {
      dir = join(dir, parts[i])
      if (seen.has(dir)) continue
      seen.add(dir)
      const st = await lstat(dir).catch(() => null)
      if (st?.isSymbolicLink()) return relative(folder, dir)
    }
  }
  return null
}

const linkedDirError = (dir: string): Fail => fail(`"${dir}" is a junction or symlinked folder: a snapshot would follow it outside the repository. Remove it or add it to .gitignore first`)

/**
 * Gitignored files that restoring the snapshot paths `files` would overwrite or remove: a snapshot file that is
 * an ignored file now, ignored files under a snapshot file that is a folder now, and an ignored file where the
 * snapshot has a folder. No snapshot holds them, so the safety snapshot of a restore must take them along.
 */
async function ignoredInTheWay(folder: string, files: string[]): Promise<string[]> {
  const dirs = new Set<string>()
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i))
  const spec = [...files]
  for (const d of dirs) if ((await lstat(join(folder, d)).catch(() => null))?.isFile()) spec.push(d)
  const out: string[] = []
  // the pathspecs go on the command line in chunks (Windows caps it near 32 K characters)
  for (let i = 0; i < spec.length; ) {
    const chunk: string[] = []
    for (let n = 0; i < spec.length && n < 8000; i++) {
      chunk.push(spec[i])
      n += spec[i].length + 3
    }
    out.push(...(await git(folder, ['--literal-pathspecs', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...chunk])).split('\0').filter(Boolean))
  }
  return out
}

async function readRecords(folder: string, id?: string): Promise<CheckpointRecord[]> {
  return parseCheckpointRefs(await git(folder, ['for-each-ref', `--format=${FORMAT}`, id ? REF_PREFIX + id : REF_PREFIX]))
}

function toCheckpoint(r: CheckpointRecord, head: string | null): Checkpoint {
  const { folder: _folder, ...rest } = r
  return { ...rest, headMoved: r.head !== head }
}

async function currentBranch(folder: string): Promise<string | null> {
  return (await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD'], [0, 1])).trim() || null
}

/** Name of the git operation in progress (merge, rebase, …) or null. */
async function operationInProgress(folder: string): Promise<string | null> {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
  const labels = ['merge', 'cherry-pick', 'revert', 'rebase', 'rebase']
  const paths = (await git(folder, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])])).split(/\r?\n/)
  for (let i = 0; i < names.length; i++) {
    const p = paths[i]?.trim()
    // printed relative to the folder in the main worktree, absolute in a linked one
    if (p && existsSync(resolve(folder, p))) return labels[i]
  }
  return null
}

/**
 * Write the snapshot commit and its ref. `tmp` receives `index` (a copy of the real index with the folder's
 * current files added) and `msg`; the caller removes it. The real index and the working tree are not touched.
 * `alsoAdd`: gitignored files to force into the snapshot (what a restore is about to overwrite).
 */
async function snapshot(folder: string, k: FolderKey, tmp: string, label: string, cardId?: string, alsoAdd: string[] = []): Promise<CheckpointRecord> {
  const index = join(tmp, 'index')
  const realIndex = resolve(folder, (await git(folder, ['rev-parse', '--git-path', 'index'])).trim())
  // start from the real index: an empty one would lose tracked-but-ignored files, record wrong modes on
  // Windows (core.symlinks / core.filemode off) and re-hash every file instead of only the changed ones
  if (existsSync(realIndex)) await copyFile(realIndex, index)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  // `add -A` trusts the assume-unchanged bit (core.ignoreStat sets it on every file) and would miss edits to
  // those files: clear it in the copy, so the real index keeps it
  const assumed = (await git(folder, ['ls-files', '-v', '-z', '--', ...SCOPE], [0], { env })).split('\0').filter((l) => /^[a-z] /.test(l)).map((l) => l.slice(2))
  if (assumed.length) await git(folder, ['update-index', '--no-assume-unchanged', '-z', '--stdin'], [0], { env, input: assumed.join('\0') + '\0' })
  try {
    await git(folder, ['-c', 'core.safecrlf=false', 'add', '-A', '--', ...SCOPE], [0], { env, timeout: SNAPSHOT_TIMEOUT_MS })
  } catch (err) {
    // a folder with nothing but gitignored files (or one that is ignored itself) has nothing to add: exit 1 with a hint
    const text = errorText(err)
    if ((err as { code?: unknown }).code !== 1 || !/ignored by one of your \.gitignore/.test(text) || /fatal:/.test(text)) throw err
  }
  if (alsoAdd.length) {
    const list = join(tmp, 'paths')
    await writeFile(list, alsoAdd.join('\0'), 'utf8')
    await git(folder, ['-c', 'core.safecrlf=false', 'add', '-f', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], [0], { env, timeout: SNAPSHOT_TIMEOUT_MS })
  }
  const tree = (await git(folder, ['write-tree'], [0], { env })).trim()
  const head = await headCommit(folder)
  const branch = await currentBranch(folder)
  const id = `${Date.now()}-${randomBytes(2).toString('hex')}`
  const msgFile = join(tmp, 'msg')
  await writeFile(msgFile, `${label}\n\n${MARKER}: 1\nOuroboros-Folder: ${k.key}\nOuroboros-Branch: ${branch ?? '-'}\nOuroboros-Card: ${cardId ?? '-'}\n`, 'utf8')
  const commit = (await git(folder, ['commit-tree', ...(head ? ['-p', head] : []), '-F', msgFile, tree], [0], { env: { ...process.env, ...IDENTITY } })).trim()
  // "" as the old value: the ref must not exist yet
  await git(folder, ['update-ref', REF_PREFIX + id, commit, ''])
  return { id, label, createdAt: Number(id.slice(0, 13)), commit, tree, head, branch, cardId, folder: k.key }
}

/** Remove the directories left empty once `file` is gone, up to (not including) the card's folder. */
async function pruneEmptyDirs(folder: string, file: string): Promise<void> {
  const norm = (p: string): string => (CASE_INSENSITIVE ? resolve(p).toLowerCase() : resolve(p))
  const stop = norm(folder)
  for (let dir = dirname(file); norm(dir) !== stop && norm(dir).startsWith(stop + sep); dir = dirname(dir)) {
    try {
      await rmdir(dir)
    } catch {
      return // not empty (or already gone)
    }
  }
}

/** `git reset` on the real index; another git command (an agent's) may hold index.lock for a moment. */
async function resetWithRetry(folder: string, args: string[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await git(folder, ['reset', '-q', ...args])
      return
    } catch (err) {
      if (attempt >= 5 || !/index\.lock/.test(errorText(err))) throw err
      await new Promise((r) => setTimeout(r, 150 * 2 ** attempt))
    }
  }
}

/** One operation at a time per repository (keyed on its top level, so subfolders and worktree spellings share it). */
const locks = new Map<string, Promise<void>>()
function locked<T>(top: string, fn: () => Promise<T>): Promise<T> {
  const key = top.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}

/** Take a snapshot of `folder`. Changes nothing on disk besides the new ref and objects. */
export async function createCheckpoint(folder: string, o: { label?: string; cardId?: string } = {}): Promise<CheckpointResult<{ checkpoint: Checkpoint }>> {
  const k = await repoKey(folder)
  if ('ok' in k) return k
  return locked(k.top, async () => {
    let tmp: string | undefined
    try {
      const linked = await linkedDirIn(folder, await scopeFiles(folder))
      if (linked) return linkedDirError(linked)
      tmp = await mkdtemp(join(tmpdir(), 'ouro-ckpt-'))
      const rec = await snapshot(folder, k, tmp, cleanLabel(o.label), o.cardId)
      return { ok: true, checkpoint: toCheckpoint(rec, rec.head) }
    } catch (err) {
      return fail(errorText(err))
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  })
}

/** Snapshots taken in this folder (other folders of the same repository are hidden), newest first. */
export async function listCheckpoints(folder: string): Promise<CheckpointResult<{ checkpoints: Checkpoint[] }>> {
  try {
    const k = await repoKey(folder)
    if ('ok' in k) return k
    const head = await headCommit(folder)
    const checkpoints = (await readRecords(folder)).filter((r) => sameKey(r.folder, k.key)).map((r) => toCheckpoint(r, head))
    return { ok: true, checkpoints }
  } catch (err) {
    return fail(errorText(err))
  }
}

/**
 * Put the folder's files back as they were in checkpoint `id`. Saves a "before restore" snapshot first.
 * Refuses when HEAD moved since the snapshot unless `moveHead` is set (then the branch is moved back too).
 */
export async function restoreCheckpoint(folder: string, id: string, o: { moveHead?: boolean; cardId?: string } = {}): Promise<CheckpointRestoreResult> {
  if (!ID_RE.test(id)) return fail('invalid checkpoint id')
  const k = await repoKey(folder)
  if ('ok' in k) return k
  return locked(k.top, async () => {
    let tmp: string | undefined
    let safety: CheckpointRecord | undefined
    let head: string | null = null
    let touched = false // files were changed: whatever happens next, the caller must hear about the safety snapshot
    try {
      const cp = (await readRecords(folder, id))[0]
      if (!cp) return fail(`no checkpoint ${id}`)
      if (!sameKey(cp.folder, k.key)) return fail('this checkpoint was taken in another folder')
      const busy = await operationInProgress(folder)
      if (busy) return fail(`a ${busy} is in progress; finish or abort it first`)
      // the real index is written last; a lock on it would otherwise surface only after the files were rewritten
      if (existsSync(resolve(folder, (await git(folder, ['rev-parse', '--git-path', 'index.lock'])).trim()))) return fail('the repository index is locked: another git command is running, or a crashed one left .git/index.lock behind. Try again in a moment')
      // a junction anywhere the restore would write or delete must stop it before anything is touched
      const cpFiles = await snapshotFiles(folder, cp.commit)
      const linked = await linkedDirIn(folder, [...(await scopeFiles(folder)), ...cpFiles])
      if (linked) return linkedDirError(linked)
      head = await headCommit(folder)
      const moved = head !== cp.head
      if (moved && !o.moveHead) {
        let ahead = 0
        let behind = 0
        if (cp.head && head) [ahead, behind] = (await git(folder, ['rev-list', '--left-right', '--count', `${cp.head}...${head}`])).trim().split(/\s+/).map(Number)
        else if (head) behind = Number((await git(folder, ['rev-list', '--count', head])).trim())
        return { ...fail(`HEAD moved since this checkpoint (${behind} new, ${ahead} dropped commits); pass move_head=true to move the branch back as well`), ahead, behind }
      }
      if (moved) {
        if (!cp.head) return fail('this checkpoint predates the first commit; HEAD cannot be moved back to it')
        const branch = await currentBranch(folder)
        if (branch !== cp.branch) return fail(`the branch changed since the checkpoint (${cp.branch ?? 'detached'} → ${branch ?? 'detached'}); check it out first`)
      }
      tmp = await mkdtemp(join(tmpdir(), 'ouro-ckpt-'))
      // gitignored files the restore is about to overwrite or remove are in no snapshot: the safety snapshot takes them along
      safety = await snapshot(folder, k, tmp, `before restore: ${cp.label}`, o.cardId, await ignoredInTheWay(folder, cpFiles))
      // the safety snapshot's index is the index of the current state: the restore works against it, so
      // the real index stays untouched until the files are in place
      const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') }
      // files that exist now but not in the snapshot go first (also makes case-only renames come out right)
      const extra = (await git(folder, ['diff-index', '--cached', '--no-renames', '--name-only', '-z', '--diff-filter=A', cp.commit, '--', ...SCOPE], [0], { env })).split('\0').filter(Boolean)
      touched = true
      // a file another program holds open, or a repository of its own, survives this; it is reported at the end
      // (checked now, before the restore writes the snapshot's own files to such paths)
      for (const p of extra) await rm(resolve(k.top, p), { force: true }).catch(() => undefined)
      const left = (await Promise.all(extra.map(async (p) => ((await lstat(resolve(k.top, p)).catch(() => null)) ? p : null)))).filter((p): p is string => p !== null)
      try {
        // no-overlay (the default): files in the index but not in the source are removed too
        await git(folder, ['restore', '-q', `--source=${cp.commit}`, '--worktree', '--', ...SCOPE], [0], { env, timeout: RESTORE_TIMEOUT_MS })
      } catch (err) {
        // `restore` reports "did not match" when the scope is empty on both sides: nothing to do then
        const inIndex = (await git(folder, ['ls-files', '-z', '--', '.'], [0], { env })).split('\0').filter((p) => p && !isBoardFile(p))
        if (cpFiles.some((p) => !isBoardFile(p)) || inIndex.length) throw err
      }
      // git only removes directories it emptied itself; the files removed above may have left some behind
      for (const p of extra) await pruneEmptyDirs(folder, resolve(k.top, p))
      const movedHead = moved && Boolean(o.moveHead)
      if (movedHead) {
        // `reset <commit>` resets the index first and moves HEAD last; a lock on the branch fails only that last step
        const err = await resetWithRetry(folder, [cp.head as string]).then(
          () => undefined,
          (e: unknown) => e
        )
        if ((await headCommit(folder)) !== cp.head) {
          await resetWithRetry(folder, []).catch(() => undefined) // index back on HEAD: only the files differ now
          throw new Error(`HEAD could not be moved back (${err ? errorText(err) : 'the branch did not move'}); the files are restored and the commits are kept`)
        }
      } else await resetWithRetry(folder, ['--', ...SCOPE])
      if (left.length) throw new Error(`${left.slice(0, 3).join(', ')}${left.length > 3 ? ` and ${left.length - 3} more` : ''} could not be removed (held open by another program, or a repository of its own)`)
      const headAfter = await headCommit(folder)
      return { ok: true, restored: toCheckpoint(cp, headAfter), safety: toCheckpoint(safety, headAfter), movedHead }
    } catch (err) {
      // once the safety snapshot exists the caller must know its id: the folder may be half restored
      if (!safety) return fail(errorText(err))
      return { ...fail(`${errorText(err)} (${touched ? 'the folder may be partly restored; ' : ''}the state before this restore is saved as checkpoint ${safety.id})`), safety: toCheckpoint(safety, head) }
    } finally {
      if (touched) invalidateChanges(folder)
      if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  })
}

export async function deleteCheckpoint(folder: string, id: string): Promise<CheckpointResult<{ id: string }>> {
  if (!ID_RE.test(id)) return fail('invalid checkpoint id')
  const k = await repoKey(folder)
  if ('ok' in k) return k
  return locked(k.top, async () => {
    try {
      const cp = (await readRecords(folder, id))[0]
      if (!cp) return fail(`no checkpoint ${id}`)
      if (!sameKey(cp.folder, k.key)) return fail('this checkpoint was taken in another folder')
      await git(folder, ['update-ref', '-d', REF_PREFIX + id, cp.commit])
      return { ok: true, id }
    } catch (err) {
      return fail(errorText(err))
    }
  })
}
