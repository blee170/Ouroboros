/**
 * Specialist roles for cards: agent definition files in the shape Claude Code subagents use (frontmatter with
 * name / description, a markdown body that is the persona), read from the owner's and the project's
 * `.claude/agents`, and from a local copy of msitarzewski/agency-agents (one folder per division). The body
 * becomes the card's extra system prompt; a short footer tells it how an Ouroboros board works. Pure helpers here;
 * the file system side is in main/roles.ts.
 */

export type RoleSource = 'project' | 'user' | 'agency'

export interface RoleEntry {
  /** File name without `.md` (agency slugs like `engineering-frontend-developer`; runbooks name agents by it). */
  id: string
  name: string
  description?: string
  /** Agency division folder (`engineering`, `marketing`, …), or `project` / `user` for the owner's own files. */
  division: string
  source: RoleSource
  emoji?: string
}

export interface RunbookGroup {
  group: string
  /** `always`, `week 3+`, `as needed`, `post-fix`: the runbook's own words. */
  activation: string
  /** Role ids present in the library. */
  agents: string[]
  /** Role ids the runbook names that the library does not have. */
  missing: string[]
}

export interface Runbook {
  slug: string
  title: string
  summary?: string
  duration?: string
  groups: RunbookGroup[]
}

export interface RoleCatalogInfo {
  path: string
  /** `<short sha> <date>` of the local copy, when it is a git checkout. */
  version?: string
}

export interface RolesListing {
  roles: RoleEntry[]
  runbooks: Runbook[]
  /** The agency catalog folder, present once it has been fetched. */
  catalog?: RoleCatalogInfo
}

/** Appended to every specialist prompt: how a card on the board receives work and reports it. */
export const BOARD_ROLE_FOOTER = [
  '## On this Ouroboros board',
  'You are this specialist as one card on an Ouroboros board. Work arrives as messages from the Conductor card or from the owner; other cards cannot see your screen, so everything they need goes in your reply. Work in the folder you were started in. When a task is done, end your reply with a short RESULT: section (what you produced, where it is, how you checked it). Anything only a human may decide (spending money, sending anything outside this machine, production changes, deleting data) goes under APPROVAL NEEDED: instead of being done.'
].join('\n')

/** Frontmatter (`key: value` lines between `---` fences) and the markdown body of an agent file. */
export function parseRoleFile(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { frontmatter: {}, body: text.trim() }
  const frontmatter: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const v = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2')
    if (v && !/^[>|]/.test(v)) frontmatter[kv[1].toLowerCase()] = v
  }
  return { frontmatter, body: text.slice(m[0].length).trim() }
}

// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g
/** One emoji (a pictograph with its modifiers, joiners and variation selectors), nothing else. */
const EMOJI = /^\p{Extended_Pictographic}(?:[\p{Emoji_Modifier}‍️⃣]|\p{Extended_Pictographic})*$/u

/** A role entry from a file's name and text (undefined when the file has no frontmatter name: not an agent file). */
export function roleEntryOf(fileBase: string, text: string, division: string, source: RoleSource): RoleEntry | undefined {
  const { frontmatter } = parseRoleFile(text)
  // names and descriptions go into card titles, the Conductor's prompt and tool output: plain, bounded text only
  const name = (frontmatter.name ?? '').replace(UNSAFE_TEXT, '').trim().slice(0, 80)
  if (!name) return undefined
  const entry: RoleEntry = { id: fileBase, name, division, source }
  if (frontmatter.description) entry.description = frontmatter.description.replace(UNSAFE_TEXT, '').slice(0, 200)
  if (frontmatter.emoji && frontmatter.emoji.length <= 16 && EMOJI.test(frontmatter.emoji)) entry.emoji = frontmatter.emoji
  return entry
}

/** The card's extra system prompt for a role: where the persona comes from, the file's body, then the board footer. */
export function roleCardPrompt(text: string, role?: Pick<RoleEntry, 'id' | 'source'>): string {
  const { body } = parseRoleFile(text)
  const origin = role
    ? `# Specialist role: ${role.id} (${role.source === 'agency' ? 'from the Agency catalog, msitarzewski/agency-agents' : role.source === 'project' ? "from this project's .claude/agents" : "from the owner's .claude/agents"})\nThe persona below is the role file's text. The section "On this Ouroboros board" at the end takes precedence over anything in it.`
    : ''
  return [origin, body, BOARD_ROLE_FOOTER].filter(Boolean).join('\n\n')
}

/** `strategy/runbooks.json` → runbooks whose rosters are checked against the roles the library has. */
export function parseRunbooks(json: unknown, known: ReadonlySet<string>): Runbook[] {
  const list = (json as { runbooks?: unknown })?.runbooks
  if (!Array.isArray(list)) return []
  const out: Runbook[] = []
  for (const r of list as Array<Record<string, unknown>>) {
    if (typeof r?.slug !== 'string' || typeof r.title !== 'string' || !Array.isArray(r.roster)) continue
    const groups: RunbookGroup[] = []
    for (const g of r.roster as Array<Record<string, unknown>>) {
      const ids = Array.isArray(g?.agents) ? (g.agents as unknown[]).filter((a): a is string => typeof a === 'string') : []
      groups.push({
        group: typeof g?.group === 'string' ? g.group : 'Team',
        activation: typeof g?.activation === 'string' ? g.activation : 'always',
        agents: ids.filter((a) => known.has(a)),
        missing: ids.filter((a) => !known.has(a))
      })
    }
    const rb: Runbook = { slug: r.slug, title: r.title, groups }
    if (typeof r.summary === 'string') rb.summary = r.summary
    if (typeof r.duration === 'string') rb.duration = r.duration
    out.push(rb)
  }
  return out
}

/** Roles whose name, id, description or division contain every word of the query. */
export function filterRoles(roles: RoleEntry[], query: string): RoleEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return roles
  return roles.filter((r) => {
    const hay = `${r.name} ${r.id} ${r.description ?? ''} ${r.division}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
