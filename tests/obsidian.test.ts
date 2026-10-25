import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Task } from '../src/shared/ledger'
import { boardCanvas, homeNote, inertText, reportDate, reportNote, taskNote, tasksBase, vaultProjectName } from '../src/shared/obsidian'
import { VaultExport, safeRel, vaultProblem, type VaultExportDeps } from '../src/main/obsidian-export'

const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `task ${id}`, state: 'todo', deps: [], createdBy: 'owner', createdAt: new Date(2026, 9, 26, 9, 5, 7).getTime(), updatedAt: new Date(2026, 9, 26, 10, 0, 0).getTime(), ...extra })

describe('obsidian builders (pure)', () => {
  it('writes a task note with quoted frontmatter, vault-path links and its sections', () => {
    const md = taskNote(t('T3', { title: 'Fix "login": now', state: 'doing', owner: 'c1', parent: 'T1', deps: ['T2', 'bad id'], detail: 'Do it.', result: 'Done.' }), { base: 'Ouroboros/proj', project: 'proj', ownerTitle: 'Reviewer' })
    expect(md).toContain('title: "Fix \\"login\\": now"')
    expect(md).toContain('owner: "Reviewer"')
    expect(md).toContain('parent: "[[Ouroboros/proj/Tasks/T1|T1]]"')
    expect(md).toContain('  - "[[Ouroboros/proj/Tasks/T2|T2]]"')
    expect(md).not.toContain('bad id')
    expect(md).toContain('created: 2026-10-26T09:05:07')
    expect(md).toContain('  - ouroboros/doing')
    expect(md).toContain('# T3 · Fix "login": now\n\nDo it.\n\n## Result\n\nDone.')
  })
  it('names project folders safely and reads report dates from run file names only', () => {
    expect(vaultProjectName('my/app:v2')).toBe('my_app_v2')
    expect(vaultProjectName('..')).toBe('no-project')
    expect(vaultProjectName('우로보로스')).toBe('우로보로스')
    expect(reportDate('run-2026-10-26_08-30.md')).toBe('2026-10-26T08:30:00')
    expect(reportDate('notes.md')).toBeUndefined()
    expect(reportNote('# Morning\n', { project: 'p', date: '2026-10-26T08:30:00' })).toBe('---\ntype: ouroboros-report\nproject: "p"\ndate: 2026-10-26T08:30:00\ntags:\n  - ouroboros/report\n---\n\n# Morning\n')
  })
  it('draws the board as JSON Canvas: text cards coloured by state, browser cards as links, lines between known cards', () => {
    const c = JSON.parse(
      boardCanvas(
        [
          { id: 'a', kind: 'claude', title: 'Chief **x**', engine: 'claude', status: 'needs-you', statusDetail: 'permission: Bash', lastReply: 'r'.repeat(1300), x: 10.4, y: 20, width: 100, height: 50 },
          { id: 'b', kind: 'browser', title: 'Docs', url: 'https://example.com', x: 500, y: 0, width: 400, height: 300 },
          { id: 'c', kind: 'browser', title: 'Local', url: 'file:///x', x: 0, y: 400, width: 400, height: 300 }
        ],
        [{ id: 'e1', source: 'a', target: 'b', label: 'auto' }, { id: 'e2', source: 'a', target: 'gone' }]
      )
    )
    expect(c.nodes[0]).toMatchObject({ id: 'a', type: 'text', x: 10, width: 160, height: 80, color: '1' })
    expect(c.nodes[0].text.startsWith('**Chief x**\nclaude · needs-you · permission: Bash\n\n')).toBe(true)
    expect(c.nodes[0].text.endsWith('…')).toBe(true)
    expect(c.nodes[1]).toMatchObject({ type: 'link', url: 'https://example.com' })
    expect(c.nodes[2].type).toBe('text')
    expect(c.edges).toEqual([{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'auto' }])
  })
  it('writes a Bases file over the tasks folder and a home note with full-path links', () => {
    expect(tasksBase('Ouroboros/p')).toContain('    - "file.inFolder(\\"Ouroboros/p/Tasks\\")"')
    const home = homeNote({ base: 'Ouroboros/p', project: 'p', tasks: [t('T1'), t('T2', { state: 'done' })], reports: ['run-2026-10-26_08-30.md'] })
    expect(home).toContain('todo 1 · doing 0 · blocked 0 · done 1')
    expect(home).toContain('![[Ouroboros/p/Tasks.base]]')
    expect(home).toContain('- [[Ouroboros/p/Reports/run-2026-10-26_08-30|run-2026-10-26_08-30]]')
  })
})

describe('VaultExport (files on disk)', () => {
  const setup = (): { vault: string; reports: string; deps: VaultExportDeps; tasks: Task[]; logs: string[] } => {
    const vault = mkdtempSync(join(tmpdir(), 'ouro-vault-'))
    const reports = mkdtempSync(join(tmpdir(), 'ouro-reports-'))
    const tasks = [t('T1'), t('T2', { parent: 'T1' })]
    const logs: string[] = []
    const deps: VaultExportDeps = {
      vault: () => vault,
      root: () => 'C:\\work\\proj',
      project: () => 'proj',
      tasks: () => tasks,
      ownerTitle: () => undefined,
      board: () => ({ cards: [], edges: [] }),
      reportsDir: () => reports,
      log: (l) => logs.push(l),
      failed: () => {}
    }
    return { vault, reports, deps, tasks, logs }
  }

  it('writes the project folder, then only what changed, keeps owner edits and pre-existing files, and removes untouched notes of gone tasks', async () => {
    const { vault, reports, deps, tasks, logs } = setup()
    writeFileSync(join(reports, 'run-2026-10-26_08-30.md'), '# Report\n')
    const dir = join(vault, 'Ouroboros', 'proj')
    mkdirSync(join(dir, 'Tasks'), { recursive: true })
    writeFileSync(join(dir, 'Tasks', 'T2.md'), 'mine') // there before the first export
    const ex = new VaultExport(deps)
    const r1 = await ex.run()
    expect(r1).toMatchObject({ ok: true, folder: 'Ouroboros/proj', kept: 1 })
    for (const f of ['Tasks/T1.md', 'Reports/run-2026-10-26_08-30.md', 'Board.canvas', 'Tasks.base', 'proj.md', '.ouroboros-export.json']) expect(existsSync(join(dir, ...f.split('/')))).toBe(true)
    expect(readFileSync(join(dir, 'Tasks', 'T2.md'), 'utf8')).toBe('mine')
    expect(logs.some((l) => l.includes('Tasks/T2.md was not written by Ouroboros'))).toBe(true)
    // nothing changed: nothing written
    const r2 = await ex.run()
    expect(r2.written).toBe(0)
    // the owner edits T1: kept from now on, even when the task changes
    writeFileSync(join(dir, 'Tasks', 'T1.md'), 'edited in Obsidian')
    tasks[0] = { ...tasks[0], state: 'done', updatedAt: tasks[0].updatedAt + 1000 }
    const r3 = await ex.run()
    expect(readFileSync(join(dir, 'Tasks', 'T1.md'), 'utf8')).toBe('edited in Obsidian')
    expect(r3.kept).toBe(2)
    // a new task appears, then leaves the ledger (with T1): its untouched note is removed; the edited T1 stays
    tasks.push(t('T3'))
    await ex.run()
    expect(existsSync(join(dir, 'Tasks', 'T3.md'))).toBe(true)
    tasks.splice(0, tasks.length, t('T2'))
    const r4 = await ex.run()
    expect(r4.removed).toBe(1)
    expect(existsSync(join(dir, 'Tasks', 'T3.md'))).toBe(false)
    expect(readFileSync(join(dir, 'Tasks', 'T1.md'), 'utf8')).toBe('edited in Obsidian')
  })
  it('never follows a tampered manifest outside the export folder', async () => {
    const { vault, deps } = setup()
    const dir = join(vault, 'Ouroboros', 'proj')
    mkdirSync(dir, { recursive: true })
    const outside = join(vault, 'precious.md')
    writeFileSync(outside, 'x')
    writeFileSync(join(dir, '.ouroboros-export.json'), JSON.stringify({ files: { '../../precious.md': '11f6ad8ec52a2984abaafd7c3b516503785c2072', 'C:/x.md': 'a', 'a\\b.md': 'b' } }))
    await new VaultExport(deps).run()
    expect(existsSync(outside)).toBe(true)
    expect(safeRel('Tasks/T1.md')).toBe(true)
    for (const bad of ['../x', '/abs', 'C:/x', 'a\\b', 'a//b', './x', '']) expect(safeRel(bad)).toBe(false)
  })
  it('reports a missing or relative vault and does nothing', async () => {
    expect(vaultProblem(undefined, () => true, () => true)).toContain('no vault folder')
    expect(vaultProblem('vault', () => true, () => true)).toContain('not a full path')
    expect(vaultProblem(join(tmpdir(), 'nope-ouro-vault'), () => false, () => false)).toContain('does not exist')
    const { deps } = setup()
    const r = await new VaultExport({ ...deps, vault: () => join(tmpdir(), 'nope-ouro-vault-x') }).run()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('does not exist')
    expect(vaultProblem('\\\\attacker\\share', () => true, () => true)).toContain('network path')
    expect(vaultProblem('//host/share', () => true, () => true)).toContain('network path')
  })
  it('stops on a damaged manifest and leaves it as it is; adopts identical files when the manifest is gone', async () => {
    const { vault, deps } = setup()
    const ex = new VaultExport(deps)
    ex.run()
    const dir = join(vault, 'Ouroboros', 'proj')
    const manifest = join(dir, '.ouroboros-export.json')
    writeFileSync(manifest, '{ broken')
    const r = ex.run()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('damaged')
    expect(readFileSync(manifest, 'utf8')).toBe('{ broken')
    // the owner deletes the manifest: the files are still exactly the export's, so they are taken back
    unlinkSync(manifest)
    const r2 = ex.run()
    expect(r2).toMatchObject({ ok: true, kept: 0, written: 0 })
    expect(JSON.parse(readFileSync(manifest, 'utf8')).files['Tasks/T1.md']).toBeTruthy()
  })
  it('refuses a folder that belongs to another project with the same name', () => {
    const { deps } = setup()
    new VaultExport(deps).run()
    const r = new VaultExport({ ...deps, root: () => 'D:\\fork\\proj' }).run()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('belongs to another project')
  })
  it('never deletes reports, and an empty ledger removes no task notes', () => {
    const { vault, reports, deps, tasks } = setup()
    writeFileSync(join(reports, 'run-2026-10-26_08-30.md'), '# r\n')
    const ex = new VaultExport(deps)
    ex.run()
    const dir = join(vault, 'Ouroboros', 'proj')
    unlinkSync(join(reports, 'run-2026-10-26_08-30.md'))
    tasks.splice(0, tasks.length)
    const r = ex.run()
    expect(r.removed).toBe(0)
    expect(existsSync(join(dir, 'Reports', 'run-2026-10-26_08-30.md'))).toBe(true)
    expect(existsSync(join(dir, 'Tasks', 'T1.md'))).toBe(true)
  })
})

describe('agent text in the vault', () => {
  it('makes Templater and Dataview code inert and leaves other markdown alone', () => {
    expect(inertText("<%* require('child_process').exec('x') %>")).toBe("<\\%* require('child_process').exec('x') %>")
    expect(inertText('```dataviewjs\ndv.span(1)\n```')).toBe('```text-dataviewjs\ndv.span(1)\n```')
    expect(inertText('  ~~~ dataview\nLIST\n~~~')).toBe('  ~~~ text-dataview\nLIST\n~~~')
    expect(inertText('see `$= dv.current()` and `= this.file.name`')).toBe('see `\u200d$= dv.current()` and `\u200d= this.file.name`')
    expect(inertText('**bold** `code` ```ts\nx\n```')).toBe('**bold** `code` ```ts\nx\n```')
    const note = taskNote(t('T9', { title: 'a\nb', detail: '<% tp.file.title %>' }), { base: 'Ouroboros/p', project: 'p' })
    expect(note).toContain('# T9 · a b')
    expect(note).toContain('<\\% tp.file.title %>')
    expect(reportNote('```dataviewjs\nx\n```', { project: 'p', date: '2026-10-26T08:30:00' })).toContain('```text-dataviewjs')
    expect(JSON.parse(boardCanvas([{ id: 'a', kind: 'note', title: 'n', lastReply: '<% x %>', x: 0, y: 0, width: Infinity, height: NaN }], [])).nodes[0]).toMatchObject({ width: 160, height: 80, text: '**n**\n\n<\\% x %>' })
  })
  it('escapes characters strict YAML refuses, skips missing times, and avoids Windows-reserved names', () => {
    const note = taskNote(t('T1', { title: 'del\x7f lone\ud800', createdAt: NaN }), { base: 'Ouroboros/p', project: 'p' })
    expect(note).toContain('title: "del\\u007f lone\\ud800"')
    expect(note).not.toContain('created:')
    expect(vaultProjectName('CON')).toBe('CON_')
    expect(vaultProjectName('app. ')).toBe('app')
  })
})
