# Orca's chat view vs Ouroboros, and the chat view built here (2026-11-05)

Source: the Instagram reel https://www.instagram.com/reel/DfTCNo1J2--/ (not watched: this report goes by its caption) and Orca's own repository, release notes and docs, read through the GitHub API on 2026-11-05. Nothing was cloned or run. Baseline for Ouroboros: `main` d3baabf (v0.18.10 plus PRs #69 to #72, unreleased).

## What the reel claims

- Orca's chat screen is now a regular feature; Settings picks chat or terminal per agent.
- For the same question the terminal answers in text and the chat answers with visuals (a diagram of what each of three files does, and which file to edit for menu items and prices).
- It runs on the user's Claude Code subscription at no extra cost.

## What Orca actually does

| Question | Finding | Evidence |
|---|---|---|
| Repo, license, stack | `stablyai/orca`, MIT (Lovecast Inc.), Electron 43 + React 19 + TypeScript | `LICENSE`, `package.json` |
| When | "Chat UI is out of experimental: Choose Chat or CLI for each agent" in v1.4.246 (2026-11-02); new installs still start in Terminal | release notes |
| How it talks to Claude Code | Not a terminal. It drives the user's installed `claude` through `@anthropic-ai/claude-agent-sdk` (the stream-json protocol), with its own spawn hook | `src/main/claude/claude-stream-json-connection.ts`, `claude-agent-sdk-process-spawn.ts` |
| Codex and others | `codex app-server` for Codex; ACP for Grok, OpenCode and others | `src/main/codex/app-server/*`, `src/main/acp/*` (file names; spawn arguments not read) |
| Billing | The local `claude` binary and its own sign-in; no API key | `claude-structured-auth-policy.ts` (the environment-building code was not traced) |
| Markdown | react-markdown + rehype-sanitize, Mermaid fences drawn after streaming ends | `NativeChatMarkdown.tsx` |
| The "visual answer" | A bundled Claude plugin and skill tell the model to write a whole HTML page into a scratch folder and name it in the reply (`::orca-visual{file="x.html"}`); the page is shown in a script-enabled iframe whose CSP allows scripts from four CDNs | `resources/native-chat-visuals/`, `NativeChatVisualFrame.tsx`, `native-chat-visual-shell.ts` |
| Permissions | The SDK's `canUseTool` callback feeds a prompt card in the transcript | `claude-permission-presentation.ts` |
| Chat and terminal | A structured chat has no terminal behind it. "Continue with Terminal Agent" starts a new session with a copy of the conversation. Only the older terminal-backed chat toggles in place | `docs/.../native-chat.mdx` |
| Known issues | Claude's own Artifacts do not work in chat (#37609), Windows chat bugs (#38127), chat stalls called out in the v1.4.249 notes | issues, release notes |

Not verified: whether Orca injects any API key in some path, Mermaid's `securityLevel` in Orca, and how tool calls are folded.

## The two ways to bring it to Ouroboros

**(a) A chat rendering on the existing session.** The card keeps running the interactive `claude` in its PTY. The chat view reads the session's transcript (the JSON-lines file its hooks already name) and draws it; the composer types into the same terminal. The terminal stays mounted underneath.

**(b) A separate headless card kind** driven by the Agent SDK or `claude -p --output-format stream-json`, as Orca does.

| | (a) layered on the session | (b) headless/SDK card |
|---|---|---|
| Subscription billing | Unchanged: the same `claude`, the same sign-in | Works today through the local CLI, but it is a second launch path to keep in line with Claude Code's terms and releases |
| Hooks (status, gate, announcements, autonomy rails) | Unchanged | Would need re-wiring: the per-card `--settings` hooks do run in `-p` mode, but the status model (ready text, trust question, permission notifications) is built on the TUI |
| Session inbox, board MCP server | Unchanged | The inbox socket and `--mcp-config` would need re-checking in headless mode |
| Relay (`/clear`), `read_output`, phone page, Ouro, far-zoom summary | Unchanged: they read or type into the terminal, which is still there | Each needs a second implementation or stops working for these cards |
| Permission prompts | Answered in the terminal, one click away | Needs a `canUseTool` bridge and an approval UI (and its own rules for autonomous runs) |
| Token-by-token streaming | No: a reply appears when Claude Code writes it to the transcript (per message block) | Yes |
| Switch chat and terminal on a running session | Yes, in place, any time | No (Orca copies the conversation into a new session) |
| Size | One read-only IPC call, one parser, one view | A new card kind across launcher, board, hooks, gate, relay, phone |

**Chosen: (a).** It is the only one of the two that keeps subscription billing, the hooks and the board tools working with no change to them, and it gives something Orca's structured chat does not have: the same session in both views. The price is no token streaming and no in-chat approval buttons, both listed below.

## What was built

- **View per card, default in Settings.** A button in a Claude card's header switches between terminal and chat at any time; Inspector → *View* pins a card; Settings → Engines → *Card view* sets the default (terminal, as before). Codex, Gemini, Grok and WSL cards always show the terminal: their transcripts are not read.
- **The conversation** comes from the transcript through one read-only IPC call (`chat:read`). Main picks the file (the one the card's hooks named, else the one of the session it resumes), only under the Claude Code config folder, and reads at most 2 MB per call; the renderer never passes a path. Prompts, replies (markdown, tables, code, clickable file paths as in the Inspector), thinking and tool calls (folded, with input and result) and compaction and `/clear` markers are shown. Subagent turns and harness reminders are left out.
- **Visuals.** A top-level fenced ```` ```mermaid ```` block is drawn with Mermaid; a ```` ```svg ```` block is drawn as is. A Claude card launched in chat view gets one fixed paragraph appended to its system prompt saying the view draws these (without it Claude Code assumes a terminal and never draws). A diagram that fails keeps its source visible with the reason.
- **Composer.** Enter sends (not while an IME composition is open), Shift+Enter breaks the line, a stop button interrupts. It types into the terminal as the left composer does (bracketed paste, then Enter), and holds the Enter back if the card started asking a question in between. It refuses, with the text kept in the box, while the card is starting, ended, or asking a question. A sent prompt stays as a pending bubble until the transcript shows it (matched on its text, one transcript line per prompt, including a prompt Claude Code took mid-turn, which it records only as a `queued_command` attachment); if that never happens it is marked and stays until dismissed, also across a switch to the terminal and back. A slash command shows the terminal, because it may open a menu only the terminal draws.
- **Questions the card asks** (permission prompts, the trust question) are answered in the terminal: the chat shows a *Needs you* bar with the pending tool call and *Answer in the terminal*, which shows the terminal until the card carries on. Nothing in the chat presses keys for the owner.

### Safety of rendered model output

- Markdown goes through the existing sanitiser (raw HTML shown as text, DOMPurify, http(s)/mailto only).
- SVG, from the model or from Mermaid, goes through a second DOMPurify instance: no script, `foreignObject`, `image`, `feImage`, `a` or SMIL elements; `href` may only be `#id`; any attribute or stylesheet with a `url()` that is not `url(#id)`, an `@import`, `image()`/`image-set()` or a backslash is dropped. A model's own SVG may not carry CSS at all.
- Mermaid runs with `securityLevel: 'strict'` and `htmlLabels: false`, and its source has every tag-opening `<` escaped first (`<br>` and `<<annotation>>` excepted). Reason: in a test, Mermaid 12.2 in strict mode still handed an `onerror` from a label to an HTML parser (the page's CSP blocked it). With the escaping, none of nine markup and entity variants produced an image request or a handler.
- A diagram cannot change Mermaid's settings for itself: `themeCSS`, `fontFamily`, `theme`, `themeVariables`, `htmlLabels` and `dompurifyConfig` are locked (`secure`). Before the lock, a `%%{init}%%` directive or front matter put its own CSS into the page while the diagram was being drawn (seen as a CSP report for a `url()` in `themeCSS`).
- **A new wall in the main process.** The test harness showed that the window's CSP does not stop a `file:` URL on another machine: `'self'` on a page loaded from disk matches every `file:` URL, so an image at `file://host/share/x.png` (what a UNC path becomes) was requested with no CSP report. Windows would offer the owner's sign-in to that machine. Mermaid's image shapes (`@{ img: … }`) reach exactly that while a diagram is drawn. The app window's session now cancels every `file:` request that names another machine (the app's own machine excepted, if it is installed on a share). Browser cards have their own session and are not affected. This also backs the markdown sanitiser, which already refused such URLs.
- The window's CSP is unchanged (scripts from the app only, images from the app or `data:`); it stops `http(s)` loads (seen as CSP reports in the harness). No CDN, no remote load, no iframe.

### New dependency

`mermaid` 12.2.0 (MIT), exact version, as a **devDependency**: Vite bundles it into the renderer as lazy chunks (loaded with the first diagram), and electron-builder does not ship `node_modules` for it. 12.3.0 was two days old on 2026-11-05 and was passed over. Its transitive packages are the usual d3, dagre, cytoscape, katex, dompurify set; their licenses were not audited one by one.

## Out of scope (not built)

1. **Token streaming.** Needs option (b) or a stream tap; the transcript only has finished blocks.
2. **Approve/deny buttons in the chat.** The safe route is a `PermissionRequest` hook that waits for the owner, not pressing keys into a dialog whose default differs per dialog (the trust question's default is "No, exit").
3. **Orca-style HTML pages** (charts with script). They need a script-enabled frame and CDN loads, which the app's CSP forbids on purpose. Mermaid and SVG cover diagrams.
4. **Chat for Codex, Gemini, Grok and WSL cards.** Each needs its own transcript reader.
5. **Syntax highlighting, image attachments in the composer, the `/` command picker, chat on the phone page.**
6. A headless card kind (option b).

## Verified / not verified

Verified: unit tests (parser, incremental reader, view choice, composer rules, pending-prompt matching, CSS and reference rules, Mermaid escaping, the `file:` rule); typecheck; build; a throwaway harness (not committed) that mounted the real `ChatView` in Electron 45's Chromium under the app's CSP with a canned transcript: three diagrams drawn, a broken one shown as source, ten Mermaid diagram kinds, nine hostile SVGs and sixteen hostile Mermaid sources (markup and entity variants in labels, `click` links, `%%{init}%%` and front matter, image shapes, icons) leaving no handler, link, image or foreign markup in what is mounted, the composer refusing while the card asks and typing once it is idle. An adversarial review (silent failures, security) followed; its confirmed findings are fixed and listed in the CHANGELOG.

Not verified: a real Claude card in the built app (view switch on a live session, the transcript following a live turn, the system-prompt paragraph producing diagrams, a permission prompt answered through the bar, a slash command showing the terminal), the main-process `file:` wall in the packaged app (the rule is unit-tested and the harness showed Electron's `webRequest` sees and can cancel these requests, but the app's own handler was not run), relay (`/clear`) seen from the chat, very long transcripts on a slow disk, the shape of an owner-typed `queued_command` (the one read from a real transcript was a task notification), and the three CSP console messages Mermaid's first render produces (blocked, harmless, cause not traced).

Left as they are (reported by the review, not fixed): a prompt sent while a menu no hook announces is open in the terminal (the chat cannot see it; slash commands sent from the chat show the terminal, a menu opened by other means does not); a card's own hook can name another of the owner's transcripts under the Claude config folder, and the chat would then show that conversation.
