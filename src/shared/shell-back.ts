/**
 * Is an agent card's shell back on its own prompt? A CLI that exits (killed, out of memory) leaves the card's shell
 * running, and a prompt typed there runs as a command. Read from the card's terminal output: the last line, escape
 * sequences removed, is PowerShell's bare prompt. Only PowerShell's default prompt (powershell.exe and pwsh, the shells
 * cards run on Windows); cmd, bash, the other shells and a prompt a profile rewrites (oh-my-posh, starship) are not
 * recognised, so those cards are typed into as before. Pure, no timers.
 */

/** A prompt that stood alone this long before more output came: that output was typed at the shell, not drawn by a TUI. */
export const SHELL_QUIET_MS = 1500
const TAIL_CAP = 2000

export interface ShellWatch {
  /** the card's latest output */
  tail: string
  /** when the output began to end on the bare prompt (unset while it does not) */
  bareAt?: number
  /** the bare prompt stood alone for SHELL_QUIET_MS: the shell is back even if what follows hides it (mouse reports, a paste) */
  back: boolean
}

// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
/** PowerShell's prompt, alone on its line (an environment prefix such as "(venv) " allowed) */
const PS_PROMPT = /^(?:\([^)\n]{1,40}\) )?PS [A-Za-z]:\\[^>\n]{0,260}>$/

/** The output ends on PowerShell's bare prompt. A TUI line that only looks like one is glued to the row before it. */
export function endsAtBarePrompt(output: string): boolean {
  const clean = output.replace(OSC, '').replace(CSI, '').trimEnd()
  const last = clean.split('\n').pop()?.replace(/\r/g, '') ?? ''
  return PS_PROMPT.test(last)
}

export function feedShellWatch(w: ShellWatch, chunk: string, now: number): void {
  if (w.bareAt !== undefined && now - w.bareAt >= SHELL_QUIET_MS) w.back = true
  w.tail = (w.tail + chunk).slice(-TAIL_CAP)
  w.bareAt = endsAtBarePrompt(w.tail) ? (w.bareAt ?? now) : undefined
}

/** At the moment of typing a bare prompt of any age counts: typing into a shell is the worse mistake. */
export function shellIsBack(w: ShellWatch | undefined): boolean {
  return Boolean(w && (w.back || w.bareAt !== undefined))
}
