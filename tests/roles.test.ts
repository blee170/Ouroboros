import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BOARD_ROLE_FOOTER, filterRoles, parseRoleFile, parseRunbooks, roleCardPrompt, roleEntryOf } from '@shared/roles'
import { listRoleFiles, listRunbooksIn, listingIn, readRolePromptIn } from '../src/main/roles'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ouro-roles-'))
  dirs.push(d)
  return d
}
const file = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

const AGENT = (name: string, extra = ''): string => `---\nname: ${name}\ndescription: Does ${name.toLowerCase()} things\ncolor: cyan\nemoji: 🖥️\n${extra}---\n\n# ${name} Agent Personality\n\nYou are **${name}**.\n\n## Mission\n- Ship it\n`

describe('role files', () => {
  it('parses frontmatter and body, with CRLF, quotes and a BOM', () => {
    const r = parseRoleFile('﻿---\r\nname: "Frontend Developer"\r\ndescription: \'Builds UIs\'\r\nvibe: >\r\n  folded\r\n---\r\n\r\n# Body\r\nline')
    expect(r.frontmatter).toEqual({ name: 'Frontend Developer', description: 'Builds UIs' })
    expect(r.body).toBe('# Body\r\nline')
    expect(parseRoleFile('no frontmatter here')).toEqual({ frontmatter: {}, body: 'no frontmatter here' })
  })

  it('makes an entry only from a file with a name, trims the description, keeps a short emoji', () => {
    const e = roleEntryOf('engineering-frontend-developer', AGENT('Frontend Developer'), 'engineering', 'agency')
    expect(e).toEqual({ id: 'engineering-frontend-developer', name: 'Frontend Developer', description: 'Does frontend developer things', division: 'engineering', source: 'agency', emoji: '🖥️' })
    expect(roleEntryOf('readme', '# Just a readme\n', 'engineering', 'agency')).toBeUndefined()
    const long = roleEntryOf('x', `---\nname: X\ndescription: ${'d'.repeat(300)}\n---\nbody`, 'user', 'user')
    expect(long?.description).toHaveLength(200)
  })

  it('turns the body into a card prompt with the board footer, and names the origin when given', () => {
    const p = roleCardPrompt(AGENT('Tester'))
    expect(p.startsWith('# Tester Agent Personality')).toBe(true)
    expect(p.endsWith(BOARD_ROLE_FOOTER)).toBe(true)
    expect(p).not.toContain('color: cyan')
    expect(BOARD_ROLE_FOOTER).toContain('RESULT:')
    const withOrigin = roleCardPrompt(AGENT('Tester'), { id: 'testing-tester', source: 'agency' })
    expect(withOrigin.startsWith('# Specialist role: testing-tester (from the Agency catalog')).toBe(true)
    expect(withOrigin).toContain('takes precedence')
    expect(withOrigin.indexOf('# Tester Agent Personality')).toBeGreaterThan(0)
    expect(roleCardPrompt(AGENT('X'), { id: 'x', source: 'project' })).toContain("from this project's .claude/agents")
  })

  it('bounds and cleans names, keeps only real emoji', () => {
    const mk = (fm: string) => roleEntryOf('x', `---\n${fm}\n---\nbody`, 'user', 'user')
    expect(mk(`name: ${'N'.repeat(100)}`)?.name).toHaveLength(80)
    expect(mk('name: Evil\u202e name\u0007 here')?.name).toBe('Evil name here')
    expect(mk('name: A\nemoji: 👨‍💻')?.emoji).toBe('👨‍💻')
    expect(mk('name: A\nemoji: 🏳️‍🌈')?.emoji).toBe('🏳️‍🌈')
    expect(mk('name: A\nemoji: :smile:')?.emoji).toBeUndefined()
    expect(mk('name: A\nemoji: 🖥️ x')?.emoji).toBeUndefined()
    expect(mk('name: \u200b')).toBeUndefined()
  })

  it('reads runbooks and marks roster ids the library lacks', () => {
    const json = {
      runbooks: [
        { slug: 'mvp', title: 'MVP', summary: 'fast', duration: '4 weeks', roster: [{ group: 'Core', activation: 'always', agents: ['a', 'b'] }, { group: 'Later', activation: 'week 3+', agents: ['c'] }] },
        { slug: 'bad' },
        { slug: 'empty', title: 'Empty', roster: [{ agents: 'nope' }] }
      ]
    }
    const rb = parseRunbooks(json, new Set(['a', 'c']))
    expect(rb).toEqual([
      { slug: 'mvp', title: 'MVP', summary: 'fast', duration: '4 weeks', groups: [{ group: 'Core', activation: 'always', agents: ['a'], missing: ['b'] }, { group: 'Later', activation: 'week 3+', agents: ['c'], missing: [] }] },
      { slug: 'empty', title: 'Empty', groups: [{ group: 'Team', activation: 'always', agents: [], missing: [] }] }
    ])
    expect(parseRunbooks(null, new Set())).toEqual([])
    expect(parseRunbooks({ runbooks: 'x' }, new Set())).toEqual([])
  })

  it('filters by every word across name, id, description and division', () => {
    const roles = [
      { id: 'engineering-frontend-developer', name: 'Frontend Developer', description: 'React and CSS', division: 'engineering', source: 'agency' as const },
      { id: 'marketing-growth-hacker', name: 'Growth Hacker', description: 'funnels', division: 'marketing', source: 'agency' as const }
    ]
    expect(filterRoles(roles, '').map((r) => r.id)).toEqual(roles.map((r) => r.id))
    expect(filterRoles(roles, 'react').map((r) => r.id)).toEqual(['engineering-frontend-developer'])
    expect(filterRoles(roles, 'marketing growth').map((r) => r.id)).toEqual(['marketing-growth-hacker'])
    expect(filterRoles(roles, 'engineering growth')).toEqual([])
  })
})

describe('role library on disk', () => {
  const configDir = tmp()
  const cwd = tmp()
  const catalogDir = join(tmp(), 'agency-agents')
  file(join(cwd, '.claude', 'agents', 'our-reviewer.md'), AGENT('Our Reviewer'))
  file(join(configDir, 'agents', 'my-writer.md'), AGENT('My Writer'))
  // the project's file wins over the owner's when both use an id
  file(join(configDir, 'agents', 'our-reviewer.md'), AGENT('Shadowed Reviewer'))
  file(join(catalogDir, 'divisions.json'), JSON.stringify({ divisions: { engineering: { label: 'Engineering' }, marketing: { label: 'Marketing' }, security: { label: 'Security' } } }))
  file(join(catalogDir, 'engineering', 'engineering-frontend-developer.md'), AGENT('Frontend Developer'))
  file(join(catalogDir, 'engineering', 'README.md'), '# not an agent')
  file(join(catalogDir, 'marketing', 'marketing-growth-hacker.md'), AGENT('Growth Hacker'))
  file(join(catalogDir, 'security', 'security-architect.md'), AGENT('Security Architect'))
  file(join(catalogDir, 'security', 'SECURITY.md'), ['---', 'name: Policy', '---', 'not a role'].join('\n'))
  file(join(catalogDir, 'examples', 'example-agent.md'), AGENT('Example'))
  file(join(catalogDir, 'engineering', 'godot', 'godot-shader-developer.md'), AGENT('Godot Shader Developer'))
  file(join(catalogDir, 'engineering', 'huge.md'), AGENT('Huge') + 'x'.repeat(300 * 1024))
  mkdirSync(join(catalogDir, '.git'), { recursive: true })
  file(join(catalogDir, 'strategy', 'runbooks.json'), JSON.stringify({ runbooks: [{ slug: 'startup-mvp', title: 'Startup MVP Build', roster: [{ group: 'Core Team', activation: 'always', agents: ['engineering-frontend-developer', 'agents-orchestrator'] }] }] }))

  it('lists project, user and agency roles in that order, first id wins, non-division folders skipped', () => {
    const roles = listRoleFiles({ configDir, cwd, catalogDir })
    expect(roles.map((r) => `${r.source}:${r.id}:${r.name}`)).toEqual([
      'project:our-reviewer:Our Reviewer',
      'user:my-writer:My Writer',
      'agency:engineering-frontend-developer:Frontend Developer',
      'agency:godot-shader-developer:Godot Shader Developer',
      'agency:marketing-growth-hacker:Growth Hacker',
      'agency:security-architect:Security Architect'
    ])
    expect(roles[2].division).toBe('engineering')
    expect(roles.every((r) => r.file.endsWith('.md'))).toBe(true)
  })

  it('reads a role prompt by id and says undefined for unknown ids', () => {
    const p = readRolePromptIn({ configDir, cwd, catalogDir }, 'marketing-growth-hacker')
    expect(p?.startsWith('# Specialist role: marketing-growth-hacker (from the Agency catalog')).toBe(true)
    expect(p).toContain('# Growth Hacker Agent Personality')
    expect(p?.endsWith(BOARD_ROLE_FOOTER)).toBe(true)
    expect(readRolePromptIn({ configDir, cwd, catalogDir }, 'nobody')).toBeUndefined()
    expect(readRolePromptIn({ configDir, cwd, catalogDir }, '../divisions')).toBeUndefined()
  })

  it('builds a listing with runbooks checked against the library and the catalog info', () => {
    const l = listingIn({ configDir, cwd, catalogDir, catalogVersion: 'abc1234 2026-10-19' })
    expect(l.roles.some((r) => 'file' in r)).toBe(false)
    expect(l.runbooks).toEqual([{ slug: 'startup-mvp', title: 'Startup MVB'.replace('MVB', 'MVP Build'), groups: [{ group: 'Core Team', activation: 'always', agents: ['engineering-frontend-developer'], missing: ['agents-orchestrator'] }] }])
    expect(l.catalog).toEqual({ path: catalogDir, version: 'abc1234 2026-10-19' })
    // a folder without .git (a killed clone) is no catalog
    const half = join(tmp(), 'half')
    file(join(half, 'engineering', 'x.md'), AGENT('X'))
    expect(listingIn({ configDir, cwd, catalogDir: half }).catalog).toBeUndefined()
    expect(listingIn({ configDir, cwd, catalogDir: half }).roles.map((r) => r.id)).toEqual(['our-reviewer', 'my-writer'])
    const none = listingIn({ configDir, cwd, catalogDir: join(catalogDir, 'missing') })
    expect(none.catalog).toBeUndefined()
    expect(none.runbooks).toEqual([])
    expect(none.roles).toHaveLength(2)
    expect(listRunbooksIn(join(catalogDir, 'missing'), new Set())).toEqual([])
  })

  it('without divisions.json every folder except the known non-division ones counts', () => {
    const bare = join(tmp(), 'bare')
    mkdirSync(join(bare, '.git'), { recursive: true })
    file(join(bare, 'design', 'design-ui.md'), AGENT('UI Designer'))
    file(join(bare, 'strategy', 'playbook.md'), AGENT('Not An Agent Folder'))
    file(join(bare, '.github', 'x.md'), AGENT('Hidden'))
    expect(listRoleFiles({ configDir: join(bare, 'nocfg'), cwd: '', catalogDir: bare }).map((r) => r.id)).toEqual(['design-ui'])
  })
})
