import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliWatch } from '../src/main/cli-watch'
import { findStrings, inHelp } from '../src/main/cli-compat'
import {
  CLI_UPDATES_TOKEN,
  CLI_WATCH_ROUTINE,
  WATCH_LIMITS,
  applyReports,
  buildDigest,
  cliUpdates,
  compareVersions,
  compatSentence,
  markReviewed,
  relevantChangelog,
  sanitizeCompatState,
  staleEngines,
  type CheckReport,
  type CompatState,
  type DetectedCli
} from '../src/shared/cli-watch'
import { checkRoutine } from '../src/shared/routines'

const cli = (engine: DetectedCli['engine'], version: string | undefined, installed = true): DetectedCli => ({ engine, label: { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', grok: 'Grok Build' }[engine], installed, version })
const report = (engine: string, statuses: string[], version = 'raw line'): CheckReport => ({ engine, installed: true, version, lines: statuses.map((status, i) => ({ status, kind: i === 0 ? 'flag' : 'string', text: `t${i}`, why: `w${i}` })) })
const empty: CompatState = { engines: {}, reviewed: {} }

const CHANGELOG = `# Changelog

## 2.1.318

- Fixed a typo in the welcome banner
- Changed the Stop hook payload to carry \`background_tasks\`
- [VSCode] Fixed a hook spinner

## 2.1.317

- Added \`--effort\` levels to the picker
- Improved startup time
- Self-hosted runner: Fixed a checkout hook

## 2.1.316

- Removed the old plugin loader

## 2.1.9

- Fixed hooks on Windows
`

describe('versions and stale CLIs', () => {
  it('compares dotted versions by number', () => {
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1)
    expect(compareVersions('2.1.318', '2.1.318')).toBe(0)
    expect(compareVersions('1.0.70 (f509) [stable]', '1.0.7')).toBe(1)
    expect(compareVersions('0.65', '0.65.0')).toBe(0)
  })
  it('lists the installed CLIs whose version is not the one last checked', () => {
    const state = applyReports(empty, [report('claude', ['ok'])], { claude: '2.1.316' }, 1).state
    const detected = [cli('claude', '2.1.316'), cli('gemini', '0.65.0'), cli('codex', undefined, false), cli('grok', undefined)]
    expect(staleEngines(state, detected)).toEqual(['gemini'])
    expect(staleEngines(state, detected, true)).toEqual(['claude', 'gemini'])
    expect(staleEngines(state, [cli('claude', '2.1.317')])).toEqual(['claude'])
  })
})

describe('applyReports', () => {
  it('keeps what is missing and hidden, the count, and the version before', () => {
    const first = applyReports(empty, [report('claude', ['hidden', 'ok', 'ok'])], { claude: '2.1.316' }, 10)
    expect(first.broke).toEqual([])
    expect(first.state.engines.claude).toEqual({ version: '2.1.316', checkedAt: 10, total: 3, missing: [], hidden: [{ kind: 'flag', text: 't0', why: 'w0' }] })
    const second = applyReports(first.state, [report('claude', ['ok', 'missing', 'missing'])], { claude: '2.1.317' }, 20)
    expect(second.state.engines.claude).toMatchObject({ version: '2.1.317', previousVersion: '2.1.316', missing: [{ text: 't1' }, { text: 't2' }] })
    expect(second.broke).toEqual([{ engine: 'claude', version: '2.1.317', missing: second.state.engines.claude!.missing }])
    // a forced re-check of the same version keeps the version before
    expect(applyReports(second.state, [report('claude', ['ok'])], { claude: '2.1.317' }, 30).state.engines.claude?.previousVersion).toBe('2.1.316')
  })
  it("falls back to the report's own version line, and skips what is not a CLI of ours or not installed", () => {
    const r = applyReports(empty, [report('grok', ['ok'], 'grok 1.0.70 (f5) [stable]'), report('other', ['ok']), { engine: 'codex', installed: false, lines: [] }], {}, 1)
    expect(Object.keys(r.state.engines)).toEqual(['grok'])
    expect(r.state.engines.grok?.version).toBe('grok 1.0.70 (f5) [stable]')
  })
})

describe('sanitizeCompatState', () => {
  it('keeps check results and reviewed versions, drops everything else', () => {
    const state = sanitizeCompatState({
      engines: { claude: { version: '2.1.316', checkedAt: 5, total: 44, missing: [{ kind: 'flag', text: '--x', why: 'y' }, { kind: 'bad', text: 'z' }, 'no'], hidden: 'no' }, evil: { version: '1', checkedAt: 1 }, gemini: { version: '', checkedAt: 1 }, grok: { version: '1', checkedAt: 'no' } },
      reviewed: { claude: '2.1.310', nope: '1', gemini: 5 }
    })
    expect(state).toEqual({ engines: { claude: { version: '2.1.316', checkedAt: 5, total: 44, missing: [{ kind: 'flag', text: '--x', why: 'y' }], hidden: [] } }, reviewed: { claude: '2.1.310' } })
    expect(sanitizeCompatState('junk')).toEqual(empty)
    expect(sanitizeCompatState(null)).toEqual(empty)
  })
})

describe('relevantChangelog', () => {
  it('takes the versions after the covered one up to the installed one, and only entries that matter to cards', () => {
    const r = relevantChangelog(CHANGELOG, '2.1.316', '2.1.318')
    expect(r.versions).toEqual(['2.1.318', '2.1.317'])
    expect(r.lines).toEqual(['## 2.1.318', '- Changed the Stop hook payload to carry `background_tasks`', '## 2.1.317', '- Added `--effort` levels to the picker'])
    expect(r.more).toBe(0)
  })
  it('takes only the installed version on a first watch, and nothing newer than it', () => {
    expect(relevantChangelog(CHANGELOG, undefined, '2.1.317').lines).toEqual(['## 2.1.317', '- Added `--effort` levels to the picker'])
    expect(relevantChangelog(CHANGELOG, '2.1.9', '2.1.316').lines).toEqual(['## 2.1.316', '- Removed the old plugin loader'])
    expect(relevantChangelog(CHANGELOG, '2.1.318', '2.1.318').lines).toEqual([])
  })
  it("matches the contract's own strings too, and counts what it leaves out past the cap", () => {
    const md = `## 1.0.1\n- Renamed the frobnicate_widget field\n- Something else`
    expect(relevantChangelog(md, '1.0.0', '1.0.1', ['frobnicate_widget']).lines).toEqual(['## 1.0.1', '- Renamed the frobnicate_widget field'])
    const many = `## 1.0.1\n${Array.from({ length: WATCH_LIMITS.changelogLines + 7 }, (_, i) => `- hook change ${i}`).join('\n')}`
    const r = relevantChangelog(many, '1.0.0', '1.0.1')
    expect(r.lines).toHaveLength(WATCH_LIMITS.changelogLines)
    expect(r.more).toBe(8)
  })
})

describe('the watch digest', () => {
  const checked = applyReports(empty, [report('claude', ['hidden', 'ok']), report('gemini', ['ok', 'missing'])], { claude: '2.1.318', gemini: '0.66.0' }, 1).state
  it('lists the CLIs whose version the last run did not cover, and covers them after', () => {
    const state: CompatState = { ...checked, reviewed: { claude: '2.1.316', gemini: '0.66.0' } }
    const detected = [cli('claude', '2.1.318'), cli('gemini', '0.66.0'), cli('grok', '1.0.70'), cli('codex', undefined, false)]
    const updates = cliUpdates(state, detected)
    expect(updates).toEqual([
      { engine: 'claude', label: 'Claude Code', from: '2.1.316', to: '2.1.318' },
      { engine: 'grok', label: 'Grok Build', to: '1.0.70' }
    ])
    expect(cliUpdates(markReviewed(state, updates), detected)).toEqual([])
  })
  it('says what changed, what the check found and which changelog lines matter', () => {
    const text = buildDigest({
      updates: [
        { engine: 'claude', label: 'Claude Code', from: '2.1.316', to: '2.1.318' },
        { engine: 'gemini', label: 'Gemini CLI', to: '0.66.0' },
        { engine: 'grok', label: 'Grok Build', to: '1.0.71' }
      ],
      state: checked,
      changelog: { lines: ['## 2.1.318', '- Changed the Stop hook'], more: 2 }
    })
    expect(text).toContain('- Claude Code: 2.1.316 → 2.1.318')
    expect(text).toContain('- Gemini CLI: 0.66.0 (first watch)')
    expect(text).toContain('- Claude Code 2.1.318: everything Ouroboros relies on is there (2 checked); 1 flag no longer in --help (still works): t0')
    expect(text).toContain('- Gemini CLI 0.66.0: 1 of 2 MISSING: t1 (w1)')
    expect(text).toContain('- Grok Build 1.0.71: not checked yet')
    expect(text).toContain('## 2.1.318\n- Changed the Stop hook\n… 2 more such entries')
    expect(text).toContain('look them up for Gemini CLI 0.66.0, Grok Build 1.0.71')
  })
  it('says so when the changelog could not be fetched or has nothing, and stays under its size', () => {
    const updates = [{ engine: 'claude' as const, label: 'Claude Code', from: '2.1.316', to: '2.1.318' }]
    expect(buildDigest({ updates, state: checked, changelogError: 'HTTP 503' })).toContain('could not be fetched (HTTP 503)')
    expect(buildDigest({ updates, state: checked, changelog: { lines: [], more: 0 } })).toContain('No Claude Code changelog entry')
    const long = buildDigest({ updates, state: checked, changelog: { lines: Array.from({ length: 120 }, () => `- ${'x'.repeat(390)}`), more: 0 } })
    expect(long.length).toBeLessThan(WATCH_LIMITS.digestChars + 80)
    expect(compatSentence('X', checked.engines.gemini!)).toBe('X 0.66.0: 1 of 2 MISSING: t1 (w1)')
  })
  it('offers a routine that passes the routine checks and carries the token', () => {
    const r = checkRoutine({ ...CLI_WATCH_ROUTINE, cardId: 'c1' })
    expect(r.ok).toBe(true)
    expect(CLI_WATCH_ROUTINE.prompt).toContain(CLI_UPDATES_TOKEN)
  })
})

describe('the check core', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ouro-compat-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a flag in help text only as its own token', () => {
    const help = '  -c, --config <key=value>   Override\n  --model <m>\n  resume [--last]  Resume\n  (default, auto_edit, yolo)'
    expect([inHelp(help, '-c'), inHelp(help, '--config'), inHelp(help, '--mod'), inHelp(help, '--last'), inHelp(help, 'resume'), inHelp(help, 'yolo'), inHelp(help, 'edit')]).toEqual([true, true, false, true, true, true, false])
  })
  it('finds strings in files, also one cut by a chunk boundary, and reports the ones that are nowhere', async () => {
    const big = join(dir, 'big.bin')
    // 4 MiB chunks: the needle starts 5 bytes before the first boundary
    const body = Buffer.alloc(4 * 1024 * 1024 + 3 * 1024 * 1024, 0x61)
    body.write('NEEDLE_ACROSS_BOUNDARY', 4 * 1024 * 1024 - 5)
    body.write('tail-needle', body.length - 11)
    writeFileSync(big, body)
    writeFileSync(join(dir, 'small.js'), 'const x = "PostToolUse"')
    const found = await findStrings([join(dir, 'nope'), big, join(dir, 'small.js')], ['NEEDLE_ACROSS_BOUNDARY', 'tail-needle', 'PostToolUse', 'absent-text'])
    expect([...found].sort()).toEqual(['NEEDLE_ACROSS_BOUNDARY', 'PostToolUse', 'tail-needle'])
  })
})

describe('CliWatch', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ouro-watch-'))
    file = join(dir, 'sub', 'cli-compat.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const make = (over: Partial<ConstructorParameters<typeof CliWatch>[0]> = {}) => {
    const calls: string[][] = []
    const broke: string[] = []
    const env = { detected: [cli('claude', '2.1.316'), cli('gemini', '0.65.0'), cli('codex', undefined, false)], statuses: { claude: ['hidden', 'ok'], gemini: ['ok'] } as Record<string, string[]>, changelog: CHANGELOG as string | Error }
    const watch = new CliWatch({
      file,
      detect: async () => env.detected,
      check: async (engines) => {
        calls.push(engines)
        return engines.map((e) => report(e, env.statuses[e] ?? ['ok']))
      },
      fetchText: async () => {
        if (env.changelog instanceof Error) throw env.changelog
        return env.changelog
      },
      now: () => 100,
      onBroke: (label, version, missing) => broke.push(`${label} ${version}: ${missing.map((m) => m.text).join(',')}`),
      ...over
    })
    return { watch, calls, broke, env }
  }

  it('checks each installed CLI once per version and keeps the result in its file', async () => {
    const { watch, calls, env } = make()
    const view = await watch.refresh()
    expect(calls).toEqual([['claude', 'gemini']])
    expect(view.checking).toBe(false)
    expect(view.engines.claude).toMatchObject({ version: '2.1.316', total: 2, hidden: [{ text: 't0' }], missing: [] })
    await watch.refresh()
    expect(calls).toHaveLength(1)
    env.detected = [cli('claude', '2.1.317'), cli('gemini', '0.65.0')]
    await watch.refresh()
    expect(calls[1]).toEqual(['claude'])
    await watch.refresh(true)
    expect(calls[2]).toEqual(['claude', 'gemini'])
    // a new instance reads the file: nothing to check
    const again = make()
    again.env.detected = env.detected
    await again.watch.refresh()
    expect(again.calls).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).engines.claude.previousVersion).toBe('2.1.316')
  })
  it('reports a version that lacks something once, not again on a forced re-check', async () => {
    const { watch, broke, env } = make()
    env.statuses.claude = ['ok', 'missing']
    await watch.refresh()
    expect(broke).toEqual(['Claude Code 2.1.316: t1'])
    await watch.refresh(true)
    expect(broke).toHaveLength(1)
    env.detected = [cli('claude', '2.1.317')]
    await watch.refresh()
    expect(broke).toEqual(['Claude Code 2.1.316: t1', 'Claude Code 2.1.317: t1'])
  })
  it('says when the check itself could not run, keeps the last result, and clears the error when it runs again', async () => {
    const seen: boolean[] = []
    let fail = true
    const { watch } = make({
      check: async (engines) => {
        if (fail) throw new Error('the check script is not built')
        return engines.map((e) => report(e, ['ok']))
      }
    })
    watch.on('change', (v) => seen.push(v.checking))
    const view = await watch.refresh()
    expect(view).toMatchObject({ checking: false, error: 'the check script is not built', engines: {} })
    expect(seen).toEqual([true, false])
    fail = false
    expect((await watch.refresh()).error).toBeUndefined()
  })
  it('ignores a report for a CLI it did not ask about', async () => {
    const { watch } = make({ check: async () => [report('claude', ['ok']), report('grok', ['missing'])] })
    const view = await watch.refresh()
    expect(Object.keys(view.engines)).toEqual(['claude'])
  })
  it('hands a routine what changed since its last run, and nothing once that was covered', async () => {
    const { watch, env } = make()
    const first = await watch.digest()
    if ('none' in first) throw new Error('expected a digest')
    expect(first.summary).toBe('Claude Code 2.1.316, Gemini CLI 0.65.0')
    expect(first.text).toContain('- Claude Code: 2.1.316 (first watch)')
    expect(first.text).toContain('## 2.1.316\n- Removed the old plugin loader')
    // not sent (no commit): the next run still has it
    expect('text' in (await watch.digest())).toBe(true)
    first.commit()
    expect(await watch.digest()).toEqual({ none: 'no CLI updates since the last run (Claude Code 2.1.316, Gemini CLI 0.65.0)' })
    env.detected = [cli('claude', '2.1.318'), cli('gemini', '0.65.0')]
    const second = await watch.digest()
    if ('none' in second) throw new Error('expected a digest')
    expect(second.summary).toBe('Claude Code 2.1.316 → 2.1.318')
    expect(second.text).toContain('## 2.1.318')
    expect(second.text).toContain('## 2.1.317')
    expect(second.text).not.toContain('Gemini')
    env.changelog = new Error('HTTP 503')
    expect(((await watch.digest()) as { text: string }).text).toContain('could not be fetched (HTTP 503)')
  })
  it('has nothing for a PC without a CLI', async () => {
    const { watch, env } = make()
    env.detected = [cli('claude', undefined, false)]
    expect(await watch.digest()).toEqual({ none: 'no agent CLI was found on this PC' })
  })
  it('starts over from a state file that is not JSON', async () => {
    const { watch } = make()
    await watch.refresh()
    writeFileSync(file, '{broken')
    const again = make()
    await again.watch.refresh()
    expect(again.calls).toEqual([['claude', 'gemini']])
  })
})
