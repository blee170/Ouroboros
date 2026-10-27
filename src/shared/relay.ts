/**
 * Context relay ("fresh start"): a Claude card whose conversation has grown large is asked for a handoff note while
 * it is idle, its conversation is cleared (/clear), and the note comes back as the first prompt of the new one.
 * Pure rules here; the steps run in main/relay.ts.
 */

export type RelayMode = 'auto' | 'ask' | 'off'

export const RELAY_DEFAULTS = { tokens: 250_000, conductor: 'ask' as RelayMode, workers: 'auto' as RelayMode }
/** a conversation never runs past this share of its window before it relays, whatever the token setting says */
export const RELAY_WINDOW_SHARE = 0.6
/** at most this many fresh starts per card in RELAY_CHAIN_MS */
export const RELAY_CHAIN_MAX = 3
export const RELAY_CHAIN_MS = 12 * 60 * 60_000
/** a card idle for less than this may just be between a reply and the next prompt */
export const RELAY_IDLE_MS = 2 * 60_000
/** a note shorter than this is not a handoff: the relay stops and the conversation is kept */
export const RELAY_NOTE_MIN = 300
/** the owner is asked again about a card they did not say yes to after this long */
export const RELAY_ASK_AGAIN_MS = 6 * 60 * 60_000

export interface RelayCard {
  id: string
  kind: string
  engine?: string
  status: string
  /** when its last turn ended */
  lastStopAt?: number
  contextTokens?: number
  contextWindow?: number
  /** a question, approval or permission prompt is open for it */
  pending: boolean
}

export interface RelaySettings {
  tokens: number
  conductor: RelayMode
  workers: RelayMode
}

export function relaySettings(s: { relayTokens?: number; relayConductor?: RelayMode; relayWorkers?: RelayMode }): RelaySettings {
  const mode = (m: unknown, d: RelayMode): RelayMode => (m === 'auto' || m === 'ask' || m === 'off' ? m : d)
  const tokens = typeof s.relayTokens === 'number' && Number.isFinite(s.relayTokens) && s.relayTokens >= 50_000 ? s.relayTokens : RELAY_DEFAULTS.tokens
  return { tokens, conductor: mode(s.relayConductor, RELAY_DEFAULTS.conductor), workers: mode(s.relayWorkers, RELAY_DEFAULTS.workers) }
}

/** The context size at which a card relays: the setting, but never past RELAY_WINDOW_SHARE of its window. */
export function relayThreshold(tokens: number, contextWindow: number | undefined): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 200_000
  return Math.min(tokens, Math.floor(window * RELAY_WINDOW_SHARE))
}

/** Fresh starts of one card still inside the chain window. */
export function recentRelays(history: number[] | undefined, now: number): number[] {
  return (history ?? []).filter((t) => now - t < RELAY_CHAIN_MS)
}

/** What to do with a card now: relay it, ask the owner first, or nothing. */
export function relayDecision(c: RelayCard, settings: RelaySettings, history: number[] | undefined, now: number): 'auto' | 'ask' | null {
  if ((c.engine ?? 'claude') !== 'claude') return null
  if (c.kind !== 'claude' && c.kind !== 'conductor') return null
  const mode = c.kind === 'conductor' ? settings.conductor : settings.workers
  if (mode === 'off') return null
  if (c.status !== 'idle' && c.status !== 'done') return null
  if (c.pending) return null
  if (!c.lastStopAt || now - c.lastStopAt < RELAY_IDLE_MS) return null
  if (typeof c.contextTokens !== 'number' || c.contextTokens < relayThreshold(settings.tokens, c.contextWindow)) return null
  if (recentRelays(history, now).length >= RELAY_CHAIN_MAX) return null
  return mode
}

/** Whether a reply is a usable handoff note. */
export function noteUsable(note: string | undefined): boolean {
  return typeof note === 'string' && note.trim().length >= RELAY_NOTE_MIN
}

/** starts the note prompt: the board arms its Stop capture on the UserPromptSubmit that carries it */
export const NOTE_MARKER = '[Ouroboros fresh start: handoff note]'

export const NOTE_PROMPT = [
  NOTE_MARKER + ' Your conversation is getting long. It will be cleared, and you will continue in a new one from a note you write now.',
  'Reply with the handoff note only, no tool calls. Cover:',
  '- your role and who you report to;',
  '- what you are working on, and the task ids you own (they stay in task_list);',
  '- decisions made and why, and what the owner told you that still holds;',
  '- open questions, things you are waiting on, and cards you are watching;',
  '- the files, branches and commands that matter;',
  '- your next steps, in order.',
  'Write it for yourself, in full sentences, as long as it needs to be.'
].join('\n')

/** The first prompt of the new conversation. */
export function resumePrompt(note: string, title: string): string {
  return [
    `[Ouroboros fresh start] You are the card "${title}". Your previous conversation was cleared to keep the context small. Below is the handoff note you wrote for yourself just before.`,
    'Check check_inbox for mail and, if you have the task tools, task_list for your tasks; then carry on from the note. Your role and your tools are unchanged.',
    '',
    '--- handoff note ---',
    note.trim(),
    '--- end of note ---'
  ].join('\n')
}

export function relayQuestion(title: string, tokens: number): string {
  return `${title} has ${Math.round(tokens / 1000)}k tokens of conversation. Start it fresh from a handoff note it writes now? (Its tasks and board stay; only the conversation is cleared.)`
}
export const RELAY_YES = 'Fresh start'
export const RELAY_NO = 'Not now'
