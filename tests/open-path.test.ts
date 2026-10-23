import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { openMode, resolveOpenPath } from '../src/main/open-path'

const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
const cwd = process.platform === 'win32' ? 'C:\\proj\\wt' : '/proj/wt'

describe('resolveOpenPath', () => {
  it('resolves relative paths against the card folder and ~ against home', () => {
    expect(resolveOpenPath('pmo/CARD.md', cwd, home)).toEqual({ ok: true, abs: resolve(cwd, 'pmo/CARD.md') })
    expect(resolveOpenPath('~/.claude/settings.json', cwd, home)).toEqual({ ok: true, abs: resolve(home, '.claude/settings.json') })
    expect(resolveOpenPath('x.txt', undefined, home)).toEqual({ ok: true, abs: resolve(home, 'x.txt') })
  })
  it('refuses URLs, UNC and device paths, non-strings and null bytes; a drive letter passes', () => {
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'http://x/y', '\\\\attacker\\share\\x', '//attacker/share/x', '\\\\?\\C:\\x', 42, '', 'a\0b']) expect(resolveOpenPath(bad, cwd, home).ok, String(bad)).toBe(false)
    if (process.platform === 'win32') expect(resolveOpenPath('C:\\x\\y.md', cwd, home)).toEqual({ ok: true, abs: 'C:\\x\\y.md' })
  })
  it('ignores a UNC cwd', () => {
    expect(resolveOpenPath('a.md', '\\\\srv\\share', home)).toEqual({ ok: true, abs: resolve(home, 'a.md') })
  })
})

describe('openMode', () => {
  it('opens folders and plain file types, reveals everything that could run', () => {
    expect(openMode('C:\\x\\dir', true)).toBe('open')
    for (const f of ['CARD.md', 'box1.ps1.txt', 'notes.json', 'a.png', 'report.pdf', 'index.html', 'ipc.ts']) expect(openMode(f, false), f).toBe('open')
    for (const f of ['setup.exe', 'run.ps1', 'notes.hta', 'run.py', 'a.sh', 'x.cpl', 'y.url', 'z.lnk', 'app.jar', 'm.docm', 'tool', 'file.txt:evil.exe', 'a.js', 'b.vbs', 'c.msi', 'd.scf']) expect(openMode(f, false), f).toBe('reveal')
  })
})
