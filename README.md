# Ouroboros

Personal infinite-canvas cockpit for running and **conducting** many Claude Code sessions on Windows — a Symvibe-style board, built for one user. Single window, no stray consoles.

- **Cards** = real PTY terminals (PowerShell / cmd / Git Bash / WSL / any shell) or Claude Code sessions, placed on an infinite canvas.
- **Status map**: every Claude card reports *Working / Needs you / Done* in real time through Claude Code's HTTP hooks (auto-injected via `--settings`), with Windows toast when an agent needs you.
- **Lines that do something**: drag from a card's right port to another's left port. When the source finishes a response (`Stop` hook), the rendered template is pasted into the target — automatically, or with the ▶ button. Conditions and rate limits included.
- **Conductor**: a Claude card with an internal MCP server (`list_agents`, `read_output`, `send_prompt`, `create_agent`, `set_note`, `connect_agents` / `list_handoffs` / `fire_handoff` / `remove_handoff`). Talk to one card; it reads the board, dispatches to the others and can wire the lines itself.
- **✨ Build board**: scans a root folder and your Claude Code history (`~/.claude/projects`), then generates a board — Conductor (continuing that folder's latest conversation), Implementer / Tester / Reviewer / Ops role cards with role prompts, handoff lines between them, and cards resuming other folders' latest sessions.
- **🌐 Browser cards**: a real Chromium view *inside the canvas* (shared persistent profile, so you log in once). Agents drive it through MCP tools (`browser_open/navigate/read/links/click/type/screenshot`); the Conductor has them, and any Claude card can enable *Board & browser tools* in the Inspector. This is the in-canvas alternative to external AI browsers like Aside, whose windows cannot be embedded.
- **Browser & other tools per card**: Inspector → *MCP servers* → one-click presets for **Aside** (`aside mcp`), **ego lite** and **Playwright MCP**, or any custom server; the card's `claude` gets them via `--mcp-config`.
- **★ Bookmarks**: browser cards list your Chrome/Edge bookmarks (read from the profile's `Bookmarks` file; logins cannot be imported, sign in once in the card). Agents get `browser_bookmarks`.
- **🧹 Tidy**: close cards whose process exited or that have been done/idle for N minutes (dialog with a checklist, optional auto-tidy, and a `tidy_board` tool for the Conductor). Conductors, working and waiting cards are never touched.
- **Roster + broadcast**, git **worktree per card**, workspace saved to `<project>/.ouroboros.json`, external Claude Code sessions (e.g. the Windows Claude app's Code tab) shown as cards and pullable into the canvas via `--resume`.

## Install as a normal program (Windows)

Build once, then launch from the desktop/Start menu icon — no terminal needed afterwards:

```powershell
cd C:\Users\<you>\Ouroboros
npm run dist:win            # ~2–5 min; produces release\Ouroboros-Setup-<version>.exe and release\Ouroboros-<version>-portable.exe
```

- **Installer** (`Ouroboros-Setup-<version>.exe`): installs per user (no admin), creates a desktop and Start-menu shortcut, launches when done.
- **Portable** (`Ouroboros-<version>-portable.exe`): a single exe you can keep anywhere and pin to the taskbar.
- The build is unsigned, so the first launch shows SmartScreen: click *More info → Run anyway* once.
- `Ouroboros.exe <folder>` opens that project directly (handy as a shortcut target).
- **Several windows**: one window = one project folder. Open another folder with 📁 while a project is open (or ⧉, or `Ouroboros.exe <folder>`) and it gets its own window and board; a Conductor only sees and creates cards in its own window. Closing a window ends its cards; the last window hides to the tray if that option is on.
- **Changes**: cards show `+n −m` for uncommitted changes in their folder/worktree; the Inspector lists files, shows diffs, reverts a file and can ask the card to review its own diff. The Conductor has `get_changes` to review a worker's result before accepting it.
- **Context meter**: Claude cards show how full their context window is (from the session transcript); orange past 70% means "ask it to /compact".
- **Roster** groups cards like Claude Code's Agent View (Needs you / Ready to review / Working / Idle / Ended). Ctrl+1…9 jumps to a card, Ctrl+F finds one by title.
- **Codex and Gemini cards**: right-click → Codex agent / Gemini agent (or Inspector → Engine, or `create_agent engine=codex|gemini`). They get the same status, lines, reports and board tools: Codex through its `notify` command and `-c` overrides (needs Node.js on PATH), Gemini through hooks + MCP in a per-card settings file (your own `~/.gemini` settings are untouched). A Conductor can be any engine. Each engine uses your own sign-in and plan.
- **Team leads**: the Conductor can give a card the board tools (`create_agent board_tools=true` or `set_board_tools`) so it runs its own sub-cards and lines.
- **Feedback screenshots**: paste an image (Ctrl+V) or drop files onto a card's terminal and the file path is typed into the prompt, so a Claude card can look at it.
- **Updating**: Settings (⚙) → *Check for updates* downloads the latest GitHub Release and installs it on restart. Releases are built automatically by GitHub Actions when a `v*` tag is pushed. Because the repository is private, paste a fine-grained GitHub token (Contents: read on `blee170/Ouroboros`) into Settings once; it is stored encrypted.
- Without a token (or to build locally), `git pull && npm run dist:win` and re-run the installer still works.

## Run from source (Windows)

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
4. Put a **Conductor** card in the middle and give it the goal; it uses the MCP tools to delegate and report back. Or press **✨ Build board** to generate Conductor + role cards + lines from an existing project folder.
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
