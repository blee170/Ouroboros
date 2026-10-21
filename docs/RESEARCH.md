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
