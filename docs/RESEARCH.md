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
| 선행 사례 공통 패턴 | 소리/토스트/음성 각각 토글(claude-code#45619 제안), 창 포커스 시 억제(Herdr), 10초 미만 작업은 안 알림(docker-agent `sound_threshold`), 매 턴 알림은 짜증(claude-code#87351), 300자 넘으면 "보고서 확인" 문구(heard.dev 가이드). VoiceMode MCP(mbailey/voicemode, MIT)는 양방향 대화형 — 총괄과 "통화"가 필요해지면 후보. | 각 저장소 |

**채택 규칙** (`src/shared/announce.ts`): 대상 off/총괄만(기본)/전부 · 토스트·음성 각각 · 턴 10초 미만 무시 · 문장은 고정("○○ 작업이 끝났습니다. 보고를 확인해 주세요" — 답변 본문은 절대 안 읽음; 네 명의 의견 수렴 후 Jev 선택 a 0.69/grounded 0.80) · 한글이 제목/답변에 있으면 한국어, 한국어 음성 없으면 영어 문장으로 폴백 · needs-you는 카드당 60초에 한 번 음성 · 여러 카드가 돈 뒤 5초 정적이면 "모든 카드 작업이 끝났습니다"(마지막 턴이 이미 개별로 알려졌으면 생략).

**알려진 한계**: tap 모드 마이크가 열린 채면 TTS 문장이 받아쓰기에 섞인다(README에 적음) · 알림은 창 포커스와 무관하게 나간다(설정 없음, 단순 유지).
