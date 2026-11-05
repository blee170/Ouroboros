# Fact check: "멀티 에이전트 쓰지 마세요.. (실제 테스트 결과)" vs Ouroboros (2026-11-05)

Video: [멀티 에이전트 쓰지 마세요.. (실제 테스트 결과)](https://www.youtube.com/watch?v=cIGRF-acSzs) ("Don't use multi-agent: real test results"), 챗대리의 AI연구소, uploaded 2026-11-04, 9:15.
How it was watched: yt-dlp download, the uploader's Korean captions and the auto-translated English ones (3,186 words), 45 frames on 5 contact sheets. The whole video was watched; nothing here is guessed from the title or the description. The English auto-captions say "Claude 3.5 Sonnet" and "Opus 3.5"; the Korean audio and the on-screen labels say **Sonnet 5.5** and **Opus 5.5**, and that is what is graded.
Compared against: `origin/main` d3baabf (v0.18.10 plus the unreleased PRs #69 to #72). Installed CLI: Claude Code 2.1.318 (it was 2.1.316 when the task was written).
Overlap with the two neighbouring sessions: none with the Orca-style chat view. With the CLI compatibility check (PR #72, merged, `docs/COMPAT-2026-11-02-mods-and-cli-updates.md`) the only shared ground is the composer's built-in slash-command list, which that report and its contract table (`src/shared/cli-contract.ts`) do not cover; one entry was added there (see Changed, 3).

## What the video says

It is not a product update video. One creator ran the same coding tasks through three set-ups in Claude Code and compares time, output tokens and a score:

1. **Single**: one Claude session does everything.
2. **Agent team**: five subagents from the ECC plugin (planner, architect, tdd-guide, code-reviewer, security-reviewer), every step delegated.
3. **Single + reviewer**: the main session plans and implements, one code-reviewer subagent checks the result.

| Test (model) | Single | Agent team | Single + reviewer |
|---|---|---|---|
| 1. Mini kanban board, then 4 more features (Sonnet 5.5) | 47/47, 6.0 min, 47k output tokens, 0 agent calls | 47/47, 39.6 min, 228k, 5 calls | 47/47, 7.3 min, 55k, 1 call |
| 2. 14 real tasks of an MCP server, 110-point answer key (Sonnet 5.5) | 58 pts, 36.5 min, 228k | 52 pts, 79.6 min, 530k, 9 calls | 63 pts, 36.9 min, 257k, 1 call; the reviewer found 5 bugs |
| 2b. Single + `/code-review` afterwards | 39.8 min, 247k: "tied first" with single + reviewer | | |
| 3. Same 14 tasks (Opus 5.5) | 64 pts, 42.8 min, 248k; called 3 Explore subagents on its own | 62 pts, 63.6 min, 479k, 10 calls | not run |
| Tests 1 + 2 together | 42.5 min, 275k | 119.2 min, 758k (2.8x the time, 2.8x the tokens) | 44.2 min, 312k |

Her conclusion (06:20 to 08:50): the single session wins on time and cost; the one addition that pays for itself is an independent review after the implementation; use agents for independent review, a broad survey of a codebase, and parallel independent work, and keep one session for work that carries context from plan to tests, small fixes, speed, and back-and-forth refinement. With a plugin such as ECC, do not install everything by default: call the one agent you need (`@agent-ecc:code-reviewer`) when you need it.

## Claims, graded

Grades: correct, partly correct, wrong, 미확인 (could not be verified).

| # | Time | Claim | Grade | Evidence |
|---|---|---|---|---|
| 1 | 00:26 | Anthropic's official documentation says a team is inefficient when the task is not large, and sequential work is better done by the main Claude alone | **Correct** | Claude Code docs, [Agent teams](https://code.claude.com/docs/en/agent-teams): "For sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective." and "Too small: coordination overhead exceeds the benefit." The blog post she shows on screen does not say this; the docs do. |
| 2 | 00:40 | Splitting roles causes a "telephone game": accuracy drops as information is passed along | **Correct** | [Building agents: When to fold subagents into your main agent loop](https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop) (claude.com, 22 Oct 2026): "When agents are split by problem type, they engage in a "telephone game," passing information back and forth with each handoff degrading fidelity." The post says "split by problem type", not "small tasks". |
| 3 | 01:55 | The agents come from the GitHub repository ECC by Affaan Mustafa, winner of an Anthropic hackathon; 71 agents | **Correct** | [affaan-m/ECC](https://github.com/affaan-m/ECC) README: "Access to 71 agents, 314 skills…" and "Won the Anthropic x Forum Ventures hackathon in Sep 2025" (the author's own statement). The `agents/` folder lists 71 files, including the five used. Brian's installed ECC 2.2.1 has 68. |
| 4 | 02:40, 05:30 | Models: Sonnet 5.5 for tests 1 and 2, Opus 5.5 for test 3 | **Correct** (they exist) | `claude -p --model sonnet` on this PC resolved to `claude-sonnet-5-5`. |
| 5 | 02:50 to 06:45 | Every number in the table above | **미확인** | Her own runs, one per cell, no repository, prompt or log published. The arithmetic is consistent: the totals are the sums of tests 1 and 2 (6.0 + 36.5 = 42.5; 39.6 + 79.6 = 119.2; 47k + 228k = 275k), 119.2 / 42.5 = 2.80 and 758 / 275 = 2.76 ("2 to 3 times"), 39.6 / 6.0 = 6.6 ("about seven times"). At 05:55 the English auto-caption reads "64 to 60" where the table on screen shows 64 to 62; the Korean caption is garbled there, so the table is used. |
| 6 | 04:50 | Running the `/code-review` slash command in the single session catches the bugs as well as the separate reviewer, at about the same time and tokens | **Correct** for the feature, **미확인** for the numbers | `/code-review` is a bundled command in Claude Code 2.1.318 and runs in a sub-agent (the CLI's own changelog: "a finished `/code-review`, or another skill that runs in a sub-agent"), so it is the same shape as "single + reviewer". |
| 7 | 06:05, 07:25 | Opus 5.5 called three Explore agents by itself to read the code in parts | **Correct** that it can; the count is 미확인 | Explore is a built-in subagent of Claude Code ([Subagents](https://code.claude.com/docs/en/sub-agents)). |
| 8 | 06:50 | Anthropic's post: a single agent with skills frequently beat the subagent design on quality, often at lower cost and latency | **Correct** | Verbatim in the post: "In our comparisons across several enterprise deployments, a single agent with skills frequently outperformed both the one-prompt-for-everything design and the subagent design on quality, and often at a lower cost and latency per task." It also reports one customer with "a roughly 2x faster runtime" on a single loop. |
| 9 | 07:10 | "Anthropic gives clear criteria" for when to use agents: an independent code review after implementation, a broad survey of a codebase, parallel independent work or a review from several angles | **Partly correct** | The substance is there, the three-item list is her summary. The post: subagents "are effective at verification, parallel work, and modular permissioning"; good candidates are "independent research paths, separate components with clean interfaces, or black-box verification". The Subagents doc: use them when the output is verbose, tool limits are wanted, or "the work is self-contained and can return a summary". |
| 10 | 07:47 | More agents means more tokens | **Correct** | Agent teams doc: "token usage scales with the number of active teammates". [Costs](https://code.claude.com/docs/en/costs): "approximately 7x more tokens than standard sessions when teammates run in plan mode". Subagents doc: "each subagent spends tokens of its own while it runs." |
| 11 | 07:50 | A single Claude is better when context carries from plan through implementation to tests, for small quick fixes, when speed matters, and for conversational refinement | **Correct** | Almost word for word the Subagents doc, "Use the main conversation when": "Multiple phases share significant context, such as planning, implementation, and testing", "You're making a quick, targeted change", "Latency matters", "The task needs frequent back-and-forth or iterative refinement". |
| 12 | 08:17 | With ECC, do not install the agent rules by default; call one agent directly, for example `@agent-ecc:code-reviewer`, after the implementation | **Correct** | Subagents doc: "`@agent-<name>` for local subagents, or `@agent-` followed by the scoped name for plugin subagents, for example `@agent-my-plugin:code-reviewer`". ECC's README agrees on rules: "add only the rule packs you actually want". |
| 13 | title | "Don't use multi-agent" | **Overstated** | Her own conclusion is narrower: do not split one task into roles; do use an independent reviewer, parallel independent work and exploration. |

**Overall: accurate.** The sources are real and quoted correctly, and the advice matches Anthropic's documentation. The weak part is the data: one run per cell, self-reported, not reproducible from what is published. Two limits matter for Ouroboros. First, what she tested is **subagents inside one session**, not Claude Code's experimental agent teams and not separate sessions run by an orchestrator. Second, a board of separate sessions pays the same costs at least as much: every card re-reads the code, and every handoff carries only what the prompt says.

## Ouroboros against the claims that hold

| Claim | Ouroboros (code read at `origin/main`, line numbers are this branch) | Verdict |
|---|---|---|
| One independent review after implementation is the addition that pays (5, 6, 9) | The Reviewer preset is read-only (`permissionMode: 'plan'`, `src/shared/board-builder.ts:28`); the Conductor reviews a worker's diff with `get_changes` before accepting it (`src/main/claude-launcher.ts:191`) | **Already there** |
| Parallel work must be independent (9, 1) | `create_agent worktree=true` gives a card its own worktree; the prompt asks for it "for anything that edits code in parallel" | **Already there** |
| More agents, more tokens (10) | A cap of 6 live dispatched cards and three levels, retirement 5 minutes after a card's report (`claude-launcher.ts:194`), reuse of a card by title, and the effort guidance "cheap divergence on low, expensive convergence on high" (`:188`) | **Already there** |
| Call the one agent you need (12) | Cards run the owner's real Claude Code profile, so `@agent-ecc:code-reviewer` and every plugin subagent work inside any Claude card; the composer's `/` picker lists plugin skills and commands (`src/main/skills.ts:76`) | **Already there** (CLI feature) |
| Do not split one task into roles; keep plan, implementation and tests in one context (1, 2, 8, 11) | The Conductor's prompt said the opposite: "Prefer small parallel cards with clear markers over one long card", "one role per card", and a ten-stage **default** pipeline (Plan, Design review, Implement, Completeness scoring, Decision, Bug hunt, Bug fix, Final check, Deploy safety, Deploy guide) | **Missed: changed** (1 below) |
| Single + one reviewer is the best small team (5) | Build board could not make it: with Tester unticked there was no line from the Implementer to the Reviewer, and the Conductor's routing rules still described a Tester that was not on the board | **Missed: changed** (2 below) |
| `/code-review` in the same session (6) | The composer's `/` picker did not offer it: the built-in list had only the older `review`, and bundled skills have no file on disk for the scanner to find | **Missed: changed** (3 below) |

## Changed on `claude/right-size-team`

1. **The Conductor sizes the team before it sets up cards** (`CONDUCTOR_SYSTEM_PROMPT`, `src/main/claude-launcher.ts:209`). A new *Team size* section, read at intake: small or sequential work gets one worker card (plan → implement → test in one session) and one independent review (a Reviewer card; for a small change on a Claude card the worker may run its own code-review skill instead, and the Conductor then reads the diff itself with `get_changes`, because a worker's own review is the worker's word); more cards only for independent work (components built at the same time, a broad survey, one result reviewed from several angles, output too long for one context); the ten-stage pipeline is now the *full* pipeline for large or risky work, not the default; every dispatch must stand on its own; role cards and lines the owner already put on the board (a built board) are used as wired. The rule "Prefer small parallel cards…" became "Parallel cards are for independent work items…; one change stays in one card from plan to tests", and "one role per card" became "a worker owns its change from plan to tests, a reviewer only reviews". Tools, markers, human gates and the reporting rules are untouched.
2. **Build board with Implementer + Reviewer and no Tester works** (`src/shared/board-builder.ts:135`, `:262`). That combination now gets an automatic line Implementer → Reviewer that fires only when the Implementer's reply has a RESULT section: the label must start a line, in any of the forms a model writes it (`RESULT:`, `**RESULT:**`, `## Result`, `결과:`; `RESULT_SECTION`, `:50`), so a question that mentions RESULT in passing is not a review request. The Reviewer is asked for the changes the report lists, the uncommitted diff and any new commits. The board note and the dialog's *Lines* summary say so, and the Conductor's routing rules name only the roles that are on the board (`:88`). With all four roles ticked the generated board is the same as before.
3. **`/code-review` in the composer's `/` picker** (`src/main/skills.ts:9`). Built-ins are now listed after what is on disk, so a project's or the owner's own command of the same name shows as theirs and not as the built-in.

### What the prompt change does (planning probe)

The old and the new prompt were given to `claude -p` (Sonnet 5.5, no tools, this PC) with four owner requests, asking only for the cards and stages it would set up. Two rounds of two samples each; the second round used the final wording, after the review fixes. Cards planned, not counting the Conductor:

| Request | Old prompt (4 samples) | New prompt, first wording (2) | New prompt, final wording (2) |
|---|---|---|---|
| S: fix a typo and a year in the README | 1, 1, 1, 1 | 1, 1 | 1, 1 |
| M: one button in a React dialog, with a unit test | 1, 2, 2, 2 | 2, 2 | 2, 2 (worker + reviewer) |
| P: three independent locale files | 3, 3, 3, 3 | 4, 4 | 4, 4 (three translators + one reviewer) |
| L: payments service, 14 endpoints, a migration, an admin UI, a production deploy | 12, 13, 12, 11 | 9, 6 | 6, 5 |

Read honestly: on small tasks the old prompt was already fine with this model (it shortened the pipeline by itself), so the gain there is consistency, an independent review every time; on the parallel task the new prompt costs one card more, the reviewer. The real difference is on large work: the old prompt produced one card per pipeline stage (Design reviewer, Completeness scorer, Bug fixer, Final checker, Deploy guide writer…), 11 to 13 cards against a live cap of 6; the new one keeps builders and verifiers, 5 to 9. A plan and not a run, Sonnet only, few samples.

### Bug hunt

Two independent adversarial reviews of the diff (silent failures; security), 18 points between them, several the same, each checked against the code before anything was changed. Confirmed and fixed (seven):

- The review line's first condition (`/\bRESULT:/`) missed `## RESULT`, `**RESULT**:`, `Result:` and `결과:`, so a finished report could skip the review with no sign of it, and it fired on a question that only mentioned RESULT. It is now the line-anchored `RESULT_SECTION`, with tests for ten accepted and eight refused forms and for a 300,000-character reply staying fast.
- The prompt called a worker's own code-review run an independent review. It is now the worker's word: the Conductor reads the diff itself with `get_changes`, and the wording says "when it has one".
- The new prompt contradicted a built board's own lines (Implementer → Tester). It now says role cards and lines already on the board are used as wired.
- Routing rules for a Tester + Reviewer board without an Implementer had lost the sentence about the PASS line. Restored.
- The review template said "the current diff", which is empty once the Implementer has committed. It now names the commits too.
- A project's own `code-review` command would have been listed as the built-in. Built-ins are now listed last.
- The Build board dialog's *Lines* summary still described a Tester when none was ticked.

Looked at and left: the review line still fires on a reply whose RESULT section says "blocked" (one unneeded review by a read-only card, bounded by the line's cooldown); the board note is still not role-aware for every other subset of roles (as before).

Found, not introduced here, and worth its own change: board-trust's view of a card's incoming lines covers a line's source, mode and template but not its **condition** (`src/shared/board-trust.ts`, `incomingOf`), so a board file edited outside the app can drop any line's condition without the card being held. Adding the field changes what existing boards compare against, so it needs its own design and test pass.

## Left as it is, and why

| Item | Why it was not changed | Recommendation |
|---|---|---|
| Build board ticks all four roles by default (`src/renderer/src/panels/BoardBuilder.tsx:37`) | The video did not test a tester-then-reviewer chain, and Anthropic's post names black-box verification as a good use of a separate agent. Changing what a new board looks like is Brian's call. The new prompt tells the Conductor to use a built board as wired, so the two do not contradict each other | Untick Tester for a small project: the board then is the video's winning shape, and it now wires itself. Keep the default |
| "Do not do the coding yourself when a card for it exists" (`claude-launcher.ts:231`) | The video's winner is the main session doing the work itself. In Ouroboros the Conductor is the owner's one point of contact and must stay responsive with a small context; letting it code changes what the Conductor is | Keep the rule. One worker plus one review is the board's version of "single + reviewer" |
| Plugin subagents (ECC's 68) as card roles in `list_roles` (`src/main/roles.ts:88` reads only `.claude/agents`, `~/.claude/agents` and the Agency roster) | A card per plugin agent is the pattern the video argues against, and a Claude card can already call `@agent-ecc:code-reviewer` inside its own session | Not now |
| Time and output tokens per card, to repeat her experiment on the board | No request for it; `/cost` inside a card and the Usage view exist | Not now |
| The older `review` entry in the picker (`skills.ts:21`) | Whether 2.1.318 still accepts `/review` is 미확인: its description string is gone from the binary, a headless probe was inconclusive | Leave it; PR #72's `npm run compat` is the place to add a slash-command check |
| Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) | Experimental and off by default; Ouroboros does not use or depend on it | Nothing to do |

## Not verified

- A live Conductor on a real board with the new prompt: the probe above is a plan from a headless session without tools, on Sonnet 5.5. Whether the cards a real run creates, the time and the tokens follow it is not measured.
- The new Implementer → Reviewer line firing in the built app (unit tests cover the generated edge and its condition).
- The picker entry in the built app.
- The video's own numbers.
