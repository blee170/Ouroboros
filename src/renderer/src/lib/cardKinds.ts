import type { LucideIcon } from 'lucide-react'
import { AppWindow, CircleDashed, Gem, Globe, Hexagon, Sparkles, SquareTerminal, StickyNote, Workflow, Zap } from 'lucide-react'
import type { AgentEngine, NodeKind } from '@shared/types'

/** One list of the cards a person can add, shared by the title bar's "New card" menu and the canvas context menu. */
export interface CardKindItem {
  kind: NodeKind
  engine?: AgentEngine
  icon: LucideIcon
  label: string
  /** Extra data the store applies (the Aside command card). */
  data?: { title?: string; commandTemplate?: string }
  hint?: string
}

export const ENGINE_ICON: Record<AgentEngine, LucideIcon> = { claude: Sparkles, codex: Hexagon, gemini: Gem }
export const ENGINE_LABEL: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

export const CARD_KINDS: CardKindItem[] = [
  { kind: 'claude', engine: 'claude', icon: ENGINE_ICON.claude, label: 'Claude agent' },
  { kind: 'claude', engine: 'codex', icon: ENGINE_ICON.codex, label: 'Codex agent' },
  { kind: 'claude', engine: 'gemini', icon: ENGINE_ICON.gemini, label: 'Gemini agent' },
  { kind: 'conductor', icon: Workflow, label: 'Conductor' },
  { kind: 'terminal', icon: SquareTerminal, label: 'Terminal' },
  { kind: 'browser', icon: Globe, label: 'Browser' },
  { kind: 'command', icon: Zap, label: 'Command card' },
  { kind: 'command', icon: AppWindow, label: 'Aside', data: { title: 'Aside', commandTemplate: 'aside exec {{prompt}}' }, hint: "Runs Aside's browser agent for every prompt it receives (needs the Aside app + CLI)" },
  { kind: 'note', icon: StickyNote, label: 'Note' }
]

/**
 * The icon a card of this kind carries in its header, the sidebar and the Inspector. A board file is not
 * validated, so a kind or engine this build does not know falls back to a generic icon instead of rendering
 * `undefined` (which would blank the window).
 */
export function kindIcon(kind: NodeKind, engine?: AgentEngine): LucideIcon {
  switch (kind) {
    case 'claude':
      return ENGINE_ICON[engine ?? 'claude'] ?? Sparkles
    case 'conductor':
      return Workflow
    case 'terminal':
      return SquareTerminal
    case 'browser':
      return Globe
    case 'command':
      return Zap
    case 'note':
      return StickyNote
    case 'external':
      return CircleDashed
    default:
      return SquareTerminal
  }
}
