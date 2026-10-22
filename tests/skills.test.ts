import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listSkillsIn } from '../src/main/skills'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ouro-skills-'))
  dirs.push(d)
  return d
}
const file = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

describe('listSkillsIn', () => {
  it('collects built-ins, user and project commands and skills, and plugin skills as plugin:name', () => {
    const configDir = tmp()
    const cwd = tmp()
    const plugin = join(tmp(), 'ecc', '2.2.1')
    file(join(configDir, 'commands', 'ship.md'), '---\ndescription: "Ship it"\n---\nbody')
    file(join(configDir, 'skills', 'aside-browser', 'SKILL.md'), '---\nname: aside-browser\nversion: 3\ndescription: Read when you need a browser.\n---\n')
    file(join(configDir, 'skills', 'noname', 'SKILL.md'), '# no frontmatter')
    file(join(cwd, '.claude', 'commands', 'nested', 'deploy.md'), '---\ndescription: >\n  folded\n---\n')
    file(join(plugin, 'skills', 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: Review the diff\n---\n')
    file(join(plugin, 'commands', 'checkpoint.md'), 'no frontmatter')
    file(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'ecc@ecc': [{ installPath: plugin }], 'gone@x': [{ installPath: join(plugin, 'missing') }] } }))
    const list = listSkillsIn({ configDir, cwd })
    const by = Object.fromEntries(list.map((s) => [s.name, s]))
    expect(by['help']).toMatchObject({ source: 'builtin' })
    expect(by['ship']).toEqual({ name: 'ship', description: 'Ship it', source: 'user' })
    expect(by['aside-browser']).toEqual({ name: 'aside-browser', description: 'Read when you need a browser.', source: 'user' })
    expect(by['noname']).toEqual({ name: 'noname', description: undefined, source: 'user' })
    expect(by['deploy']).toEqual({ name: 'deploy', description: undefined, source: 'project' })
    expect(by['ecc:code-review']).toEqual({ name: 'ecc:code-review', description: 'Review the diff', source: 'plugin' })
    expect(by['ecc:checkpoint']).toMatchObject({ source: 'plugin' })
    expect(list.map((s) => s.name)).toEqual([...list.map((s) => s.name)].sort((a, b) => a.localeCompare(b)))
  })

  it('copes with an empty config dir and no cwd', () => {
    const list = listSkillsIn({ configDir: tmp(), cwd: '' })
    expect(list.every((s) => s.source === 'builtin')).toBe(true)
    expect(list.length).toBeGreaterThan(5)
  })
})
