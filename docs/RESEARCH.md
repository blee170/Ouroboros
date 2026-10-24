# Ouroboros — 기획 조사 기록 (2026-10-21)

이 문서는 코드를 쓰기 전에 한 조사·검토를 보존한다. 결론부터: **상용 제품이 아니라 본인용 "Symvibe Windows판"** 을 만들기로 했다.
근거가 되는 사실 확인, 경쟁 조사, 가치 평가를 아래에 남긴다. 출처는 각 항목의 URL. 확인 못 한 것은 UNVERIFIED.

## 1. Gemini 답변 사실 확인

| 주장 | 판정 | 확인 내용 |
|---|---|---|
| Symvibe $19/월, $190/년 | 맞음 | Pro 단일 플랜(1인), 무료 체험 없음, 첫 구매 14일 환불, 음성 플래너 월 10,000 크레딧. 오프라인 15분 후 잠금. https://www.symvibe.com/tour , https://www.symvibe.com/download |
| macOS 전용 | 맞음 | macOS 14+ Apple Silicon. Windows/Linux/Intel 빌드·로드맵 없음. Hypervibe→Symvibe 개명. 제작: Lucio Sianca LLC(인디). https://www.symvibe.com/ , https://www.producthunt.com/products/hypervibe-2 |
| Jev = TypeSafe AI "System 1" 모델, Choice/Score 모델 변종 | 절반 맞음 | TypeSafe AI와 모델 `jev-1.13.0`/`jev-latest` 실존(호스팅 API, Python `typesafe-sdk`, JS `@typesafe-ai/sdk`). Choice/Score는 모델이 아니라 **질문 타입**(Noul/Choice/Score). 2026-09-15 얼리액세스. https://github.com/typesafe-ai , https://github.com/typesafe-ai/typesafe-sdk-js |
| REA(Reverse Engineer Anything) 스킬로 앱을 만들 수 있다 | 부적합 | `morluto/rea`(MIT)는 Ghidra/IDA로 **기존 바이너리를 분석**하는 도구. 앱 제작과 무관. Windows 지원 제한적. https://github.com/morluto/rea |
| OpenHands Agent Canvas | 실존, 다른 제품 | 이름과 달리 그래프 캔버스가 아니라 채팅형 "developer control center". 2026-07 본 저장소 병합, MIT, Windows Electron 설치기(v1.29.0). 음성·메신저·비개발자 기능 없음. https://github.com/OpenHands/OpenHands |
| ego(lite) 브라우저 | 실존 | Citro Labs `ego-lite`(MIT). 에이전트용 Chromium, `ego-browser` CLI, Windows 지원(README). https://github.com/citrolabs/ego-lite |
| Aside 브라우저 | 실존 | YC F25, Windows 2026-09-14 정식. **CLI + MCP(`aside mcp`) + REPL** 공식. https://docs.aside.com/help/developers |
| "Claude 3.5 Sonnet" 추천 | 구버전 | 현행: Opus 5.5 `claude-opus-5-5`($4/$20), Sonnet 5.5 `claude-sonnet-5-5`($2/$10), Haiku 5.5 `claude-haiku-5-5`($0.10/$0.50), Fable 5.1(최상위). 모두 1M 컨텍스트. |

플랫폼 제약:
- Chrome 136+는 일반 프로필에서 `--remote-debugging-port` 무시 → 기존 로그인 브라우저에 CDP로 붙을 수 없음. https://developer.chrome.com/blog/remote-debugging-port
- Google Play: SMS/통화기록 권한은 기본 문자/전화 앱만. 알림 접근(NotificationListenerService)+인라인 답장(RemoteInput)이 현실 경로. https://support.google.com/googleplay/android-developer/answer/9047303
- Windows 코드 서명: Azure Trusted Signing은 US/CA/EU/UK 법인 중심(개인·한국 법인 UNVERIFIED). OV/EV 인증서 연 $200~500.
- Claude Code hooks: `"type":"http"` 훅 공식 지원, 이벤트 30여 개. https://code.claude.com/docs/en/hooks

## 2. 경쟁 조사

### 2-1. 멀티 에이전트 캔버스/관제탑 (Windows 지원 여부)
| 제품 | 플랫폼 | 가격 | 비고 |
|---|---|---|---|
| Symvibe | macOS | $19/월 | 모티브 |
| ccanvas | Win/mac/Linux (Tauri) | 무료 Apache-2.0 | Claude Code 전용 무한 캔버스, "flow piping" 언급. https://github.com/DevoidSloth/ccanvas |
| TermCanvas | Win/mac/Linux | 무료 MIT | 터미널 캔버스+worktree. https://www.termcanvas.com/ |
| Pane | Win/mac/Linux | 무료 AGPL | worktree별 에이전트. https://runpane.com/ |
| Vibe Kanban | Win/mac/Linux | OSS | 칸반. https://www.vibekanban.com/ |
| AgentGrid | Win/mac/Linux | 상용 | 터미널·노트·git 캔버스 |
| Conductor / Superset / Maestri / Director / CodeGrid | macOS | 다양 | Windows 없음 |
→ "Windows판 Symvibe"는 무료 대안이 이미 4개 이상. 유료 차별화 불가.

### 2-2. 개인 비서 에이전트 (외출 중 메신저·음성)
| 제품 | Windows | 메신저 | 음성/모바일 | 그래프 뷰 | BYO |
|---|---|---|---|---|---|
| OpenClaw (MIT) | 네이티브 | Telegram·WhatsApp·Slack·Discord 등 20+, 카톡은 커뮤니티 릴레이만 | iOS/Android 앱, Talk Mode | "Canvas" 표면(그래프 아님) | ✅ |
| Hermes Agent (MIT) | 네이티브/WSL2 | Telegram·Discord·Slack·WhatsApp·Email | 음성메모 | ✗ | ✅ |
| Claude Code Remote Control/Channels/Agent View | ✅ | Telegram·Discord(프리뷰) | 모바일 앱 | 목록 | 구독 |
| Claude Cowork + Dispatch | ✅ | 폰 앱 | 폰 | ✗ | ✗ |
| Gemini (Android Auto·Wear OS) | ✗ | SMS, WhatsApp 발신 | 최강, 확장 불가 | ✗ | ✗ |
| 관리형 OpenClaw: Genspark Claw $9.99~, Hostinger $5.99~, xCloud/OneClaw $9.99 | 클라우드 | LINE 포함, 카톡 없음 | — | ✗ | ✗ |
→ 전부 하는 제품은 없음. 가장 가까운 것은 OpenClaw. 공통 공백: 카카오톡·SMS, 차/워치/안경 음성, 라이브 그래프, 비개발자.

### 2-3. 채팅→워크플로 생성 빌더
Zapier Copilot/Canvas, Make AI, n8n AI Builder, Gumloop, Google Opal, Power Automate Copilot, Lindy가 "말하면 워크플로가 그림으로" 를 이미 제공. 비기술자용으로 가장 쉬웠던 Relay.app(2026-09 종료)과 OpenAI Agent Builder(2026-11-30 종료)는 문을 닫음. 카카오톡 개인 대화 지원 제품 없음.

### 2-4. 식당 운영 SaaS (로스터·발주)
7shifts·Homebase·Deputy·When I Work·Connecteam·Planday(스케줄, 지점당 $0~56), Nory(AI 스케줄+AI 발주, 지점당 ~$349, 2개 지점 이상), Choco·Rekki·Ordermentum(발주, 식당 무료), 한국: 시프티(카카오워크만), 마켓봄(업체 계정 필요), 캐시노트(매출 Q&A). 메신저 입력→로스터·발주를 하는 제품 없음. 비자 근로시간 규정은 HotSchedules가 2026-07에야 추가.

## 3. 가치 평가 (냉정한 판단, 순서대로 내린 결론)
1. **글로벌 개발자 관제탑($19/월)**: 사업 가치 낮음. 무료 경쟁자 다수, Anthropic이 Remote Control·Channels·Agent View로 같은 방향을 직접 만듦, 고통이 간헐적.
2. **범용 "설정 없는 AI 비서"**: 낮음. 관리형 OpenClaw 호스팅($5.99~)과 Zapier류가 이미 차지. 비기술자가 범용 도구를 못 쓰는 이유는 UI가 아니라 자기 업무를 명세로 풀지 못해서.
3. **한국형 관리형 에이전트 + 업종 템플릿(카톡 로스터·발주)**: 중간. 문제 실재, 경쟁 공백(카톡, 비자 규정), 그러나 단가 작고 영업 무겁고 규정 오류 책임이 큼. 생활형 규모.
4. **시각화 단독**: 기능이지 제품이 아님. 선이 실제 동작할 때만 가치. 일반인은 아직 볼 에이전트가 없음.
→ 결정: **본인용 Windows Symvibe(Claude Code 캔버스 + 동작하는 선 + 총괄 노드)** 를 만든다. 사업화는 이 도구를 쓰며 다시 판단.

## 4. 영상(1인 AI 창업 "폴시아") 교훈
월 AI 비용 $50만→$120만 폭증, GPU 자체 호스팅으로 원가 절감 후 가격 인하 → 매출 1/3 증발, 트래픽 못 버텨 재작성, ARR≠실매출, 리뷰 2.1점("끝까지 못 함").
- 고객 수에 비례하는 AI 원가를 벤더가 지면 안 된다 → BYO 키/구독 구조.
- 사용자 측 토큰 폭주 방지(예산·비용 표시)와 **작업 완료율**이 비서형 제품의 핵심 지표.
- 무료 플랜 금지, MRR로만 관리, 홍보보다 고객 가치 증명.

## 5. 클라우드 세션 → 로컬 이전
- `claude --teleport` (또는 세션 안 `/teleport`): 대화 전체 + 브랜치를 로컬로. 조건: 같은 claude.ai 계정, 같은 저장소 클론, 브랜치 푸시됨, git 깨끗함. 단방향. https://code.claude.com/docs/en/claude-code-on-the-web
- 간단 경로: `git fetch origin && git checkout <branch> && claude` (대화 이력 없음).
- 반대 방향: `claude --remote-control` → 폰/웹에서 조종. https://code.claude.com/docs/en/remote-control


## 6. 유사 프로그램 조사 → 우로보로스 개선 (2026-10-22, 0.2.6)

### 6-1. 비교표
| 제품 | 형태·플랫폼 | 가격/라이선스 | 핵심 구현 방식 | 강점(가져올 것) |
|---|---|---|---|---|
| [Conductor](https://vibecoding.app/blog/conductor-review) | macOS 앱 | 로컬 무료 / Pro $50월(클라우드 워크스페이스·5인 멀티플레이어·API) / Teams $60인 | 작업마다 git worktree + 브랜치, 에이전트 CLI 그대로 실행 | [Diff Viewer](https://docs.conductor.build/core/diff-viewer): 변경 검토, 코멘트를 에이전트에 되돌려 보내기, 파일 되돌리기, 커밋별 보기; Create PR; Checks 탭(CI·리뷰 코멘트). 에이전트 간 핸드오프 없음, 병합은 수동 |
| [Symvibe](https://www.symvibe.com/) | macOS 앱 | $19월 / $190년 | 보드 위 실제 PTY 터미널, 30+ CLI 에이전트, 음성 플래너(월 10,000 크레딧, 서버 경유) | 모티브. 독립 리뷰 없음, 선(line) 기능 문서 없음 |
| [Superset](https://superset.sh/compare/superset-vs-emdash) | 데스크톱, 로컬 우선 | 소스 공개(ELv2), 팀·클라우드 지향 | worktree 격리 + 영속 터미널, diff/파일 편집기, 인앱 브라우저(문서·dev 서버), 포트 관리, MCP 서버·CLI·TS SDK·Slack 봇, 예약 실행(automations) | MCP로 에이전트가 앱을 조종(우리와 같은 설계), 자동화 예약 |
| [Emdash](https://superset.sh/compare/superset-vs-emdash) | 데스크톱 (YC W26) | Apache-2.0 | worktree별 에이전트, 로컬 또는 SSH 원격, 30+ 에이전트, 이슈 트래커 12종 연동 | 폭넓은 연동 |
| [Mux (Coder)](https://github.com/coder/mux) | 데스크톱+브라우저 | AGPL-3.0 무료 | 로컬 폴더·worktree·SSH 워크스페이스, 자체 에이전트 루프, Plan/Exec 모드, 모델 라우팅 | 토큰·비용 가시성, 재시작 후 스트림 자동 재개 |
| [ccanvas](https://github.com/DevoidSloth/ccanvas) | Tauri, Win/mac/Linux | Apache-2.0 | 무한 캔버스: agent/term/files/diff/editor/note 위젯, 체크포인트(git 스냅샷), 트랜스크립트 위젯 | **컨텍스트 미터(70% 넘으면 compact 버튼)**, 로스터(상태·비용·턴·마지막 답), 브로드캐스트, 프롬프트 라이브러리, 파일 드롭→경로 붙여넣기, ⌘1-9 점프, 미니맵, 레이아웃 템플릿 |
| [Nimbalyst](https://www.implicator.ai/nimbalyst-claude-code-codex-mac-windows-linux/) | Electron, Win/mac/Linux | 개인 무료, MIT | 세션 보드 + 편집 파일 나란히, worktree 선택 | Crystal 후속. Windows 지원 |
| [Vibe Kanban](https://zenn.dev/maedana/articles/claude-code-multi-session-tools-comparison?locale=en) | 웹/칸반 | Apache-2.0, 커뮤니티 유지(Bloop 2026-04 종료) | 카드=에이전트 워크스페이스 | 칸반 상태 흐름 |
| [Claude Squad](https://www.augmentcode.com/tools/open-source-agent-orchestrators) | TUI(Go) | AGPL-3.0 | tmux 세션 + worktree per agent | 터미널 우선 |
| [Claude Code 데스크톱](https://code.claude.com/docs/en/desktop.md) (공식) | Win/mac | 구독 | 세션별 worktree, Changes(diff) 패널·줄 코멘트, PR 모니터링(Auto-fix, Merge when ready), Side chat, Background tasks, 세션 간 메시지, 브라우저 패널+Auto-verify, Dispatch(폰), Context 카드 | **Agent View식 그룹(needs-input / ready / working)**, Changes 패널, Context 카드, PR 자동 수정 |

### 6-2. 공통점과 차이
- 모두 "작업 = git worktree + 에이전트 CLI 그대로"가 기본. 우로보로스도 같다(카드 worktree 옵션).
- 대부분은 **사람이 각 에이전트를 지휘**한다. 에이전트 간 자동 전달(선)·총괄 에이전트·보드 MCP는 Superset(MCP) 외에는 드물다. 이 부분이 우로보로스의 차별점.
- 유료 모델은 공통적으로 "로컬 무료 + 클라우드/팀/멀티플레이어 유료"(Conductor $50, Superset 팀) 또는 1인 구독(Symvibe $19). 개인용인 우리에겐 해당 없음.

### 6-3. 0.2.6에 반영한 개선
1. **Changes(변경 검토)** — Conductor/Claude 데스크톱의 Changes 패널. 카드 헤더에 `+n −m` 배지, 인스펙터에 파일 목록·파일별 diff·되돌리기·"카드에게 diff 리뷰 시키기". 총괄용 `get_changes` MCP 도구(요약+diff)로 채점/검토 단계에서 결과물을 직접 본다.
2. **컨텍스트 미터** — ccanvas/Claude 데스크톱 Context 카드. 세션 트랜스크립트(jsonl)의 마지막 usage로 컨텍스트 사용량 바(70% 넘으면 주황).
3. **로스터 그룹** — Claude Code Agent View식 "Needs you / Ready to review / Working / Idle / Ended" + 그룹 일괄 선택 후 브로드캐스트.
4. **캔버스 단축키** — Ctrl+1…9 카드 점프, Ctrl+F 제목 검색(ccanvas).
5. **팀 리드 카드** — 총괄 피드백 반영: `create_agent board_tools=true`, `set_board_tools(agent_id)`(재시작 포함)로 하위 카드가 자기 하위 카드와 선을 직접 만든다.

### 6-4. 다음 후보
- 체크포인트(ccanvas/Conductor): 위험한 단계 전 git 스냅샷·복원.
- PR 모니터링/자동 수정(Claude 데스크톱) — `gh` 필요.
- 디스코드 봇 카드: 채널 메시지·첨부를 선으로 총괄에 전달.
- 예약 실행(Superset automations).


## 7. Codex / Gemini 어댑터 (0.2.7) — 검증한 사실
| 엔진 | 상태 전달 | 보드 MCP | 역할 프롬프트 | 이어가기 | 권한 |
|---|---|---|---|---|---|
| Codex CLI | `notify = ["node", agent-hook.js, "codex", "--url", …, "--node", …]`: 턴 종료 시 JSON을 **마지막 argv**로 전달(`type: agent-turn-complete`, `thread-id`, `turn-id`, `input-messages`, `last-assistant-message`, `cwd`; 자식 환경변수는 없음 → URL·카드 id를 인자로). `-c key=value`는 TOML로 파싱(실패 시 문자열), 우선순위 최상. 승인 요청 이벤트는 없음 | `-c mcp_servers.ouroboros.command/args/env` (MCP 자식은 부모 env를 상속하지 않으므로 env 명시) | `-c developer_instructions="…"` (developer 메시지; cmd.exe 8191자 제한 땐 첫 프롬프트로 입력) | `codex resume <thread-id>` / `resume --last` | `-s read-only` / `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI | `hooks` (settings.json): SessionStart·BeforeAgent·BeforeTool·AfterAgent(`prompt_response`)·Notification(`ToolPermission`)·SessionEnd, 입력 JSON은 **stdin**, 훅별 `env`로 URL·카드 id 전달. 설정 파일은 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`로 카드별 파일 지정(hooks 배열은 CONCAT, mcpServers는 SHALLOW_MERGE라 사용자 설정과 합쳐짐) | `mcpServers.ouroboros` (`env` 명시; `*TOKEN*` 같은 이름은 상속 시 삭제되지만 명시하면 통과) | 시스템 프롬프트 플래그 없음(`GEMINI_SYSTEM_MD`는 전체 교체) → 첫 메시지로 입력 | `-r <uuid>` / `-r latest` | `--approval-mode plan|auto_edit|yolo` |

출처: openai/codex `codex-rs/hooks/src/legacy_notify.rs`, `codex-rs/utils/cli/src/config_override.rs`, `codex-rs/rmcp-client/src/utils.rs`, `codex-rs/core/config.schema.json`; google-gemini/gemini-cli `docs/hooks/reference.md`, `docs/cli/cli-reference.md`, `docs/cli/settings.md`, `docs/tools/mcp-server.md`, `packages/cli/src/config/settings.ts`, `packages/cli/src/config/settingsSchema.ts`, `packages/core/src/hooks/hookRunner.ts`.
미검증: Codex TUI의 "준비됨" 출력 문구(없어서 출력 후 4초 정적을 준비로 간주), `codex resume` 앞에 둔 전역 플래그(`-m`, 승인 플래그) 수용 여부.

## 8. 음성 입력·완료 알림 조사 (2026-10-23, 0.3.4) — 검증한 사실

**결론**: 음성 *입력*은 Claude Code 내장 `/voice`를 쓰고(코드 0줄), 우로보로스는 *알림*(토스트+음성)만 만든다. 자체 STT는 보류.

| 항목 | 사실 | 출처 |
|---|---|---|
| Claude Code `/voice` | v2.1.69+ 내장 받아쓰기. Space 홀드(기본) 또는 `/voice tap`(2.1.116+). 한국어 포함 20개 언어, `language` 설정을 따름. 오디오는 Anthropic 서버에서 전사(로컬 아님), **claude.ai 로그인 필요**(API 키·Bedrock 불가), 토큰 소모 없음. Windows 네이티브 지원. 녹음은 claude 프로세스의 네이티브 모듈이 직접 → 터미널이 xterm이어도 무관. | https://code.claude.com/docs/en/voice-dictation |
| Electron Web Speech API | `webkitSpeechRecognition`은 Electron에서 `network` 에러(Chromium이 Google 서버를 쓰는데 Electron엔 키가 없음). 온디바이스 인식(`processLocally`)도 Electron이 `unavailable` 스텁 처리. | electron/electron#46143, electron/electron#52955 |
| Windows Win+H | Claude Code TUI에서는 "no text box selected"로 실패. | anthropics/claude-code#37095 |
| 자체 STT 후보(보류) | 로컬 whisper.cpp 애드온(`@kutalia/whisper-node-addon`, 프리빌드·Vulkan; small 466 MB, 한국어 CER ~18%) · Groq `whisper-large-v3-turbo` $0.04/시간(키 필요 → "자체 모델 호출 없음" 원칙과 충돌). Codex/Gemini 카드에 음성이 필요해질 때 다시 본다. | micdrop.dev/blog/local-speech-to-text-node, console.groq.com/docs/speech-to-text |
| TTS | 렌더러 `speechSynthesis`는 Electron에서 동작하나 **SAPI 음성만** 노출(이 PC: Microsoft Heami Desktop ko-KR, Zira en-US). Windows 11 "자연 음성"·Edge 온라인 음성은 서드파티 앱에 안 열림(WebView2Feedback#2660). `getVoices()`는 첫 호출에 비어 있을 수 있어 `voiceschanged`를 기다린다. | MicrosoftEdge/WebView2Feedback#2660, super-productivity#6437 |
| 자연 음성 TTS (2026-10-24) | Heami가 너무 딱딱해 사용자 자기 키로 쓰는 엔진을 붙임(`src/shared/tts.ts`, `src/main/tts.ts`). **Gemini**: `POST https://generativelanguage.googleapis.com/v1beta/interactions`, 헤더 `x-goog-api-key`, 본문 `input[{type:user_input, content[{type:text, text, annotations[{type:speech_metadata, style}]}]}]` + `response_format{type:audio}` + `generation_config.speech_config[{voice}]`, 응답 `steps[type=model_output].content[type=audio].data`(base64, WAV 24 kHz mono 16-bit). 모델 `gemini-3.8-flash-lite-tts`(무료 티어; `-flash-tts`는 더 고품질), 30개 프리빌트 음성(Kore·Zephyr·Puck·Achird·Sulafat…), 한국어 자동 인식. AI Studio 키(aistudio.google.com/app/apikey); Gemini CLI의 OAuth는 못 씀. **OpenAI**: `POST /v1/audio/speech` `gpt-4o-mini-tts` + `instructions`, mp3(2027-01-06 종료 예정). **ElevenLabs**: `POST /v1/text-to-speech/{voice_id}` `xi-api-key`, `eleven_multilingual_v2`, 무료 1만 크레딧. Edge 온라인 음성(비공식)은 2026-10-10 깨짐 → 제외. 로컬 자연 음성(Supertonic 3, ONNX, 한·영)은 onnxruntime-node 의존이라 보류. | ai.google.dev/gemini-api/docs/speech-generation (2026-10-24 스크랩), platform.openai.com/docs/guides/text-to-speech, elevenlabs.io/docs |
| 선행 사례 공통 패턴 | 소리/토스트/음성 각각 토글(claude-code#45619 제안), 창 포커스 시 억제(Herdr), 10초 미만 작업은 안 알림(docker-agent `sound_threshold`), 매 턴 알림은 짜증(claude-code#87351), 300자 넘으면 "보고서 확인" 문구(heard.dev 가이드). VoiceMode MCP(mbailey/voicemode, MIT)는 양방향 대화형 — 총괄과 "통화"가 필요해지면 후보. | 각 저장소 |

**채택 규칙** (`src/shared/announce.ts`): 대상 off/총괄만(기본)/전부 · 토스트·음성 각각 · 턴 10초 미만 무시 · 문장은 고정("○○ 작업이 끝났습니다. 보고를 확인해 주세요" — 답변 본문은 절대 안 읽음; 네 명의 의견 수렴 후 Jev 선택 a 0.69/grounded 0.80) · 한글이 제목/답변에 있으면 한국어, 한국어 음성 없으면 영어 문장으로 폴백 · needs-you는 카드당 60초에 한 번 음성 · 여러 카드가 돈 뒤 5초 정적이면 "모든 카드 작업이 끝났습니다"(마지막 턴이 이미 개별로 알려졌으면 생략) · 음성 엔진은 설정에서 고름(기본 Windows; Gemini/OpenAI/ElevenLabs는 본인 키, safeStorage 암호화, 문장별 `userData/tts/` 캐시, 실패 시 Windows 음성 폴백 + 설정에 이유 표시).

**알려진 한계**: tap 모드 마이크가 열린 채면 TTS 문장이 받아쓰기에 섞인다(README에 적음) · 알림은 창 포커스와 무관하게 나간다(설정 없음, 단순 유지).

## 9. 자율 운영(팀·워커 수명·컨텍스트·자율성) 조사 (2026-10-24, 0.4 계획 전) — 검증한 사실

**질문**: "팀 카드가 워커를 스스로 띄우고 거두고, 컨텍스트가 차면 스스로 넘기고, 사장님은 결정 게이트에서만" — 이 방향이 맞는지, 2025–26 선행 사례에서 무엇이 되고 무엇이 망했는지. 세 갈래(팀/워커 오케스트레이션 · 컨텍스트 한계 · 자율성 경계)를 Opus 리서치 3개로 병렬 조사, 아래는 교차 확인된 것만.

### 9.1 세 시스템 이상에서 반복되는 패턴 (= 베낄 것)

| 패턴 | 어디서 | 우로보로스 현재 |
|---|---|---|
| **에이전트 밖의 내구성 작업 원장**(work ledger): 워커가 항목을 claim하고 상태·의존을 갱신 | Gas Town beads · Claude Code agent teams 태스크 리스트(의존·파일 락) · Anthropic 기능 목록 JSON(`passes`만 바뀜) · MS Magentic task ledger · OpenAI 저장소 내 실행 계획 | **없음** — `set_note` 자유 마크다운은 덮어써짐 |
| **명시적 완료 신호로 은퇴**, idle 시간은 폴백 | `gt done`(브랜치 푸시→머지 요청→자기 세션 종료) · agent-teams 종료 핸드셰이크+idle 알림에 최종 답 포함 · Codex는 모든 결과 대기 | **idle 시간만** — `tidy_board`는 done/idle 30분 |
| **역할·헌장은 세션과 분리된 파일** | `.claude/agents/*.md` · `.codex/agents/*.toml` · Gas Town identity/sandbox/session 3층 · CrewAI role/backstory | 카드 안 `role_prompt`뿐, 팀 헌장 파일 없음 |
| **정체·조기종료 감시(watchdog)** | Gas Town 3분 heartbeat → `GUPP_VIOLATION` · Magentic `max_stall_count`→재계획 · agent-teams `TeammateIdle` exit 2 · Anthropic "기능 목록 대조 전엔 못 멈춤" | **없음** |
| **매니저는 조율·전달만, 구현·요약 금지** | agent-teams 리드가 직접 구현해버리는 실패 · CrewAI 매니저가 모든 태스크 실행 · LangGraph "전화 놀이"(`forward_message`로 ~50% 개선) · Gas Town Witness | 프롬프트 규칙만("Do not do the coding yourself") |
| **워커당 worktree + 단일 머지 단계** | Gas Town Refinery · 서브에이전트 `isolation: worktree` · Claude Squad · Conductor · Codex 동시 쓰기 충돌 경고 | worktree 있음, 머지 큐 없음 |
| **스폰 프롬프트가 전체 맥락을 들고 감** | agent-teams 팀원은 리드 히스토리 상속 안 함 · Anthropic 리서치 브리프(목표·형식·경계) | 있음(`role_prompt`+`prompt`) |
| **동시성·깊이 상한을 코드로** | agent-teams 3–5명·중첩 금지 · Codex `max_concurrent_threads_per_session` · Gas Town 20–30 | 프롬프트 권고만 |

### 9.2 실패한 것 (= 안 할 것)

- **Gas Town**(Yegge, 2026-01 → 2026-09 중단): 영속 워커 풀 → 좀비 워커·stale 브랜치 219개, Witness 단일 병목, "expensive as hell", 모델이 Gas Town 자체를 자꾸 손대서("just two more things") 유지에 "too much elbow grease". 남긴 교훈은 **beads(원장)뿐**이라고 본인이 정리.
- **동등한 에이전트 떼·여러 쓰기 주체·락 파일**: Cognition "mostly a distraction"(2026-04-22), Cursor "bottleneck, risk-averse".
- **LLM 매니저 혼자 맡기기**: CrewAI 매니저가 모든 태스크를 직접 함/`coworker not found`; 단계별 명시 지시로만 고쳐짐.
- **AutoGPT류 무한 루프·자원 고갈**; 테스트 없이 "완료" 선언(Anthropic 2025-11-26, Cursor).
- **자체 권한 분류기**: Anthropic 것도 false-negative 17%(2026-03-25) → 벤더 모드만 쓴다.
- Claude Code agent teams 한계: in-process 팀원 resume 불가, Windows Terminal 분할 미지원, 중첩 금지 → **우로보로스 캔버스+`--resume`+`set_board_tools` 중첩은 이미 그 틈을 메운다**.

### 9.3 컨텍스트 한계 — 사실

| 항목 | 사실 | 출처 |
|---|---|---|
| CC 자동 compact | 윈도 미설정 시 모델 한계에서 발동(네이티브 1M 모델 ~967K). `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(100K–1M, 최우선) · `--autocompact <auto\|tokens>`(2.1.309 확인) · `autoCompactWindow` · `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`(낮추기만). `DISABLE_AUTO_COMPACT=1`. | code.claude.com/docs/en/env-vars, model-config |
| idle compact | ~54분 idle & ≥200K면 조용히 압축(인터랙티브 기본 on). `idleCompaction:false`로 끔 — **캔버스 idle 카드가 몰래 압축될 수 있음** | settings-reference#idlecompaction |
| PreCompact 훅 | `trigger` manual/auto, exit 2 또는 `decision:"block"`으로 차단 가능하나 **복구 compact 차단 시 요청 실패**; `systemMessage` 버려져 요약 방향 못 정함. PostCompact엔 `compact_summary` 들어옴 | docs/en/hooks |
| SessionStart 훅 | `source`: startup/resume/compact/fork, `additionalContext` 주입, resume/fork엔 `context_tokens` | docs/en/hooks |
| 신호 | JSONL `compact_boundary` 레코드(`compactMetadata{trigger,preTokens,postTokens,durationMs}`); 로컬 샘플 497,898→25,441 토큰 97초. 통계줄 `used_percentage`는 자동압축 윈도 아닌 전체 윈도 기준 | 로컬 관측, statusline 문서 |
| `--fork-session` | **전체 히스토리 복사** → 새 컨텍스트가 아님 | cli-reference |
| Codex / Gemini | Codex `model_auto_compact_token_limit`, `compact_prompt`, `codex resume/fork` · Gemini `model.compressionThreshold` 기본 **0.5**, `/compress`, `/chat save`, `checkpointing` | 각 문서 |
| compact vs 핸드오프 | Anthropic: "compaction isn't sufficient"(지시 전달 불완전) → 진행 파일+커밋+세션당 기능 1개. Factory 측정(36,611 메시지): 어떤 압축도 **파일 변경 흔적(artifact trail) 2.2–2.5/5**로 가장 약함. 컨텍스트 커질수록 18개 모델 전부 성능 저하(Chroma context-rot) | anthropic.com/engineering/effective-harnesses-for-long-running-agents, factory.com/news/evaluating-compression, trychroma.com/research/context-rot |

### 9.4 자율성 사다리에서 우로보로스 위치

L1 감독형 → L2 태스크 에이전트(마커·체크포인트·diff) → **L3 파이프라인(조건 라인·루프 가드·사람 게이트·보고 라인·wait) = 충족** → L4 자가 편성 팀(원장·워치독·예산·새 컨텍스트·단일 머지) = **절반**(팀장·tidy·note 있음 / 원장·워치독·예산·컨텍스트 순환 없음) → L5 자가 지시(스케줄·트리거·자율 지표·롤백) = 없음. 측정 지표: 개입/세션(Anthropic 5.4→3.3), 무인 분/개입, 게이트 요청/일, 체크포인트 복원률, 머지당 비용.

### 9.5 하네스 vs CLI vs 모델 경계

지금 가능: 원장 · 작업/임계 기준 워커 은퇴와 재스폰 · 정체 워치독 · worktree+단일 머저 · 기계적 게이트(테스트 실행, 다른 엔진 리뷰어) · Stop 훅 `decision:"block"` 계속 진행(Claude만; Codex/Gemini [미확인]). CLI 기능 필요: 하드 비용 상한(`--max-budget-usd`는 print 모드만) · 무인 권한 안전(벤더 분류기) · PC 꺼진 동안 실행(벤더 scheduled tasks). 모델 발전 필요: 표류·조기 완료·만지작거림 수렴(판정자+새 시작으로 완화만).

### 9.6 원래 계획 대비 바뀐 것

| 원안(이 세션 초안) | 조사 후 |
|---|---|
| Tidy: 파견 플래그 + idle N분 | **완료 신호로 은퇴**(보고 라인이 상위에 전달됨 + done)가 기본, idle은 폴백. 상주 카드는 opt-in으로만 |
| 팀 = 컨덕터 + `appendSystemPrompt` 헌장 | 헌장은 **파일**(`.ouroboros/teams/<slug>.md`) + 팀 진행 로그(태스크 닫힐 때 한 줄, 시작 시 앞 200줄 주입) + 보고는 **원문 그대로** 위로 + 워커 수·깊이(총괄→팀→워커) 상한을 코드로 |
| 컨텍스트: 75%/90% 배너 | **절대 토큰** 밴드(<150K / 150–250K 인계 준비 / >250K 다음 경계에서 인계), 스폰 시 `--autocompact` 백스톱, 인계는 **경계에서만**(턴 종료 ∧ 커밋/스테이지 완료 ∧ 백그라운드 없음), 노트는 카드 자신이 작성, 옛 세션은 `--resume` 가능하게 보존, 사장님 카드는 클릭 없이는 절대 안 함, 자동 인계 계보당 3회 상한 |
| (없음) | **작업 원장**(`task_create/claim/update/list`, 상태·의존·부모)이 백본 — 두 리서치 모두 1순위 |
| (없음) | **정체 워치독**: Working인데 훅 이벤트 N분 없음 / needs-you N분 / 같은 라인 반복 → 부모에 `[card stalled]`, 3회면 총괄+알림 |
| (없음) | 완료 게이트: 코딩 태스크는 `RESULT:` 마커 + `get_changes` 비어있지 않아야 완료 |

**안 만들 것**: 영속 워커 풀 · 동등 에이전트 떼/여러 쓰기 주체 · 자체 권한 분류기 · 워커가 우로보로스/보드 설정 편집 · 구독 돌려쓰기 · 테마 역할명 잔뜩 · 자체 클라우드 실행층 · 사장님 없는 main 머지/배포.

**미확인**: Codex/Gemini의 Stop-훅 대응물 · `contextWindowFor`가 Opus 4.7+를 1M으로 안 잡을 가능성(실제 모델 id에 따라) · compact vs 핸드오프 직접 비교 측정 없음.

## 10. Orca(onorca.dev) 해부 (2026-10-24, 0.7 계획 전) — 검증한 사실

사장님이 "딱 이거네"라고 한 Orca를 소스 수준에서 뜯어본 기록. 소스는 `stablyai/orca`(MIT, 103k 스타, 2026-03 생성, 매일 릴리즈, Windows 설치 exe 포함) 커밋 01652255를 얕게 클론해 읽었다. 스택이 우로보로스와 같다(Electron + electron-vite + TypeScript + zustand). 결론은 §10.4.

### 10.1 디자인 시스템 — 사실 (`docs/STYLEGUIDE.md`, `src/renderer/src/assets/main.css` .dark 블록 298-466행)

- **원칙**: "monochrome and quiet — 중립 회색이 크롬을 맡고, 색은 상태(선택 링·파괴적 동작·git 장식)에만"(STYLEGUIDE 7행). "muted/accent/border를 먼저 집어라"(11행), "컴포넌트에 hex 금지"(24행). Tailwind 4 + lucide-react 아이콘만.
- **중립 토큰(다크)**: background `#0a0a0a` · 에디터면 `#1e1e1e` · foreground `#fafafa` · card/popover `#171717` · primary 버튼 `#e5e5e5` 글자 `#171717` · secondary/muted 면 `#262626` · muted 글자 `#a1a1a1` · accent(호버/활성 채움) `#404040` · border `rgb(255 255 255/.07)` · input 테두리 `white/.15` · ring `#737373`. 왼쪽 사이드바는 더 밝은 `#2a2a2a`(호버 `#353535`), 오른쪽 패널은 `#171717`.
- **상태 색**(Tailwind 팔레트명 → 근사 hex는 에이전트의 Tailwind 지식, 저장소에 hex가 있는 건 아님): working = yellow-500(≈`#f0b100`, 회전하는 2px 링) · needs-you = **orange-500**(≈`#ff6900`, "amber가 아니라 orange: working-yellow와 구분") · done = emerald-500(≈`#00bc7d`, 체크 글리프) · error = red-500 점 · idle = neutral-500 40% 점 · destructive `#ff6568` · warning `#eab308`. git 장식: 추가 `#81b88b` 수정 `#e2c08d` 삭제 `#c74e39`, git 상태에만.
- **색 쓰는 곳 / 회색인 곳**: 색 = 에이전트 상태 글리프, 파괴 동작, git, 포커스 링, 알림/안읽음 배지. 회색 = 파괴 외 모든 버튼, 내비 행, 헤더, 탭(활성 탭은 색이 아니라 2px foreground 바), 브랜드, 크롬의 링크, 아이콘(글자색 상속).
- **타이포**: 본문 14px, `letter-spacing .01em` 전역. 대문자 메타 라벨 = **11px / 600 / uppercase / .05em** 한 가지 레시피. 12px 보조·경로·탭·상태바, 13px 사이드바 행·카드 제목(13/20), 11px 에이전트 행, 10px 배지·시각·모델 칩. 헤더 600, 내비 500, 메뉴 450, 다이얼로그 제목 18px/600.
- **모양·깊이**: radius 기본 10px(sm 6 · md 8 · lg 10 · xl 14). 버튼·입력 8, 카드 14, 워크트리 카드·다이얼로그 10, 배지 full, kbd 4. **고도 3단계뿐**: 1px 헤어라인 → shadow-xs+border → 떠 있는 것 `0 10px 24px rgb(0 0 0/.18)`. 다이얼로그: border white/14, `rgba(23,23,23,.96)` + backdrop-blur, 그림자 `0 24px 72px rgba(0,0,0,.55), inset 0 1px 0 white/.06`, 패딩 24, 최대 512px, 오버레이 검정 55%.
- **행 레시피**: 호버 accent · 키보드 선택 `accent + inset 0 0 0 1px color-mix(fg 16%)` · 현재 카드 `border color-mix(fg 18%, border)`, `bg color-mix(fg 10%)` · 다중 선택 `ring 30%` · 에이전트 행 호버 `color-mix(accent 18%)`. 포커스 링 `0 0 0 3px color-mix(#737373 50%)`. 스크롤바 thin, 썸 `muted 28%`, 사이드바는 호버 전 숨김. kbd 칩: min 24px, radius 4, border/80, secondary/70, 12px/500 muted. 툴팁: fg 배경 + bg 글자, 400ms 지연.
- **셸 치수**: 타이틀바 36px(4px 드래그 + 32px 탭 줄), 앱 이름 12px/600 muted, 아이콘 버튼 24px(패딩 4, radius 4, 호버 accent 채움). 왼쪽 사이드바 280px(220–500 리사이즈): 8px 패딩 내비 블록(Search 행 + Tasks/Artifacts/Skills/Automations/Agent dashboard/Mobile 행, 13px/500, 패딩 6 8, radius 8, 16px 아이콘 비활성 30%) → 32px 헤더("Projects" 12px/600 muted/80 + 오른쪽 벨 아이콘에 Needs you/Working/Idle 카운트) → 가상화 목록(섹션 헤더 28px 13px/600 + 16px 아이콘 + 14px 셰브런, 깊이당 10px 들여쓰기 · 워크트리 카드 radius 10 · 에이전트 행 패딩 4 8, 상태 글리프 10–12px + 14px 종류 아이콘 + 11px 글자 + 10px mono 모델 + 뒤쪽 상대시각 10px muted/60, 자식 행 20px 들여쓰기 + 1.5px 연결선) → 하단 툴바(위 1px 선, 패딩 6 8, 14px 아이콘). 탭 180px(≥1280에서 220), 활성 = `color-mix(fg 6%, card)` + 2px fg 밑줄. 오른쪽 패널 350px, 36px 헤더(11px 대문자), 40px 액티비티 바. **상태바 24px**, 12px 글자. 알림 스택 우하단 360px.

### 10.1-매핑 우로보로스 토큰·표면 변경표 — 제안

| 우로보로스 | 채택 |
|---|---|
| `--bg #0e1016` | `#0a0a0a`, 캔버스 radial gradient 제거 |
| `--panel #151823` | `#171717` |
| (신규) `--sidebar` | `#2a2a2a`, 호버 `#353535` |
| `--panel-2 #1b1f2d` | `#262626` |
| `--panel-3 #222738` | `#404040` (호버/선택 채움) |
| `--border #2a2f3d` | `rgb(255 255 255/.07)` |
| `--text #d9dce3` | `#fafafa` |
| `--muted #8b90a0` | `#a1a1a1` |
| `--accent #38bdf8`(시안) | **색으로서 은퇴**. 포커스 = `--ring #737373`, primary 버튼 = `#e5e5e5` 위 `#171717` |
| `--info`(working 파랑) | working 노랑 ≈`#f0b100` — **파랑→노랑은 결정 사항** |
| `--warn`(needs-you 앰버) | orange ≈`#ff6900`; 경고용 `#eab308`은 따로 |
| `--ok` | 점 ≈`#00bc7d`, 글자 `#86efac` |
| `--danger` | `#ff6568` |
| (신규) git 색 | +`#81b88b` −`#c74e39` 수정 `#e2c08d` |
| `--shadow` | `0 10px 24px rgb(0 0 0/.18)`, 떠 있는 면에만 |

`src/shared/status.ts`의 `STATUS_COLOR`(미니맵이 읽음)도 같이: starting/idle `rgb(115 115 115/.4)`, working 노랑, needs-you 오렌지, done 에메랄드, ended `#a1a1a1`.

표면: **툴바** → 36px 타이틀바(카드색, 헤어라인; 왼쪽 12px/600 muted 워드마크 + 프로젝트 버튼; "+ Claude/+ Terminal/More" 셋 → 24px 아웃라인 "New card" 하나(종류 메뉴); 오른쪽은 24px 고스트 아이콘 버튼; Roster/Inspector = 패널 토글 아이콘; 상태 스트립은 사이드바 헤더 카운트로; 자율모드 필·업데이트 배지는 **24px 상태바**로). **Roster** → 왼쪽 사이드바 280px(Search 행 → 프로젝트 헤더 → 상태 섹션 Needs you/Working/Idle/Ended 28px → 카드 행: 12px 상태 글리프 + 종류 아이콘 + 13px 제목 + 호버 시 핫키 칩, 2줄째 11px 상태 + 10px 경과시각, 11px 마지막 답장 한 줄, 체크박스는 호버/선택 시만 → 컴포저 → 하단 툴바). 워커는 Conductor 아래 1.5px 연결선으로 중첩(선이 이미 관계를 안다). **Inspector** → 오른쪽 패널 350px, 36px 헤더 11px 대문자, 섹션 h4 11/600/.05em. **카드 헤더** 32px(패딩 3 14), 상태 글리프가 색 점 대체, 제목 13/600, 상태 11px muted, 아이콘 버튼 24px/12px 아이콘; 카드 테두리 1px 토큰(2px 상태색 테두리 폐지), radius 10, 선택 = 1px 링 + 현재 카드 워시. **다이얼로그** = Orca dialog 값 그대로, 제목 18/600, 푸터 오른쪽 primary + Cancel 고스트.

**우로보로스가 지금 어기는 것**(styles.css 기준): ① 시안을 크롬 색으로 — 브랜드·primary·모든 버튼 호버 테두리·`.btn.active`·링크·포트·찾기 상자·auto-pill ② 이모지/유니코드 아이콘 — `◎` `⬆` `▣`, 카드 종류 🎼🌐⚡🅰📝, `↻ ★ ⤢ ↗`, `⛁ ⟲ ✕ ▾`, `⎌ ▸`, `▶ ⧉` ③ 색 버튼 — 초록 `.btn.saved`, `.update-badge`, 시안 `.btn.active` ④ 깜빡임·글로우 — needs-you 무한 펄스, 흐르는 엣지 + drop-shadow ⑤ 2px 상태색 카드 테두리, working 틴트 링 ⑥ CSS 안 raw hex 10여 개 ⑦ 대문자 라벨 레시피 3종 ⑧ 손으로 만든 kbd 칩, "Ctrl+N" 하드코딩 ⑨ `title=`를 툴팁으로 ⑩ 포커스 2px 시안 outline.

### 10.2 셸 UX·상태 모델·어텐션 — 사실

- **레이아웃**: 왼쪽 사이드바 → 타이틀바 + 워크벤치(터미널/에디터/브라우저) → 선택적 오른쪽 사이드바(`app-shell/AppWorkspaceShell.tsx:115-213`). 워크스페이스 미선택 시 가운데는 Landing. 설정·태스크·자동화·모바일 같은 페이지가 가운데를 차지한다.
- **사이드바**: 위 내비(Search=Cmd+J 팔레트, Artifacts, Skills, Automations, Mobile) → "Projects" 헤더 + **벨 토글**(본문을 워크스페이스 목록 ↔ 에이전트 목록으로 전환; 벨에 어텐션 수, 없으면 working 수, 어텐션>0이면 물음표 글리프) → 목록(none/status/repo/PR 그룹핑, 핀 섹션, "Smart" 정렬 = Needs you › Done(최근) › Working › Unverifiable › Idle, **재정렬은 3초 유예**해서 행이 매 업데이트마다 튀지 않게 `sort-settle.ts`). 워크스페이스 카드의 상태 글리프는 소속 에이전트에서 permission › working › monitoring › active › inactive 순으로 롤업, 안읽음 배지 오버레이, 수동 "안읽음 표시" 벨, 별 = primary 워크트리.
- **에이전트 행**: 상태 점 + 종류 아이콘 · **보조 줄**은 우선순위(프로그램이 보고한 블록(로그인 등) › 턴 판정 › "no update for Xm" › 중지 중 › 툴 미리보기 › 마지막 답장) · 모델, `+N` 자식 수, 프롬프트 캐시 타이머, "done X ago"/"started X ago". **안 본 행은 굵게**.
- **이동**: Cmd+J "Jump to…"(채팅·터미널·워크스페이스·태스크·설정·액션 검색, Tab으로 필터), Cmd+P 파일, Cmd+Shift+↑/↓ 이전/다음 워크트리, Cmd+1–9, Cmd+B/L 패널 토글. **"다음 needs-attention" 단축키는 없음**.
- **상태바**: Claude/Codex 사용량 칩(5시간·주간 %, 리셋 카운트다운; 트랜스크립트 스캔 + OAuth usage 요청), 리소스·포트·SSH·업데이트.
- **상태 모델**: 와이어 상태는 working / blocked / waiting / done 넷뿐. 훅이 권위, OSC 7501(프로그램이 터미널에 직접 쓰는 상태)이 빈틈을 메우고 훅이 2분 침묵하면 넘겨받음, 터미널 제목에선 절대 추론 안 함. Claude 훅: PermissionRequest·AskUserQuestion → waiting. 표시 상태는 더 많음: monitoring, interrupted, failed, idle, **unverifiable**(프로세스 살아있는데 침묵), **unconfirmed**(턴 끝났는데 결과 불명), permission. 30분 지난 항목은 프로세스 살아있으면 unverifiable, 아니면 idle로 **감쇠하되 절대 done으로는 안 감**. 글리프: working 노란 스피너, done 초록 체크, unverifiable/unconfirmed 앰버 점선 원, waiting 오렌지 물음표, blocked/failed 빨간 점.
- **턴 판정**(`agent-turn-idle-verdict.ts`): 프롬프트 뒤 새 done이 왔거나, 터미널 마지막 6줄에 "command not found / is not recognized"(→ failed)거나, 상태 없는 패널이 2분 유예를 넘겼을 때만 완료로 침.
- **알림**: 완료 시 250ms(최대 1.5s) 훅 상세를 기다렸다 발송. 문구는 상태·결과에서 고름(needs input / failed / stopped / finished), **working 중엔 절대 "finished"라 안 함**. 본문은 마지막 답장 또는 "Using Tool: …". 전달 순서: ① 트레이 어텐션 점 먼저(어떤 게이트보다 앞) ② 모바일 푸시 ③ 설정 게이트 ④ **창이 포커스 + 그 워크트리가 활성이면 억제** ⑤ 워크트리당 5초 버스트 쿨다운 ⑥ macOS는 권한 차단 감지 시 인앱 토스트. 소리는 배너가 실제로 나갔을 때만. 자리 비움 = 시스템 유휴 180초.
- **어텐션**: 음소거 워크스페이스는 안 받음 · 라이브 세션 없으면 거부 · **보고 있는 표면은 전달은 하되 안읽음은 안 남김** · 안읽음은 전달 전에 기록(배너가 억제돼도 표식은 남음). 안읽음 사유: 완료, 터미널 벨, 수동. 턴은 `stateStartedAt` 이후 확인될 때까지 안읽음; 같은 상태의 반복 핑은 재발화 안 함; 수동 안읽음은 자리를 뜨거나 새 턴이 시작되면 소멸. **done은 안 본 동안만 "done", 보고 나면 idle**(이게 헤더 카운트의 원천). 탭에는 앰버 벨(라이브 working/needs-input이 우선).
- **온보딩**: FirstLaunchBanner는 텔레메트리 고지일 뿐. 첫 실행 5단계(에이전트, 테마, 통합, Windows 터미널, 알림 소리 선택) → 그 뒤 세션당 기능 팁 모달 하나 → Landing(로고, "Add a project", 단축키 목록, 사전점검 경고, 스타 버튼) → 8단계 설정 체크리스트(사이드바에 done/total, 끝나면 숨김).

### 10.3 모바일 컴패니언 — 사실

- **전송**: 같은 LAN에서는 React Native 앱이 데스크톱의 평문 `ws://<ip>:6768`에 직접 붙는다(`mobile/README.md`, `runtime-rpc-pairing-types.ts:20`). 서버는 처음엔 `127.0.0.1`에만 묶이고, **네트워크 페어링을 한 번 만들면 그때부터 `0.0.0.0`으로 넓힌다**(`runtime-rpc-lifecycle.ts:166-178`, `ipc/mobile.ts:170-190`). Windows에선 방화벽 규칙을 점검·복구한다(`mobile.ts:278-292`).
- **집 밖**: ① Tailscale 등 다른 IP로 저장된 호스트 주소만 바꾸거나(재페어링 없음) ② **Orca Relay**(`relay.onorca.dev`, Stably가 GCP Cloud Run에서 운영, Orca 계정 로그인 필요). 폰과 데스크톱이 각각 아웃바운드 WS를 열고 릴레이가 프레임을 이어 붙인다. 앱 계층 E2EE(NaCl, X25519 공개키를 QR에 핀)라 릴레이는 메타데이터·타이밍·크기만 본다(릴레이 코드 자체는 감사 안 함 — 미확인).
- **페어링**: Settings → Mobile의 QR = `orca://pair?code=<base64url JSON{endpoint, deviceToken(192bit), publicKey, deviceId, scope}>`. 브라우저 링크는 URL `#fragment`에 넣어 로그·Referer에 안 남긴다. **LAN 토큰은 만료가 없다** — "Regenerate QR"로 돌리거나 revoke할 때까지(`device-registry.ts:99-151`). Relay 초대는 10분 만료.
- **프로토콜**: `{id, deviceToken, method, params}` 봉투, 메서드 약 300개(terminal.*, worktree.*, git.*, github/linear/jira, files.*, 브라우저 스크린캐스트…), 모바일 스코프는 허용 목록으로 제한. 워크트리 목록은 **포그라운드에서 3초 폴링**, 변경은 `clientEvents` 구독으로 푸시, 알림은 256개 리플레이 버퍼. 터미널 출력은 16바이트 헤더 바이너리 프레임, 5ms 배치, ACK 윈도 흐름제어(스트림당 512KiB). 입력 프레임 1MiB, 응답 4MiB 상한.
- **"권한 대기" 응답은 구조화 API가 아니라 글자 그대로의 키 입력**(`terminal.send`로 옵션 번호, 거부는 Esc)(`mobile-native-chat-permission.ts:43-60`). 빨간 점 = 막힘/대기.
- **푸시 알림**은 릴레이와 별개의 클라우드 게이트웨이 `push.onorca.dev`가 APNs/FCM으로 보낸다. 제목 80자·본문 180자 **평문**으로 POST(`push-gateway-client.ts`). 즉 Apple·Google·Stably가 알림 문구를 본다.
- **보안**: LAN에 TLS 없음, WS 업그레이드에 Origin 검사 없음 → 기밀성은 전적으로 앱 계층 E2EE에 의존. 인증 실패 속도 제한 없음(192비트라 무력화는 어려움). 폰 토큰은 SecureStore(백업 제외). 문서화된 위험: 스캔 전 QR 유출 시 회전 전까지 유효, 키쌍 재생성은 모든 기기 페어 해제.

### 10.3-설계 우로보로스 린 컴패니언 (앱스토어·클라우드 없음) — 제안

1. **별도 `PhoneServer`**: 훅 서버(127.0.0.1:47821, CLI와 MCP가 의존)는 그대로. 새 `http.Server`를 **기본 꺼짐**, Settings에서 켬. 바인드는 사용자가 고른 인터페이스 IP 하나(기본 Tailscale `100.x`), `0.0.0.0` 조용히 금지. Windows 방화벽 규칙 점검.
2. **전송 보안**: **Tailscale 전용으로 먼저 출시** — WireGuard 위 평문 HTTP, 출발지가 `100.64.0.0/10` 밖이면 거부. 필요하면 `tailscale serve/cert`로 진짜 HTTPS(`*.ts.net`, 웹푸시에 필요). LAN 모드는 TLS 없이는 세션 쿠키가 스니핑되므로 "신뢰하는 집 네트워크 전용" 라벨 또는 자체서명 인증서(폰에서 번거로움).
3. **페어링**: Settings의 QR = `http(s)://<ip>:<port>/m#pair=<128bit 1회용 코드, 5분 만료>`. 페이지가 `/m/api/pair`에 POST → 192비트 기기 토큰(서버는 sha256만 저장 + 이름 + lastSeen), 페이지는 localStorage, 이후 `Authorization: Bearer`. Settings에 기기 목록 + Revoke.
4. **라우트** (`/m/api/*`, `timingSafeEqual`): `GET /board`(상태별 카드, 마지막 답장 4KB 절단), `GET /events`(SSE; 폴링 3초 폴백; 재접속 시 재조회), `POST /cards/:id/prompt`, `POST /cards/:id/answer {key}`(`permission:` 카드에만, 브래킷 페이스트 없이 원시 키 — **Claude Code 다이얼로그가 붙여넣은 "1"을 받는지 미검증**), `GET /report/latest`, 정적 `GET /m`(빌드 없음, CDN 없음, PWA 매니페스트).
5. **알림(선택)**: VAPID 웹푸시(결국 FCM/Apple 경유, HTTPS 필요, iOS는 홈화면 설치 필요) 또는 Telegram/Discord 웹훅(제목+카드명만, 답장 본문은 안 보냄).
6. **보안 요구**: 기본 꺼짐·명시적 바인드·보이는 토글, 1회용 단명 코드, 해시 저장·회수 가능·상수시간 비교 토큰, `Host`/`Origin` 검사(DNS 리바인딩·CSRF), `CSP default-src 'self'`, 본문 64KB·프롬프트 16KB 상한, IP별 인증 실패 제한, `/hook/*`·`/api/*`는 폰 리스너에 절대 노출 금지, 폰발 프롬프트/응답은 전부 로그(모닝 리포트에 표시).
7. **범위 밖**: 터미널 스트리밍, 파일 열람·편집, git 조작, 카드 생성·삭제, 설정 변경, 멀티 데스크톱, 네이티브 앱, 클라우드 릴레이.

### 10.4 결정 (2026-10-24) — 0.7 "Orca-style shell"

사장님 지시 "참고하고 복제해서 만들어줘" + 두 번째 "진행". 통째 복제는 안 한다(103k 스타 저장소를 혼자 따라갈 수 없고, 이미 Windows에서 공짜로 돌아간다). 우로보로스의 고유 가치(캔버스 위의 선, 총괄 + 보드 MCP, 자율모드 레일, 체크포인트, 음성 알림)는 유지하고 **셸과 시각 언어를 Orca 쪽으로** 옮긴다. 결정이 필요하다고 보고된 4개는 모두 Orca 쪽으로(working 파랑→노랑, 카드 종류 이모지→SVG 아이콘, 총괄 아래 워커 중첩, 상태바 추가) — 사장님이 한 줄로 뒤집을 수 있는 가역 선택.

**1단계 (0.7.0, 지금)**: §10.1-매핑 그대로. 조용한 모노크롬 토큰 + Orca 상태색, raw hex 제거, 대문자 라벨 레시피 하나, 포커스 링·스크롤바·kbd·다이얼로그 레시피 · 36px 타이틀바(워드마크, 프로젝트, "New card" 하나 + 종류 메뉴, 24px 고스트 아이콘, 패널 토글) · 왼쪽 사이드바 280px(검색 행, 프로젝트 헤더 + 카운트, 상태 섹션, 글리프 카드 행, 총괄 아래 워커 중첩, 컴포저) · 오른쪽 패널 350px(36px 헤더) · 카드 헤더 32px + 상태 글리프, 1px 테두리, 펄스·글로우 제거 · 24px 상태바(자율모드 필, 업데이트, 저장 상태) · lucide 아이콘.
**2단계 (0.7.x)**: §10.2 판정의 Adopt/Adapt — 턴 확인(done은 볼 때까지만, 안읽음 굵게), 3초 재정렬 유예, 상태·결과 기반 토스트 문구 + 5초 버스트 쿨다운 + "포커스 + 선택된 카드"일 때만 억제, 누락 명령 꼬리 스캔(3분 park 대신 수 초), unverifiable/unconfirmed 표시 상태, Ctrl+J 점프 팔레트, 다음 needs-you 단축키, 상태바 사용량 칩, 온보딩에 엔진 선택·소리 테스트 단계.
**3단계 (Type 1, 승인 후)**: §10.3-설계 린 폰 컴패니언, Tailscale 전용부터.
**Skip**: OSC 7501 진행 링, 네이티브 모바일 앱·클라우드 릴레이·푸시 게이트웨이, 오른쪽 탐색기/SCM/포트 패널(캔버스와 경쟁), 숨김 워크스페이스 음소거, FirstLaunchBanner.

## 11. Orca 너머의 자율성: 엔진 간 에이전트 통신과 push / deploy / SQL의 게이트된 자동화 (2026-10-25, 0.8 계획 전) — 검증한 사실 + 설계 제안

**질문**(사장님, 2026-10-25): Orca는 "여러 세션 지켜보기"를 잘한다. 우로보로스는 그 너머 — 다른 엔진의 에이전트끼리 통신하고, push·deploy·SQL 권한까지 포함해 전부 자동화할 가능성을, 보안 문제를 같이 풀면서 — 로 가야 한다. 이 섹션은 코드가 아니라 **설계 제안**이다. 방법: 리서치 4개(Orca 격차 · 엔진 간 통신 · 게이트 자동화 · 위협 모델)를 Opus로 병렬 수행(각 20–30 호출, 1차 출처 우선, 지난 12개월), 핵심 주장 3개(Claude 채널·크로스세션 메시징·Gemini CLI 상태)는 편집자가 공식 문서로 재확인, 로컬 사실은 이 워크트리의 소스를 직접 읽음(f5fca4d). 1차 출처에서 읽지 못한 것은 **[미확인]**. 출처는 §11.7.

### 11.0 결정 브리프 (사장님용, 2분)

**결론 한 줄**: 자동화의 경계는 "에이전트가 무엇을 하려 하는지 분류"가 아니라 **"에이전트가 애초에 할 수 없게"**로 그린다. 서버 측 규칙(GitHub 룰셋·Supabase 브랜칭·플랫폼 Git 연동)과 **자격증명 부재**(prod 토큰은 우로보로스 메인 프로세스만 들고, 카드 폴더·env에는 절대 없음)가 기계적 게이트고, CLI의 deny/hook은 2차 레일이다. 벤더 3사 모두 "명령 패턴 규칙은 보안 경계가 아니다"라고 문서에 쓴다(§11.4).

**빌드 순서** (가역 → 비가역, 각 단계가 앞 단계를 전제):
1. **보안 부채 먼저 (0.8.0, 1–2일)** — 코드에서 확인된 구멍 4개: 앱 단일 토큰 → **카드별 토큰**, `/hook/*` 무인증 → 토큰 요구, `x-ouroboros-self` 자기주장 → 토큰에서 유도, Codex argv 토큰 노출 → env/파일로. 그리고 `Host`/`Origin` 검사, 카드 spawn 시 **env 허용목록**(부모 env 상속 금지), `.ouroboros.json` 해시 검증. 이게 없으면 2·3단계가 "한 카드 뚫리면 보드 전체"가 된다. (§11.5 #5·#6)
2. **엔진 간 메시지 (0.8.x)** — 보드 MCP에 `send_message` / `check_inbox` / `ack` 셋 + 훅 서버의 **내구 큐**(ID·ack·루프 가드), 배달은 엔진별 어댑터(Claude = Stop/UserPromptSubmit 훅 드레인이 기본, 채널은 프리뷰라 옵션; Codex = 훅 `additionalContext` + Stop block; Gemini = 훅). 세 엔진 전부 보드 MCP가 이미 연결돼 있어 새 전송층이 필요 없다. 원장(`claude/task-ledger` 브랜치)과 같은 저장 패턴. (§11.3)
3. **액션 게이트 (0.9)** — 프로젝트별 정책 파일(`auto` / `ask` / `never`), 메인 프로세스의 **자격증명 브로커**("승인 후 실행" 버튼이 토큰을 자식 프로세스 env에만 주입), 서버 측 룰셋 체크리스트, 감사 로그 JSONL → 모닝 리포트. 자동 허용 범위는 **non-main 브랜치 push · PR 열기 · 브랜치 DB 마이그레이션 · prod SQL 읽기(read-only 롤)**까지. (§11.4)
4. **Orca 격차 채택 (0.9.x)** — 스케줄러+precheck, 실행 원장(건너뛴 이유), `ask`(워커 질문 → 총괄/폰), 스테일 응답 가드(prompt-id), 권한 대기 중 메시지 보류, 완료 카드 하이버네이션, 사용량 칩. (§11.2)

**사람 게이트로 남는 것 (영구)**: main 머지 · prod 배포(트래픽 전환) · prod 마이그레이션 · prod SQL 쓰기 · 공개 PR/이슈/코멘트/퍼블리시 등 **되돌릴 수 없는 외부 송신** · 새 MCP 서버/스킬/페르소나 소스 **첫 신뢰** · 서드파티 저장소에 카드 붙이기 · `.ouroboros.json`/권한 설정 변경. 이유: 프롬프트 인젝션에는 신뢰할 만한 기술적 방어가 없다(Willison: "100% 막는 법을 아직 모른다", Anthropic auto 분류기 false-negative 17%/5.7%). 분류기 정확도가 아무리 올라도 "되돌릴 수 없음 × 외부"는 사람이 누른다. 이건 사장님 작업 규칙(Type 1)과 정확히 일치한다.

**Type 1 결정 (사장님이 정할 것)**:
- (a) 자동 허용 목록의 경계 — 제안: non-main push(자기 브랜치만) · PR 열기(초안) · 브랜치 DB 마이그 · prod SQL 읽기. **PR 자동 머지는 제외**(Supabase 브랜칭이면 머지 = prod 마이그).
- (b) 저장소별 GitHub 룰셋 적용 — 비공개 저장소면 **GitHub Pro 필요**(가격 [미확인]). 관리자 bypass 끄기 포함.
- (c) 자격증명 모델 — 카드용 fine-grained PAT(저장소 스코프·만료) 발급, prod 토큰은 우로보로스 메인에만. 1Password `op run`류 브로커를 쓸지.
- (d) Codex/Gemini 카드의 자율모드 처리 — 지금은 run 시작 때 닫힘. Codex는 네이티브 Windows 샌드박스가 있어 **workspace-write + `never` 승인으로 자율 참여** 가능; Gemini는 소비자 로그인이 2026-06-18 종료돼(유료 API 키만) **베스트에포트**로 격하 제안.
- (e) Claude 카드를 WSL2 안에서 띄워 샌드박스를 켤지 — 네이티브 Windows엔 Claude 샌드박스가 없다. 격리는 크게 오르고 ConPTY·파일시스템 비용이 든다.
- (f) Supabase 브랜칭 결제(Pro + $0.01344/브랜치·시간) vs 로컬 스택 `db reset`.

### 11.1 코드에서 확인한 현재 상태 — 사실 (이 워크트리 소스 직접 읽음)

| 항목 | 사실 | 위치 |
|---|---|---|
| 보드 MCP | 카드마다 stdio MCP 프로세스. 도구 22개(list/read_output/send_prompt/list_roles/create_agent/remove_agent/set_board_tools/get_changes/checkpoint 4종/wait_for_agents/set_note/tidy_board/handoff 4종/browser_*). 훅 서버에 `x-ouroboros-token`·`x-ouroboros-self` 헤더로 HTTP | `src/main/mcp-server.ts:27-34, 48-300` |
| 세 엔진 모두 연결됨 | Claude = `--mcp-config` 파일, Codex = `-c mcp_servers.ouroboros.*`, Gemini = 시스템 설정 파일의 `mcpServers`. **새 메시징 전송층 불필요** | `claude-launcher.ts:184`, `agent-launcher.ts:92-94, 160-170` |
| 토큰 범위 | `randomBytes(24)` **앱 실행당 1개**, 모든 카드 공유(`OUROBOROS_API_TOKEN` env가 덮어씀) | `hook-server.ts:115` |
| `/hook/*` | **토큰 검사 없음** — 로컬 아무 프로세스가 아무 카드의 훅 이벤트(done/needs-you)를 위조 가능 | `hook-server.ts:166-176` |
| `x-ouroboros-self` | 토큰 확인 뒤 **자기주장 헤더를 신뢰**해 `tidy` 범위 등 결정 → 카드 A가 카드 B로 행동 가능 | `hook-server.ts:179-183` |
| 토큰 노출 | Claude 카드: 프로세스 env(`OUROBOROS_TOKEN`) → 에이전트가 띄우는 모든 셸이 상속. **Codex 카드: 명령줄 argv**(`-c mcp_servers.ouroboros.env={...TOKEN...}`) → `Get-CimInstance Win32_Process`로 같은 사용자 전 프로세스가 읽음. Gemini: 설정 파일 | `claude-launcher.ts:36-39`, `agent-launcher.ts:94, 165, 203` |
| 수명 이벤트 | Claude HTTP 훅 / Codex `notify`(턴 종료만, PreToolUse류 게이트 없음) / Gemini `hooks` 명령 | `claude-launcher.ts:163`, `agent-launcher.ts:90, 142-151` |
| 자율모드 레일 | deny 규칙은 카드별 `--settings` 임시 JSON에 기록. run 시작 시 Codex/Gemini 카드 **닫힘**(deny 규칙 없음), run 중 `create_agent`는 Claude만. 캡: dispatch·재시도·stall nudge→park. 이벤트 로그+모닝 리포트 `%APPDATA%\Ouroboros\autonomy\<project>\` | `shared/autonomy.ts:171-200`, `ipc.ts:345-349`, `main/autonomy.ts` |
| 문서화된 한계 | README 83행: 규칙은 **타이핑된 텍스트만** 매치(별칭·래퍼 스크립트·`curl`로 GitHub API·중첩 `bash -c` 못 잡음), Edit 규칙은 셸 쓰기 못 묶음, "샌드박스가 아니다, prod 자격증명을 워커 폴더에 두지 마라" | `README.md:83` |
| 프로젝트 파일 | `.ouroboros.json` 프로젝트 폴더당 1개, 체크포인트는 절대 안 건드림. 벤더 보호 경로 목록엔 없음 | `workspace-store.ts:6`, `checkpoints.ts:6` |
| 원장 | `task_create/claim/update/list`는 **다른 세션이 `claude/task-ledger`에서 구현 중** — 여기선 설계만 참조 | — |

### 11.2 Orca가 다세션 운영에서 하는 것 중 우로보로스에 없는 것 — 사실 + 판정

소스: `stablyai/orca` 문서(`docs/site/content/docs/*`, `skill-guides/*`), `src/` 일부, 2026-08~10 릴리즈 98개, 이슈. v1.4.239(2026-10-24) 기준. **§10 작성 때 못 봤던 교정**: Orca는 실험 기능 **Orchestration**으로 에이전트 간 메시징·태스크 DAG·결정 게이트를 **이미 갖고 있다**. 없는 것은 push/deploy/SQL **정책 게이트**와 deny 목록이다 — 기본 실행이 `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo`("worktree가 샌드박스")이고, 2026-10-20 v1.4.232에서야 Manual|Auto|Yolo 스위치가 생겼다(Auto = Claude `--permission-mode auto`, Claude/Codex만).

| # | Orca 기능 | 사실 (출처) | 판정 | 이유 |
|---|---|---|---|---|
| 1 | **스케줄 자동화**(hourly/daily/cron/RRULE, 타임존, 실행 원장) | 트리거 타입은 `'scheduled' \| 'manual'` 둘뿐, 스케줄러는 로컬 호스트 서비스(클라우드 아님). `automations-types.ts` | **채택** | 스케줄러 없으면 무인 작업이 없다. 모닝 리포트에 실제 야간 실행이 들어감 |
| 2 | **precheck** 셸 게이트(비0 종료 = 건너뜀, 예 `gh pr list`) | GitHub/Linear 이벤트 트리거 **없음**, 폴링으로 대체. `automations.mdx` | **채택** | 웹훅·클라우드 없이 "PR 생기면"을 흉내. 몇 줄 |
| 3 | 실행 원장의 **타입 있는 건너뜀 이유**(`skipped_precheck/missed/unavailable/needs_interactive_auth`, `dispatch_failed`) + "Orca가 터미널을 잃었다" 설명 | `run-completion-watcher.ts` | **채택** | 모닝 리포트는 "왜 안 돌았나"가 필요 |
| 4 | 스케줄 extra-args 허용목록 — **권한/설정 플래그 거부**(v1.4.224) | `automations.mdx` | **채택** | 스케줄로 deny 규칙 우회 못 하게. 사소 |
| 5 | **내구 FIFO 인박스 + 명시 ack**, 타입 있는 `worker_done{outcome, files}`, **dispatch ID**로 스테일 완료 거부 | "성공한 send는 내구 enqueue만 증명, wake/nudge는 베스트에포트" `messaging-and-gates.md` | **적응** | §11.3 메시징의 저장 모델로 그대로. 총괄 `send_prompt`엔 배달·ack 의미가 없다 |
| 6 | `ask`(워커→코디네이터 질문, 옵션+타임아웃) — TUI 프롬프트 대신 | `orchestration.mdx` | **채택** | 무인 운영의 핵심: 막힌 카드 대신 총괄/폰으로 질문 라우팅 |
| 7 | **결정 게이트**(해결될 때까지 태스크 블록) | `orchestration.mdx` | **적응** | parked 카드의 "이유"를 게이트로 — 사장님이 폰/음성으로 해결 |
| 8 | 태스크 DAG 상태 어휘 `pending/ready/dispatched/completed/failed/blocked` | `orchestration.mdx` | **적응** | 로드맵 C 원장의 상태 이름으로 재사용 |
| 9 | **스테일 응답 가드** — prompt-id가 아직 대기 중일 때만 답 주입 | `src/cli/specs/connector.ts` "늦은 답이 다음 프롬프트에 타이핑되지 않게" | **채택** | 폰 컴패니언·총괄 `send_prompt` 둘 다 필요 |
| 10 | **권한 대기 중 후속 메시지 보류** | `connector.ts` | **채택** | 총괄이 승인 메뉴에 타이핑하는 실패를 막음 |
| 11 | **하이버네이션** — 완료·미터치 카드 N분(기본 30) 후 sleep, 열면 `--resume`; 미결 dispatch 있으면 안 잠 | `hibernation.mdx` | **채택** | Orca 이슈 #29899(**Windows**, 3+ 에이전트 메모리 포화·프리즈)의 완화. parked 카드와 자연스럽게 맞음 |
| 12 | 사용량/레이트리밋 칩(로컬 파일만, 80% 경고, 리셋 카운트다운) | `usage-tracking.mdx` | **채택** | "새벽 3시에 멈출까"를 봐야 함. API 호출 없음 |
| 13 | 레이트리밋 시 계정 자동 페일오버 | **Orca에도 없음**, 요청 이슈 #20512(댓글 20) | **적응** | 계정 돌리기 대신 "리셋까지 park" 규칙(이미 15분 continue). 구독 돌려쓰기는 §9에서 금지 |
| 14 | Manual/Auto/Yolo 전역 스위치 | v1.4.232 | **적응** | 자율모드 **아래** 중간 티어로 "Auto"(deny 규칙은 그대로 위에). Orca엔 deny 층이 없다 |
| 15 | Agent Dashboard 칸반(Needs You/Working/Done/Idle≥30분) | `agents-sessions.mdx` | **적응** | 캔버스가 보드. Needs-you 필터·30분 idle 디밍만 |
| 16 | `orca.yaml` `scripts.setup/archive`, `.worktreeinclude` | `orca-yaml.mdx` | **적응** | 헤드리스 spawn에 워크트리 셋업(의존성·env 복사) 필요 |
| 17 | Resource Manager — 병합된 워크트리 일괄 정리(확인 후), PTY 검증 종료 | v1.4.238 | **적응** | 모닝 리포트 액션 "머지된 카드 워크트리 정리" — 항상 확인 후, 자동은 절대 아님 |
| 18 | Keep awake(On/Agent/Off) | `settings.mdx`, Windows 동작 [미확인] | 이미 있음 | 자율모드가 `keepAwake` 보유 |
| 19 | 그룹 주소(`@idle`, `@claude`, `@worktree:`) | `messaging-and-gates.md` | **스킵** | 핸드오프 선이 이미 토폴로지. 브로드캐스트는 소음 + Reason Network 원칙 "브로드캐스트는 사람만" |
| 20 | Agents 피드, Tasks 페이지(GitHub Projects/Linear/Jira), git UI(AI 커밋/PR, 자동 머지, Fix broken checks) | 각 문서 | **스킵** | 모닝 리포트+음성이 캐치업. 사장님이 push·merge를 직접 한다. "Fix broken checks → 새 카드"만 나중에 |

Orca가 **안 하는 것**(= 우로보로스 차별점 유지): push/merge/deploy/SQL deny·정책 게이트 없음 · 이벤트 트리거 없음 · 일괄 승인 없음(문서·트리 검색에서 미발견) · 머지 시 워크트리 자동 삭제 없음(PR #32263은 PR 링크만 정리) · 모닝 리포트·음성 알림 대응물 [부재 미확인]. 운영 불만: #17344 터미널 레코드 누적, #21343 죽은 PTY 재수화, #28147 헤드리스 좀비, #16102 숨긴 창에서 권한 알림 유실.

### 11.3 엔진 간 통신 — 사실과 추천 설계

**사실 (엔진 × 능력)** — 편집자가 Claude 두 항목을 공식 문서에서 재확인(2026-10-25).

| 엔진 | 실행 중 인바운드 | idle 때 인바운드 | 훅 | Stop/계속 | 비고 |
|---|---|---|---|---|---|
| **Claude Code** | ① **채널**: MCP 서버가 `capabilities.experimental['claude/channel']` 선언 → `notifications/claude/channel {content, meta}`; 바쁘면 모아서 다음 턴. **ack 없음, 미등록이면 조용히 드롭**. ② **크로스세션 메시징**(네이티브 Windows **v2.1.234+**, 기본 on): 세션마다 **named pipe**, `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`을 훅·Bash에 export, Windows는 첫 줄 `{"type":"auth","token":…}` 필수; "툴 호출 사이에" 읽음. ③ PostToolUse/UserPromptSubmit `additionalContext` | ② idle이면 **새 턴 시작**. `asyncRewake` 훅 exit 2가 깨움 | 33 이벤트, `command`/`http`/`mcp_tool` 타입(http는 SessionStart 불가) | Stop `decision:"block"`+reason 계속 | 채널은 **리서치 프리뷰**: 커스텀 채널은 `--dangerously-load-development-channels server:<name>` + 전체화면 확인 다이얼로그, `-p`/SDK에선 무시, claude.ai/Console 인증 필요, `--help`에 없음, 계약 변경 가능. 크로스세션은 기본 정책이 bypass 클래스 불일치 시 **hold**(5분 후 드롭) — 카드 `--settings`에 `crossSessionInbound:"accept"` 필요. 루프 가드 내장(발신자별 레이트리밋·동일 반복 드롭·큐 50) |
| **Codex CLI** | `codex app-server`(stdio JSONL) `turn/steer`(활성 턴에 입력 추가), `turn/interrupt`; TUI면 훅 `additionalContext`(SessionStart/UserPromptSubmit/Pre·PostToolUse)만 | app-server `turn/start`; TUI는 **없음**(PTY 타이핑만) | 12 이벤트 **기본 on**, **해시로 신뢰** — 훅 명령이 바뀌면 재신뢰까지 건너뜀 → 토큰은 inline 말고 env로 | Stop `decision:"block"` → `reason`이 계속 프롬프트 | app-server WebSocket 리스너는 실험적이며 **기본으로 비-루프백 무인증 허용** — 쓰지 말 것. `notify`·`-c mcp_servers` [이번 세션 미재확인] |
| **Gemini CLI** | 푸시 없음. BeforeAgent `additionalContext`(그 턴만), AfterAgent `decision:"deny"` → `reason`을 새 프롬프트로 재시도(`stop_hook_active` 제공) | ACP `session/prompt`(네이티브 ACP 에이전트) | 11 이벤트 | AfterAgent deny | **Google 공식**: 2026-06-18부로 소비자(AI Pro/Ultra·무료 Code Assist) 접근 종료, "Login with Google" 불가; **유료 Gemini API 키·Code Assist Standard/Enterprise만** 유지. 후속은 비공개 **Antigravity CLI(`agy`)**, 훅 문서 404, ACP 목록에 없음 → **베스트에포트 어댑터** |
| 프로토콜 | ACP(`session/prompt`/`update`/`cancel`, 중간 steer 없음): Gemini 네이티브, Claude `claude-agent-acp`, Codex `codex-acp` 어댑터. MCP 2025-11-25: tasks(실험)·URL elicitation·sampling tools — **서버가 사용자 턴을 주입하는 표준은 없음**(채널은 Anthropic 확장) | | | | |

**선행 사례**: Reason Network(MIT/Apache, Rust P2P) — MCP 도구 `list_team`/`send_message`/`check_inbox`; Claude Code·Codex는 미드세션+idle 웨이크, Gemini/Cursor/Copilot은 "다음 스텝에"; 오프라인 큐; **브로드캐스트는 사람만**(푸시 메커니즘 자체는 미문서화). Claude agent teams — `~/.claude/teams/<team>/inboxes/<agent>.json` 파일 메일박스, 쓰기 성공 = 전송 성공, Windows Terminal 분할 미지원. mcp_agent_mail — pull 전용(git+SQLite, `fetch_inbox`/ack/advisory 파일 리스), Python판 비유지. Gas Town `gt nudge` = tmux send-keys, 본인 문서가 "undocumented limits" 취약점으로 명시.

**추천 설계 (기존 `mcp-server.ts`/`hook-server.ts` 패턴 유지)**:
1. **도구 셋** — 보드 MCP에 `send_message(to, body, kind?, reply_to?, ack_required?)`, `check_inbox(unread_only)`, `ack(id)`. 수신자는 카드 ID 또는 제목. `kind` 어휘는 Orca를 빌린다: `status | question | worker_done{outcome, files} | escalation`. 브로드캐스트 도구는 **없음**(사람만, 인스펙터에서).
2. **저장** — 훅 서버(메인 프로세스)가 카드별 **내구 FIFO**를 소유: `{id, from, to, kind, body, created, delivered?, acked?}`, 디스크(`%APPDATA%\Ouroboros\mail\<project>.jsonl`)에 append. 원장(`claude/task-ledger`)과 같은 저장 패턴. **send 성공 = enqueue 증명만**. 50개 큐 상한, 발신자별 분당 N개, 동일 본문 60초 내 반복 드롭(Claude 내장 규칙 복제).
3. **배달 어댑터** (베스트에포트, 멱등):
   - **공통 백스톱** = **Stop 훅 드레인**: 턴이 끝나려 할 때 미읽음 메일이 있으면 `decision:"block"`, `reason` = 메일 본문(발신 카드 표시, "다른 카드의 메시지, 사용자 승인 아님" 래퍼). 연속 block 상한 3(Codex/Gemini는 `stop_hook_active`로 확인). 이것만으로 세 엔진 모두 "미읽음 메일 두고 턴을 끝내지 않음"이 된다.
   - **미드턴** = Claude PostToolUse/UserPromptSubmit `additionalContext`, Codex Pre/PostToolUse `additionalContext`, Gemini BeforeAgent `additionalContext`. 이미 훅 서버가 이 이벤트를 받고 있으니 응답 본문에 싣기만 하면 됨(지금은 `{}`를 즉시 반환).
   - **idle 웨이크** = Claude는 named pipe(v2.1.234+)에 auth 줄 + 메시지(줄 스키마 [미확인] — 스파이크 필요), 또는 채널(프리뷰, 다이얼로그 비용). Codex TUI는 idle 웨이크 없음 → 지금처럼 `send_prompt`(PTY 타이핑)가 폴백, 단 **권한 대기 중엔 보류**(§11.2 #10) + **prompt-id 가드**(#9). Gemini는 `send_prompt` 폴백.
   - Codex를 `app-server`로 띄우는 안(`turn/steer`·`thread/resume`·`item/permissions/requestApproval`)은 **카드 UI를 PTY에서 이벤트 렌더로 바꾸는 큰 공사** — 0.9 이후로 디퍼.
4. **보안 결합** — `send_message`의 `from`은 헤더가 아니라 **카드별 토큰에서 유도**(§11.5 #5). 워커 역할은 `send_message`를 **부모(총괄)에게만**, `send_prompt`·`create_agent`는 총괄 전용(`set_board_tools` 역할 프로파일). 수신 본문은 항상 "untrusted data from card X" 봉투.
5. **UI** — 핸드오프 선 위에 메시지 수 배지, 인스펙터에 인박스 탭, 모닝 리포트에 "메일 N통, 미ack M통".

### 11.4 push / merge / deploy / 마이그레이션 / SQL의 게이트된 자동화 — 서베이와 "액션 게이트" 설계

**서베이 — 2025–26 도구들이 게이트를 어떻게 세우나** (1차 문서 읽은 것은 출처 표기, 아니면 [미확인])

| 층 | 메커니즘 | 기계적? | 비용 |
|---|---|---|---|
| GitHub 서버 | **룰셋**(PR 필수·필수 상태 체크·force push 차단·"배포 성공 필수"·서명 커밋), 클래식 보호와 **합산되어 가장 엄격한 쪽 적용**, bypass 액터(역할·팀·GitHub App). 공개 저장소 무료, **비공개는 Pro 이상** | **예**(에이전트가 로컬 자격증명만 들면 못 넘음) | Pro 가격 [미확인]; 설정 ~10분 |
| GitHub 환경 | required reviewers(최대 6, 1명 승인), self-review 금지, wait timer(≤30일), 배포 브랜치 제한, 커스텀 보호 규칙(App, 프리뷰). **required reviewers는 공개 저장소 또는 Enterprise** — 비공개 개인 저장소엔 "승인 클릭" 없음 | 예 | 공개면 무료 |
| GitHub 머지 큐 | 조직 소유 공개 저장소 또는 Enterprise Cloud. **개인 계정 불가** | — | 해당 없음 |
| GitHub 토큰 | fine-grained PAT(저장소 선택·권한별 r/w·만료 ≤366일), App 설치 토큰(1h), `GITHUB_TOKEN` `permissions:` 블록, Actions OIDC(`id-token: write` → 클라우드 신뢰, 환경 바운드 `sub`). **함정**: PAT 소유자가 admin이고 admin이 bypass면 토큰이 bypass 상속 → **admin을 bypass에서 뺄 것** [PAT·App·OIDC 세부 미확인] | 예 | 무료 |
| Supabase | **브랜칭**: PR마다 브랜치 DB, **PR 머지 시 Supabase가 prod에 pending 마이그 적용**(Clone→Pull→Health→Configure→Migrate→Seed→Functions) → "머지 클릭 = prod 마이그 게이트". Pro/Team + **$0.01344/브랜치·시간**. **스코프 PAT GA(2026-10-06)**: 능력별 read/read-write, **SQL은 Database read-write 없으면 read-only**. `db push`는 `environment: production` 잡 + env 시크릿으로 [미확인]. `pg_read_all_data`+`default_transaction_read_only` 롤, `pgaudit` [미확인] | 예(서버) | Pro |
| Cloudflare | `wrangler versions upload`(배포 없이 버전 생성, Workers Builds가 비-prod 브랜치에 기본) vs `versions deploy`(트래픽 %). **버전 URL은 prod 바인딩(D1/KV/R2) 공유** → "프리뷰"가 prod 데이터를 만질 수 있음. 토큰 권한 "Workers Scripts:Edit"는 upload·deploy 둘 다 [미확인] | 워크플로 기계적, **자격증명 기계적 아님** | 무료 |
| Vercel | 프리뷰 vs `vercel promote`; **Rolling Releases**(Pro, 프로젝트 1개, 단계별 %; CI는 `rolling-release start/complete`, `promote`는 100%로 점프). 토큰은 팀 스코프, 프로젝트 스코프 없음 [미확인] | 같음 | Pro |
| 정책 엔진 | OPA/Conftest(Rego, CI 필수 체크), Cerbos, Oso; 에이전트 승인 제품(HumanLayer·Permit.io·Composio/Arcade·Devin "ask before") — **전부 [미확인]**, 솔로 개발엔 과함 | — | — |
| 자격증명 브로커 | 1Password `op run`, Doppler/Infisical `run --`, Vault 동적 DB 자격증명(TTL) — 비밀을 **자식 프로세스 env에만** 주입 [미확인]. Anthropic 클라우드 세션 모델: GitHub 자격증명이 VM에 절대 안 들어가고 프록시가 서버 측에서 붙임(공식) | 예 | 무료~ |
| **Claude Code** | 평가 순서 **deny → ask → allow**, 첫 매치 확정, 특이성 무관. Bash 규칙은 전체 명령 텍스트 매치, 서브셸·`$(…)`·루프 안도 검사. 공식 문구: "**프로그램을 둘러싼 보안 경계가 아니다**", "인자 제약 패턴은 fragile". PreToolUse 훅 `permissionDecision allow/deny/ask/defer`, **exit 2는 규칙 평가 전 차단**(allow보다 셈), 훅 allow는 deny/ask 못 넘음. `PermissionRequest` 훅. `disableBypassPermissionsMode`/`disableAutoMode: "disable"`(관리 설정이면 불변). 샌드박스: **"네이티브 Windows에선 샌드박스 없이 실행"**, WSL2만. 모드 `auto` 분류기(2026-03-25): FP 0.4%, **과잉 행동 FN 17%(n=52), 합성 유출 FN 5.7%(n=1000)**, "고위험 인프라의 사람 리뷰 대체 아님". 관리 설정/Team 로그인 아니면 **mod가 deny를 뒤집을 수 있음** | 2차 레일 | 무료 |
| **Codex CLI** | `sandbox_mode` read-only / workspace-write / danger-full-access; `approval_policy` 현재 문서는 **on-request / never**만(`untrusted` 선택 불가, `on-failure`·`--full-auto`는 구 문서). **네이티브 Windows 샌드박스**: MXC(관리자 불필요, Win11 24H2 26100.9278+/25H2 26200.9278+ — 이 PC 26200, 리비전 [미확인]), elevated(전용 저권한 사용자·ACL·방화벽·**deny-read 글롭**), unelevated(제한 토큰, deny-read 없음). CVE-2025-59532(0.39.0 수정) 샌드박스 쓰기 루트 우회 | 샌드박스는 기계적 | 무료 |
| **Gemini CLI** | 승인 `default/auto_edit/plan`, YOLO는 CLI 플래그만, `security.disableYoloMode`·`admin.secureModeEnabled`. **TOML 정책 엔진**(`[[rule]] toolName/commandPrefix/decision allow\|deny\|ask_user/priority`, Admin>User>Workspace>Extension>Default, 비대화형에서 `ask_user`→deny). 샌드박스 `windows-native`(icacls Low MIL, 세션 후 **지속**)/docker | 정책 2차, 샌드박스 약함 | 무료 |
| git 로컬 | pre-push 훅은 `--no-verify`·`core.hooksPath`로 우회, `includeIf "gitdir:"`로 폴더별 자격증명/서명키, GCM `credential.useHttpPath` [미확인]. 같은 OS 사용자인 에이전트는 `.git/config`·훅을 고칠 수 있음 → **관례 수준**(실수 방지엔 유효) | 아니오 | 무료 |

**액션별 결론 (솔로 개발·개인 GitHub·Windows)**:

| 액션 | 기계적 게이트 | 어디서 | 제안 |
|---|---|---|---|
| 자기 브랜치 push | 저장소 스코프 PAT(Contents:write, admin bypass 없음) | 서버(토큰) | **auto**(브랜치 패턴 `claude/*`·`card/*`만, CLI는 `ask`→정책으로 allow) |
| main push | 룰셋(PR 필수·force 차단·업데이트 제한·bypass 액터 0) | 서버 | **never** + CLI deny 2중 |
| PR 열기 | 토큰(Pull requests:write) | 서버 | **auto**(draft) |
| PR 머지 | 룰셋 체크 + `gh pr merge --auto`; 솔로는 자기 PR 승인 불가 | 서버 | **사장님 클릭**(Supabase 브랜칭이면 머지 = prod 마이그). CLI deny `gh pr merge` 유지 |
| 프리뷰 배포 | 플랫폼 Git 연동(에이전트 자격증명 0) | 플랫폼 | **auto**, 단 Cloudflare 버전 URL의 prod 바인딩 주의 |
| prod 배포 | main 빌드 또는 `workflow_dispatch`(사람 클릭); Rolling/`versions deploy %` | 서버+플랫폼 | **사람 트리거**, prod 토큰은 에이전트 env에 없음 |
| 브랜치 DB 마이그 | Supabase 브랜칭(자동) 또는 로컬 `db reset` | 플랫폼 | **auto**(결제 시) |
| prod 마이그 | 브랜칭 머지 또는 `environment: production` 잡 | 서버 | **사람만**(머지 클릭/dispatch). DB 비번·rw PAT 절대 미지급 — 현행 규칙 그대로 |
| prod SQL 읽기 | `pg_read_all_data` 롤 / 스코프 PAT Database:read / MCP `--read-only` | 서버 | **auto**(읽기 전용 자격증명으로) |
| prod SQL 쓰기 | 에이전트 경로 없음 | 자격증명 부재 | **사람 실행**, 에이전트는 SQL+롤백 초안(현행 "상자" 관행) |

**"액션 게이트" 설계** (0.9):

1. **정책 파일** — 프로젝트별, 단 **워크트리 밖**: `%APPDATA%\Ouroboros\policy\<project-hash>.json`(`.ouroboros.json`은 참조만; 벤더 보호 목록에 없으므로 로드 시 SHA-256 대조, 불일치면 사람 클릭 없이는 리로드 거부). 스키마 초안:
   ```json
   { "version": 1,
     "actions": {
       "git.push":        { "auto": ["refs/heads/claude/*", "refs/heads/card/*"], "never": ["refs/heads/main", "--force*"] },
       "gh.pr.create":    { "auto": { "draft": true } },
       "gh.pr.merge":     "ask",
       "deploy.preview":  "auto",
       "deploy.prod":     "never",
       "db.migrate":      { "auto": ["branch"], "never": ["prod"] },
       "db.sql.read":     { "auto": { "role": "agent_ro" } },
       "db.sql.write":    "never" },
     "credentials": { "GITHUB_TOKEN": "card-pat", "SUPABASE_ACCESS_TOKEN": "broker-only" } }
   ```
   `auto`는 조건부 자동, `ask`는 **APPROVAL NEEDED**(parked 게이트, 폰/음성/인스펙터에서 해결), `never`는 에이전트 경로 자체 없음(= 자격증명 부재 + 서버 규칙). 정책은 **더 엄격해지는 방향만** 카드가 제안 가능, 완화는 사장님 클릭.
2. **3층 집행** — ① **서버**: 저장소마다 체크리스트(main 룰셋·bypass 액터 0·force 차단·필수 체크, Supabase 브랜칭 또는 `environment: production` dispatch) — 우로보로스가 `gh api`로 **읽어서 상태바에 "룰셋 ✓/✗"** 표시(쓰기는 안 함). ② **자격증명**: 카드 spawn 시 **env 허용목록**(부모 env 상속 금지; `ANTHROPIC_API_KEY`·`GITHUB_TOKEN`·`SUPABASE_*`·`CLOUDFLARE_*`·`VERCEL_*` 제외), 카드용은 fine-grained PAT 1개만. prod 토큰은 **메인 프로세스가 Windows Credential Manager/DPAPI에서 읽어** "승인 후 실행" 버튼이 띄우는 자식 프로세스 env에만 주입 — 카드가 읽을 수 있는 파일·env엔 절대 없음. ③ **CLI 레일**: Claude = `permissions.deny`(현행) + `ask`(`git push*`) + **PreToolUse 훅 exit 2**(정책 파일 평가 — `git push`의 refspec·`gh pr merge`·`wrangler versions deploy`·`vercel promote`·`supabase db push` 등; 훅은 **메인 프로세스가 평가**하고 결과만 반환; 그 입력 `session_id, tool_input, cwd, tool_use_id`가 감사 로그 한 줄). Codex = `sandbox_mode: workspace-write` + `approval_policy: never` + PreToolUse 훅(해시 신뢰라 명령 불변). Gemini = 정책 TOML(`git push` deny, Admin 티어) + BeforeTool 훅. 단, 세 벤더 모두 **규칙은 2차**라는 걸 UI에 적는다(지금 README처럼).
3. **감사 로그** — `%APPDATA%\Ouroboros\audit\<project>.jsonl`: `{ts, card, engine, action, decision(auto|ask|never|approved|denied), by(policy|owner), tool_input, cwd, head_sha, diff_sha256}`. **모닝 리포트** 첫 섹션 "게이트": 자동 허용 N, 승인 대기 M(링크), 거부 K(어떤 카드가 뭘 시도했나). Claude auto 분류기 거부도 같은 파일(현재는 분류기 거부만 보고 — 규칙 거부도 넣는다).
4. **범위 밖** — 자체 권한 분류기(§9 금지 유지), 머지 큐(개인 계정 불가), OPA(과함), 클라우드 승인 서비스.

### 11.5 보안 — 무인 보드의 위협 모델 (각각 완화·비용·잔여 위험)

| # | 위협 | 근거 사례 (출처) | 기계적 완화 | 비용 | 잔여 위험 / 사람 게이트? |
|---|---|---|---|---|---|
| 1 | **가져온 콘텐츠의 프롬프트 인젝션**(웹·이슈·PR 코멘트·README·MCP 결과) → 도구 오용·유출 | Willison "lethal trifecta"(비공개 데이터+신뢰 못 할 콘텐츠+외부 통신), "100% 막는 법 모른다"(2025-06). Invariant GitHub MCP 독성 흐름(공개 이슈→비공개 저장소 유출, 서버 버그 아님). Tracebit Gemini CLI RCE(README/GEMINI.md + 허용목록 파싱, `env \| curl`, 0.1.14 수정). Claude Code 승인 우회 CVE-2025-54795/58764, CVE-2026-24887. Codex CVE-2025-59532. OWASP Agentic Top 10 ASI01(2025-12, PDF [미확인]) | **카드별 트라이펙타 분리**: 리서치 카드 = 웹 fetch O·비밀 X·쓰기 도구 X; 빌드 카드 = 저장소·토큰 O·웹 fetch X·egress 허용목록. 한 카드에 둘 다 두지 않음. Claude WebFetch는 요약 모델 경유(공식). bypassPermissions 절대 금지 | 중(역할 프로파일에 도구 셋 추가) | **높음 — 사람 게이트 필수**: push·공개 PR/이슈/코멘트·퍼블리시·외부 송신. github.com 허용은 그 자체가 유출 채널(gist/PR) |
| 2 | **페르소나 카탈로그·CLAUDE.md/AGENTS.md/GEMINI.md 인젝션, 숨은 유니코드** | Pillar "Rules File Backdoor"(2025-03, 숨은 유니코드). Snyk ToxicSkills(2026-02): 스킬 3,984개 중 **13.4% 치명**. Anthropic이 유니코드 태그 문자 감지 추가 [미확인]. Claude `-p`/SDK는 **신뢰 다이얼로그 없이** 저장소 훅·`env`·`apiKeyHelper`·`.mcp.json`을 로드(`permissions.allow`·추가 디렉토리만 보류) — 공식 | Agency 카탈로그 **스냅샷 + 파일별 SHA-256 핀**, 임포트 시 유니코드 Tags(U+E0000–E007F)·zero-width·bidi·HTML 코멘트 스크럽, 갱신은 diff 리뷰 후. 서드파티 저장소 카드는 `--setting-sources user` 또는 `--bare` + 명시 `--settings`, Gemini `folderTrust` on(기본 off) | 낮음(수십 줄) | 첫 임포트 내용·저장소 컨텍스트 파일은 여전히 프롬프트 → **첫 신뢰·카탈로그 갱신·서드파티 저장소 = 사람** |
| 3 | **자격증명 유출**(`.env`·`~/.aws`·gh `hosts.yml`·Credential Manager·상속 env) | Claude `Read(./.env)` deny는 내장 도구와 `cat/head/sed`만, **`grep -r`·Python/Node 서브프로세스엔 무효**(공식). 샌드박스에 기본 자격증명 deny 목록 없음(공식). Claude 자격증명은 Windows에서 사용자 프로필 ACL 파일(공식). Codex elevated만 deny-read | spawn env 허용목록, 저장소 스코프 단명 토큰, 브로커(§11.4 ②), Codex elevated deny-read, Claude는 WSL2 샌드박스 `sandbox.credentials`(네이티브 불가) | 낮~중 | 같은 OS 사용자면 `git credential fill`·프로필 파일 읽기 가능 → OS 사용자 경계 없으면 중간. 게이트 아님, 의심 시 회전 |
| 4 | **워커가 자기 가드레일 편집**(`.claude/settings*.json`·`~/.claude`·`.ouroboros.json`·훅·`.mcp.json`) | Claude 보호 경로(`.git`·`.claude`·`.mcp.json`·rc 파일…)는 모든 모드에서 자동 승인 안 됨, **bypassPermissions만 허용**(공식). `ConfigChange` 훅으로 차단 가능(공식). 샌드박스는 쓰기 거부(공식). CVE-2026-55607 워크트리/심링크 탈출 [미확인] | bypass 금지 + `disableBypassPermissionsMode:"disable"`(관리 설정 경로 [미확인]), ConfigChange 훅, `.ouroboros.json`·정책 파일 워크트리 밖 + 해시, 보드 권위는 메인 프로세스에만. 강한 집행은 **카드별 별도 Windows 사용자**(Codex elevated·srt-win 방식) | 중~높 | 같은 사용자 서브프로세스는 Claude 파일 규칙 우회 → **권한·정책 변경 = 사람 클릭** |
| 5 | **카드 간 측면 이동**(보드 MCP로 `send_prompt`·`create_agent`·타 카드 출력 읽기) | 공개 사례 없음. 선례: Claude 크로스세션은 bypass 클래스 불일치 메시지를 **hold**, `requiresUserInteraction` MCP 도구는 bypass에서도 자동 승인 안 됨(공식). **로컬 사실**: 토큰 1개 공유 + self 헤더 신뢰(§11.1) | **카드별 토큰**(호출자 신원 = 토큰), 역할별 도구 화이트리스트(워커: 자기 상태 보고·부모에게 메시지만; `send_prompt`·`create_agent`·타 카드 `read_output`은 총괄/사람), 카드 생성 야간 캡(있음), 교차 카드 텍스트 "untrusted" 봉투 | 낮음 | 총괄 카드는 단일 침해점 → 총괄의 카드 생성은 캡 초과 시 사람 |
| 6 | **훅 서버/토큰 남용**(argv·DNS 리바인딩·CSRF) | MCP Inspector CVE-2025-49596(0.0.0.0 + DNS 리바인딩, 웹페이지 방문만으로 RCE). Langflow CVE-2025-3248(CISA KEV). **로컬 사실**: `/hook/*` 무인증, Codex argv 토큰 | 127.0.0.1 유지, **모든** 경로 토큰(헤더), `Host`가 `127.0.0.1:<port>` 아니면 거부, `Origin` 있으면 거부, CORS 없음, 상수시간 비교, 토큰은 env/파일(argv 금지), 실행당 회전 | 낮음(하루) | 같은 사용자 에이전트는 상속 env의 토큰을 읽음 → "토큰 보유 = 보드"가 아니라 **카드 단위 권한** |
| 7 | **네이티브 Windows 샌드박스 부재** | Claude: "네이티브 Windows는 샌드박스 없음, WSL2 사용"(공식). Codex: MXC/elevated/unelevated(공식). Gemini: icacls Low MIL/Docker(공식). Anthropic sandbox-runtime Windows 알파(`srt-sandbox` 사용자+WFP) [미확인] | Codex = MXC, Claude = WSL2 안 `sandbox.enabled`+`failIfUnavailable`+`allowUnsandboxedCommands:false`(ConPTY→`wsl.exe`, 저장소 WSL 파일시스템 [미확인]), Gemini = Docker. 전 엔진 공통 = 카드별 Windows 사용자 | 높음 | 프록시 TLS 미검사·도메인 프론팅·벤더 CVE. **Type 1 (e)** |
| 8 | **MCP/스킬/플러그인 공급망**(악성 패키지·툴 설명 변조·러그풀) | postmark-mcp 숨은 BCC(2025-09) [미확인]. ToxicSkills. Anthropic "MCP 서버를 감사하지 않음"(공식). `disabledMcpjsonServers`(공식) | 보드가 MCP 설정 소유(`--mcp-config`, `--strict-mcp-config` [미확인]), 정확한 버전 핀(`@latest` 금지), 승인 시 툴 목록 해시 저장·변경 시 재승인, 자동 업데이트 없음 | 낮음 | 첫 버전이 악성이면 리뷰로만 → **새 MCP/스킬 소스 = 사람** |

**안전하게 만들 수 없어 사람 게이트로 남는 것**: #1 인젝션 자체 → 되돌릴 수 없는 외부 송신 전부(push·merge·공개 PR/이슈/코멘트·퍼블리시·메시지 송신·prod 배포·prod SQL 쓰기). #2/#8의 **첫 신뢰**(페르소나·스킬·MCP 서버 소스, 서드파티 저장소). #4의 정책·권한 변경. 나머지(#3·#5·#6·#7·공급망 핀)는 낮~중 비용으로 기계적 완화 가능하며 §11.0 1단계가 그 시작이다.

### 11.6 미확인 목록 (쓰기 전에 확인할 것)

- Claude named pipe의 auth 줄 **이후 메시지 줄 스키마**; stdio MCP 자식이 `CLAUDE_CODE_MESSAGING_*` env를 받는지; `asyncRewake`가 완전 idle에서 새 턴을 여는지; 채널 dev 플래그 다이얼로그가 Electron ConPTY에서 어떻게 뜨는지 — **스파이크 1일**.
- Codex `notify`·`-c mcp_servers` 재확인, `.git` 보호·네트워크 기본값, MXC 가용 빌드 리비전(이 PC `winver`).
- GitHub Pro 가격, 비공개 개인 저장소의 push 룰셋·커스텀 배포 보호 규칙 가용성, fine-grained PAT/App 토큰/OIDC 세부(공식 문서 URL은 §11.7).
- Supabase `db push`/`db lint`/`pg_read_all_data`/`pgaudit` 세부, Vercel 프로젝트 스코프 토큰 존재, Cloudflare upload 전용 권한 존재.
- 보안: `disableBypassPermissionsMode` 관리 설정 경로, srt-win 레포 README, Windows argv/env 가시성 범위, GCM per-path, `op run`, Anthropic 유니코드 태그 감지 변경 로그, OWASP Agentic Top 10 원문.
- Orca: 자동화가 데스크톱 꺼진 동안 도는지, 하이버네이션 도입 시점, 모닝 리포트·음성 알림 부재.
- Gemini CLI 저장소 유지 상태(2026-06 이후), Antigravity CLI 훅·ACP.

### 11.7 출처 (1차 우선; 이번 조사에서 읽음, 2025-10 ~ 2026-10)

Anthropic/Claude Code: code.claude.com/docs/en/{channels, channels-reference, cross-session-messaging, hooks, agent-teams, permissions, permission-modes, sandboxing, security, settings-reference}, anthropic.com/engineering/claude-code-auto-mode(2026-03-25), github.com/anthropics/claude-code 어드바이저리 GHSA-x56v-x2h6-7j34 · GHSA-qxfv-fcpc-w36x · GHSA-qgqw-h4xq-7w8w. OpenAI/Codex: learn.chatgpt.com/docs/{app-server, hooks, sandboxing, windows/windows-sandbox}(developers.openai.com/codex가 리다이렉트), osv.dev CVE-2025-59532, github.com/openai/codex/issues/9062. Google/Gemini: developers.googleblog.com "transitioning-gemini-cli-to-antigravity-cli", developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals, geminicli.com/docs/hooks(+reference), github.com/google-gemini/gemini-cli/docs/{reference/configuration, reference/policy-engine, cli/trusted-folders, cli/sandbox}. 프로토콜: agentclientprotocol.com/{overview/agents, protocol/prompt-turn}, modelcontextprotocol.io/specification/2025-11-25/changelog. Orca: github.com/stablyai/orca — docs/site/content/docs/{cli/automations, cli/orchestration, cli/worktree-checkpoints, model/agents-sessions, agents/hibernation, agents/usage-tracking, agents/native-chat, review/github, review/commit-push, mobile, settings, activity}, skill-guides/orchestration/references/messaging-and-gates.md, src/shared/automations-types.ts, src/main/automations/*, src/cli/specs/connector.ts, releases v1.4.180–v1.4.239, issues #16102 #17344 #20512 #21343 #25451 #26714 #28147 #29899, PRs #19244 #32263. GitHub: docs.github.com {about-rulesets, available-rules-for-rulesets, deployments-and-environments, merging-a-pull-request-with-a-merge-queue}. Supabase: supabase.com/docs/guides/deployment/branching, supabase.com/pricing, supabase.com/changelog/scoped-personal-access-tokens-ga(2026-10-06). Cloudflare: developers.cloudflare.com/workers/{configuration/versions-and-deployments/gradual-deployments, ci-cd/builds/configuration, versions-and-deployments/version-urls}. Vercel: vercel.com/docs/rolling-releases(2026-09-15). 선행 사례·사고: github.com/reason-machines/reason-network, github.com/Dicklesworthstone/mcp_agent_mail, docs.gastownhall.ai/usage/communication, simonwillison.net/2025/Jun/16/the-lethal-trifecta, invariantlabs.ai/blog/mcp-github-vulnerability, tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack, snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub, thehackernews.com(Rules File Backdoor 2025-03), recordedfuture.com(CVE-2025-49596), helpnetsecurity.com(CVE-2025-3248). 2차(미확인 표기): CSA 리서치 노트(claude-code-action CVE-2025-66032, skill.md 포이즈닝, MCP 툴 포이즈닝), codex.danielvaughan.com, morphllm.com, flaviocopes.com, aiweekly.co.
