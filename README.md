# Ouroboros

> **이 저장소는 제가 더 편하고 효율적으로 일하려고 만든 개인용 시스템입니다.** 저는 개발자 이력이 없고 전공자도 아닌, 그냥 AI와 대화하며 만드는 바이브 코더입니다. [Symvibe](https://www.symvibe.com/) 웹사이트를 보고 "저런 보드가 Windows에도 있으면 좋겠다"는 생각에서 시작해, Claude Code와 함께 하나씩 붙여 가며 지금의 모양이 됐습니다. 혹시 필요한 분이 있을지 몰라 그대로 공개합니다. 완성도나 지원을 보장하지는 못하지만, 설치해서 바로 쓸 수 있는 상태입니다.
>
> **This is a tool I built for myself, to work faster and with less friction.** I am not a developer by trade and have no CS background; I am a vibe coder who builds by talking to AI. It started when I saw the [Symvibe](https://www.symvibe.com/) website and wanted that kind of board on Windows, and it grew piece by piece with Claude Code. I am publishing it as-is in case someone else finds it useful. No promises of polish or support, but it installs and works today.

**An infinite-canvas cockpit for conducting many AI coding agents at once — on Windows, with your own Claude Code / Codex / Gemini sign-ins.**

Every agent is a card on a board. Cards are real terminals. Lines between cards actually carry work: when one agent finishes, its reply is typed into the next one. A **Conductor** card holds the tools to see the whole board, create cards, draw lines and run a pipeline (plan → review → implement → score → bug hunt → deploy guide) while you watch and decide at the gates.

Ouroboros does not call any model API itself. It launches the CLIs you already pay for (`claude`, `codex`, `gemini`) inside the cards and listens to their lifecycle hooks. Nothing leaves your machine except what those CLIs send to their own providers.

> 한국어 요약은 맨 아래 [한국어 안내](#한국어-안내)에 있습니다.

**New here?** [docs/TUTORIAL.md](docs/TUTORIAL.md) walks you from install to a Conductor running a small pipeline in about an hour. What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

---

## Contents

- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
  - [Architecture](#architecture)
  - [Cards and status](#cards-and-status)
  - [Lines (handoffs)](#lines-handoffs)
  - [The Conductor and the board MCP server](#the-conductor-and-the-board-mcp-server)
  - [Engines: Claude Code, Codex, Gemini](#engines-claude-code-codex-gemini)
  - [Windows, workspaces and persistence](#windows-workspaces-and-persistence)
- [Install](#install)
- [Daily use](#daily-use) · first hour: [docs/TUTORIAL.md](docs/TUTORIAL.md)
- [Settings](#settings)
- [Security and privacy](#security-and-privacy)
- [Build from source](#build-from-source)
- [Project layout](#project-layout)
- [Development](#development)
- [Release process](#release-process)
- [Limitations and roadmap](#limitations-and-roadmap)
- [Changelog](CHANGELOG.md)
- [License](#license)
- [한국어 안내](#한국어-안내)

---

## Why

Running three or four coding agents in parallel is easy; **knowing what each one is doing, handing results between them and deciding at the right moments is not.** Existing tools (Conductor, Superset, Claude Code desktop, Symvibe, ccanvas…) give each agent a workspace and a diff view, but you still relay results by hand. Ouroboros makes the relay part of the board:

- a **status map** (Working / Needs you / Done) driven by the CLIs' own hooks, not by scraping output;
- **lines that fire**: templates, conditions (`SCORE: 9/10`, `PASS`, `/regex/`), rate limits;
- a **Conductor agent** with an MCP server that exposes the board itself as tools.

It was built as a personal tool for one developer and is shared as-is. See `docs/RESEARCH.md` for the comparison with other tools and the research behind the design.

## Features

| Area | What you get |
|---|---|
| **Cards** | Real PTY terminals (PowerShell / cmd / Git Bash / WSL / any shell) or agent sessions on an infinite canvas with zoom, minimap, Ctrl+1…9 jumps, Ctrl+J *Jump to…* (type, ↑↓, Enter), Ctrl+Shift+N for the next card that needs you. Terminals redraw sharp at every zoom without resizing the program inside; zoomed far out a card shows its last reply in large type; ↓ jumps back to the latest output. |
| **Status** | Starting / Idle / Working / Needs you / Done / Ended per card, with desktop toasts and taskbar flashing when a card needs a human. |
| **Announcements** | When the Conductor (or, if you choose, any card) finishes a turn of 10 s or more: a toast with the first line of the reply and/or a spoken "<card> finished, please check the report" — with your own voice engine (Gemini TTS, OpenAI or ElevenLabs key, natural Korean and English) or the offline Windows voices. "Needs you" is spoken too ("failed" when the turn ended in an error), and "all cards have finished" once a run of several cards settles. The reply itself is never read out — long reports are on the canvas. The card you are looking at (selected, window focused) gets no toast or voice, and one card gets at most one toast per 5 s. |
| **Voice input** | Claude cards take Claude Code's own dictation: `/voice` (hold Space) or `/voice tap`, Korean included, free with a claude.ai sign-in. `/` in the sidebar composer lists it. |
| **Lines** | Drag port to port. Auto (fires on the source's finished reply) or manual (▶). Template with `{{last_assistant_message}}`, `{{source_title}}`, … Condition as substring or `/regex/`. 8 s cooldown, max 6 fires / 5 min per line. A line flashes when it fires and glows while the card it feeds is working on that handoff. |
| **Conductor** | A card with the board MCP server: `list_agents`, `read_output`, `send_prompt`, `create_agent`, `remove_agent`, `wait_for_agents`, `connect_agents` / `fire_handoff` / `remove_handoff`, `set_note`, `tidy_board`, `get_changes`, `create_checkpoint` / `restore_checkpoint`, `set_board_tools`, `browser_*`. Ships with an operating procedure (intake → setup → run → report), a default pipeline and human gates (`APPROVED BY OWNER`). |
| **Engines** | Each agent card runs **Claude Code** (default), **OpenAI Codex CLI** or **Gemini CLI**. Same status, lines, reports and board tools for all three. |
| **Team leads** | `create_agent board_tools=true` / `set_board_tools` give a worker the same tools so it runs its own sub-cards. |
| **Reports** | Every card the Conductor creates gets an automatic report line back; "needs input" notices are relayed too. |
| **One card per role** | `create_agent` with a title that already exists reuses that card when it is idle or done and replaces it when it has ended, so a Conductor that asks for its "Brief writer" every round does not pile up copies. |
| **Build board** | Scans a root folder and your Claude Code history and generates Conductor + Implementer / Tester / Reviewer / Ops cards, lines and a pipeline note. |
| **Changes** | `+n −m` badge per card (uncommitted git changes in its folder or worktree), per-file diff, revert, "ask the card to review its diff". |
| **Checkpoints** | Git snapshots of a card's folder (every non-gitignored file, committed or not; taking one changes nothing on disk), from the Inspector or the Conductor's `create_checkpoint` before a risky stage. Restore puts the files back and saves a "before restore" snapshot first, so it can be undone. |
| **Context meter** | Claude cards show how full their context window is (read from the session transcript); orange past 70 %. |
| **Browser cards** | Chromium inside the canvas with a shared persistent profile; agents drive it via `browser_*` tools; ★ Chrome/Edge bookmarks; ↗ to the system browser. Briefs (a claude.ai artifact from any card, any URL in a Conductor reply) open in a "📄 Briefs" card on the canvas, also when the writer posted the link in an earlier turn; the 📄 button on the Conductor card and on the card that published it reopens the latest one. |
| **Command cards** | Any CLI as a card (`aside exec {{prompt}}`, `codex exec {{prompt}}` …): its output is its reply, so lines work the same. |
| **Worktrees** | One git worktree + branch per card with one click (or `worktree=true` from the Conductor). |
| **Several windows** | One window = one project folder, each with its own board; Conductors never see another window. |
| **Sidebar** | Every agent card by state, like Claude Code's Agent View (Needs you / Ready to review / Working / Idle / Ended), workers nested under their Conductor, a search row, the project with its counts, Ctrl+1…9 hotkeys on hover; drag the edge to resize (220–500 px). A finished turn is *Done* (green check) only until you look at the card — select it with the window focused — then it reads *Idle*; a result you have not looked at (a finished turn, a question) keeps its row **bold**. Rows move to their new section 3 s after a change, so the list does not jump under the pointer; a working card silent for 2 min says *no update for Nm*. Checkboxes pick the cards the composer at the bottom sends one prompt to. Typing `/` in the composer lists the commands and skills the cards offer (built-ins, `~/.claude`, the project, installed plugins as `plugin:name`); ↑↓ and Tab complete. |
| **Tidy** | Cards a Conductor or team dispatches are retired on their own 5 minutes after their report reaches the card that made them (idle time is only the fallback for cards with no report line; a crashed card waits the same 5 minutes so you can read it); nothing is retired while the card that made it, or a card wired to it, is mid-turn. Cards you made yourself are never closed automatically, and 📌 Keep pins any card. 🧹 Tidy lists what would go (your own cards only when asked); `tidy_board` lets a team close its own workers, never another team's. A lead may have 6 live dispatched cards at once and the chain goes no deeper than Conductor → team → worker — `create_agent` refuses with the reason (`retireMinutes`, `maxWorkersPerLead` in `settings.json`). |
| **Placement** | New cards (yours or the Conductor's) take the first free cell of the grid, never a cell another card covers. ⊞ Arrange lays the board out along its lines: cards nobody feeds on the left, the cards they report to (the Conductor) to their right, and the briefs and notes in a lane beside the Conductor, so lines run left to right; ↶ puts everything back until you move something. |
| **Screenshots in** | Ctrl+V a screenshot into a Claude card and Claude Code attaches it as an `[Image #1]` chip, exactly as in the desktop app (Alt+V does the same). In terminal, command, Codex and Gemini cards the image is saved and its path typed; dropped files are typed as paths everywhere. The sidebar composer takes screenshots and files too (paste or drop; chips under the box) and sends them the same way to every checked card. |
| **External sessions** | Claude Code sessions started elsewhere (e.g. the Claude desktop app) appear as cards in the window of the project they run in (never in another project's window) and can be pulled into the canvas via `--resume`. |
| **Autonomous mode** | The moon in the title bar: the board keeps working while you sleep or are out, and the *app* holds the rails. A preflight sheet shows the end time, the caps and what happens to every live card (Claude cards restart in auto mode on the same conversation; Codex/Gemini cards close). During the run: the PC stays awake; every card launched gets `permissions.deny` rules in both the Bash and the PowerShell tool namespace (git push/merge/rebase/reset --hard/branch -D/clean/force-add, also with options before the subcommand like `git -C x push`; gh pr merge/workflow run/release/api; npm publish, docker push, vercel, wrangler, firebase/netlify/fly deploy, terraform apply, supabase db push/reset, prisma migrate deploy/reset; rm -rf /, ~; editing `.ouroboros.json`, Claude settings or `~/.claude`; the board browser's click and type tools); new cards run in auto mode and only Claude cards can be created; nothing is typed into terminal or command cards, no card answers a parked permission prompt, and a checkpoint restore never moves HEAD; a card that asks a question, needs a permission or fails is **parked** (never answered for you) and the Conductor is briefed to move on; a cap on new cards and on re-making a role; a silent card (no tool running) is nudged, then parked; a card that never comes up in 3 min is parked; a usage limit gets a "continue" every 15 min; the run ends at the deadline (36 h at most), on the stop button of the status-bar pill, or once nothing has worked for 15 min. The **morning report** (waiting on you first, then every card with its branch, uncommitted diff size and last reply, auto-mode denials, stalls, timeline) lands on the canvas as a note and in `%APPDATA%\Ouroboros\autonomy\<project>\`. The deny rules match the command text as typed (`git push`, not an alias, a wrapper script that pushes, `gh api`'s cousins through `curl`, or a nested `bash -c`), Edit rules do not bind shell writes, the owner's own MCP servers (a desktop shell, computer use) stay reachable, and only the auto-mode classifier's denials are reported, not rule denials: a guard against the obvious, not a sandbox, so keep production credentials out of worker folders. |
| **Reply viewer** | A card's last reply, rendered in the Inspector (tables, code, lists): every file or folder path in it opens on click (relative to the card's folder; executables are revealed, not run), *Copy* takes the text, *Pop out* puts the reply on the canvas as a note. Notes render their markdown too (✎ or double-click to edit). |
| **Shell** | Quiet and monochrome, colour only for state (Orca-style, see `docs/RESEARCH.md` §10). A 36 px **title bar**: sidebar toggle, wordmark, project, then *New card* (the button adds the default agent, its arrow lists every kind), Build board, Tidy, Arrange, Autonomous mode, Help, Settings, Inspector toggle, all 24 px ghost icons with tooltips. A 24 px **status bar**: *working / need you / ready / idle* counts (click to jump to the first such card), a *near context limit* chip when a Claude card is past 70 % of its window (click to jump to the fullest), the autonomous-run pill, an update badge, the save state. Cards carry one state glyph: a turning ring (working), an orange ? (needs you), a green check (done). lucide icons throughout; no emoji in the chrome. |
| **Fonts** | Bundled, no install: Pretendard for the UI and D2Coding in the terminals (Hangul exactly two cells wide, so Korean output lines up). |
| **Updates** | ⚙ → *Check for updates* (GitHub Releases, built by Actions). |

## How it works

### Architecture

```
┌──────────────────────────── Electron main process ───────────────────────────────┐
│                                                                                  │
│  PtyManager ── node-pty ──► shell ──► claude / codex / gemini / any CLI           │
│      ▲                                   │ hooks (HTTP)   │ MCP (stdio)          │
│      │ keystrokes, paste                 ▼                ▼                      │
│  HookServer 127.0.0.1:47821  ◄── POST /hook/<cardId>    mcp-server.js            │
│      │  /api/*  (token)      ◄──────────────────────── (one per card, runs       │
│      ▼                                                  with plain node)         │
│  Board (per window): nodes, edges, status, output ring buffers                    │
│      │ events: status / stop / external                                          │
│      ▼                                                                           │
│  Handoff runner: lines, reports, needs-input relay, briefs                        │
│                                                                                  │
└───────────────────────┬──────────────────────────────────────────────────────────┘
                        │ IPC (contextBridge)
┌───────────────────────▼──────────────────────────────────────────────────────────┐
│  Renderer (React + React Flow + xterm.js): canvas, cards, lines, panels           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Main process** owns everything that must survive a re-render: PTYs, the authoritative board state, the local HTTP server, update checks. The renderer is a view that syncs its node/edge list to main and receives pushes (status, output, lines fired).
- **HookServer** is a tiny HTTP server bound to `127.0.0.1`. `POST /hook/<cardId>` receives lifecycle events from the CLI running in that card. `/api/*` is the JSON API the MCP server uses; it requires a per-launch random token (`x-ouroboros-token`) and an `x-ouroboros-self` header naming the calling card, which scopes every call to that card's window.
- **mcp-server.js** is a single-file MCP server bundled from `src/main/mcp-server.ts`. It is started by the agent CLI itself (as a configured MCP server) and talks to the HookServer over HTTP, so the agent gets tools without any plugin install.
- **agent-hook.js** is a single-file bridge that turns Codex and Gemini notifications into the same hook events.

### Cards and status

A Claude card runs:

```
claude --settings <tmp>/<cardId>.settings.json --mcp-config <tmp>/<cardId>.mcp.json \
       --append-system-prompt-file <tmp>/<cardId>.system.md [--continue | --resume <id>] [--model …] [--permission-mode …]
```

The settings file registers HTTP hooks for every lifecycle event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`, …) pointing at `http://127.0.0.1:47821/hook/<cardId>`. A pure reducer (`src/shared/status.ts`) maps events to statuses:

| Event | Status |
|---|---|
| `SessionStart`, idle prompt | Idle |
| `UserPromptSubmit`, `PreToolUse` | Working (with the tool name) |
| `Notification` permission / question | **Needs you** (toast, flashing taskbar, relayed to the Conductor) |
| `Stop` | Done, with the last assistant message |
| `SessionEnd`, PTY exit | Ended |

Because hooks are injected per launch through `--settings`, your global Claude settings are not modified. (Tracking sessions started *outside* Ouroboros is opt-in and writes one hook into `~/.claude/settings.json`.)

### Lines (handoffs)

A line stores `mode` (auto / manual), a `template` and an optional `condition`. On the source card's `Stop`, the handoff runner renders the template with the reply and types it into the target card using bracketed paste followed by Enter, so multi-line text lands as one prompt. Conditions let a pipeline branch: `/SCORE: ([89]|10)\/10/` to proceed, `CHANGES REQUESTED` to loop back. Cooldown and a per-line budget stop runaway loops.

Lines are drawn by hand, generated by **Build board**, or created by the Conductor with `connect_agents`. Every card a Conductor creates also gets a **report line** back to it (`[<card> finished] …`), which is how results reach the Conductor without polling.

### The Conductor and the board MCP server

A Conductor is a Claude (or Codex / Gemini) card launched with the board MCP server and a system prompt (`CONDUCTOR_SYSTEM_PROMPT` in `src/main/claude-launcher.ts`) that explains the tools, how results arrive, the default pipeline and the rules:

- set up first (reuse idle cards, create the missing ones with role prompts and markers, draw lines, write a Pipeline note), then run, then report in five lines;
- markers every worker must end with: `RESULT:`, `SCORE: n/10`, `ISSUES:`, `PASS` / `FAIL`, `APPROVED` / `CHANGES REQUESTED`, `SAFE TO DEPLOY` / `BLOCKED`;
- human gates: production deploys, destructive git, spending money, messages outside the machine — proposed, never done, unless the owner replies `APPROVED BY OWNER`;
- `get_changes` to review a worker's diff before accepting it; `create_checkpoint` before a stage that edits files and `restore_checkpoint` when it fails review (undoable; moving the branch back with `move_head` is a human gate); `tidy_board` to keep the board readable.

Any plain Claude card can get the same tools with *Board & browser tools* in the Inspector; the Conductor can grant them with `set_board_tools` (team leads).

### Engines: Claude Code, Codex, Gemini

| | Claude Code | OpenAI Codex CLI | Gemini CLI |
|---|---|---|---|
| Status | HTTP hooks via `--settings` | `notify` command (turn complete, JSON as last argv) → `agent-hook.js` | hooks (`SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterAgent`, `Notification`, `SessionEnd`) → `agent-hook.js` |
| Board tools | `--mcp-config` | `-c mcp_servers.ouroboros.*` | `mcpServers.ouroboros` |
| Role prompt | `--append-system-prompt-file` | `-c developer_instructions` (posix) / typed first message (Windows) | typed first message |
| Resume | `--continue` / `--resume <id>` | `resume --last` / `resume <thread-id>` | `-r latest` / `-r <uuid>` |
| Permissions | `--permission-mode` | `-s read-only` / `--full-auto` / bypass | `--approval-mode plan\|auto_edit\|yolo` |
| Config footprint | per-card temp files | command line only | per-card settings file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (merged with yours) |

A role prompt typed as a message is treated as a *role turn*: the reply ends Idle and fires no lines, and a queued task prompt waits for it. Codex gives no "needs approval" event, so Codex cards show Working only from prompts Ouroboros sent. Codex cards need Node.js on `PATH`.

### Windows, workspaces and persistence

- One window = one project folder. The board (cards, lines, viewport, per-card options) is saved to `<project>/.ouroboros.json` automatically after every change and on 💾 / Ctrl+S. Add it to `.gitignore` if you do not want it in the repo.
- Per-user settings and the recent-project list live in Electron's `userData` folder (`%APPDATA%\Ouroboros` on Windows). Temporary launch files are under `userData/claude-launch`.
- Runtime output of each card is kept in a 200 KB ring buffer in main (what `read_output` returns), not on disk.

## Setup for ChatGPT or Gemini users

You do not need Claude. Ouroboros runs whichever CLI you are signed in to:

| You have | Install the CLI | Sign in | Then |
|---|---|---|---|
| **ChatGPT** (Plus/Pro/Business) | `npm install -g @openai/codex` (needs [Node.js](https://nodejs.org/)) | `codex login` | pick **Codex** as the default engine |
| **Google / Gemini** | `npm install -g @google/gemini-cli` (needs Node.js) | `gemini` (browser sign-in on first run) | pick **Gemini** |
| **Claude** (Pro/Max) | `irm https://claude.ai/install.ps1 \| iex` | `claude` | pick **Claude** |

The Welcome screen and ⚙ Settings → *Engines* show what is installed and signed in, with copyable commands and an *Open sign-in terminal* button. While `claude` is signed in, Claude cards do not inherit an `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from your environment (Claude Code would prefer that key over the sign-in, and a stale one fails every turn with "Invalid API key"); a key meant for a gateway (`ANTHROPIC_BASE_URL` set) stays, and so does one set in Claude's own settings `env` or your shell profile. ⚙ Settings → *Let an ANTHROPIC_API_KEY in the environment override my Claude sign-in* passes it through. The default engine is used for new agent and Conductor cards; any card can switch engine in the Inspector, and a board can mix engines (a Codex Conductor driving Gemini and Claude workers, for example).

## Install

**Windows 10/11, x64.** Download the latest `Ouroboros-Setup-<version>.exe` (installer, per-user, no admin) or `Ouroboros-<version>-portable.exe` from the [Releases page](https://github.com/blee170/Ouroboros/releases). The build is unsigned, so SmartScreen asks once: *More info → Run anyway*.

Prerequisites on the machine:

- Git for Windows (Claude Code uses Git Bash) and the CLI(s) you intend to run, signed in: `claude`, optionally `codex` (needs Node.js on `PATH`) and `gemini`.
- Nothing else. The app bundles its own Node runtime for its helper scripts where it can.

`Ouroboros.exe <folder>` opens that project directly (handy as a shortcut target). After installing once, later versions come through ⚙ → *Check for updates*.

Linux builds (`npm run dist:linux`) are used for the automated tests; macOS is untested.

## Daily use

1. **Open a project folder** (Welcome screen or 📁). A second folder opens in a second window.
2. **Add cards**: *New card* in the title bar (its arrow or the canvas right-click menu lists every kind) → Claude agent / Codex agent / Gemini agent / Conductor / Terminal / Browser / Command card / Aside / Note. The Inspector (sections Card · Work · Launch · Last reply) edits a card's folder, engine, `--continue` / `--resume`, model, permission mode, extra system prompt, MCP servers, worktree.
3. **Draw lines** from a card's right port to another's left port; set mode, condition and template in the Inspector.
4. **Conduct**: put a Conductor in the middle and give it the goal. It creates and wires what it needs, runs the stages, relays questions and reports. Or press **✨ Build board** to generate a starting board from your folder and Claude Code history.
5. **Review**: click a card's `+n −m` badge to see its diff, revert files or ask it to review itself. The sidebar and the status bar show what needs you.
6. **Clean up**: dispatched cards retire themselves once their report is in; 🧹 Tidy for the rest; ⊞ Arrange lines the board up.
7. **Hands-free**: leave the window; the Conductor's finished turns are announced (⚙ Announcements). Leaving for hours: 🌙 Autonomous mode (first night: a 4 h deadline, a handful of low-stakes tasks, watch the first 20 minutes; the deny rules are code, but auto mode's own judgement is not perfect, so keep production credentials out of worker folders). To talk instead of type, run `/voice` in a Claude card and hold Space (set `language` to Korean in Claude Code's `/config` for Korean dictation). In tap mode the microphone stays open until you tap again, so an announcement spoken meanwhile is dictated too — hold mode or ⚙ voice off avoids that.

## Settings

Settings (the gear in the title bar):

- Desktop notifications when a card needs you.
- Announcements: whose finished turns (nothing / Conductor / every card), toast on/off, voice on/off, 🔊 Test. Voice engine: **Windows voice** (offline; only SAPI voices are available to the app — Heami for Korean, Zira for English — the Windows 11 "natural" voices are not exposed to third-party apps) or your own subscription — **Gemini TTS** (a Google AI Studio key, free tier, `gemini-3.8-flash-lite-tts`, voices like Kore/Zephyr/Puck), **OpenAI** (`gpt-4o-mini-tts`) or **ElevenLabs** (multilingual v2, a voice id). Paste the key (stored encrypted, sent only to that engine), optionally a voice and a style hint, press 🔊 Test. Each sentence is fetched once and cached under the app's data folder (`tts/`); when the engine fails the Windows voice speaks instead and Settings shows why.
- Keep running in the tray when the last window is closed.
- Track Claude Code sessions started outside Ouroboros (writes one HTTP hook into `~/.claude/settings.json`; needs port 47821 free).
- Open claude.ai briefs in the system browser instead of a browser card (off by default; turn it on only if claude.ai refuses to sign in inside the card — the card's ↗ button opens any page outside too).
- Default shell, browser home page; auto-retire minutes and the live-worker cap live in the 🧹 Tidy dialog and `settings.json` (`retireMinutes`, `maxWorkersPerLead`).
- Updates: *Check for updates*. The repository is public, so no token is needed; the token field remains for private forks (stored encrypted with Electron's `safeStorage`).

## Security and privacy

- **No accounts, no telemetry, no model calls from the app.** The CLIs in the cards use your own sign-ins and plans and talk to their providers directly.
- The local HTTP server listens on `127.0.0.1` only. Hook posts carry no secrets; the JSON API requires a random per-launch token known only to the MCP servers Ouroboros starts.
- Agents get exactly the permissions you give their CLI (permission mode / approval mode / sandbox). The Conductor's human gates are instructions, not enforcement; the enforcement is the CLI's own approval prompts, which show up as **Needs you**.
- `.ouroboros.json` contains card titles, folders, role prompts and line templates — review it before committing it to a shared repository.
- Browser cards share one persistent Chromium profile (`persist:ouroboros-browser`) stored in `userData`; sign-ins there stay on your machine.
- The repository and release history were checked for leaked keys and tokens before it was made public; none were ever committed.

## Build from source

Prerequisites: Node 22+, Git. No compiler: `node-pty` ships prebuilt N-API binaries.

```powershell
git clone https://github.com/blee170/Ouroboros.git
cd Ouroboros
npm install
npm run dev          # development build with hot reload
npm run dist:win     # release\Ouroboros-Setup-<version>.exe + portable exe (unsigned)
```

If `npm install` did not download the Electron binary (corporate proxies), run `node node_modules/electron/install.js` once.

## Project layout

```
src/main/        Electron main process
  index.ts         app bootstrap, windows (one Board per window), tray, single instance
  ipc.ts           IPC handlers, per-window API (createApiHandlers), handoff runner, notifications
  board.ts         authoritative board state + status reducer wiring
  hook-server.ts   HTTP hooks + JSON API (token, per-card scoping)
  claude-launcher.ts  Claude command line, hook settings, MCP config, CONDUCTOR_SYSTEM_PROMPT
  agent-launcher.ts   Codex / Gemini launch recipes
  agent-hook.ts    Codex notify / Gemini hooks → Ouroboros hook events (bundled standalone)
  mcp-server.ts    the board MCP server (bundled standalone)
  pty-manager.ts   node-pty wrapper
  git-changes.ts   status / diff / revert for the Changes panel and get_changes
  checkpoints.ts   git snapshots of a folder (create / list / restore / delete) for the Inspector and the *_checkpoint tools; git.ts runs git for both
  claude-history.ts  reads ~/.claude transcripts (sessions list, context usage)
  bookmarks.ts, browser-manager.ts, command-runner.ts, updater.ts, worktree.ts, workspace-store.ts, windows.ts
src/preload/     contextBridge (window.ouroboros)
src/renderer/    React + React Flow canvas, xterm cards, panels (title bar, Sidebar, Inspector, status bar, Settings, Board Builder, Tidy)
src/shared/      types, protocol (IPC names), pure logic (status reducer, handoff templating, tidy, board builder)
scripts/         gen-icon.mjs, smoke.mjs (Playwright + Electron end-to-end test)
tests/           vitest unit tests
docs/RESEARCH.md research notes: competitor comparison, fact checks, engine config sources
```

## Development

```bash
npm run typecheck                     # main/preload + renderer
npm run build                         # electron-vite + the two standalone bundles
npm test                              # vitest (run after build: two tests exercise the bundled scripts)
xvfb-run -a node scripts/smoke.mjs    # end-to-end: PTY, hooks, lines, Conductor API, browser cards, windows, engines
```

The smoke test launches the real app under Playwright, drives it through the JSON API and the renderer store, and checks every feature end to end; it runs on Linux (xvfb) and against a packaged build with `SMOKE_EXE=…`.

## Release process

Add the version's entry to `CHANGELOG.md` (Added / Changed / Fixed / Security / Verified, newest first), bump `version` in `package.json` as the last commit, and push. `.github/workflows/release.yml` creates the `v<version>` tag, runs typecheck, build and tests on `windows-latest`, packages with electron-builder and uploads the installer, the portable exe, the blockmap and `latest.yml` to a GitHub Release in one step. The in-app updater reads `latest.yml`. The workflow fires on any branch push that changes `package.json`, so a bump on a feature branch releases that branch.

## Limitations and roadmap

- Windows is the target; Linux builds are for tests; macOS untested.
- Unsigned binaries (SmartScreen warning on first run).
- Codex: no "needs approval" signal; readiness is inferred from output.
- Checkpoints restore files, not staging state: everything comes back unstaged, and a staged version that was edited further before the restore is not kept. Files that were gitignored when the snapshot was taken but are not any more count as new and are removed by a restore (the "before restore" snapshot has them). Submodule contents are not covered. Snapshot commits show up in `git log --all`. They hold every non-gitignored file, so an un-ignored `.env` lands in `.git/objects` exactly as `git add -A` would put it there. Folders that are junctions or symlinks are refused.
- Not yet: Discord/Telegram bot cards that feed messenger feedback into the Conductor, scheduled runs, PR monitoring.

## License

MIT — see `LICENSE`.

---

## 한국어 안내

**우로보로스**는 여러 AI 코딩 에이전트(Claude Code · Codex CLI · Gemini CLI)를 한 화면의 캔버스에서 **카드**로 띄우고, 카드 사이의 **선**으로 결과를 자동으로 넘기며, **총괄(Conductor)** 카드에게 전체 파이프라인을 맡기는 Windows 프로그램입니다. 모델 API를 직접 부르지 않고 각자 로그인해 둔 CLI를 그대로 실행하므로 요금은 본인 구독으로 나갑니다.

**설치**: [Releases](https://github.com/blee170/Ouroboros/releases)에서 `Ouroboros-Setup-<버전>.exe` 받아 설치(관리자 권한 불필요). 서명이 없어 SmartScreen이 한 번 묻습니다 → *추가 정보 → 실행*. 이후 업데이트는 앱 안의 ⚙ → *Check for updates*.

**준비물**: Git for Windows, 그리고 쓸 CLI 로그인 (`claude`, 선택적으로 `codex`(Node.js 필요), `gemini`).

**처음이라면**: [docs/TUTORIAL.md](docs/TUTORIAL.md)가 설치부터 총괄 카드가 작은 파이프라인을 돌리는 데까지 한 시간 코스로 안내합니다(영문, 단계 제목만 따라가도 됩니다). 버전별 변경 내역은 [CHANGELOG.md](CHANGELOG.md).

**기본 흐름**
1. 프로젝트 폴더 열기 → 캔버스 우클릭으로 카드 추가.
2. 카드 오른쪽 포트에서 다른 카드 왼쪽 포트로 드래그하면 선. 인스펙터에서 자동/수동, 조건(`SCORE: 9/10`, `PASS`, `/정규식/`), 템플릿 편집.
3. 총괄 카드를 하나 두고 목표를 말하면 필요한 카드와 선을 스스로 만들고 돌린 뒤 5줄로 보고합니다. 배포·파괴적 git·돈 쓰는 일은 `APPROVED BY OWNER`라고 답할 때까지 제안만 합니다.
4. 카드의 `+n −m` 배지로 변경 내용(diff)을 검토하고, 로스터에서 "Needs you"를 먼저 처리합니다. 위험한 단계 전에는 인스펙터의 체크포인트(git 스냅샷)를 찍어 두면 잘못됐을 때 되돌릴 수 있습니다(되돌리기 자체도 취소 가능). 총괄은 이걸 스스로 합니다.

**작동 원리 요약**: 카드마다 CLI를 실제 터미널(PTY)에서 실행하고, CLI의 라이프사이클 훅(HTTP, 127.0.0.1)으로 상태를 받습니다. 선은 원본 카드의 답이 끝나는 순간 템플릿을 대상 카드에 타이핑합니다. 총괄은 앱이 제공하는 MCP 서버(`list_agents`, `create_agent`, `connect_agents`, `get_changes` …)로 보드를 조작합니다. 자세한 내용은 위 영문 [How it works](#how-it-works).

**보안**: 텔레메트리·계정·자체 모델 호출 없음. 로컬 서버는 127.0.0.1 전용이고 API는 실행마다 바뀌는 토큰을 요구합니다. 저장소 공개 전 전체 커밋 이력에서 키·토큰 유출을 검사했고 없었습니다.
