# Ouroboros

Personal infinite-canvas cockpit for running and **conducting** many Claude Code sessions on Windows — a Symvibe-style board, built for one user. Single window, no stray consoles.

- **Cards** = real PTY terminals (PowerShell / cmd / Git Bash / WSL / any shell) or Claude Code sessions, placed on an infinite canvas.
- **Status map**: every Claude card reports *Working / Needs you / Done* in real time through Claude Code's HTTP hooks (auto-injected via `--settings`), with Windows toast when an agent needs you.
- **Lines that do something**: drag from a card's right port to another's left port. When the source finishes a response (`Stop` hook), the rendered template is pasted into the target — automatically, or with the ▶ button. Conditions and rate limits included.
- **Conductor**: a Claude card with an internal MCP server (`list_agents`, `read_output`, `send_prompt`, `create_agent`, `set_note`). Talk to one card; it reads the board and dispatches to the others.
- **Roster + broadcast**, git **worktree per card**, workspace saved to `<project>/.ouroboros.json`, external Claude Code sessions (e.g. the Windows Claude app's Code tab) shown as cards and pullable into the canvas via `--resume`.

## Run (Windows)

Prerequisites: Node 22+, Git for Windows (Claude Code needs Git Bash), Claude Code CLI on `PATH` (`claude`). No compiler is needed: `node-pty` ships prebuilt N-API binaries for win32-x64/arm64.

```powershell
git clone https://github.com/blee170/Ouroboros.git
cd Ouroboros
npm install          # node-pty uses its prebuilt N-API binary; no compiler needed
npm run dev          # development
npm run dist:win     # release\Ouroboros-<version>-x64.exe (portable) + NSIS installer, unsigned
```

`Ouroboros.exe <folder>` (or `OUROBOROS_PROJECT=<folder>`) opens that project on start.

## Daily use

1. Open a project folder. Right-click the canvas → **Claude agent** / **Conductor** / **Terminal** / **Note**.
2. Each Claude card runs `claude --settings <hooks>` in its folder (options in the Inspector: `--continue`, `--resume`, model, permission mode, extra system prompt, worktree).
3. Connect cards to create handoff lines; edit mode/condition/template in the Inspector.
4. Put a **Conductor** card in the middle and give it the goal; it uses the MCP tools to delegate and report back.
5. Settings (⚙): notifications, tray, *track external sessions* (writes an HTTP hook into `~/.claude/settings.json`; requires the default hook port 47821 to be free).

## Development

```bash
npm run typecheck      # main/preload + renderer
npm test               # vitest: status reducer, handoff templating, launcher, store, external hooks, bundled MCP server
npm run build          # electron-vite build -> out/
xvfb-run -a node scripts/smoke.mjs   # Linux end-to-end smoke test (Playwright + Electron)
```

Layout: `src/main` (PTY manager, hook server + JSON API, Claude launcher, handoff runner, worktrees, MCP server), `src/preload` (contextBridge), `src/renderer` (React Flow canvas, xterm cards, panels), `src/shared` (types, pure logic), `tests/`, `docs/RESEARCH.md` (the planning research that led here).

## Out of scope (by decision)

Payments/licensing, code signing, phone/voice companion, cloud relay, non-developer UI, status tracking for non-Claude CLIs (they still run in terminal cards).
