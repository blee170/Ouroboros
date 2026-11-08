# Ouro calls you: design (2026-11-08)

Brian wants Ouro to phone him when something needs him and he has not reacted, and the call should feel like a call from a person, not a touch-tone menu: Ouro explains, offers choices, listens, confirms, acts. A phone call is the one channel Android Auto handles the same for every app, which is why it beats the Discord DMs (never shown in the car) and SMS (dropped).

Reference: the short "Claude Code can call you now" (Hridyesh AI, 2026-11-04) shows Bland AI placing the call and a bridge on the PC answering the agent's questions from Claude Code. Bland has no Korean evidence and its own LLM, so the stack here is different; the shape of the call (situation → choices → spoken answer → act → tell the others) is the same.

## Decision

Council of four (Architect, Skeptic, Pragmatist, Critic) over four stacks: Twilio ConversationRelay with Claude streamed from the app (A), ElevenLabs Agents with Claude built in plus a Twilio number (B), Bland plus a bridge (C), a Twilio `<Gather>`/`<Say>` menu (D). B won 3–1 (the Critic preferred A for keeping every rule inside the app; its requirements are adopted below). Brian chose B on 2026-11-08.

Why B: ElevenLabs runs speech-to-text, text-to-speech, turn-taking and the Claude loop (Sonnet 5.5 / Haiku 5.5 billed at provider price through their account, no Anthropic key), has the strongest Korean evidence (Korea operations since Nov 2025 with a Korean model, a Korean senior-care deployment praised for honorifics), and leaves the app with webhooks only: no WebSocket, no token streaming, no barge-in code in Electron.

## Shape

```
Ouro notice (Discord DM, as today)
  └─ 5 min, no reaction ──► VoiceCaller.call(needs)
        Twilio Calls API: To=<owner phone, pinned in Settings>, From=<Twilio number>,
        Url=/ouro/call/answer?c=<token>, StatusCallback=/ouro/call/status?c=<token>,
        MachineDetection=Enable, Timeout=25, TimeLimit=<cap>
Twilio ──POST /ouro/call/answer──► app (X-Twilio-Signature checked; machine → <Hangup/>)
        app ──POST /v1/convai/twilio/register-call (agent_id, from, to, direction=outbound,
             conversation_initiation_client_data.dynamic_variables {owner_name, situation, options, call_token …})──► ElevenLabs
        app ◄── TwiML ── returns it to Twilio (application/xml)
ElevenLabs agent (Claude) talks; one server tool `ouro_action` ──POST /ouro/call/tool──► app
        header X-Ouro-Call-Key (provisioned secret) + body call_token; action ∈ status|approve|hold|later|reply|answer
        app acts through the same approve/hold/answer path the Discord dialogue uses, returns one line for the agent to say
Twilio ──POST /ouro/call/status──► app (completed / no-answer / busy / failed → run log, DM on a miss)
ElevenLabs ──POST /ouro/call/post──► app (ElevenLabs-Signature HMAC; transcript → run log + DM summary)
Inbound: Twilio ──POST /ouro/call/inbound──► app (signature; every caller → <Reject/>, unbilled;
        From = owner's number → VoiceCaller places a call back to the pinned number with the status and the board)
```

Nothing is ever answered on an inbound leg: caller ID is set by the caller and Australia has no STIR/SHAKEN attestation, so a number that reads as the owner's proves nothing. Ringing the number is a request for a call back, which goes to the real number, counts against the daily cap and the one-call-at-a-time rule like any other, and so a spoofed call at worst rings the owner.

The app creates the Twilio call itself rather than using ElevenLabs' outbound endpoint, so the destination number, answering-machine detection, the time limit, the status callbacks and the webhook signatures all stay in the app, and ElevenLabs never holds the Twilio credentials or the number.

All routes sit on the existing loopback reply server (`GrokReplyServer`, 127.0.0.1, Tailscale Funnel on 8443), which now runs when either Grok replies or Ouro calls are on.

## Triggers

1. Board needs, as today: a question, a gate approval, a task waiting on the owner.
2. Someone asks for Brian on Discord: a server message that @mentions him or replies to one of his, or a direct message to the bot from someone else. The bot gets the GUILD_MESSAGES intent; everything else is filtered out in-process. Each becomes an Ouro need of kind `mention` (title `#channel · author`, text = the message, cut), read out like any other need and cleared when Brian writes in that channel, when he picks "later" or "reply" on the call, or after 2 hours.

Gmail is not in this change (a new OAuth connection and the app reading personal mail: Brian's call). KakaoTalk has no API.

## The ladder

A fresh need is told on Discord as today (what already waits when Ouro connects is told in the greeting and waits the same way). A timer starts (default 5 min). When it fires the call is placed only if: calls are on and configured, the need is still open, it was not called about before, Brian sent no Discord message since the notice, the PC has been idle for over a minute (someone typing at the PC has the board in front of them), it is not quiet hours (default 23:00–07:00 local), the daily cap is not reached (default 6) and no call is under way. A skip for one of the last three reasons starts the wait over while the need still stands, so a need that arrives at 22:58 is called about after quiet hours end. Several fresh needs within the window go into one call. Calls set off only by people asking for Brian on Discord (no board need in them) come out of a budget of two a day, so a stranger's messages cannot spend the cap. A miss (no answer, busy, machine) is a DM and no retry. When the call cannot be placed, or Twilio never calls back within 90 s (Funnel down, PC asleep; Twilio reports initiated and ringing as soon as it can reach the PC), Brian gets a DM saying so, so silence never looks like "nothing urgent". A call that connected but ended before Ouro's voice joined (ElevenLabs slow or down) is a DM too. An answered call whose end Twilio never reports is closed by the app two minutes after the time limit, so a lost callback cannot block the next call. Dials Twilio refuses never rang and do not count against the cap.

## The call

First message: "{owner_name}, 우로예요. {situation}" then the options. The options are an app-generated menu per need kind (approve / hold / later; a question's own answers; for a mention: reply with a canned line, later, leave it); the triggering message is quoted inside a fence marked as information from someone else and never becomes an option. The agent reads a choice back and confirms before calling the tool; what Discord Ouro refuses by voice (permission prompts, tasks only the owner can do, approvals whose command cannot be read aloud) the tool refuses too. The call ends on "끝" / "고마워", on 20 s of silence, or at the time limit. Voice alone never does anything irreversible that Discord Ouro would not do.

## Security requirements (from the council, all stacks)

- The owner's phone number lives in Settings only and is not settable over any HTTP route; Twilio always dials it.
- Every webhook is checked: Twilio's X-Twilio-Signature (HMAC-SHA1, URL with and without the port, since Twilio signs voice-over-HTTPS URLs without it), ElevenLabs' `ElevenLabs-Signature` (`t=…,v0=HMAC-SHA256(t.body)`, 30 min tolerance), the tool's provisioned key, all compared in constant time. Unknown or finished call tokens get `<Hangup/>` / 404.
- No inbound call is answered (not billed); caller ID is not trusted at all. The owner's number ringing in asks for a call back to the pinned number. A badly signed voice webhook gets `<Reject/>` or `<Hangup/>`, never an error page Twilio would answer the call to read out.
- The webhook address a call was placed with is kept on the call and used to check its signatures, so the setting moving mid-call does not turn the owner's call into 403s.
- Names and channel names from Discord are fenced in the agent's prompt like the message itself; `{{ }}` inside any third-party text is broken so ElevenLabs cannot expand it as a variable.
- Retention: the bot receives every server message (GUILD_MESSAGES) and drops all but mentions, replies and DMs in-process; a mention's excerpt and a call's summary go to the autonomy run log; mentions are held in memory for at most two hours.
- Caps: one call at a time, n per day, m minutes per call (Twilio TimeLimit and the agent's max duration both), one call per need. A crafted "urgent" mention is a cost attack otherwise. Brian also sets a spend alert in Twilio.
- Secrets (Twilio auth token, ElevenLabs key, tool key, webhook secret) are stored encrypted like the other tokens and never logged.

## Files

- `src/shared/ouro-call.ts` (new, pure): settings view + parser, E.164, quiet hours, the menu and dynamic variables, the untrusted fence, the agent prompt, TwiML snippets, limits.
- `src/main/voice-call.ts` (new): `VoiceCaller` (Twilio and ElevenLabs clients over fetch, the routes, the call sessions, the call log with the daily cap, provisioning of the tool and the agent, the two signature checks).
- `src/main/discord.ts`: GUILD_MESSAGES intent; `mention` and `ownerSpoke` events.
- `src/main/ouro.ts`: mention needs, the ladder, a voice bridge (needs, act with the same refusals, status).
- `src/main/grok-reply.ts`: extra routes on the reply server; `src/main/ipc.ts`, `src/main/index.ts`: wiring, IPC, the server runs when either feature is on.
- `src/shared/types.ts`, `src/shared/protocol.ts`, `src/preload/index.ts`: settings and API.
- `src/renderer/src/panels/OuroCallSettings.tsx` (new, mounted in Settings → Ouro): numbers, keys, caps, quiet hours, the webhook addresses to paste into Twilio and ElevenLabs, Provision, Test call.
- Tests: `tests/ouro-call.test.ts`, additions to `tests/ouro-main.test.ts`, `tests/discord.test.ts`, `tests/grok-reply.test.ts`.

## Not verified here

Korean on the agent (`language: "ko"`), tools during a register-call outbound call, Twilio and ElevenLabs accepting webhook URLs on port 8443 (fallback: Funnel on 443), real Korean recognition in a moving car, what the owner hears on `<Reject/>` before the call back arrives (a reject tone or a short announcement, carrier-dependent), and the plan minutes (Free 15, Starter 75 a month, $0.08/min after, LLM on top). Only a live call on Brian's accounts settles these; the first one is the test. Known limit: the ladder runs off the Discord notice, so with the bot down or notifications off there is no call either.

Bug hunt 2026-11-09 (silent-failure hunter and security reviewer, both Opus, on the diff): confirmed and fixed here: caller-ID spoofing on the inbound route (now reject-and-call-back), an inbound session that never ended without the post-call webhook and blocked every later call, an answered call relying on a single Twilio callback (backstop timer), the watchdog racing a slow pick-up (status events for every step, 90 s), "completed" without an answer logged as a normal call (now `dropped`, a DM), skipped calls never retried, needs in the greeting never armed, failed dials spending the cap, mentions spending the cap, unfenced names in the prompt, `{{ }}` in third-party text, the base address moving mid-call, a future timestamp on the ElevenLabs signature, a replayed post-call webhook telling the summary twice, two DMs on one ElevenLabs failure, sessions and channel names growing without bound, no fetch timeouts. Left as noted: the ladder's dependence on Discord (above), a slow channel-name lookup holding the DM queue for up to 15 s.

## Cost

Per minute about $0.08 (ElevenLabs) + Claude tokens (~$0.01–0.06) + $0.075 (Twilio, AU mobile) + $0.0075 per call for machine detection; an AU local number is $3 a month.
