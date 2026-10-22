const ARTIFACT_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_\-/.]+/g
const ANY_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_\-/.]+|https?:\/\/[^\s)>\]"'`]+/
const trim = (u: string): string => u.replace(/[.,;:!?]+$/, '')

/**
 * The brief a card just published: a URL in its final reply (any https URL for a conductor, claude.ai artifacts
 * for other cards), else the newest claude.ai artifact link in its output so far (a brief writer posts the
 * link once and later turns only report edits).
 */
export function findBriefUrl(o: { message: string; output: string; anyUrl: boolean }): { url: string; inMessage: boolean } | null {
  const m = (o.anyUrl ? ANY_URL_RE : new RegExp(ARTIFACT_RE.source)).exec(o.message)
  if (m) return { url: trim(m[0]), inMessage: true }
  const all = o.output.match(ARTIFACT_RE)
  return all?.length ? { url: trim(all[all.length - 1]), inMessage: false } : null
}
