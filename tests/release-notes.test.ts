import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changelogSection } from '@shared/changelog'
// @ts-expect-error a plain .mjs script, no types
import { MAX_BODY, changelogVersions, releaseNotes, sectionBody } from '../scripts/release-notes.mjs'

const changelog = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8')

describe('release notes from the changelog', () => {
  it('cuts every version the way the app does', () => {
    const versions: string[] = changelogVersions(changelog)
    expect(versions.length).toBeGreaterThan(60)
    for (const v of versions) expect(sectionBody(changelog, v)).toBe(changelogSection(changelog, v)?.body)
  })

  it('every released version has notes that fit a GitHub release body', () => {
    for (const v of changelogVersions(changelog) as string[]) {
      if (v === 'Unreleased') continue
      const notes: string | undefined = releaseNotes(changelog, v)
      expect(notes, v).toBeTruthy()
      expect(notes!.length, v).toBeLessThanOrEqual(MAX_BODY)
      expect(notes, v).toContain(`/blob/v${v}/CHANGELOG.md`)
    }
  })

  it('has nothing for a version the changelog does not know, and cuts an oversized section', () => {
    expect(releaseNotes(changelog, '99.0.0')).toBeUndefined()
    expect(releaseNotes('## [1.0.0]\n\n## [0.9.0]\n- x\n', '1.0.0')).toBeUndefined()
    const big = releaseNotes(`## [1.0.0]\n${'- line\n'.repeat(30_000)}`, '1.0.0') as string
    expect(big.length).toBeLessThanOrEqual(MAX_BODY)
    expect(big).toContain('(cut here; the rest is in the changelog)')
  })
})
