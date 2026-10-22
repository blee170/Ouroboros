# Ouroboros

> **I built this for myself, to work faster and with less friction.**
> I am not a developer by trade and have no computer-science background. I am a vibe coder: I build by talking to AI.
> It started when I saw the [Symvibe](https://www.symvibe.com/) website and wanted that kind of board on Windows.
> It grew piece by piece with Claude Code until it became what you see here.
> I am publishing it as-is in case someone else finds it useful. I cannot promise polish or support, but it installs and works today.

**An infinite-canvas cockpit for running and conducting many AI coding agents at once, on Windows, with your own Claude Code / OpenAI Codex CLI / Gemini CLI sign-ins.**

- Ouroboros never calls a model API itself. It launches the CLIs you already pay for (`claude`, `codex`, `gemini`) inside real terminals on the board and listens to their lifecycle hooks. Each engine bills your own plan, and nothing leaves your machine except what those CLIs send to their own providers.
- No accounts, no telemetry. The local server listens on 127.0.0.1 only.

## What it does

| | |
|---|---|
| **Cards** | Real terminals (PowerShell, cmd, Git Bash, WSL) or agent sessions on an infinite canvas. Minimap, Ctrl+1…9 to jump to a card, Ctrl+F to find one. |
| **Status** | Every card shows Starting / Idle / **Working** / **Needs you** / **Done** / Ended, driven by the CLI's own hooks. A desktop toast and a flashing taskbar when a card needs a human. |
| **Lines** | Drag from one card's port to another. When the source finishes a reply, a template is typed into the target, automatically or with ▶. Conditions (`PASS`, `SCORE: 9/10`, `/regex/`), cooldown and a fire budget keep loops safe. |
| **Conductor** | A card that holds the board itself as tools: `list_agents`, `create_agent`, `connect_agents`, `send_prompt`, `wait_for_agents`, `get_changes`, `tidy_board`, `browser_*` and more. Give it the goal; it creates the cards and lines it needs, runs plan → review → implement → score → bug hunt → deploy guide, and reports in five lines. Deploys, destructive git and spending money are proposed, never done, until you reply `APPROVED BY OWNER`. |
| **Engines** | Each card runs Claude Code (default), OpenAI Codex CLI or Gemini CLI. All three get the same status, lines, reports and board tools. |
| **Changes** | Each card shows `+n −m` for its uncommitted git changes, with per-file diffs, revert, and "ask the card to review its own diff". |
| **Context meter** | Claude cards show how full their context window is (orange past 70 %). |
| **Browser cards** | Chromium inside the canvas with a persistent profile (sign in once). Agents drive it through `browser_*` tools. ★ Chrome/Edge bookmarks, ↗ to open in your system browser. |
| **Command cards** | Any CLI as a card (`aside exec {{prompt}}`, `codex exec {{prompt}}` …). Its output is its reply, so lines work the same. |
| **And** | A git worktree per card, several windows (one project per window), a roster grouped by Needs you / Ready / Working with broadcast, 🧹 Tidy, paste a screenshot into a card and its path is typed in, ✨ Build board (generates a board from your folder and Claude Code history), in-app updates. |

## How it works, briefly

1. Each card runs its CLI in a real PTY terminal. Claude gets its hooks through `--settings`, Codex through its `notify` command, Gemini through hooks in a per-card settings file. Your global CLI settings are never modified.
2. Hook events arrive at `127.0.0.1:47821/hook/<cardId>` and update the card's status. On `Stop` (reply finished), every line leaving that card renders its template and pastes it into the target card.
3. The Conductor controls the board through an MCP server the app starts for it (`mcp-server.js`). Every card the Conductor creates gets an automatic report line back, so results land in the Conductor's input without polling.
4. The board is saved to `<project>/.ouroboros.json` automatically.

The full architecture, per-engine configuration and security notes are further down in this README and in `docs/RESEARCH.md`.

## Install (Windows 10/11, x64)

1. Download `Ouroboros-Setup-<version>.exe` (per-user installer, no admin) or `Ouroboros-<version>-portable.exe` from [Releases](https://github.com/blee170/Ouroboros/releases).
2. The build is unsigned, so SmartScreen asks once: *More info → Run anyway*.
3. Prerequisites: Git for Windows, and the CLIs you want to run, signed in: `claude`, optionally `codex` (needs Node.js on PATH) and `gemini`.
4. Later versions arrive through ⚙ → *Check for updates* inside the app.

## Basic use

1. Open a project folder. Right-click the canvas to add cards (Claude / Codex / Gemini / Conductor / Terminal / Browser / Command / Note).
2. Drag from a card's right port to another card's left port to draw a line. Set auto/manual, condition and template in the Inspector.
3. Tell the Conductor the goal and let it set up and run the rest. Handle "Needs you" in the roster first, and review results through each card's `+n −m` badge.

## Build from source

```powershell
git clone https://github.com/blee170/Ouroboros.git
cd Ouroboros
npm install
npm run dev          # development
npm run dist:win     # release\Ouroboros-Setup-<version>.exe
```

Node 22+ and Git are all you need (no compiler).

## Limitations

Windows only (Linux builds exist for the automated tests; macOS is untested). Binaries are unsigned. Codex sends no "waiting for approval" signal, so its readiness is inferred from output. Not yet: checkpoints, Discord/Telegram bot cards, scheduled runs.

## License

MIT. Use it, change it, share it. It was made for one person's workflow, so issue responses may be slow.
