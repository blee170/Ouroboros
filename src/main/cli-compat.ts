/**
 * The CLI compatibility check: does an installed agent CLI still have what Ouroboros relies on (the table in
 * shared/cli-contract.ts)? A flag is "ok" when `--help` lists it, "hidden" when only the installed files have it
 * (works today, may go without notice), "missing" otherwise; strings are searched in the installed files (the native
 * binary, or the npm package). Read-only: it runs `--version` and `--help` and reads files.
 *
 * A check that could not be made is an `error`, never a verdict: a CLI that timed out once (a virus scan of a fresh
 * binary) must not be recorded as lacking everything.
 *
 * Used from two places, so it imports nothing but Node built-ins and types: `npm run compat` loads this file with
 * Node's own type stripping (scripts/cli-compat.mjs), and the app runs it in a child process (cli-compat-run.ts),
 * because searching a 300 MB binary would stall the main process.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CliContract } from '../shared/cli-contract'

export interface CompatLine {
  status: 'ok' | 'hidden' | 'missing'
  kind: 'flag' | 'string' | 'run'
  text: string
  /** where Ouroboros relies on it */
  why: string
}

export interface CompatReport {
  engine: CliContract['engine']
  installed: boolean
  /** the first line of `--version` */
  version?: string
  path?: string
  lines: CompatLine[]
  /** the check could not be made for this CLI: `lines` says nothing about it */
  error?: string
}

const win = process.platform === 'win32'
const CHUNK = 4 * 1024 * 1024
/** an npm package's files are searched up to this many bytes in all */
const PACKAGE_BYTES = 800_000_000

/**
 * Run a CLI with fixed arguments: its output, and whether that is an answer. A timeout, a start that failed or no
 * output at all is not one; a non-zero exit with output is (some CLIs print their help that way). npm shims on
 * Windows are .cmd files, which only start through a shell.
 */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): Promise<{ ok: boolean; out: string }> {
  const shell = win && /\.(cmd|bat)$/i.test(bin)
  return new Promise((resolve) => {
    // through a shell the line is ours to write: the shim's path quoted (it may sit under "Program Files"), then the
    // args, which are fixed words from the contract (--help, resume)
    execFile(shell ? `"${bin}" ${args.join(' ')}` : bin, shell ? [] : args, { encoding: 'utf8', timeout, shell, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`
      const failed = !!err && (err.killed === true || typeof err.code === 'string')
      resolve({ ok: !failed && out.trim().length > 0, out })
    })
  })
}

/** The CLI's path on PATH, or undefined. On Windows a .cmd shim is preferred over the extensionless sh script. */
export async function whichCli(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const out = await new Promise<string>((resolve) => execFile(win ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true, env, timeout: 10_000 }, (_err, stdout) => resolve(stdout ?? '')))
  const hits = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return win ? (hits.find((h) => /\.(exe|cmd|bat)$/i.test(h)) ?? hits[0]) : hits[0]
}

/** The files to search: a native binary itself, else the npm package's code (its vendored binaries included). */
async function scanTargets(path: string, npmPackage: string | undefined): Promise<string[]> {
  const size = (await stat(path)).size
  if (size > 2_000_000) return [path]
  // a small file is a launcher (an npm shim, a wrapper script): searching it alone would report every string missing
  if (!npmPackage) throw new Error(`${path} is a launcher, not the CLI's own binary: its files were not found`)
  const candidates = [join(dirname(path), 'node_modules', ...npmPackage.split('/'))]
  // posix: the bin is a symlink into …/node_modules/<pkg>/…; walk up to the package root
  let dir = dirname(await realpath(path))
  for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
    try {
      if (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === npmPackage) candidates.unshift(dir)
    } catch {
      // no package.json here, or not JSON: keep walking up
    }
  }
  const root = candidates.find((c) => existsSync(c))
  if (!root) throw new Error(`the files of ${npmPackage} were not found next to ${path}`)
  const files: string[] = []
  let total = 0
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        const code = /\.(c|m)?js$|\.exe$|\.node$/.test(e.name)
        if (!code && e.name.includes('.')) continue
        const size = (await stat(p)).size
        if (!code && size < 1_000_000) continue
        total += size
        if (total < PACKAGE_BYTES) files.push(p)
      }
    }
  }
  await walk(root)
  return files
}

/** Which of the texts occur in any of the files. Files are read in chunks that overlap by the longest text. */
export async function findStrings(files: string[], texts: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  const needles = texts.map((t) => ({ t, b: Buffer.from(t, 'utf8') }))
  const overlap = Math.max(0, ...needles.map((n) => n.b.length)) - 1
  const buf = Buffer.allocUnsafe(CHUNK + Math.max(0, overlap))
  for (const f of files) {
    if (found.size === texts.length) break
    let fh
    try {
      fh = await open(f, 'r')
    } catch {
      continue // unreadable: its strings count as not found
    }
    try {
      let kept = 0
      for (;;) {
        const { bytesRead } = await fh.read(buf, kept, CHUNK, null)
        if (bytesRead === 0) break
        const view = buf.subarray(0, kept + bytesRead)
        for (const n of needles) if (!found.has(n.t) && view.indexOf(n.b) >= 0) found.add(n.t)
        if (found.size === texts.length) break
        // the tail of this chunk goes in front of the next: a text cut by the boundary is still found
        kept = Math.min(Math.max(0, overlap), view.length)
        view.copy(buf, 0, view.length - kept)
      }
    } finally {
      await fh.close()
    }
  }
  return found
}

/** Pure: a flag or word as its own token in help text (so `-c` does not match inside `--config`). */
export function inHelp(help: string, text: string): boolean {
  return new RegExp(`(^|[\\s,\\[("'|])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,=\\])"'|<.])`, 'm').test(help)
}

/** Check one CLI against its contract. A CLI that is not on PATH is `installed: false` with no lines. */
export async function checkCli(c: CliContract, env: NodeJS.ProcessEnv = process.env): Promise<CompatReport> {
  const path = await whichCli(c.bin, env)
  if (!path) return { engine: c.engine, installed: false, lines: [] }
  const fail = (error: string): CompatReport => ({ engine: c.engine, installed: true, path, lines: [], error })
  const v = await run(path, ['--version'], env)
  const version = v.out.trim().split(/\r?\n/)[0]
  if (!v.ok || !version) return fail(`${c.bin} --version did not run (timed out, or printed nothing)`)
  // every help text first: one that did not come would turn each of its flags into a false "hidden" or "missing"
  const helps = new Map<string, string>()
  for (const f of c.flags) {
    const args = f.helpArgs ?? ['--help']
    const key = args.join(' ')
    if (helps.has(key)) continue
    const h = await run(path, args, env)
    if (!h.ok) return fail(`${c.bin} ${key} did not run (timed out, or printed nothing)`)
    helps.set(key, h.out)
  }
  let found: Set<string>
  try {
    found = await findStrings(await scanTargets(path, c.npmPackage), [...c.flags, ...c.strings].map((x) => x.text))
  } catch (e) {
    return fail((e as Error).message)
  }
  const lines: CompatLine[] = []
  for (const f of c.flags) lines.push({ status: inHelp(helps.get((f.helpArgs ?? ['--help']).join(' ')) ?? '', f.text) ? 'ok' : found.has(f.text) ? 'hidden' : 'missing', kind: 'flag', text: f.text, why: f.why })
  for (const s of c.strings) lines.push({ status: found.has(s.text) ? 'ok' : 'missing', kind: 'string', text: s.text, why: s.why })
  return { engine: c.engine, installed: true, version, path, lines }
}
