/**
 * The role library on disk: the owner's `~/.claude/agents`, the project's `.claude/agents`, and the agency catalog
 * (a shallow clone of msitarzewski/agency-agents under userData/roles). Reading is pure over the given roots;
 * fetching runs git.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { RoleEntry, RolesListing, RoleSource, Runbook } from '@shared/roles'
import { parseRunbooks, roleCardPrompt, roleEntryOf } from '@shared/roles'
import { git } from './git'

export const AGENCY_REPO = 'https://github.com/msitarzewski/agency-agents'
/** Top-level folders of the agency repo that hold no agent files (used when divisions.json is missing). */
const NON_DIVISION_DIRS = new Set(['integrations', 'strategy', 'examples', 'scripts', 'node_modules'])
/** Larger files are not roles (the catalog's personas are 5–15 KB; the whole file becomes a system prompt). */
export const MAX_ROLE_FILE_BYTES = 256 * 1024
/** git must never wait on a credential prompt here: the repo is public, and a prompt would hang the fetch until its timeout. */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
/** The file index is reused this long (the Inspector, Build board and the Conductor all ask for it); a fetch resets it. */
const INDEX_TTL_MS = 30_000

interface RoleFile extends RoleEntry {
  file: string
}

/** Agent files in `dir` and its subfolders (game-development keeps engines in folders of their own). */
function agentFilesIn(dir: string, division: string, source: RoleSource, out: RoleFile[], depth = 0): void {
  if (!existsSync(dir)) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const f of names.sort()) {
    const file = join(dir, f)
    let st
    try {
      // a symlink is not followed: a catalog commit could point one anywhere
      st = lstatSync(file)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (depth < 2 && !f.startsWith('.')) agentFilesIn(file, division, source, out, depth + 1)
      continue
    }
    // repo boilerplate only: a role file such as security-architect.md must not be mistaken for SECURITY.md
    if (!st.isFile() || !f.endsWith('.md') || /^(README|CONTRIBUTING(_[\w-]+)?|SECURITY|LICENSE|CHANGELOG)\.md$/i.test(f)) continue
    // a file past the size cap is not a role: a persona is a few KB, and the whole file would become a system prompt
    if (st.size > MAX_ROLE_FILE_BYTES) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8').slice(0, 6000)
    } catch {
      continue
    }
    const entry = roleEntryOf(basename(f, '.md'), text, division, source)
    if (entry) out.push({ ...entry, file })
  }
}

/** The divisions of a catalog folder: divisions.json when present (its labels are not used here), else every folder with agent files. */
function divisionsOf(catalogDir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(catalogDir, 'divisions.json'), 'utf8')) as { divisions?: Record<string, unknown> }
    const keys = Object.keys(j.divisions ?? {})
    if (keys.length) return keys.filter((k) => /^[a-z0-9-]+$/.test(k))
  } catch {
    /* fall through */
  }
  try {
    return readdirSync(catalogDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NON_DIVISION_DIRS.has(d.name))
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * Every role the library has, project first, then the owner's, then the agency catalog; the first file with a
 * given id wins. Pure over the given roots.
 */
export function listRoleFiles(o: { configDir: string; cwd: string; catalogDir: string }): RoleFile[] {
  const out: RoleFile[] = []
  if (o.cwd) agentFilesIn(join(o.cwd, '.claude', 'agents'), 'project', 'project', out)
  agentFilesIn(join(o.configDir, 'agents'), 'user', 'user', out)
  if (hasCatalog(o.catalogDir)) for (const division of divisionsOf(o.catalogDir)) agentFilesIn(join(o.catalogDir, division), division, 'agency', out)
  const seen = new Set<string>()
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

/** A catalog counts once it is a git checkout; a folder a killed clone left behind is not one. */
export function hasCatalog(catalogDir: string): boolean {
  return existsSync(join(catalogDir, '.git'))
}

/** The runbooks of a catalog folder, rosters checked against `known` ids. */
export function listRunbooksIn(catalogDir: string, known: ReadonlySet<string>): Runbook[] {
  try {
    return parseRunbooks(JSON.parse(readFileSync(join(catalogDir, 'strategy', 'runbooks.json'), 'utf8')), known)
  } catch {
    return []
  }
}

const strip = (r: RoleFile): RoleEntry => {
  const { file: _file, ...entry } = r
  return entry
}

export function listingIn(o: { configDir: string; cwd: string; catalogDir: string; catalogVersion?: string }, files = listRoleFiles(o)): RolesListing {
  const listing: RolesListing = { roles: files.map(strip), runbooks: listRunbooksIn(o.catalogDir, new Set(files.map((r) => r.id))) }
  if (hasCatalog(o.catalogDir)) listing.catalog = o.catalogVersion ? { path: o.catalogDir, version: o.catalogVersion } : { path: o.catalogDir }
  return listing
}

/** The extra system prompt for role `id` (its file's body + the board footer), or undefined when the library has no such role. */
export function readRolePromptIn(o: { configDir: string; cwd: string; catalogDir: string }, id: string, files = listRoleFiles(o)): string | undefined {
  const hit = files.find((r) => r.id === id)
  if (!hit) return undefined
  try {
    return roleCardPrompt(readFileSync(hit.file, 'utf8'), hit)
  } catch {
    return undefined
  }
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** The first line of git's own reason (`fatal: …`), else the error's first line. */
function gitReason(err: unknown): string {
  const e = err as { message?: string; stderr?: string }
  const fatal = (e.stderr ?? '').split(/\r?\n/).find((l) => /^(fatal|error):/i.test(l))
  return (fatal ?? e.message ?? String(err)).split('\n')[0].trim()
}

/** The library for the real roots: the user's config dir, `cwd`, and the catalog under `userData/roles`. */
export class RoleLibrary {
  private version: string | undefined
  private index = new Map<string, { at: number; files: RoleFile[] }>()
  constructor(private readonly catalogDir: string) {}

  roots(cwd: string): { configDir: string; cwd: string; catalogDir: string } {
    return { configDir: claudeConfigDir(), cwd, catalogDir: this.catalogDir }
  }

  private files(cwd: string): RoleFile[] {
    const hit = this.index.get(cwd)
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.files
    const files = listRoleFiles(this.roots(cwd))
    this.index.set(cwd, { at: Date.now(), files })
    return files
  }

  async list(cwd: string): Promise<RolesListing> {
    if (this.version === undefined && hasCatalog(this.catalogDir)) this.version = await this.readVersion()
    return listingIn({ ...this.roots(cwd), catalogVersion: this.version }, this.files(cwd))
  }

  prompt(cwd: string, id: string): string | undefined {
    return readRolePromptIn(this.roots(cwd), id, this.files(cwd))
  }

  /**
   * Clone the agency repo (shallow) or bring the clone to upstream's tip (fetch + reset: a shallow clone cannot
   * fast-forward past its graft). A folder a killed clone left behind is removed first. Returns the version afterwards.
   */
  async fetch(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      if (hasCatalog(this.catalogDir)) {
        await git(this.catalogDir, ['fetch', '--depth', '1', 'origin', 'HEAD'], [0], { timeout: 180_000, env: GIT_ENV })
        await git(this.catalogDir, ['reset', '-q', '--hard', 'FETCH_HEAD'], [0], { timeout: 60_000, env: GIT_ENV })
      } else {
        if (existsSync(this.catalogDir)) rmSync(this.catalogDir, { recursive: true, force: true })
        const parent = dirname(this.catalogDir)
        mkdirSync(parent, { recursive: true }) // git would make the folder, but execFile needs an existing cwd
        await git(parent, ['clone', '--depth', '1', '-c', 'core.symlinks=false', AGENCY_REPO, this.catalogDir], [0], { timeout: 300_000, env: GIT_ENV })
      }
      this.version = await this.readVersion()
      this.index.clear()
      return { ok: true, version: this.version ?? '' }
    } catch (err) {
      this.index.clear()
      return { ok: false, error: gitReason(err) }
    }
  }

  private async readVersion(): Promise<string | undefined> {
    try {
      return (await git(this.catalogDir, ['log', '-1', '--format=%h %cs'], [0], { timeout: 20_000, env: GIT_ENV })).trim() || undefined
    } catch {
      return undefined
    }
  }
}
