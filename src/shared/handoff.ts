import type { HandoffEdgeData, WorkspaceEdge } from './types'

export interface HandoffContext {
  last_assistant_message?: string
  source_title?: string
  source_cwd?: string
  target_title?: string
}

export const DEFAULT_HANDOFF_TEMPLATE =
  'Handoff from "{{source_title}}". Their last message:\n\n{{last_assistant_message}}\n\nContinue from here.'

/** Replace `{{key}}` placeholders. Unknown keys become empty strings. */
export function renderTemplate(template: string, ctx: HandoffContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = (ctx as Record<string, string | undefined>)[key]
    return v ?? ''
  })
}

/**
 * Condition syntax: empty/undefined = always; `/pattern/flags` = regex; anything else = case-insensitive substring.
 */
export function matchesCondition(condition: string | undefined, message: string | undefined): boolean {
  const c = (condition ?? '').trim()
  if (!c) return true
  const text = message ?? ''
  const re = /^\/(.+)\/([a-z]*)$/s.exec(c)
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(text)
    } catch {
      return false
    }
  }
  return text.toLowerCase().includes(c.toLowerCase())
}

/** Pick the handoff edges leaving `sourceId` that should fire for `message`. */
export function selectHandoffs(
  edges: WorkspaceEdge[],
  sourceId: string,
  message: string | undefined,
  opts: { includeManual?: boolean } = {}
): WorkspaceEdge[] {
  return edges.filter((e) => {
    if (e.source !== sourceId) return false
    const d: HandoffEdgeData = e.data
    if (!opts.includeManual && d.mode !== 'auto') return false
    return matchesCondition(d.condition, message)
  })
}

/** Normalise text so it can be pasted into an interactive CLI (bracketed paste) and submitted. */
export function toPastePayload(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '')
  return `\x1b[200~${normalised}\x1b[201~`
}
