import { extname, isAbsolute, join, resolve } from 'node:path'

/**
 * A path out of a card's reply, clicked by the owner. Main decides everything: where it resolves, that
 * it is local, and whether it is opened with its app or only revealed in its folder. Files are opened
 * only when their extension is on this list; anything else (scripts, installers, shortcuts, archives,
 * Office files, no extension) is revealed, so a planted file cannot run from a click.
 */
const OPENABLE = new Set(['md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'xml', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'sql', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'pdf', 'diff', 'patch', 'lock', 'env', 'example', 'sample', 'rst', 'adoc', 'mjs', 'cjs', 'jsx', 'vue', 'svelte', 'astro', 'prisma', 'graphql', 'gql', 'proto', 'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'm', 'dart', 'lua', 'r'])

export type ResolvedPath = { ok: true; abs: string } | { ok: false; error: string }

/** Resolve what the renderer sent: a string, no scheme, no UNC or device path; relative to the card's folder, `~` to home. */
export function resolveOpenPath(p: unknown, cwd: unknown, home: string): ResolvedPath {
  if (typeof p !== 'string' || !p || p.includes('\0')) return { ok: false, error: 'Not a path' }
  if (/^[a-z][a-z0-9+.-]+:/i.test(p)) return { ok: false, error: 'Not a path' } // a URL scheme (two+ letters: drive letters pass)
  if (/^[\\/]{2}/.test(p)) return { ok: false, error: 'Not a local path' } // UNC and \\?\ device paths
  const base = typeof cwd === 'string' && isAbsolute(cwd) && !/^[\\/]{2}/.test(cwd) ? cwd : home
  const abs = /^~([\\/]|$)/.test(p) ? join(home, p.slice(1)) : isAbsolute(p) ? p : resolve(base, p)
  if (/^[\\/]{2}/.test(abs)) return { ok: false, error: 'Not a local path' }
  return { ok: true, abs }
}

/** Open with its app only for folders and plainly-readable file types; everything else is revealed in its folder. */
export function openMode(abs: string, isDirectory: boolean): 'open' | 'reveal' {
  if (isDirectory) return 'open'
  const ext = extname(abs).slice(1).toLowerCase()
  return ext && OPENABLE.has(ext) ? 'open' : 'reveal'
}
