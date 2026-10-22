import { execFile } from 'node:child_process'
import { readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ChangeFile, ChangesSummary } from '@shared/protocol'
export type { ChangeFile, ChangesSummary }

const execFileP = promisify(execFile)
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
/** untracked files whose lines are counted (the rest show 0) */
const MAX_COUNTED_UNTRACKED = 30
const MAX_COUNTED_BYTES = 512 * 1024
/** one summary per folder is shared by every card and panel polling it */
const SUMMARY_TTL_MS = 2_000
const summaryCache = new Map<string, { at: number; promise: Promise<ChangesSummary> }>()

async function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    if (typeof e.code === 'number' && okCodes.includes(e.code)) return e.stdout ?? ''
    throw err
  }
}

/** Parse `git status --porcelain=v1 -z` output (pure). */
export function parseStatus(raw: string): Array<{ path: string; status: ChangeFile['status'] }> {
  const out: Array<{ path: string; status: ChangeFile['status'] }> = []
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    let path = entry.slice(3)
    if (x === 'R' || x === 'C') {
      // renamed: "R  new\0old"
      i++
      path = `${parts[i] ?? ''} → ${path}`
    }
    let status: ChangeFile['status']
    if (x === '?' && y === '?') status = '?'
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'C'
    else if (x === 'R') status = 'R'
    else if (x === 'A' || y === 'A') status = 'A'
    else if (x === 'D' || y === 'D') status = 'D'
    else status = 'M'
    out.push({ path, status })
  }
  return out
}

/** Parse `git diff --numstat -z` output (pure). Binary files count as 0/0. */
export function parseNumstat(raw: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>()
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      // rename with -z: "added\tdeleted\t\0old\0new"
      const oldP = parts[++i] ?? ''
      const newP = parts[++i] ?? ''
      path = `${oldP} → ${newP}`
    }
    map.set(path, { added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) })
  }
  return map
}

/** "old → new" display paths (renames) resolve to the new path on disk. */
function diskPath(path: string): string {
  return path.includes(' → ') ? path.split(' → ').pop()!.trim() : path
}

async function countLines(file: string): Promise<number> {
  try {
    if ((await stat(file)).size > MAX_COUNTED_BYTES) return 0
    const text = await readFile(file, 'utf8')
    if (!text) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

async function hasHead(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1])).trim() !== ''
}

async function computeChanges(cwd: string): Promise<ChangesSummary> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { repo: false, files: [], added: 0, deleted: 0 }
  }
  const branch = (await git(cwd, ['branch', '--show-current'], [0, 128])).trim() || undefined
  const status = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  const numstat = (await hasHead(cwd)) ? parseNumstat(await git(cwd, ['diff', 'HEAD', '--numstat', '-z', '-M'])) : new Map()
  let counted = 0
  const files: ChangeFile[] = []
  for (const s of status) {
    let n = numstat.get(s.path)
    if (!n && s.status === '?' && counted < MAX_COUNTED_UNTRACKED) {
      counted++
      n = { added: await countLines(join(cwd, s.path)), deleted: 0 }
    }
    files.push({ path: s.path, status: s.status, added: n?.added ?? 0, deleted: n?.deleted ?? 0 })
  }
  return { repo: true, branch, files, added: files.reduce((a, f) => a + f.added, 0), deleted: files.reduce((a, f) => a + f.deleted, 0) }
}

/** Uncommitted changes (working tree vs HEAD) of a folder, untracked files included. Cached briefly per folder. */
export function getChanges(cwd: string): Promise<ChangesSummary> {
  const hit = summaryCache.get(cwd)
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.promise
  const promise = computeChanges(cwd)
  summaryCache.set(cwd, { at: Date.now(), promise })
  // only keep real results: a folder that just became a repo (or an error) must not stay cached
  promise.then((r) => !r.repo && summaryCache.delete(cwd)).catch(() => summaryCache.delete(cwd))
  return promise
}

/** Unified diff of one file (or everything). Untracked files are shown as whole-file additions. */
export async function getDiff(cwd: string, file?: string, maxChars = 200_000): Promise<string> {
  const head = await hasHead(cwd)
  let out = ''
  if (file) {
    if (file.includes(' → ')) {
      const [oldP, newP] = file.split(' → ').map((p) => p.trim())
      out = head ? await git(cwd, ['diff', 'HEAD', '-M', '--', oldP, newP]) : ''
    } else {
      const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', file], [0, 1])).trim() !== ''
      const inHead = head && (await git(cwd, ['ls-tree', '--name-only', 'HEAD', '--', file])).trim() !== ''
      if (tracked && inHead) out = await git(cwd, ['diff', 'HEAD', '--', file])
      else out = await git(cwd, ['diff', '--no-index', '--', NULL_DEVICE, file], [0, 1])
    }
  } else {
    out = head ? await git(cwd, ['diff', 'HEAD', '-M']) : ''
    const untracked = (await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    for (const u of untracked.slice(0, 50)) {
      out += await git(cwd, ['diff', '--no-index', '--', NULL_DEVICE, u], [0, 1])
      if (out.length > maxChars) break
    }
  }
  return out.length > maxChars ? out.slice(0, maxChars) + `\n… (truncated, ${out.length} chars)` : out
}

/** Discard one file's uncommitted change: restore from HEAD, or delete a file HEAD does not have (staged or untracked). */
export async function revertFile(cwd: string, file: string): Promise<void> {
  file = diskPath(file)
  const inHead = (await hasHead(cwd)) && (await git(cwd, ['ls-tree', '--name-only', 'HEAD', '--', file])).trim() !== ''
  if (inHead) {
    await git(cwd, ['checkout', 'HEAD', '--', file])
    return
  }
  const staged = (await git(cwd, ['ls-files', '--error-unmatch', '--', file], [0, 1])).trim() !== ''
  if (staged) await git(cwd, ['rm', '-q', '--cached', '--', file])
  await unlink(join(cwd, file)).catch(() => undefined)
}
