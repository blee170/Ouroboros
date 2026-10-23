import { describe, expect, it } from 'vitest'
import { isExecutablePath, linkifyPaths, looksLikePath, renderReply } from '@shared/replyMarkdown'

describe('looksLikePath', () => {
  it('accepts drive, home and dot-relative paths, folders and files', () => {
    for (const p of ['C:\\Users\\piz91\\.claudecode\\pmo\\DELETE-worktrees-2026-10-24b\\', 'C:/x/y.txt', '~/.claude/settings.json', './scripts/run.mjs', '../a', 'pmo/DELETE-worktrees-2026-10-24b/', 'src/main/ipc.ts', 'tests/unit/dashboard-club-border.test.ts', 'wt/clubborder-alt', 'board-waived-badge-0929/x']) expect(looksLikePath(p), p).toBe(true)
  })
  it('rejects prose, URLs, dates and bare words', () => {
    for (const p of ['and/or', 'TCP/IP', 'https://example.com/a/b', '2026/10/24', 'origin/main', 'A·B·C', '/', 'C:', 'ipc.ts']) expect(looksLikePath(p), p).toBe(false)
  })
})

describe('linkifyPaths', () => {
  it('links paths inside escaped text and leaves the rest alone', () => {
    const out = linkifyPaths('폴더는 C:\\Users\\piz91\\.claudecode\\pmo\\DELETE-worktrees-2026-10-24b\\ 입니다. 상자 1: box1.ps1.txt')
    expect(out).toContain('<a class="path" data-path="C:\\Users\\piz91\\.claudecode\\pmo\\DELETE-worktrees-2026-10-24b\\"')
    expect(out).not.toContain('data-path="box1.ps1.txt"')
  })
  it('drops sentence punctuation and keeps a path in parentheses whole', () => {
    expect(linkifyPaths('see src/main/ipc.ts.')).toBe('see <a class="path" data-path="src/main/ipc.ts" title="Open src/main/ipc.ts">src/main/ipc.ts</a>.')
    expect(linkifyPaths('(in pmo/x-1/)')).toBe('(in <a class="path" data-path="pmo/x-1/" title="Open pmo/x-1/">pmo/x-1/</a>)')
  })
  it('never touches URLs, entities or the tail of a word', () => {
    expect(linkifyPaths('https://claude.ai/code/artifact/x &amp; y')).not.toContain('data-path')
    expect(linkifyPaths('&quot;b/c-d&quot;')).toBe('&quot;<a class="path" data-path="b/c-d" title="Open b/c-d">b/c-d</a>&quot;')
    expect(linkifyPaths('foo/bar-baz')).toContain('data-path="foo/bar-baz"')
    expect(linkifyPaths('nofoo/bar-baz')).toContain('data-path="nofoo/bar-baz"')
  })
})

describe('renderReply', () => {
  it('renders GFM tables and links paths in code spans and plain text', () => {
    const html = renderReply('| 상자 | md5 |\n|---|---|\n| 1 box1 | `fb17f874` |\n\n위치: `pmo/DELETE-worktrees-2026-10-24b/`. 실행 순서는 CARD.md 와 scripts/run.mjs 에 있어요.')
    expect(html).toContain('<table>')
    expect(html).toContain('<code><a class="path" data-path="pmo/DELETE-worktrees-2026-10-24b/"')
    expect(html).toContain('data-path="scripts/run.mjs"')
    expect(html).not.toContain('data-path="CARD.md"')
  })
  it('escapes HTML the agent wrote and keeps markdown links as hrefs', () => {
    const html = renderReply('<img src=x onerror=alert(1)> [docs](https://example.com)')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('href="https://example.com"')
  })
  it('flags executables so a click reveals instead of runs', () => {
    expect(isExecutablePath('C:\\tools\\setup.exe')).toBe(true)
    expect(isExecutablePath('box1.ps1.txt')).toBe(false)
    expect(isExecutablePath('a/b.ps1')).toBe(true)
  })
})
