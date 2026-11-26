/**
 * Is an agent card's shell back on its own prompt? A CLI that exits (killed, out of memory) leaves the card's shell
 * running, and a prompt typed there runs as a command. Read from the card's terminal output: the last line, escape
 * sequences removed, is PowerShell's bare prompt, or more output came after such a prompt (mouse reports from a terminal
 * left in mouse-tracking mode, a paste). A line is what follows a newline or a cursor move to column 1 (a CLI's /exit
 * can leave the prompt there with no newline); a cursor move forward is blank cells (a TUI draws spaces that way). A
 * move to any other column starts nothing: a TUI row drawn there stays glued to what came before it. Only PowerShell's
 * default prompt on a drive path (powershell.exe and pwsh, the shells cards run on Windows); cmd, bash, the other shells
 * and a prompt a profile rewrites (oh-my-posh, starship) are not recognised, so those cards are typed into as before.
 * Pure.
 *
 * No clock, and the trade for that: a TUI frame that a chunk boundary cuts right after a row that looks like the prompt
 * latches on its next chunk. No such frame has been recorded; the TUI's next chunk with the ready text and no prompt
 * line, or any report from the CLI (a hook, an inbox), clears it.
 */
import { detectClaudeReady } from './status'

const TAIL_CAP = 2000

export interface ShellWatch {
  /** the card's latest output */
  tail: string
  /** the tail ends on the bare prompt */
  bare: boolean
  /** output came after a bare prompt: the shell is back even if what follows hides the prompt (mouse reports, a paste) */
  back: boolean
}

export function newShellWatch(): ShellWatch {
  return { tail: '', bare: false, back: false }
}

// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
/** a cursor move to column 1 (ESC[H, ESC[<row>H, ESC[<row>;1H, and the same with f) */
// eslint-disable-next-line no-control-regex
const LINE_START = /\u001b\[\d*(?:;1?)?[Hf]/g
/** a cursor move forward (ESC[<n>C) */
// eslint-disable-next-line no-control-regex
const FORWARD = /\u001b\[(\d*)C/g
const FORWARD_CAP = 200
/** PowerShell's prompt, alone on its line (an environment prefix such as "(venv) " allowed) */
const PS_PROMPT = /^(?:\([^)\n]{1,40}\) )?PS [A-Za-z]:\\[^>\n]{0,260}>$/
/** a line that begins with PowerShell's prompt, whatever follows it */
const PS_PROMPT_LINE = /(?:^|[\r\n])(?:\([^)\n]{1,40}\) )?PS [A-Za-z]:\\[^>\r\n]{0,260}>/

/** Terminal output as the text it shows: lines that cursor moves to column 1 start, blanks that cursor moves skip. */
function asText(output: string): string {
  return output
    .replace(OSC, '')
    .replace(LINE_START, '\n')
    .replace(FORWARD, (_, n: string) => ' '.repeat(Math.min(Number(n) || 1, FORWARD_CAP)))
    .replace(CSI, '')
}

/** The output ends on PowerShell's bare prompt. A TUI line that only looks like one is glued to the row before it. */
export function endsAtBarePrompt(output: string): boolean {
  const clean = asText(output).trimEnd()
  const last = clean.split('\n').pop()?.replace(/\r/g, '') ?? ''
  return PS_PROMPT.test(last)
}

function hasPromptLine(chunk: string): boolean {
  return PS_PROMPT_LINE.test(asText(chunk))
}

export function feedShellWatch(w: ShellWatch, chunk: string): void {
  if (detectClaudeReady(asText(chunk)) && !hasPromptLine(chunk)) {
    // the CLI drew itself: what stood before no longer counts. Not when the chunk also has a line that begins with the
    // shell's prompt: that is a terminal repainted after a resize, showing a dead CLI's last frame with the prompt under it
    w.tail = ''
    w.bare = false
    w.back = false
  } else if (w.bare) {
    // more output after a bare prompt was typed at the shell or printed by it: the shell is back even though it hides the prompt
    w.back = true
  }
  w.tail = (w.tail + chunk).slice(-TAIL_CAP)
  w.bare = endsAtBarePrompt(w.tail)
}

export function shellIsBack(w: ShellWatch | undefined): boolean {
  return Boolean(w && (w.back || w.bare))
}

/** The card's CLI reported (a hook, an inbox): a latch read from its output was wrong. What the terminal shows now still counts, a report can land after its CLI has gone. */
export function cliReported(w: ShellWatch | undefined): void {
  if (w) w.back = false
}
