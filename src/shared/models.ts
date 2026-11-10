/**
 * The Model choices a card's Inspector offers per engine. The value goes to the CLI as is (`--model` for Claude
 * Code, `-m` for Codex, Gemini and Grok); an empty value is the CLI's own default. Codex and Gemini rename their
 * models often, so they get no presets: the custom field takes whatever their own `/model` lists (`grok models` for Grok).
 * Claude Code's family aliases (opus, sonnet, haiku, fable) follow its newest model of each family, so they do not
 * go stale when a model ships; only the pinned ids do.
 */
import type { AgentEngine } from './types'

export interface ModelPreset {
  value: string
  label: string
}

export const MODEL_PRESETS: Record<AgentEngine, ModelPreset[]> = {
  claude: [
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'sonnet', label: 'Sonnet (latest): cheaper, routine work' },
    { value: 'haiku', label: 'Haiku (latest): lightest' },
    { value: 'fable', label: 'Fable (latest): hardest problems' },
    { value: 'claude-fable-5-2', label: 'Fable 5.2 (pinned)' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5 (pinned)' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (pinned)' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5 (pinned)' }
  ],
  codex: [],
  gemini: [],
  grok: [{ value: 'grok-4.7', label: 'Grok 4.7 (latest)' }]
}

/** What the select shows for a stored model: '' (default), a preset's value, or 'custom'. */
export function modelChoice(engine: AgentEngine, model: string | undefined): string {
  if (!model) return ''
  return MODEL_PRESETS[engine].some((p) => p.value === model) ? model : 'custom'
}
