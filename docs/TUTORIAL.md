# Your first hour with Ouroboros

A walk-through for someone who has just installed the app and has never used it. It takes about an hour at a relaxed pace and ends with a Conductor running a small pipeline for you. The [README](../README.md) is the reference; this is the path through it.

**What Ouroboros is, in one breath:** a canvas where every AI coding agent (Claude Code, Codex, Gemini CLI) is a card, cards are real terminals, lines between cards carry one card's finished reply into the next, and a Conductor card can run the whole board for you. The app calls no model itself: it launches the CLIs you are already signed in to.

Korean: 한국어 요약은 README 맨 아래 [한국어 안내](../README.md#한국어-안내)에 있고, 이 튜토리얼의 각 단계 제목만 따라가도 됩니다.

---

## 0. Before you start (5 min)

You need, on the Windows machine:

1. **Git for Windows** (Claude Code uses Git Bash). `git --version` in a terminal should answer.
2. **At least one CLI, signed in.** Pick the one you pay for:

   | You have | Install | Sign in |
   |---|---|---|
   | Claude (Pro / Max) | `irm https://claude.ai/install.ps1 \| iex` | run `claude` once and follow the browser sign-in |
   | ChatGPT (Plus / Pro) | `npm install -g @openai/codex` (needs Node.js) | `codex login` |
   | Google / Gemini | `npm install -g @google/gemini-cli` (needs Node.js) | run `gemini` once |

3. **Ouroboros** from the [Releases page](https://github.com/blee170/Ouroboros/releases): `Ouroboros-Setup-<version>.exe` (per-user, no admin) or the portable exe. The build is unsigned, so SmartScreen asks once: *More info → Run anyway*.

The Welcome screen shows which CLIs it found and whether they are signed in, with the commands to copy if one is missing. Fix anything red there before going on; nothing else in the app works without a signed-in CLI.

This tutorial uses Claude Code. With Codex or Gemini the steps are the same; pick that engine as the default in Settings (the gear in the title bar) → *Engines* and read "Claude card" as "agent card".

## 1. Open a project and add one card (5 min)

1. On the Welcome screen press **Open project folder** and pick a project you know, ideally a small git repository. One window holds one project; a second folder opens a second window.
2. The canvas is empty. Press **New card** in the title bar (the button adds your default agent; its arrow lists every kind). A card appears, and inside it a real terminal starts `claude` in your project folder. The first time Claude Code sees a folder it asks whether to trust it: answer in the card with the arrow keys and Enter, exactly as in a terminal.
3. Type something into the card: *"Describe this repository in five lines."* Watch the card's header: the dot goes blue (**Working**), then green (**Done**). That status comes from Claude Code's own lifecycle hooks, not from reading the screen, so it is reliable.
4. Click the card and look at the **Inspector** on the right. *Card* holds the title and the folder, *Work* shows the diff badge and checkpoints, *Launch* holds the model, the permission mode and resume options, and **Last reply** shows what the card just wrote, rendered as markdown with file paths you can click. Rename the card to *Explorer* (title field, Enter).

What you have learned: a card is a terminal, the app knows what the agent is doing, and the Inspector is where you read and tune a card.

## 2. The sidebar and the status bar (5 min)

The **sidebar** on the left lists every card grouped by state: *Needs you* first, then *Ready to review*, *Working*, *Idle*, *Ended*; a worker sits indented under its Conductor. Each row carries the card's state glyph (a turning ring = working, an orange **?** = needs you, a green check = done), its kind, how long ago it last moved and its last reply. Click a row to jump to the card; hover it for its Ctrl+1…9 key. The **status bar** at the bottom (`2 working · 1 need you · …`) does the same for the whole board. Drag the sidebar's edge to resize it; the first button in the title bar hides it.

Try it: give *Explorer* a longer task (*"List every TODO comment in this repo with its file and line."*), then zoom out with the mouse wheel. Zoomed far out a card shows its last reply in large type instead of the terminal, and ↓ on the card brings you back to the live output. The minimap at the bottom right and Ctrl+1…9 jump between cards; Ctrl+J opens *Jump to…* (type part of a title, ↑↓, Enter) and Ctrl+Shift+N goes to the next card that needs you. A card's green check means a turn finished that you have not looked at yet: its row is bold, and once you select the card it reads *Idle* again.

The composer at the bottom of the sidebar sends text to the checked cards. Paste a screenshot into it (Ctrl+V) and it becomes a chip; on Send a Claude card receives it as an image, other cards as a path. This is how you give several cards the same brief at once.

## 3. Two cards and a line (10 min)

Lines are what makes the board more than a window manager.

1. Add a second Claude card and rename it *Reviewer*. In its Inspector (*Launch* section), set **Extra system prompt** to something like: *"You review changes other agents made. Read the diff, list problems, end with SCORE: n/10."*
2. Drag from *Explorer*'s **right port** to *Reviewer*'s **left port**. A line appears. Click it: the Inspector shows its **mode** (Auto: fires when the source finishes a reply; Manual: you press the play button on the line or *Send now* in the Inspector), its **template** (what gets typed into the target; `{{last_assistant_message}}` is the source's reply, `{{source_title}}` its name) and an optional **condition** (a substring such as `PASS` or a regex such as `/SCORE: (9|10)\/10/`). Leave it on Auto with the default template.
3. Give *Explorer* a small real task: *"Add a one-line docstring to the top of the main entry file. Reply with the file name you changed."* When it finishes, the line flashes and *Reviewer* starts: the reply was typed into it. The line glows while *Reviewer* works on that handoff.
4. When *Reviewer* is done, open *Explorer*'s **`+n −m` badge**: the Inspector shows the diff per file, with ✕ (discard that file's changes) and *Ask the card to review*. This is the only honest way to know what an agent did: read the diff, not the reply.

What you have learned: auto lines relay results without you; templates decide what is relayed; conditions decide whether; the diff badge is where trust comes from.

## 4. Checkpoints: a safety net before a risky step (5 min)

Before letting an agent touch anything you care about, take a **Checkpoint** (Inspector → *Work* → Checkpoints → **Snapshot**, with an optional label). It is a git snapshot of the card's folder, every non-ignored file whether committed or not, stored under `refs/ouroboros/checkpoints/` without touching your working tree, your index or your branches.

Try it: snapshot, let *Explorer* make a change you do not want (*"Rename every variable in the entry file to single letters"*), then **Restore** the snapshot (the clock-arrow button on its row). The files come back. The restore first saves a *before restore* snapshot, so a restore can itself be undone. The Conductor takes these snapshots on its own before risky stages; you take them before you let a card loose on something precious.

## 5. The Conductor: let the board run itself (15 min)

A **Conductor** is a Claude card that gets an MCP server with the board as tools: it can list cards, create them, draw lines, read diffs, take checkpoints and tidy up. It also carries an operating procedure: plan → review → implement → score → bug hunt → deploy guide, with human gates.

1. Add one: the arrow next to **New card** → **Conductor** (or right-click the canvas). It starts in the project root. Give it a goal small enough to finish in a few minutes:

   > *"Goal: add a `--version` flag to the CLI. Plan it, have a worker implement it on its own worktree, have a reviewer score the diff, and report."*

2. Watch the canvas. The Conductor creates cards (each a real agent with a role), wires report lines back to itself, and runs the stages. Workers created with a worktree get their own branch (`<project>-worktrees/<slug>`), so they never trample each other or your checkout.
3. When a worker asks something the Conductor cannot answer, the card shows an orange **?** (**Needs you**) and the sidebar puts it first. Answer in the card, or in the composer. The Conductor never answers for you.
4. The Conductor's report lands as a reply; **📄** on the Conductor reopens the brief it published. Open the worker's diff badge before you believe the report.
5. Human gates: the Conductor proposes a push, a merge, a deploy or anything that spends money, and waits until you answer `APPROVED BY OWNER`. Nothing is pushed on its own.

When the run is over, **🧹 Tidy** closes finished cards (dispatched workers retire by themselves a few minutes after their report is in; pin a card with *Keep* to exempt it), and **⊞ Arrange** lines the board up along its lines. Press **✨ Build board** if you would rather start from a generated board based on your folder and your Claude Code history.

## 6. Hands-free: announcements, voice, and Autonomous mode (10 min)

- **Announcements** (Settings): when the Conductor finishes a turn of 10 s or more, a toast and/or a spoken "<card> finished, please check the report". The Windows voices are offline; a Gemini, OpenAI or ElevenLabs key gives natural Korean and English. The reply itself is never read out.
- **Voice input**: in a Claude card type `/voice` and hold Space to dictate (Claude Code's own dictation, Korean included). If the card says *No audio detected*, check Windows Settings → Privacy → Microphone → *Let desktop apps access your microphone* and the input device under Sound.
- **Autonomous mode** (the moon in the title bar) is for leaving for hours. The preflight sheet shows the end time, the caps and exactly what happens to each live card. During the run the PC stays awake, every card runs in auto mode with a deny list (no push, merge, deploy, destructive git, production data changes), a card that asks a question is **parked** rather than answered, a silent card is nudged then parked, and you come back to a **Morning report** note: what waits on you first, then every card with its branch, diff size and last reply.

  **First night:** a 4-hour deadline, a handful of low-stakes tasks, watch the first 20 minutes. The deny rules are code, but they match commands as typed, not every road to the same effect, and auto mode's own judgement is not perfect. Keep production credentials out of worker folders.

## 7. Where things are (reference)

| What | Where |
|---|---|
| The board | `.ouroboros.json` in the project folder (cards, lines, positions; sessions resume by id) |
| Settings, voice clips, logs | `%APPDATA%\Ouroboros\` (`settings.json`, `tts\`, `main.log`, `autonomy\<project>\`) |
| Worktrees made for workers | `<project>-worktrees\<slug>` next to the project |
| Checkpoints | `refs/ouroboros/checkpoints/*` inside the repository (`git for-each-ref refs/ouroboros/`) |
| Updates | Settings → *Check for updates* (the status bar shows a badge when one is ready); the app installs the next release silently when you restart it |
| What changed in each version | [CHANGELOG.md](../CHANGELOG.md) |

## Habits that make it work

1. **Small goals per Conductor run.** One feature, one bug. Big goals turn into long runs you cannot review.
2. **Read diffs, not replies.** The `+n −m` badge and the worker's branch are the evidence; "tests green" in a reply is a claim.
3. **One worktree per worker** when they edit files. Tell the Conductor, or set it in the worker's Inspector.
4. **Snapshot before you let go.** A checkpoint takes a second and makes every mistake reversible.
5. **Needs you first.** The cards with an orange **?** are the ones burning time.
6. **Tidy at the end.** Ended cards cost nothing, but a clean board is a readable one tomorrow.

If something does not match this guide, the README's [Limitations](../README.md#limitations-and-roadmap) lists what is known, and `%APPDATA%\Ouroboros\main.log` is the first place to look for a card that would not start.
