import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SkillEntry } from '@shared/protocol'

/** Claude Code's own commands that are always there (the ones the picker should offer). */
const BUILTIN: Array<[string, string]> = [
  ['clear', 'Start a fresh conversation'],
  ['compact', 'Compact the conversation (optional focus text)'],
  ['config', 'Settings'],
  ['cost', 'Token usage of this session'],
  ['doctor', 'Check the installation'],
  ['help', 'Commands and shortcuts'],
  ['init', 'Write a CLAUDE.md for this project'],
  ['mcp', 'MCP servers'],
  ['memory', 'Edit memory files'],
  ['model', 'Switch the model'],
  ['permissions', 'Allow / deny rules'],
  ['resume', 'Resume a past session'],
  ['review', 'Review a pull request'],
  ['status', 'Version, model, account'],
  ['fast', 'Toggle fast mode']
]

function frontmatter(file: string): { name?: string; description?: string } {
  let text = ''
  try {
    text = readFileSync(file, 'utf8').slice(0, 4000)
  } catch {
    return {}
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const get = (key: string): string | undefined => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1])
    const v = line?.[1].trim().replace(/^["']|["']$/g, '')
    return v && !/^[>|]/.test(v) ? v : undefined
  }
  return { name: get('name'), description: get('description') }
}

function commandsIn(dir: string, prefix: string, source: SkillEntry['source'], out: SkillEntry[]): void {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) commandsIn(join(dir, f.name), prefix, source, out)
    else if (f.name.endsWith('.md')) out.push({ name: prefix + basename(f.name, '.md'), description: frontmatter(join(dir, f.name)).description, source })
  }
}

function skillsIn(dir: string, prefix: string, source: SkillEntry['source'], out: SkillEntry[]): void {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isDirectory()) continue
    const file = join(dir, f.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const fm = frontmatter(file)
    out.push({ name: prefix + (fm.name || f.name), description: fm.description, source })
  }
}

/**
 * Slash commands a Claude Code card in `cwd` would offer: built-ins, the user's and the project's
 * commands and skills, and every installed plugin's (as `plugin:name`). Pure over the given roots.
 */
export function listSkillsIn(o: { configDir: string; cwd: string }): SkillEntry[] {
  const out: SkillEntry[] = BUILTIN.map(([name, description]) => ({ name, description, source: 'builtin' }))
  commandsIn(join(o.configDir, 'commands'), '', 'user', out)
  skillsIn(join(o.configDir, 'skills'), '', 'user', out)
  if (o.cwd) {
    commandsIn(join(o.cwd, '.claude', 'commands'), '', 'project', out)
    skillsIn(join(o.cwd, '.claude', 'skills'), '', 'project', out)
  }
  try {
    const manifest = JSON.parse(readFileSync(join(o.configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string }>> }
    for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
      const plugin = key.split('@')[0]
      const root = installs?.[0]?.installPath
      if (!plugin || !root) continue
      commandsIn(join(root, 'commands'), `${plugin}:`, 'plugin', out)
      skillsIn(join(root, 'skills'), `${plugin}:`, 'plugin', out)
    }
  } catch {
    /* no plugins */
  }
  const seen = new Set<string>()
  return out
    .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
    .map((s) => ({ ...s, description: s.description?.slice(0, 140) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const cache = new Map<string, { at: number; list: SkillEntry[] }>()

/** `listSkillsIn` for the real config dir, cached for 30 s per folder (the picker opens often). */
export function listSkills(cwd: string): SkillEntry[] {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < 30_000) return hit.list
  const list = listSkillsIn({ configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), cwd })
  cache.set(cwd, { at: Date.now(), list })
  return list
}
