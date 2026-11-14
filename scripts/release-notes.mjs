// Release notes from CHANGELOG.md.
//   node scripts/release-notes.mjs 0.20.3            print that version's notes (the release workflow uses this)
//   node scripts/release-notes.mjs --backfill        put every version's notes on its GitHub Release (needs gh, signed in)
//   node scripts/release-notes.mjs --backfill --dry-run   say what would change, change nothing
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** GitHub refuses a release body longer than this. */
export const MAX_BODY = 125_000

/** Every version heading in the changelog, newest first: `## [0.9.0] — 2026-10-26`. */
export function changelogVersions(markdown) {
  return [...markdown.replace(/\r\n?/g, '\n').matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
}

/** One version's section, heading excluded (the same cut as changelogSection in src/shared/changelog.ts). */
export function sectionBody(markdown, version) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((l) => /^## \[([^\]]+)\]/.exec(l)?.[1] === version)
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

/** The release body: the section, then where the whole history is. Undefined when the changelog has no such version. */
export function releaseNotes(markdown, version, repo = 'blee170/Ouroboros') {
  const body = sectionBody(markdown, version)
  if (body === undefined || body === '') return undefined
  const footer = `\n\n---\nFull history: [CHANGELOG.md](https://github.com/${repo}/blob/v${version}/CHANGELOG.md)`
  const cut = '\n\n(cut here; the rest is in the changelog)'
  const room = MAX_BODY - footer.length
  return (body.length > room ? body.slice(0, room - cut.length).trimEnd() + cut : body) + footer
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const markdown = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  if (argv[0] !== '--backfill') {
    const notes = argv[0] ? releaseNotes(markdown, argv[0]) : undefined
    if (notes === undefined) {
      console.error(`release-notes: no changelog section for "${argv[0] ?? ''}"`)
      process.exit(1)
    }
    process.stdout.write(notes + '\n')
    return
  }
  const dry = argv.includes('--dry-run')
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const tags = new Set(gh(['release', 'list', '--limit', '1000', '--json', 'tagName', '--jq', '.[].tagName']).split(/\r?\n/).filter(Boolean))
  const dir = mkdtempSync(join(tmpdir(), 'ouro-notes-'))
  let done = 0
  const skipped = []
  try {
    for (const version of changelogVersions(markdown)) {
      const tag = `v${version}`
      const notes = releaseNotes(markdown, version)
      if (!tags.has(tag) || notes === undefined) {
        skipped.push(version)
        continue
      }
      if (!dry) {
        const file = join(dir, `${version}.md`)
        writeFileSync(file, notes, 'utf8')
        gh(['release', 'edit', tag, '--notes-file', file])
      }
      done++
      console.log(`${dry ? 'would write' : 'wrote'} ${tag} (${notes.length} chars)`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const left = [...tags].filter((t) => !changelogVersions(markdown).includes(t.replace(/^v/, '')))
  console.log(`${dry ? 'would write' : 'wrote'} ${done} release(s). No release on GitHub for: ${skipped.join(', ') || 'none'}. Releases with no changelog section: ${left.join(', ') || 'none'}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
