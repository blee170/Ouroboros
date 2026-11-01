# Claude Code mods in Ouroboros, and keeping up with CLI updates (2026-11-02)

Two questions from Brian, after a YouTube comment listing three Claude Code "mods":

1. Do Savvy Progress, File Tree and Replay Theater work inside an Ouroboros card, and should Ouroboros build any of them natively?
2. How does Ouroboros keep working when Claude Code, Codex, Gemini CLI or Grok Build update, and what repeatable check would catch a break?

Short answers: all three load in cards, because cards use Brian's real `~/.claude` (nothing to change in Ouroboros), but File Tree needs a card at least 110 columns wide and most cards open at 89. None of them conflicts with Ouroboros's HTTP hooks. The ideas worth building natively are a per-turn edit replay and a subagent strip on the card. On compatibility, the installed Claude Code 2.1.316, Gemini CLI 0.65.0 and Grok 1.0.70 still match every assumption checked; Codex is not installed here, so it was not checked. A two-level check script is proposed at the end.

Nothing was installed into `~/.claude`. The repos were read from shallow clones; nothing in them was run.

## 1. What a "mod" is

Since Claude Code 2.1.287, a plugin can ship a **hooks module**: `hooks/hooks.json` holds `{ "modules": ["./register.tsx"] }` in place of shell or HTTP hooks. The module's `register(on)` subscribes to in-process events (`session.start`, `turn.start`, `turn.step`, `turn.complete`, `tool.call`, `tool.check`, `agent.spawn`, `prompt.submit`, `command.run`, `ui.render`) and gets a `$` handle with `$.ui.open` (a Pane), `$.command.register` (a slash command), `$.tool.register` (an MCP-style tool), `$.fs`, `$.process.spawn` and `$.http.fetch`. The Pane is docked right in the fullscreen layout, capped at 45% of the terminal width (2.1.305), or drawn inline above the prompt. The desktop app renders the same tree with SVG; the terminal falls back to text rows.

This API is separate from settings hooks. A mod's `tool.call` handler runs inside the CLI process; the `PreToolUse`/`PostToolUse` HTTP hooks Ouroboros puts in each card's `--settings` file still fire. All three mods pass calls on with `next(e)`, so none of them blocks or rewrites what Ouroboros's hooks see.

## 2. The three mods in a card

How cards are set up, as far as the mods care:

- A card runs `claude --settings <card>.settings.json --mcp-config <card>.mcp.json …` with the real config directory ([claude-launcher.ts](../src/main/claude-launcher.ts)). A plugin Brian installs with `--scope user` therefore loads in **every** card, the Conductor and autonomous workers included.
- Brian's user settings have `"tui": "fullscreen"`, so cards already run the fullscreen layout.
- Card size from `main.log`: 545 of the last ~770 spawns were 89×24; 37 were 112×26, 21 were 186×57 (maximized).
- The terminal is xterm.js 6 with fit, search, serialize, unicode11 and webgl addons, and **no image addon**: a mod's `Image` shows its `alt` text.
- Ouroboros's `statusLine` (a curl to `/hook/<id>/statusline` that prints nothing) replaces any user status line in cards. None of the three mods uses the status line; they draw in the band above the prompt or in a Pane.

| | Savvy Progress 1.2.1 | File Tree 0.5.4 | Replay Theater 0.1.0 |
|---|---|---|---|
| Source | `johnnyvizz/claude-kit` `plugins/savvy-progress` (1,271-line `register.tsx`) | `data-goblin/claude-code-filetree` (`hooks/register.tsx` and helpers) | `anthropics/claude-code-playground` `claude-code/mods/replay-theater` (249-line `.mjs`) |
| Hooks into | `agent.spawn`, `turn.step` (token usage per request), `turn.complete`, `tool.call` on `Agent`; registers two tools (`mcp__savvy-progress__progress`, `__step`) and `/agents-info`; band above the prompt plus a Pane | `tool.call` (Read, Edit, Write, Bash readers, git), `prompt.submit` (`@path`), `ui.*`; `/filetree`; spawns `du`, `sh`, `inotifywait`, git | `tool.call` on Edit/Write/MultiEdit (records old and new text), `turn.start`/`turn.complete`; `/replay`; band hint plus a 58-column Pane |
| Works in a card? | Yes, as text rows. The walking crab is drawn only on the desktop surface (SVG), so a card never shows it. | Only in a card at least 110 columns wide: `/filetree` refuses below that (`register.tsx:1944`), and at 89 columns that is most cards. The image treemap and preview fall back to text. Live updates use `inotifywait` (Linux only). | Yes. At 89 columns the docked Pane gets at most ~40 columns (45% cap), so its diff lines are cut short. |
| Conflicts with Ouroboros hooks | None found | None found | None found |
| Side effects to know | Adds two tools to every card's tool list; its cost figure is its own estimate from a price table (Ouroboros already shows Claude Code's own `cost` from the status line) | Opens at session start by default ("Open at start: on", "Focus on open: on"): in every card, including narrow ones (not tested what it does there) | Kept in memory only; records edits that were then denied |

**Keyboard focus, a real risk for Ouroboros.** A mod Pane opened with `focus: true` holds the keyboard (Replay's `n`/`p`/`c`, File Tree's `j`/`k`/`o`/Enter). Ouroboros sends prompts to a Claude card through its inbox (`CLAUDE_CODE_MESSAGING_SOCKET`) and only types them into the terminal when the card has not registered an inbox yet or the inbox write fails ([ipc.ts](../src/main/ipc.ts) `sendPrompt`). On that typed path, keys would go to the focused Pane instead of the prompt: a `c` closes Replay, Enter opens a file in File Tree, and the prompt is lost. Not reproduced; it follows from the mods' code. File Tree with "Focus on open: on" is the likeliest to hit it, at session start, which is exactly when the typed fallback is used.

**Verdict.** Fine to try in a card. Install for one session with `claude --plugin-dir <folder>` in a temp clone rather than `--scope user`, so the Conductor and autonomous workers do not get them. If File Tree is installed for good, set "Open at start" and "Focus on open" to off.

## 3. What Ouroboros should copy natively

Ouroboros already receives the same events through its HTTP hooks (every `PreToolUse`/`PostToolUse` payload carries `tool_name` and `tool_input`; `SubagentStart`/`SubagentStop` carry `agent_id`), and it can show them in React on the canvas, where the board, the phone page and the Conductor can all use them. That beats a mod inside one card's terminal.

1. **Replay of the last turn's edits (recommended first).** Record `PostToolUse` for Edit, Write and MultiEdit between `UserPromptSubmit` and `Stop`, per card, and show them as steps in the Inspector next to the Changes panel. A reviewer card and the Conductor's `get_changes` could use the same list ("what did this turn change", not "what is uncommitted"). Small to medium; no new CLI dependency.
2. **Subagent strip on the card.** Running and finished subagents (type, description, time) from `SubagentStart`/`SubagentStop`, as a chip on the card and in Orbit. Small. Cost per subagent is not needed: the status line already gives the card's real total.
3. **Files the card touched.** The paths from `tool_input.file_path` (Read in one colour, writes in another) as a list in the Inspector, marked with git status. A full IDE tree is not worth it in a canvas card; the touched-file list is the part that helps.

A bigger option, for later and Brian's call: ship an **Ouroboros mod** into cards with `--plugin-dir`. In-process events would replace the screen-reading Ouroboros does now (ready banner, trust question, "Interrupted", the `[Image #N]` chip) and the status-line curl. Against it: mods are skipped where an organization manages Claude Code, they do not load in WSL desktop sessions, and the API is new and still changing every release. Not recommended until the API settles.

## 4. What Ouroboros assumes about each CLI

### Claude Code (installed 2.1.316)

| Assumption | Where | Checked on 2.1.316 |
|---|---|---|
| Flags `--settings --continue --resume --model --effort --permission-mode --mcp-config --system-prompt-snapshot --name` | `buildClaudeCommand`, [claude-launcher.ts](../src/main/claude-launcher.ts) | All in `claude --help`; `--effort` takes low, medium, high, xhigh, max |
| `--append-system-prompt-file` | same | Not listed on its own line in `--help` (only as `--append-system-prompt[-file]` in another flag's text) but present in the binary (14 hits) and working in Brian's cards. Hidden flag: the first to watch |
| Hook events `SessionStart UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure Notification PermissionDenied Stop StopFailure SubagentStart SubagentStop PreCompact PostCompact SessionEnd`, as `type: "http"` hooks with `headers` and `allowedEnvVars` | `HOOK_EVENTS`, `buildHookSettings` | All names and `allowedEnvVars` present in the binary |
| Payload fields `hook_event_name session_id tool_name tool_input agent_id notification_type message last_assistant_message source reason transcript_path` | `reduceHook` [status.ts](../src/shared/status.ts), `stepOf` [doing.ts](../src/shared/doing.ts), [ipc.ts](../src/main/ipc.ts) | Present (spot check: `last_assistant_message`) |
| Notification types `permission_prompt idle_prompt elicitation_dialog agent_needs_input` | `NEEDS_YOU_NOTIFICATIONS`, status.ts | All present |
| PreToolUse answer `hookSpecificOutput.permissionDecision` (action gate) | [agent-hook.ts](../src/main/agent-hook.ts) | Present |
| Status line JSON `rate_limits.five_hour/seven_day.used_percentage`, `resets_at`, cost, context | [shared/usage.ts](../src/shared/usage.ts) | Field names present |
| Inbox `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`, pipe name `\\.\pipe\LOCAL\cc-msg-…` | [claude-inbox.ts](../src/main/claude-inbox.ts), [mcp-server.ts](../src/main/mcp-server.ts) | Present |
| Screen text: ready banner (`Claude Code v`, `? for shortcuts`, …) | `detectClaudeReady`, status.ts | Present |
| Trust dialog: "Quick safety check", "Yes, I trust this folder", first choice "No, exit" | `detectTrustQuestion`, status.ts; hint text in ipc.ts | Present |
| Interrupt: "Interrupted · What should Claude do instead?" | `showsInterrupt`, doing.ts | Present |
| Image paste: Alt+V (`\x1bv`) and the `[Image #N]` chip | ipc.ts `ptyPasteImage`, useTerminal.ts | Chip text present; key not checkable statically |

Changes between 2.1.287 and 2.1.316 that touch these, read from the changelog:

- **Nothing renamed or removed** among the flags, hook events, fields or screen text above.
- `SubagentStop` used to fire about twice a minute per running subagent; fixed (2.1.311). Ouroboros already ignores it after a turn ends, so this only removes noise.
- Prompt and agent hooks now run at most 24 at a time per session. Ouroboros's hooks are `http`, so not affected.
- PreCompact hook output is cut at 10,000 characters. Ouroboros returns nothing there.
- Windows: PowerShell hooks exiting 2 now block, and `PreToolUse` hooks no longer fail open when Git Bash is missing. Ouroboros's gate runs node with a JSON answer, not an exit code, so no change; it only makes Windows hooks safer.
- `CLAUDE_CODE_SUBAGENT_EFFORT` (2.1.316): subagents can run at a lower effort than the card's `--effort`. Not used yet; a possible Settings option for the effort feature (PR #70).
- Mods load by default (2.1.287). Brian's own installed plugins now run code in every card, so plugins are part of a card's behaviour to keep in mind when a card acts oddly.
- Fast mode on Opus 4.8 is deprecated and goes away on 2026-11-30. Ouroboros does not pass a fast-mode flag; only a card started on `opus-4.8` with fast mode would notice.

### Codex, Gemini CLI, Grok Build

| CLI | What Ouroboros passes | Checked |
|---|---|---|
| Codex | `-c key=value` (`notify=…`, `developer_instructions`, `model_reasoning_effort`, sandbox keys), `-m`, `-s`, `-a`, `--dangerously-bypass-approvals-and-sandbox`, `resume [--last]`; notify payload `type: agent-turn-complete`, `thread-id`, `last-assistant-message` ([agent-launcher.ts](../src/main/agent-launcher.ts), agent-hook.ts) | **Not installed on this machine: not checked** |
| Gemini CLI 0.65.0 | `-m`, `--approval-mode plan/auto_edit/yolo`, `-r [latest]`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH`; hook events `SessionStart BeforeAgent BeforeTool AfterAgent Notification SessionEnd`, field `prompt_response` | Flags in `--help`, `plan` still a choice; hook names not checked statically |
| Grok 1.0.70 | `--agent <file>`, `-m`, `--always-approve`, `-r`, `-c`; snake_case `hookEventName` ([agent-hook.ts](../src/main/agent-hook.ts) `mapGrokHook`) | Flags in `--help` |

## 5. The repeatable compatibility check (built 2026-11-02)

The assumptions are spread over six files and pinned only by unit tests with hand-written fixtures. Those tests pass even when the CLI has moved on, so the check runs against the **installed** CLIs.

**Level 1: static, free, ~30 s (`npm run compat`, [scripts/cli-compat.mjs](../scripts/cli-compat.mjs)).**

- One contract table, [src/shared/cli-contract.ts](../src/shared/cli-contract.ts), per engine: the flags the launchers pass, the hook event names, the notification types, the env names, and the screen strings the detectors match. Each entry says where Ouroboros relies on it.
- The script runs `<cli> --version` and `<cli> --help`, checks every flag, and searches the installed files for every string: a native binary itself (Claude Code, Grok), or the npm package (Gemini, Codex). It prints one line per assumption (`ok`, `hidden`: in the files but not in `--help`, `MISSING`) and exits 1 on a `MISSING`. A CLI that is not on PATH is skipped. `npm run compat -- claude gemini` checks only those.
- [tests/cli-contract.test.ts](../tests/cli-contract.test.ts) builds every launch variant (each permission mode, resume form and autonomous run) and fails when a launcher emits a flag, an approval mode or a hook event the table leaves out. So a new flag cannot skip the table.
- First run on 2026-11-02: everything found; `--append-system-prompt-file` reported `hidden`; Codex skipped (not installed). Positive control: a made-up flag and string came back `MISSING` with exit 1, and removing `--name` / `--last` from the table failed the unit test.

**Level 2: live probe, opt-in (`npm run compat -- --live`), one tiny Claude turn.**

- A throwaway HTTP server on a random port (never 47821), Ouroboros's hook shape for every event in `CLAUDE_HOOK_EVENTS`, and `claude -p … --model haiku --effort low --setting-sources project,local --no-session-persistence` in `~/.ouroboros-compat-probe`, which is outside Temp and removed afterwards. Leaving `user` out of `--setting-sources` keeps Brian's global hooks (and the Ouroboros external route) out of the probe, and this session's CLAUDE markers are stripped from the child.
- It checks that each event in `CLAUDE_PAYLOAD_KEYS` arrives with the keys Ouroboros reads. First run: UserPromptSubmit, PreToolUse, PostToolUse, Stop and SessionEnd all `ok`; `~/.claude/settings.json` hash unchanged. SessionStart is not expected: Claude Code still never sends it to http hooks. The probe prints `news` if that ever changes.
- Not covered: TUI-only text (trust dialog, interrupt), which `-p` never draws. Level 1's string search is the guard there.

**When it runs.**

- By hand after `claude update` (and before a release): `npm run compat`.
- In the app, later: Settings → Engines already reads each CLI's version. When a version differs from the last one checked, run Level 1 in the background and show "Claude Code 2.1.317: 1 assumption failed (details)" on the Engines panel, without blocking anything.
- A weekly Routine (PR #71) could hand a card the new changelog sections filtered by the contract's keywords. That is cheap and catches behaviour changes no string search sees.

## 6. Open items

- Codex was not checked (not installed here).
- The keyboard-focus risk in section 2 comes from reading the mods' code and was not reproduced in a card.
- File Tree's behaviour at session start in a card under 110 columns was not tested.
- Section 5 levels 1 and 2 are built; the in-app Engines-panel check and the weekly changelog Routine are not. Section 3 waits for Brian's choice.
