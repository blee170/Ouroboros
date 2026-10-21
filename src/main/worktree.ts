import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  )
}

export function worktreePathFor(projectRoot: string, name: string): { path: string; branch: string } {
  const slug = slugify(name)
  return {
    path: join(dirname(projectRoot), `${basename(projectRoot)}-worktrees`, slug),
    branch: `wt/${slug}`
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

export async function createWorktree(projectRoot: string, name: string): Promise<{ path: string; branch: string }> {
  const { path, branch } = worktreePathFor(projectRoot, name)
  await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])
  if (existsSync(path)) return { path, branch }
  const branches = await git(projectRoot, ['branch', '--list', branch])
  if (branches.trim()) {
    await git(projectRoot, ['worktree', 'add', path, branch])
  } else {
    await git(projectRoot, ['worktree', 'add', '-b', branch, path])
  }
  return { path, branch }
}

export async function removeWorktree(projectRoot: string, path: string): Promise<void> {
  await git(projectRoot, ['worktree', 'remove', '--force', path])
}
