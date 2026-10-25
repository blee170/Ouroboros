/**
 * Writes the open project into the owner's Obsidian vault (shared/obsidian.ts builds the files). One VaultExport per
 * window, driven by the ledger and board changes, debounced. Rules that keep the vault the owner's:
 * - only `<vault>/Ouroboros/<project>/` is ever written, and only if it resolves inside the vault (no junction out);
 * - the folder belongs to one project: its manifest names the project's path, and another path is refused;
 * - a file is written only if it is new or still exactly what the app wrote (the manifest keeps the hash); a file the
 *   owner edited since, or one that was there first, is left alone;
 * - a task's note is deleted only when the task is gone and the note is unchanged; reports are never deleted.
 */
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { Task } from '@shared/ledger'
import { VAULT_ROOT, boardCanvas, homeNote, isTaskId, reportDate, reportNote, taskNote, tasksBase, vaultProjectName, type CanvasCard } from '@shared/obsidian'

const DEBOUNCE_MS = 5000
const MAX_WAIT_MS = 30000
const MANIFEST = '.ouroboros-export.json'
/** Newest morning reports copied each run; older ones stay in the vault as they were. */
const MAX_REPORTS = 200
/** A report file larger than this is not copied (they are a few KB). */
const MAX_REPORT_BYTES = 1024 * 1024

export interface VaultExportDeps {
  /** the vault folder when the export is on, else undefined */
  vault: () => string | undefined
  /** the project's folder (the export folder belongs to this path) */
  root: () => string
  project: () => string
  tasks: () => Task[]
  ownerTitle: (cardId: string) => string | undefined
  /** the board as cards with positions (from the saved board file) and its lines */
  board: () => { cards: CanvasCard[]; edges: Array<{ id: string; source: string; target: string; label?: string }> }
  /** the folder the project's morning reports (run-*.md) are saved in */
  reportsDir: () => string
  log: (line: string) => void
  failed: (error: string) => void
}

export interface ExportResult {
  ok: boolean
  error?: string
  /** vault-relative folder written */
  folder?: string
  written: number
  kept: number
  removed: number
}

const sha = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex')

/** Pure: whether the vault setting is a folder the export may use. */
export function vaultProblem(vault: string | undefined, exists: (p: string) => boolean, isDir: (p: string) => boolean): string | undefined {
  if (!vault?.trim()) return 'no vault folder in Settings → Obsidian'
  // a network share would receive every task and reply, and Windows sends the user's credentials to it
  if (/^[\\/]{2}/.test(vault)) return 'the vault folder in Settings → Obsidian is a network path; pick a folder on this PC'
  if (!isAbsolute(vault)) return 'the vault folder in Settings → Obsidian is not a full path'
  if (!exists(vault) || !isDir(vault)) return `the vault folder ${vault} does not exist`
  return undefined
}

/** Pure: a manifest path that stays inside the export folder (forward slashes, no `..`, no drive or root). */
export function safeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || /[\\:\x00]/.test(rel)) return false
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

interface Manifest {
  root?: string
  files: Record<string, string>
}

/** The manifest: none yet is an empty one; one that cannot be read stops the export (the files would all look like the owner's). */
export function readManifest(path: string): Manifest {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files: {} }
    throw new Error(`could not read ${MANIFEST} (${(err as Error).message}); left as it is`)
  }
  let j: { root?: unknown; files?: Record<string, unknown> }
  try {
    j = JSON.parse(text) as typeof j
  } catch {
    throw new Error(`${MANIFEST} in the export folder is damaged; delete it to start the export over (files you edited are kept)`)
  }
  const files: Record<string, string> = {}
  for (const [rel, h] of Object.entries(j.files ?? {})) if (typeof h === 'string' && safeRel(rel)) files[rel] = h
  return { root: typeof j.root === 'string' ? j.root : undefined, files }
}

const sameRoot = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

export class VaultExport {
  private timer: ReturnType<typeof setTimeout> | undefined
  private firstAsk = 0
  /** files whose keeping was already logged this session */
  private keptLogged = new Set<string>()

  constructor(private deps: VaultExportDeps) {}

  /** Something changed: export a few seconds after the last change (at most every 30 s while changes keep coming). */
  schedule(): void {
    if (!this.deps.vault()) return
    const now = Date.now()
    if (!this.timer) this.firstAsk = now
    clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.firstAsk + MAX_WAIT_MS - now))
    this.timer = setTimeout(() => {
      this.timer = undefined
      // turned off while waiting: nothing to do, and no failure to report
      if (!this.deps.vault()) return
      const r = this.run()
      if (!r.ok && r.error) this.deps.failed(r.error)
    }, wait)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Export now (synchronous: two runs never overlap). */
  run(): ExportResult {
    try {
      return this.exportOnce()
    } catch (err) {
      return { ok: false, error: `Obsidian export: ${(err as Error).message}`, written: 0, kept: 0, removed: 0 }
    }
  }

  private exportOnce(): ExportResult {
    const vault = this.deps.vault()
    const problem = vaultProblem(vault, existsSync, (p) => statSync(p).isDirectory())
    if (problem || !vault) throw new Error(problem)
    const project = this.deps.project()
    const root = this.deps.root()
    const name = vaultProjectName(project)
    const base = `${VAULT_ROOT}/${name}`
    const dest = join(vault, VAULT_ROOT, name)
    mkdirSync(dest, { recursive: true })
    // a junction or link that leads out of the vault is not followed
    const realVault = realpathSync(vault)
    const inside = (p: string): boolean => {
      const rel = relative(realVault, realpathSync(p))
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    }
    if (!inside(dest)) throw new Error(`${base} leads outside the vault; not written`)
    const manifestPath = join(dest, MANIFEST)
    const before = readManifest(manifestPath)
    if (before.root && !sameRoot(before.root, root)) throw new Error(`${base} in the vault belongs to another project (${before.root}); rename one of the two project folders`)

    const files = new Map<string, string>()
    const tasks = this.deps.tasks().filter((t) => isTaskId(t.id))
    for (const t of tasks) files.set(`Tasks/${t.id}.md`, taskNote(t, { base, project, ownerTitle: t.owner ? this.deps.ownerTitle(t.owner) : undefined }))
    const reports = this.reportFiles()
    for (const r of reports) files.set(`Reports/${r.name}`, reportNote(r.text, { project, date: r.date }))
    const board = this.deps.board()
    files.set('Board.canvas', boardCanvas(board.cards, board.edges))
    files.set('Tasks.base', tasksBase(base))
    files.set(`${name}.md`, homeNote({ base, project, tasks, reports: reports.map((r) => r.name) }))

    // what the app has written, kept current file by file and saved even when a write fails part-way
    const after: Record<string, string> = { ...before.files }
    let written = 0
    let kept = 0
    let removed = 0
    const errors: string[] = []
    try {
      for (const [rel, text] of files) {
        const path = join(dest, ...rel.split('/'))
        try {
          const wrote = before.files[rel]
          const want = sha(text)
          if (existsSync(path)) {
            const disk = sha(readFileSync(path, 'utf8'))
            if (disk === want) {
              after[rel] = want // already what it should be (an export whose manifest was lost is adopted)
              continue
            }
            if (wrote === undefined || disk !== wrote) {
              kept++
              this.logKept(rel, `${base}/${rel} ${wrote === undefined ? 'was not written by Ouroboros' : 'was edited in the vault'}; left as it is`)
              continue
            }
          }
          mkdirSync(dirname(path), { recursive: true })
          if (!inside(dirname(path))) throw new Error('leads outside the vault')
          writeAtomic(path, text)
          after[rel] = want
          written++
        } catch (err) {
          errors.push(`${rel}: ${(err as Error).message}`)
        }
      }
      // tasks that left the ledger: their notes go while still exactly what the app wrote. An empty ledger next to
      // notes the app wrote is more likely a board that failed to load than every task deleted: nothing goes then.
      const wroteTasks = Object.keys(before.files).some((rel) => rel.startsWith('Tasks/'))
      const ledgerEmpty = tasks.length === 0 && wroteTasks
      for (const [rel, wrote] of Object.entries(before.files)) {
        if (files.has(rel) || !rel.startsWith('Tasks/') || ledgerEmpty) continue
        const path = join(dest, ...rel.split('/'))
        try {
          if (!existsSync(path)) delete after[rel]
          else if (sha(readFileSync(path, 'utf8')) === wrote && inside(path)) {
            unlinkSync(path)
            delete after[rel]
            removed++
          }
        } catch (err) {
          errors.push(`${rel}: ${(err as Error).message}`)
        }
      }
    } finally {
      writeAtomic(manifestPath, JSON.stringify({ note: 'Files Ouroboros wrote here and their hashes; delete a file to have it written again.', root, files: after }, null, 2))
    }
    if (written || removed) this.deps.log(`[obsidian] ${base}: ${written} written, ${removed} removed, ${kept} kept as edited`)
    if (errors.length) return { ok: false, error: `Obsidian export: ${errors.length} file(s) not written (${errors.slice(0, 3).join('; ')})`, folder: base, written, kept, removed }
    return { ok: true, folder: base, written, kept, removed }
  }

  private logKept(rel: string, line: string): void {
    if (this.keptLogged.has(rel)) return
    this.keptLogged.add(rel)
    this.deps.log(`[obsidian] ${line}`)
  }

  private reportFiles(): Array<{ name: string; date: string; text: string }> {
    const dir = this.deps.reportsDir()
    if (!existsSync(dir)) return []
    const out: Array<{ name: string; date: string; text: string }> = []
    for (const name of readdirSync(dir).sort().reverse()) {
      const date = reportDate(name)
      if (!date) continue
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (!st.isFile() || st.size > MAX_REPORT_BYTES) continue
        out.push({ name, date, text: readFileSync(path, 'utf8') })
      } catch {
        continue // a report that cannot be read is skipped; the others still go
      }
      if (out.length >= MAX_REPORTS) break
    }
    return out
  }
}

/** Write through a fresh temp file (never one that is already there); the rename is retried while a scanner holds the target. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try {
          unlinkSync(tmp)
        } catch {
          /* already gone */
        }
        throw err
      }
      // Defender, OneDrive or Dropbox holding the file for a moment
      const until = Date.now() + 50 * (i + 1)
      while (Date.now() < until) {
        /* short synchronous wait */
      }
    }
  }
}
