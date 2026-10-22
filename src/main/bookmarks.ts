import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Bookmark {
  folder: string
  title: string
  url: string
}

interface ChromeNode {
  type?: string
  name?: string
  url?: string
  children?: ChromeNode[]
}

/** Flatten a Chrome/Edge `Bookmarks` JSON document. Pure. */
export function parseBookmarks(json: string): Bookmark[] {
  let doc: { roots?: Record<string, ChromeNode> }
  try {
    doc = JSON.parse(json) as { roots?: Record<string, ChromeNode> }
  } catch {
    return []
  }
  const out: Bookmark[] = []
  const walk = (node: ChromeNode | undefined, path: string): void => {
    if (!node) return
    if (node.type === 'url' && typeof node.url === 'string' && /^https?:/i.test(node.url)) {
      out.push({ folder: path, title: (node.name ?? node.url).trim(), url: node.url })
      return
    }
    for (const c of node.children ?? []) walk(c, c.type === 'folder' ? (path ? `${path}/${c.name ?? ''}` : (c.name ?? '')) : path)
  }
  const roots = doc.roots ?? {}
  const labels: Record<string, string> = { bookmark_bar: 'Bookmarks bar', other: 'Other', synced: 'Mobile' }
  for (const key of Object.keys(roots)) walk(roots[key], labels[key] ?? key)
  return out
}

/** Candidate bookmark files: env override, then Chrome and Edge profiles on this OS. */
export function chromeBookmarkFiles(): string[] {
  if (process.env.CHROME_BOOKMARKS_FILE) return [process.env.CHROME_BOOKMARKS_FILE]
  const home = homedir()
  const bases: string[] = []
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    bases.push(join(local, 'Google', 'Chrome', 'User Data'), join(local, 'Microsoft', 'Edge', 'User Data'), join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'))
  } else if (process.platform === 'darwin') {
    bases.push(join(home, 'Library', 'Application Support', 'Google', 'Chrome'), join(home, 'Library', 'Application Support', 'Microsoft Edge'))
  } else {
    bases.push(join(home, '.config', 'google-chrome'), join(home, '.config', 'chromium'), join(home, '.config', 'microsoft-edge'))
  }
  const files: string[] = []
  for (const base of bases) {
    if (!existsSync(base)) continue
    let profiles: string[] = []
    try {
      profiles = readdirSync(base).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    } catch {
      continue
    }
    for (const p of profiles) {
      const f = join(base, p, 'Bookmarks')
      if (existsSync(f)) files.push(f)
    }
  }
  return files
}

export function listBookmarks(query?: string, limit = 2000): Bookmark[] {
  const seen = new Set<string>()
  const out: Bookmark[] = []
  for (const file of chromeBookmarkFiles()) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const b of parseBookmarks(text)) {
      if (seen.has(b.url)) continue
      seen.add(b.url)
      out.push(b)
      if (out.length >= limit) break
    }
  }
  const q = (query ?? '').trim().toLowerCase()
  return q ? out.filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || b.folder.toLowerCase().includes(q)) : out
}
