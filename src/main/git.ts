import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface GitOptions {
  /** environment for this call (defaults to the process environment) */
  env?: NodeJS.ProcessEnv
  /** kill the command after this many ms (none by default) */
  timeout?: number
}

/** Run git in `cwd` and return its stdout. Exit codes listed in `okCodes` return stdout instead of throwing. */
export async function git(cwd: string, args: string[], okCodes: number[] = [0], opts: GitOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: opts.env, timeout: opts.timeout })
    return stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    if (typeof e.code === 'number' && okCodes.includes(e.code)) return e.stdout ?? ''
    throw err
  }
}

/** The commit HEAD points at, or null before the first commit. */
export async function headCommit(cwd: string): Promise<string | null> {
  return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1])).trim() || null
}

export async function hasHead(cwd: string): Promise<boolean> {
  return (await headCommit(cwd)) !== null
}
