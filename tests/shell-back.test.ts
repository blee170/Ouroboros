import { describe, expect, it } from 'vitest'
import { SHELL_QUIET_MS, endsAtBarePrompt, feedShellWatch, shellIsBack, type ShellWatch } from '@shared/shell-back'

// Real output of one card (node-pty + powershell.exe + a real claude, Claude Code then killed with taskkill), stage by stage
/** 1. the shell up, nothing launched (a window-title sequence glued after the prompt) */
const SHELL_UP = "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b>\u001b[1C\u001b]0;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h"
/** 2. Claude Code's TUI, idle */
const TUI_IDLE = "─────────────────────────────────────────\u001b[m  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← for agents\u001b[K\u001b[28;3H\u001b[?25h\u001b[m\u001b[?25l\u001b[38;2;153;153;153m\u001b[30;44H1 agent\u001b[K\u001b[28;3H\u001b[?25h\u001b[>0q\u001b[?u\u001b[m"
/** 3. the TUI alive, with "PS C:\fake> looks like a prompt" typed into its input (not submitted) */
const TUI_TYPED = "\u001b[?25lPS C:\\fake> looks like\u001b[1Ca\u001b[1Cprompt\u001b[30;39H\u001b[K\u001b[28;34H\u001b[?25h"
/** 4. Claude Code killed: its last frame, then the shell's bare prompt */
const CLI_KILLED = "\u001b[?25l\u001b[2m\u001b[28;3HTry \"fix lint errors\"\u001b[22m\u001b[K\u001b[38;2;153;153;153m\u001b[30;39H · ← 1 agent\u001b[28;3H\u001b[?25h\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> "
/** 5. mouse reports reaching the shell (the terminal was left in mouse-tracking mode) */
const MOUSE = "\u001b[?25l\u001b[91m\u001b[29;71H> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[97m7\u001b[m\r\n\u001b[17X\u001b[29;95H\u001b[?25h\u001b[?25l\u001b[93m\u001b[29;73H[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[?25h"
/** 6. a report pasted into the shell, with an open quote, plus Enter */
const PASTED = "[worker \u001b[37mfinished] fixed `F1` on \u001b[36m\"bundle/13[\u001b[37m\r\n>>\u001b[15X\u001b[1C"
/** 7. Ctrl+C */
const CTRL_C = "\u001b[m\u001b[91m^C\r\u001b[m\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b>\u001b[1C"

const watch = (): ShellWatch => ({ tail: '', back: false })

describe('endsAtBarePrompt', () => {
  it("is true when the output ends on PowerShell's own prompt, and only then", () => {
    expect(endsAtBarePrompt(SHELL_UP)).toBe(true)
    expect(endsAtBarePrompt(TUI_IDLE)).toBe(false)
    expect(endsAtBarePrompt(TUI_IDLE + TUI_TYPED)).toBe(false) // glued to the TUI row before it: not a line of its own
    expect(endsAtBarePrompt(TUI_IDLE + TUI_TYPED + CLI_KILLED)).toBe(true)
    expect(endsAtBarePrompt(TUI_IDLE + CLI_KILLED + MOUSE)).toBe(false)
    expect(endsAtBarePrompt(TUI_IDLE + CLI_KILLED + MOUSE + PASTED)).toBe(false)
    expect(endsAtBarePrompt(TUI_IDLE + CLI_KILLED + MOUSE + PASTED + CTRL_C)).toBe(true)
  })

  it('takes an environment prefix, and not a command typed after the prompt', () => {
    expect(endsAtBarePrompt('\r\n(venv) PS D:\\work\\app> ')).toBe(true)
    expect(endsAtBarePrompt('\r\nPS D:\\work\\app> dir')).toBe(false)
    expect(endsAtBarePrompt('\r\n$ ')).toBe(false)
  })
})

describe('the shell watch', () => {
  it('a card whose CLI runs is not back; once the CLI is killed it is, through mouse reports, a paste and Ctrl+C', () => {
    const w = watch()
    feedShellWatch(w, TUI_IDLE, 0)
    expect(shellIsBack(w)).toBe(false)
    feedShellWatch(w, TUI_TYPED, 1_000)
    expect(shellIsBack(w)).toBe(false)
    feedShellWatch(w, CLI_KILLED, 2_000)
    expect(shellIsBack(w)).toBe(true)
    // minutes later the owner moves the mouse over the card: the last line is no longer the prompt
    feedShellWatch(w, MOUSE, 120_000)
    expect(shellIsBack(w)).toBe(true)
    feedShellWatch(w, PASTED, 240_000)
    expect(shellIsBack(w)).toBe(true)
    feedShellWatch(w, CTRL_C, 241_000)
    expect(shellIsBack(w)).toBe(true)
  })

  it('a shell with nothing launched in it is back', () => {
    const w = watch()
    feedShellWatch(w, SHELL_UP, 0)
    expect(shellIsBack(w)).toBe(true)
  })

  it('a TUI frame cut by a chunk boundary right after a line that looks like the prompt is not the shell', () => {
    // the frame shows a PowerShell session's text; the chunk ends on that line, the rest of the frame follows
    const head = TUI_IDLE + '\u001b[12;3H\r\nPS C:\\work>'
    const rest = '\u001b[30;3H\u001b[38;2;153;153;153m? for shortcuts\u001b[K\u001b[28;3H\u001b[?25h'
    const w = watch()
    feedShellWatch(w, head, 0)
    feedShellWatch(w, rest, 50)
    expect(shellIsBack(w)).toBe(false)
    // the same prompt standing alone longer than that: what follows it was typed at the shell
    const slow = watch()
    feedShellWatch(slow, head, 0)
    feedShellWatch(slow, rest, SHELL_QUIET_MS + 100)
    expect(shellIsBack(slow)).toBe(true)
  })

  it('no watch is not back', () => {
    expect(shellIsBack(undefined)).toBe(false)
  })
})
