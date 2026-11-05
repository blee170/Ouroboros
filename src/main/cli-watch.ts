/**
 * Keeps the CLI compatibility check current: whenever an installed agent CLI's version is not the one last checked,
 * the check (main/cli-compat.ts, in a child process) runs for it and the result is kept in the app's data folder for
 * Settings → Engines. A new version that lacks something Ouroboros relies on is reported once (a toast). It also
 * prepares what a "CLI update watch" routine hands its card (shared/cli-watch.ts).
 */
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentEngine } from '@shared/types'
import { CLI_CONTRACTS } from '@shared/cli-contract'
import {
  CLAUDE_CHANGELOG_URL,
  applyReports,
  buildDigest,
  cliUpdates,
  markReviewed,
  relevantChangelog,
  sanitizeCompatState,
  staleEngines,
  type CheckReport,
  type CliUpdate,
  type CompatIssue,
  type CompatState,
  type CompatView,
  type DetectedCli
} from '@shared/cli-watch'

export interface CliWatchDeps {
  /** the state file (the app's data folder) */
  file: string
  detect: () => Promise<DetectedCli[]>
  /** run the check for these CLIs (a child process in the app) */
  check: (engines: AgentEngine[]) => Promise<CheckReport[]>
  fetchText: (url: string) => Promise<string>
  now?: () => number
  log?: (line: string) => void
  /** a CLI's newly checked version lacks something Ouroboros relies on */
  onBroke?: (label: string, version: string, missing: CompatIssue[]) => void
}

export type WatchDigest = { text: string; summary: string; commit: () => void } | { none: string }

export class CliWatch extends EventEmitter {
  private state: CompatState
  private checking = false
  private error?: string
  /** refreshes run one after the other: a forced one asked during a check still runs */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private deps: CliWatchDeps) {
    super()
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(deps.file, 'utf8'))
    } catch {
      // no file yet, or not JSON: every installed CLI is checked again
    }
    this.state = sanitizeCompatState(raw)
  }

  view(): CompatView {
    return { engines: this.state.engines, checking: this.checking, ...(this.error ? { error: this.error } : {}) }
  }

  /** Check the installed CLIs whose version changed since their last check (every installed one with `force`). */
  refresh(force = false): Promise<CompatView> {
    return this.enqueue(() => this.run(force)).then(() => this.view())
  }

  /**
   * What changed since the last CLI-watch routine run, as text for its card; `none` (with the reason) when no
   * installed CLI changed version. `commit` records the versions as covered: call it once the text was sent.
   */
  digest(): Promise<WatchDigest> {
    return this.enqueue(async (): Promise<WatchDigest> => {
      const detected = await this.run(false)
      const installed = detected.filter((d) => d.installed && d.version)
      if (installed.length === 0) return { none: 'no agent CLI was found on this PC' }
      const updates = cliUpdates(this.state, detected)
      if (updates.length === 0) return { none: `no CLI updates since the last run (${installed.map((d) => `${d.label} ${d.version}`).join(', ')})` }
      // only a version whose check was made counts as covered: one that could not be checked comes up again next
      // time, and when none could be, nothing is sent (the routine's row says why)
      const checked = updates.filter((u) => this.state.engines[u.engine]?.version === u.to)
      if (checked.length === 0) throw new Error(this.error ?? 'the compatibility check did not finish')
      const claude = updates.find((u) => u.engine === 'claude')
      let changelog: { lines: string[]; more: number } | undefined
      let changelogError: string | undefined
      if (claude) {
        try {
          const contract = CLI_CONTRACTS.find((c) => c.engine === 'claude')
          const texts = contract ? [...contract.flags, ...contract.strings].map((x) => x.text) : []
          changelog = relevantChangelog(await this.deps.fetchText(CLAUDE_CHANGELOG_URL), claude.from, claude.to, texts)
        } catch (e) {
          changelogError = (e as Error).message || 'network error'
          this.log(`changelog fetch failed: ${changelogError}`)
        }
      }
      return {
        text: buildDigest({ updates, state: this.state, changelog, changelogError, checkError: this.error }),
        summary: updates.map((u) => `${u.label} ${u.from ? `${u.from} → ` : ''}${u.to}`).join(', '),
        commit: () => this.review(checked)
      }
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  private review(updates: readonly CliUpdate[]): void {
    this.state = markReviewed(this.state, updates)
    this.save()
  }

  private async run(force: boolean): Promise<DetectedCli[]> {
    let detected: DetectedCli[] = []
    try {
      detected = await this.deps.detect()
      const stale = staleEngines(this.state, detected, force)
      if (stale.length === 0) {
        if (this.error) {
          this.error = undefined
          this.emit('change', this.view())
        }
        return detected
      }
      this.checking = true
      this.emit('change', this.view())
      const versions: Partial<Record<AgentEngine, string>> = {}
      for (const d of detected) if (d.version) versions[d.engine] = d.version
      // only the CLIs asked for count: a report for another one would overwrite a result with a version it was not run for
      const reports = (await this.deps.check(stale)).filter((r) => stale.includes(r.engine as AgentEngine))
      const before = this.state
      const applied = applyReports(this.state, reports, versions, (this.deps.now ?? Date.now)())
      this.state = applied.state
      const label = (engine: AgentEngine): string => detected.find((d) => d.engine === engine)?.label ?? engine
      this.error = applied.failed.length ? applied.failed.map((f) => `${label(f.engine)}: ${f.error}`).join('; ') : undefined
      if (this.error) this.log(`not checked: ${this.error}`)
      this.save()
      for (const b of applied.broke) {
        this.log(`${b.engine} ${b.version}: ${b.missing.length} assumption(s) missing: ${b.missing.map((m) => m.text).join(', ')}`)
        // once per version: a forced re-check of a version already known to be broken stays quiet
        const prev = before.engines[b.engine]
        if (prev && prev.version === b.version && prev.missing.length > 0) continue
        this.deps.onBroke?.(label(b.engine), b.version, b.missing)
      }
    } catch (e) {
      this.error = (e as Error).message || 'the check failed'
      this.log(`check failed: ${this.error}`)
    } finally {
      this.checking = false
      this.emit('change', this.view())
    }
    return detected
  }

  private log(line: string): void {
    this.deps.log?.(`cli-watch: ${line}`)
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const tmp = `${this.deps.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.deps.file)
    } catch (e) {
      // the result still shows this session; the next start checks again
      this.log(`could not save ${this.deps.file}: ${(e as Error).message}`)
    }
  }
}

/** A response's body as text, read up to `max` bytes (the changelog is newest first: what is cut off is the oldest). */
export async function readTextCapped(r: { body: ReadableStream<Uint8Array> | null }, max: number): Promise<string> {
  if (!r.body) return ''
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value.subarray(0, max - size))
    size += value.length
    if (size >= max) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Run the check in its own process (out/main/cli-compat-run.js) with a system node, or the app binary as node.
 * `env` carries the PATH the CLIs are looked up on.
 */
export function runCompatCheck(opts: { script: string; nodeBin?: string; execPath: string; env: NodeJS.ProcessEnv }, engines: AgentEngine[]): Promise<CheckReport[]> {
  return new Promise((resolve, reject) => {
    if (!existsSync(opts.script)) return reject(new Error('the check script is not built (out/main/cli-compat-run.js)'))
    // a node that is a .cmd shim cannot be started without a shell: the app's own binary runs the script then
    const node = opts.nodeBin && !/\.(cmd|bat)$/i.test(opts.nodeBin) ? opts.nodeBin : undefined
    const env = { ...opts.env, ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }
    execFile(node ?? opts.execPath, [opts.script, ...engines], { env, timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`the check did not finish: ${String(stderr || err.message).slice(0, 200)}`))
      try {
        const reports = JSON.parse(stdout) as unknown
        if (!Array.isArray(reports)) throw new Error('not a list')
        resolve(reports as CheckReport[])
      } catch (e) {
        reject(new Error(`the check's answer could not be read: ${(e as Error).message}`))
      }
    })
  })
}
