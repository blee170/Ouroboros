import { toPastePayload } from '@shared/handoff'

/** Type a prompt into a card's terminal: bracketed paste, then Enter once the TUI has taken the paste. */
export function typePrompt(nodeId: string, text: string, enterDelayMs = 150): void {
  const api = window.ouroboros
  api.pty.write(nodeId, toPastePayload(text))
  setTimeout(() => api.pty.write(nodeId, '\r'), enterDelayMs)
}
