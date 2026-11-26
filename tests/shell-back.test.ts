import { describe, expect, it } from 'vitest'
import { cliReported, endsAtBarePrompt, feedShellWatch, newShellWatch, shellIsBack, type ShellWatch } from '@shared/shell-back'

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

/**
 * Another recorded session, chunk by chunk as node-pty gave them (node-pty, powershell.exe, a real Claude Code 2.1.332,
 * killed with taskkill; the keys are the chunks' numbers in the recording). The card is resized as a reattached card
 * resizes itself (a column less and back), which makes the terminal repaint its screen.
 */
const LIVE2: Record<number, string> = {
  /** the TUI's first frame (the ready text, no prompt line) */
  9: "\u001b[?25l\u001b[H\u001b[K\u001b[38;2;215;119;87m\r\n ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude Code\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort  \u001b[38;2;136;136;136m\r\n────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← for agents\u001b[K\u001b[28;3H\u001b[?25h",
  /** the live TUI repainted by a resize */
  15: "\u001b[?25l\u001b[8;30;99t\u001b[H\u001b[K\u001b[38;2;215;119;87m\r\n ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude Code\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort \u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← 1 agent\u001b[K\u001b[28;3H\u001b[?25h",
  /** the same resize, the next frame */
  19: "\u001b[H\u001b[K\u001b[38;2;215;119;87m\r\n ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude Code\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[79X\u001b[38;2;153;153;153m\u001b[79C◐ medium · /effort  \u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← 1 agent\u001b[K\u001b[28;3H\u001b[?25h",
  /** Claude Code killed */
  24: "\u001b[m",
  /** the shell's prompt */
  25: "\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> ",
  /** mouse reports 346 ms later (the terminal was left in mouse-tracking mode): the prompt row is never bare again */
  26: "\u001b[?25l\u001b[91m\u001b[29;71H> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m1\u001b[m\r\n\u001b[17X\u001b[29;91H\u001b[?25h",
  27: "\u001b[?25l\u001b[93m\u001b[29;73H[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[?25h",
  /** ten seconds later, more of them */
  28: "\u001b[?25l\u001b[m\u001b[29;73H\u001b[?25h",
  29: "\u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[\u001b[90C",
  30: "\u001b[?25l\u001b[m\r\n\u001b[93m\u001b[28;73H[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[m\r\n\u001b[29;21H\u001b[?25h",
  /** a resize: the dead frame repainted (banner, "Try ..."), the prompt row with the reports and the dead footer's remains on it */
  31: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude Code\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort \u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[38;2;153;153;153mhift+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\n\u001b[K\u001b[29;21H\u001b[?25h",
  /** the next repaint chunk */
  32: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude Code\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort  \u001b[38;2;136;136;136m\r\n─────────────────────────────────────────────────────────────────────────────────────────────────── \u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55 \u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[38;2;153;153;153mhift+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\n\u001b[K\u001b[29;21H\u001b[?25h",
  /** Ctrl+C: a fresh bare prompt */
  33: "\u001b[?25l\u001b[28;73H\u001b[?25h",
  34: "\u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> ",
  /** mouse reports 2.5 s later */
  35: "\u001b[?25l\u001b[91m\u001b[30;71H> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[\u001b[14C\u001b[?25h",
  36: "\u001b[?25l\u001b[m\r\n\u001b[93m\u001b[29;73H[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[m\r\n\u001b[29;97H\u001b[?25h",
  /** a resize again: the dead frame repainted with two prompt rows */
  37: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort \u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[38;2;153;153;153mft+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M   \u001b[m\r\n\u001b[K\u001b[29;97H\u001b[?25h",
  38: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort  \u001b[38;2;136;136;136m\r\n─────────────────────────────────────────────────────────────────────────────────────────────────── \u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55 \u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[38;2;153;153;153mft+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M    \u001b[m\r\n\u001b[K\u001b[29;97H\u001b[?25h",
  /** Ctrl+C */
  39: "\u001b[?25l\u001b[29;73H\u001b[?25h",
  40: "\u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> ",
  /** the owner types the claude command at the prompt */
  41: "\u001b[93mc",
  42: "\u001b[?25l\u001b[m\u001b[91m\u001b[30;71H> \u001b[93mclaude \u001b[90m--model \u001b[37mhaiku \u001b[90m--stric\u001b[?25h\u001b[m\r\n\u001b[90m\u001b[29;100Hct-mcp-config --mcp-config \u001b[36m\"C:/Users/piz91/AppData/Local/Temp/claude/6691116e51c561ac/327634f0-cdcc-4",
  43: "\u001b[m\r\n\u001b[93m\u001b[28;73Hclaude \u001b[90m--model \u001b[37mhaiku \u001b[90m--strict-mcp-config --mcp-config \u001b[36m\"C:/Users/piz91/AppData/Local/Temp/claude/6691116e51c561ac/327634f0-cdcc-43f5-9a91-4605b889fbfe/scratchpad/empty-mcp.json",
  44: "\u001b[?25l\u001b[m\u001b[28;71H> \u001b[93mclaude \u001b[90m--model \u001b[37mhaiku \u001b[90m--strict-mcp-config --mcp-config \u001b[36m\"C:/Users/piz91/AppData/Local/Temp/claude/6691116e51c561ac/327634f0-cdcc-43f5-9a91-4605b889fbfe/scratchpad/empty-mcp.json\"\u001b[?25h",
  45: "\u001b[m\r\n",
  46: "Claude Code's fullscreen renderer didn't finish starting last time on this machine, so this launch i\r\n\u001b[29;100His using the classic renderer. It will try fullscreen again next launch; /tui classic keeps the class\r\n\u001b[29;100Hsic renderer.\r\n",
  47: "\u001b[?25l",
  48: "\u001b[?2004h\u001b[?2031h\u001b[?1004h",
  /** the new TUI's first frame (the ready text, no prompt line) */
  49: "\u001b[38;2;215;119;87m ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m\u001b[1m\u001b[3CClaude\u001b[1CCode\u001b[38;2;153;153;153m\u001b[22m\u001b[1Cv2.1.332\u001b[m\r\n\u001b[38;2;215;119;87m▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[65C\u001b[m\r\n\u001b[38;2;215;119;87m ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[35C\u001b[m\r\n\u001b[100C\r\n\u001b[100C\r\n\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m\r\n❯ \u001b[2mTry\u001b[22m \u001b[2m\"write\u001b[22m \u001b[2ma\u001b[22m \u001b[2mtest\u001b[22m \u001b[2mfor\u001b[22m \u001b[2m<filepath>\"\u001b[22m\u001b[K\u001b[65C\r\n\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m\r\n  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← for agents                           ◐ medium · /effort  \u001b[m\r\n\u001b[27;3H\u001b[?25h",
  50: "\u001b[?25l\u001b[38;2;153;153;153m\u001b[29;44H1 agent   \u001b[27;3H\u001b[?25h",
  51: "\u001b[>0q",
  52: "\u001b[?u",
  53: "\u001b[m",
  /** that live TUI repainted by a resize, the old prompt rows above it (the ready text and a prompt line) */
  54: "\u001b[?25l\u001b[H\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[80X\u001b[38;2;153;153;153m\u001b[80C◐ medium · /effort \u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m❯ \u001b[2mTry \"fix lint errors\"\u001b[22m\u001b[K\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M[55\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C\u001b[38;2;153;153;153mft+tab to cycle) · ← 1 agent\u001b[K\u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[91m> \u001b[93m[555\u001b[37m;\u001b[97m136\u001b[37m;\u001b[93m72M[555\u001b[37m;\u001b[97m141\u001b[37m;\u001b[93m72M\u001b[91m^C \u001b[m\r\nPS C:\\Users\\piz91\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b> \u001b[93mclaude \u001b[90m--model \u001b[37mhaiku \u001b[90m--strit-mcp-config --mcp-config \u001b[36m\"C:/Users/piz91/AppData/Local/Temp/claude/6691116e51c561ac/327634f0-cdcc-3f5-9a91-4605b889fbfe/scratchpad/empty-mcp.json\"\u001b[K\u001b[m\r\nClaude Code's fullscreen renderer didn't finish starting last time on this machine, so this launch s using the classic renderer. It will try fullscreen again next launch; /tui classic keeps the clasic renderer.\u001b[K\u001b[38;2;215;119;87m\r\n ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude\u001b[22m \u001b[1mCode\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m\r\n❯ \u001b[2mTry\u001b[22m \u001b[2m\"write\u001b[22m \u001b[2ma\u001b[22m \u001b[2mtest\u001b[22m \u001b[2mfor\u001b[22m \u001b[2m<filepath>\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m\r\n  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← 1 agent                              ◐ medium · /effort \u001b[m\r\n\u001b[K\u001b[27;3H\u001b[?25h",
  /** the next repaint chunk */
  55: "\u001b[?25l\u001b[38;2;215;119;87m\u001b[H ▐\u001b[48;2;0;0;0m▛███▛█\u001b[m   \u001b[1mClaude\u001b[22m \u001b[1mCode\u001b[22m \u001b[38;2;153;153;153mv2.1.332\u001b[K\u001b[38;2;215;119;87m\r\n▝▜\u001b[48;2;0;0;0m█████\u001b[49m█▀  \u001b[38;2;153;153;153mHaiku 5.5 · Claude Ultra\u001b[K\u001b[38;2;215;119;87m\r\n ▝▝   ▝▝   \u001b[38;2;153;153;153m~\\Ouroboros\\.claude\\worktrees\\serene-mirzakhani-3e232b\u001b[K\u001b[m\r\n\u001b[K\r\n\u001b[K\u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m\r\n❯ \u001b[2mTry\u001b[22m \u001b[2m\"write\u001b[22m \u001b[2ma\u001b[22m \u001b[2mtest\u001b[22m \u001b[2mfor\u001b[22m \u001b[2m<filepath>\"\u001b[22m\u001b[K\u001b[38;2;136;136;136m\r\n───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m\r\n  \u001b[38;2;255;193;7m⏵⏵ auto mode on \u001b[38;2;153;153;153m(shift+tab to cycle) · ← 1 agent                             ◐ medium · /effort  \u001b[m\r\n                                                                                                   \r\n\u001b[K\r\n                                                                                                   \r\n\u001b[K\r\n\u001b[K\r\n                                                                                                                                                                                                      \r\n\u001b[K\r\n                                                                                                                                                                                                      \r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[7;3H\u001b[?25h",
}

/** Feed recorded chunks one by one: is the shell back after each? */
const after = (w: ShellWatch, ...ids: number[]): boolean[] => ids.map((i) => (feedShellWatch(w, LIVE2[i]), shellIsBack(w)))
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k)
const all = (n: number, v: boolean): boolean[] => Array<boolean>(n).fill(v)

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
    const w = newShellWatch()
    feedShellWatch(w, TUI_IDLE)
    expect(shellIsBack(w)).toBe(false)
    feedShellWatch(w, TUI_TYPED)
    expect(shellIsBack(w)).toBe(false)
    feedShellWatch(w, CLI_KILLED)
    expect(shellIsBack(w)).toBe(true)
    // the owner moves the mouse over the card: the last line is no longer the prompt
    feedShellWatch(w, MOUSE)
    expect(shellIsBack(w)).toBe(true)
    feedShellWatch(w, PASTED)
    expect(shellIsBack(w)).toBe(true)
    feedShellWatch(w, CTRL_C)
    expect(shellIsBack(w)).toBe(true)
  })

  it('reads the end of a long run of output: a CLI that printed a lot before it was killed still leaves its prompt counted', () => {
    const w = newShellWatch()
    feedShellWatch(w, TUI_IDLE)
    // the TUI's status row redrawn through a long turn (no ready text in it), more than the watch keeps
    for (let i = 0; i < 40; i++) feedShellWatch(w, LIVE2[50])
    feedShellWatch(w, CLI_KILLED)
    expect(shellIsBack(w)).toBe(true)
  })

  it('a shell with nothing launched in it is back', () => {
    const w = newShellWatch()
    feedShellWatch(w, SHELL_UP)
    expect(shellIsBack(w)).toBe(true)
  })

  it('a TUI frame cut by a chunk boundary right after a row that looks like the prompt: the next chunk with the ready text and no prompt line says it is not the shell', () => {
    // the frame shows a PowerShell session's text; the chunk ends on that row, the rest of the frame follows
    const head = TUI_IDLE + '\u001b[12;3H\r\nPS C:\\work>'
    const rest = '\u001b[30;3H\u001b[38;2;153;153;153m? for shortcuts\u001b[K\u001b[28;3H\u001b[?25h'
    const w = newShellWatch()
    feedShellWatch(w, head)
    feedShellWatch(w, rest)
    expect(shellIsBack(w)).toBe(false)
    // the trade for having no clock: a rest without the ready text latches (no such frame has been recorded), and the
    // TUI's next chunk with the ready text clears it
    const plain = newShellWatch()
    feedShellWatch(plain, head)
    feedShellWatch(plain, '\u001b[30;44H1 agent\u001b[K\u001b[28;3H\u001b[?25h')
    expect(shellIsBack(plain)).toBe(true)
    feedShellWatch(plain, TUI_IDLE)
    expect(shellIsBack(plain)).toBe(false)
  })

  it('no watch is not back', () => {
    expect(shellIsBack(undefined)).toBe(false)
  })
})

describe('the shell watch over a recorded session', () => {
  it('a live TUI and its repaints after a resize are not the shell', () => {
    expect(after(newShellWatch(), 9, 15, 19)).toEqual(all(3, false))
  })

  it('mouse reports right after the prompt (346 ms) keep it back, and ten seconds later too', () => {
    const w = newShellWatch()
    expect(after(w, 9, 24)).toEqual(all(2, false))
    expect(after(w, ...range(25, 30))).toEqual(all(6, true))
  })

  it('a resize that repaints the dead frame, prompt row and all, leaves it back', () => {
    const w = newShellWatch()
    after(w, 9, ...range(24, 30))
    expect(after(w, 31, 32)).toEqual(all(2, true))
    expect(after(w, ...range(33, 38))).toEqual(all(6, true))
  })

  it('Claude Code started again by hand is not the shell once its first frame is drawn, nor after a resize that repaints the old prompt rows above it', () => {
    const w = newShellWatch()
    after(w, 9, ...range(24, 39))
    // the claude command typed at the prompt is typed at the shell
    expect(after(w, ...range(40, 48))).toEqual(all(9, true))
    expect(after(w, ...range(49, 55))).toEqual(all(7, false))
  })
})

describe('cliReported (a hook, a registered inbox)', () => {
  it('does not take back what the terminal shows: a bare prompt stays back, and output after it latches again', () => {
    const w = newShellWatch()
    feedShellWatch(w, LIVE2[25])
    cliReported(w)
    expect(shellIsBack(w)).toBe(true)
    feedShellWatch(w, LIVE2[26])
    expect(shellIsBack(w)).toBe(true)
  })

  it('clears a latch read from TUI output', () => {
    const w = newShellWatch()
    feedShellWatch(w, TUI_IDLE + '\u001b[12;3H\r\nPS C:\\work>')
    feedShellWatch(w, '\u001b[30;44H1 agent\u001b[K\u001b[28;3H\u001b[?25h')
    expect(shellIsBack(w)).toBe(true)
    cliReported(w)
    expect(shellIsBack(w)).toBe(false)
  })

  it('no watch is fine', () => {
    expect(() => cliReported(undefined)).not.toThrow()
  })
})
