import type { AgentEngine, NodeKind } from '@shared/types'

/** One list of the cards a person can add, shared by the toolbar's "+ More" menu and the canvas context menu. */
export interface CardKindItem {
  kind: NodeKind
  engine?: AgentEngine
  glyph: string
  label: string
  /** Extra data the store applies (the Aside command card). */
  data?: { title?: string; commandTemplate?: string }
  hint?: string
}

export const CARD_KINDS: CardKindItem[] = [
  { kind: 'claude', engine: 'claude', glyph: '✦', label: 'Claude agent' },
  { kind: 'claude', engine: 'codex', glyph: '◎', label: 'Codex agent' },
  { kind: 'claude', engine: 'gemini', glyph: '✧', label: 'Gemini agent' },
  { kind: 'conductor', glyph: '🎼', label: 'Conductor' },
  { kind: 'terminal', glyph: '▣', label: 'Terminal' },
  { kind: 'browser', glyph: '🌐', label: 'Browser' },
  { kind: 'command', glyph: '⚡', label: 'Command card' },
  { kind: 'command', glyph: '🅰', label: 'Aside', data: { title: '🅰 Aside', commandTemplate: 'aside exec {{prompt}}' }, hint: "Runs Aside's browser agent for every prompt it receives (needs the Aside app + CLI)" },
  { kind: 'note', glyph: '📝', label: 'Note' }
]

export const ENGINE_GLYPH: Record<AgentEngine, string> = { claude: '✦', codex: '◎', gemini: '✧' }
export const ENGINE_LABEL: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
