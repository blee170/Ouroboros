import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 60_000

export interface GitOptions {
  /** environment for this call (defaults to the process environment) */
  env?: NodeJS.ProcessEnv
  /** kill the command after this many ms (60 s by default: a hung git must not block the app for good) */
  timeout?: number
  /** text written to git's stdin */
  input?: string
}

/** Run git in `cwd` and return its stdout. Exit codes listed in `okCodes` return stdout instead of throwing. */
export async function git(cwd: string, args: string[], okCodes: number[] = [0], opts: GitOptions = {}): Promise<string> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS
  const run = execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: opts.env, timeout })
  if (opts.input !== undefined) run.child.stdin?.end(opts.input)
  try {
    const { stdout } = await run
    return stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string; killed?: boolean }
    if (typeof e.code === 'number' && okCodes.includes(e.code)) return e.stdout ?? ''
    if (e.killed) throw new Error(`git ${args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? ''} timed out after ${Math.round(timeout / 1000)} s`)
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
