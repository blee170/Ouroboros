/**
 * One version's section out of CHANGELOG.md, for the release-notes page in Notion. The file is embedded at
 * build time; the heading format is the one the changelog keeps: `## [0.9.0] — 2026-10-26`.
 */

export interface ChangelogSection {
  version: string
  /** `YYYY-MM-DD`, when the heading has one */
  date?: string
  /** the section's markdown, heading excluded */
  body: string
  /** the bold lead of every top-level bullet, joined: "Board mail between cards · Action gates …" */
  highlights: string
}

export function changelogSection(markdown: string, version: string): ChangelogSection | undefined {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((l) => {
    const m = /^## \[([^\]]+)\]/.exec(l)
    return m !== null && m[1] === version
  })
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  const date = /(\d{4}-\d{2}-\d{2})/.exec(lines[start])?.[1]
  const body = lines.slice(start + 1, end).join('\n').trim()
  // only what changed: a "### Verified …" / "### Not verified …" section's bold bullets are evidence, not news, and a
  // lead ending in ":" ("Repeat calls:") labels detail under the bullet before it
  const leads: string[] = []
  // a section without subsection headings is all changes
  let inChanges = true
  for (const l of lines.slice(start + 1, end)) {
    const heading = /^### (.+)/.exec(l)
    if (heading) inChanges = /^(Added|Changed|Fixed|Security)\b/.test(heading[1])
    const lead = inChanges ? /^- \*\*(.+?)\*\*/.exec(l)?.[1] : undefined
    if (lead && !lead.endsWith(':')) leads.push(lead.replace(/\.$/, ''))
  }
  return { version, date, body, highlights: leads.join(' · ') }
}
