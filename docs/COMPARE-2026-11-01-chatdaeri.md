# 챗대리 "나만의 AI 업무 시스템 4단계" vs Ouroboros (2026-11-01)

영상: [클로드는 이렇게 쓰는 겁니다: 나만의 'AI 업무 시스템' 4단계 구축법](https://www.youtube.com/watch?v=3Me5BJgsG7E) — 챗대리의 AI연구소, 2026-10-30 업로드, 17:16.
본 방법: yt-dlp 다운로드, 자막 없음(429) → Whisper(base) 전사 2,003단어, 15초 간격 프레임 60장(7장 컨택트 시트 + 개별 프레임 8장 확대). 영상 전체를 봤고, 제목·설명으로 추측한 내용은 없다.
비교 기준: `main` 125cdce(v0.18.10 + PR #69, #70 미릴리스). Ouroboros 쪽 주장은 전부 `README.md` 기능표와 `src/` grep으로 확인했다.

## 영상이 보여준 것

**제품이 아니라 개인 운영 체계**다. 지난 Herdr 비교(오케스트레이터 대 오케스트레이터)와 달리, 이 영상은 Claude 데스크톱 앱 + Claude Code 위에 1인 사업자가 쌓아 올린 "AI 업무 시스템"을 4단계(SSR+: Skill · Second brain · Routine · Extension)로 설명한다. 기술 스택: Claude 데스크톱 앱(스킬·예약된 작업·커넥터), Claude Code(AGENTS.md, 파일 작업), Claude가 만들어 준 자체 웹 대시보드(React로 보이는 다크 UI, 지식 그래프는 3D 포인트 클라우드), 상시 머신에는 Hermes 에이전트 + Syncthing.

| 시각 | 보여준 것 | 메모 |
|---|---|---|
| 00:00–02:05 | **개인 대시보드**: 유튜브·뉴스레터 지표, 메일함, 캘린더, 라이브러리(브랜드·콘텐츠 에셋), 중앙에 세컨드 브레인 그래프. 아래 **스킬 카드**(Claude · create-quotation, collab-pick, ai-news-digest, video-transcription…): 클릭 → 모델 선택 → 프롬프트 입력 → 실행. 그 아래 **루틴**(Mac/Windows 탭, 예약 실행 목록) | 스킬 카드 하나로 사업자 정보 기반 견적서(HWP)를 바로 생성 |
| 02:40 | SSR+ 프레임: Skill → Second Brain → Routine → Extension, 각 단계 초급/중급/고급 | |
| 03:14–04:30 | **스킬 초급**: Claude 데스크톱 사용자 지정 → 스킬 → skill-creator로 말로 스킬 만들기(트위터에서 본 PC 점검 프롬프트를 스킬로) | Claude 데스크톱 기능 |
| 04:32–05:40 | **스킬 중급**: 스킬 폴더 안에 참고자료(`references/style.md`, `frame.css`, `tokens.css`, `assets/logo.png`, `examples/sample-deck.html`). HTML 조각을 통째로 넣어 두면 처음부터 코드를 짜지 않음 | Claude Code 스킬 규약 그대로 |
| 05:45–06:40 | **스킬 고급 — 스킬이 낡는 문제**: ① 스킬 자체에 업데이트 기능(발동 시 새 양식이 있으면 reference/template을 갱신하고 뭐가 달라졌는지 보고) ② "최근 N일간 스킬이 발동된 대화를 읽고 사용자가 고쳐 달라고 한 부분을 찾아 개선안을 표로 제안하는 스킬" | 프롬프트, PDF에 전문 |
| 06:45–07:35 | **세컨드 브레인 초급**: 작업 폴더 하나 + `AGENTS.md`/`CLAUDE.md`에 항상 따를 지침 | |
| 07:35–09:25 | **중급 — 길잡이 파일**: 폴더 정리에 집착하지 말고 주제별 링크 허브("나무위키식")를 두라. `AGENTS.md`가 대문(업무 자료 라우터: 분야별로 어느 안내 페이지부터 뒤질지 표) → `contents.md`, `dev.md`, `financial.md` → 서브 페이지. 대시보드 검색이 Finder보다 촬영 원본을 먼저 찾는 이유 | "찾는 법" 섹션에 `node ~/synergy-labs/routine/brain-review/scripts/find.mjs` 같은 스크립트도 적어 둠 |
| 09:25–10:45 | **고급 — 나만의 탐색기**: Obsidian/Notion 대신 Claude가 만든 지식 그래프(AGENTS.md 중심, 파일=점, 계층 뷰, 클릭하면 미리보기, 검색) | 카드가 아니라 파일의 그래프 |
| 10:50–12:00 | **루틴 초급**: Claude 데스크톱 코드 탭 → 예약된 작업 → "Daily morning briefing"(매일 09:00, 캘린더 + Gmail 훑어 오늘 할 일 브리핑). 단점: **컴퓨터와 앱이 켜져 있을 때만** 실행 | 11:45 프레임: Google Calendar·Gmail MCP 호출 후 일정/주의 메일/핵심 액션 브리핑 |
| 12:00–13:10 | **루틴 중급 — 안 꺼지는 루틴**: Hostinger 같은 VPS 또는 집의 남는 Windows PC에 Hermes(OpenClaw·Grok Bot도 가능) 설치, **Syncthing**으로 작업 폴더(세컨드 브레인) 동기화 | |
| 13:10–13:52 | **루틴 고급**: Anthropic Managed Agents(테스트 중, 미출시) — 처음부터 Claude 쪽에 다 올려 버리는 미래 | 해당 없음 |
| 13:52–15:00 | **익스텐션 초급**: Claude 데스크톱 커넥터(Gmail, Drive, Calendar, Slack, Notion, Canva, M365, Atlassian, Figma, Supabase…) 클릭 연결 | |
| 15:04–16:00 | **중급 — 커넥터 찾기**: MCP > CLI > API 순으로 쉬움. "건축물대장 mcp" 검색 → README 읽혀 연결. 이것도 스킬로 자동화 | 프롬프트 |
| 16:00–16:50 | **고급 — 직접 만들기**: Notion/Obsidian이 불편해서 만든 마크다운 뷰어(한 창에 2~3개 파일 나란히), 브랜드 라이브러리, 콘텐츠 라이브러리. 프롬프트: "AGENTS.md와 최근 작업 파일을 읽고 내가 반복해서 불편해하는 작업을 찾아 작은 도구 3가지(웹 페이지, 뷰어, 대시보드)를 시간·준비물과 함께 제안, 하나 고르면 `Extensions/<도구이름>/`에 만들어라" | |

## Ouroboros와 대조

| # | 영상의 아이디어 | Ouroboros | 판정 |
|---|---|---|---|
| 1 | 스킬 = 말로 만드는 AI 단축키 (skill-creator, 참고자료 폴더) | 카드 안의 Claude Code가 그대로 쓴다. 사이드바 작성창에서 `/`를 치면 내장 명령·`~/.claude`·프로젝트·플러그인 스킬이 자동완성된다(`src/main/skills.ts`) | **있음** (CLI 기능; 앱은 목록만 보여줌) |
| 2 | **스킬 버튼**: 클릭 → 모델 고르고 → 프롬프트 → 실행 | 저장된 프롬프트·원클릭 실행이 없다(grep `prompt librar|saved prompt|preset` 0). 매번 작성창에 타이핑하거나 Conductor에 말해야 한다. RESEARCH §6-1에서 ccanvas의 "프롬프트 라이브러리"를 가져올 것으로 적었지만 구현 안 됨 | **없음** |
| 3 | 스킬이 낡는 문제 → 스킬 개선 스킬 | 앱 영역 아님. Brian의 `~/.claude/skills`에 넣을 프롬프트 | 해당 없음 (콘텐츠) |
| 4 | AGENTS.md / CLAUDE.md 지침 | 카드가 쓰는 Claude Code의 것. 앱은 역할 프롬프트(specialist roles)와 Build board로 보강 | **있음** (CLI) |
| 5 | 길잡이 파일(주제별 링크 허브, AGENTS.md가 대문) | 없음. 앱은 지식 베이스가 아니다. 가까운 것: Obsidian 미러(태스크·보고서·보드를 볼트에 씀, 단방향) | **없음** — 단, 앱이 아니라 Brian의 프로젝트 `CLAUDE.md`에 적을 내용 |
| 6 | 파일 지식 그래프 탐색기(점=파일, 계층 뷰, 미리보기, 검색) | Orbit은 **카드**의 별자리(Conductor 핵심, 티어 셸). 파일 그래프는 없음 | **없음** — 범위 밖(Obsidian 그래프 뷰가 이미 그 일을 함) |
| 7 | **루틴**: 정해진 시간에 알아서 실행 (Daily morning briefing 09:00) | 없음(grep `schedul|cron|routine` → 전부 다른 뜻: Grok Bot routine 웹훅, Obsidian export schedule). RESEARCH §6-4 "예약 실행(Superset automations)" 후보로만 적혀 있음. 자율 모드는 **마감까지 계속 일하기**이지 **시각에 맞춰 시작하기**가 아님 | **없음** ← 가장 큰 빈칸 |
| 8 | 루틴의 한계: 앱이 켜져 있을 때만 | 같은 한계. 다만 자율 모드는 PC를 깨워 둔다(36h) | 동일 |
| 9 | 안 꺼지는 루틴: VPS/남는 PC에 Hermes + Syncthing | 없음. Herdr 비교(2026-10-31)의 "SSH 원격 카드" 빈칸과 같은 뿌리. 지금의 답: PC를 켜 두고 폰 페이지·Ouro(Discord)로 밖에서 본다 | **없음** — 이번에도 보류 권장 |
| 10 | Managed Agents | 미출시 | 해당 없음 |
| 11 | 커넥터(Gmail·Drive·Calendar…) | 카드의 Claude Code는 Brian의 MCP 설정을 그대로 쓴다. 앱 자체 연결: 브라우저 카드(`browser_*`), Discord(Ouro, `post_discord`), Notion, Obsidian, 폰 | **있음** |
| 12 | 커넥터 찾기 스킬 | 콘텐츠 | 해당 없음 |
| 13 | 마크다운 뷰어(2~3개 파일 나란히) | 노트는 마크다운 렌더(✎ 편집), 답장 뷰어·팝아웃, 📄 Briefs 카드(URL). **프로젝트의 .md 파일을 캔버스에 띄워 따라가는 카드**는 없음(경로 클릭은 외부 앱으로 열기, `src/main/open-path.ts`) | **부분** |
| 14 | 대시보드(유튜브·뉴스레터 지표, 메일함, 캘린더, 에셋 라이브러리) | 없음. 오케스트레이션 조종석이지 개인 홈이 아님. Today 탭(Needs you · Autonomous run · Reports · Working now · Done today)과 Usage 뷰가 "운영 현황"의 Ouroboros 판 | 범위 밖 |
| 15 | "반복 불편 → 작은 도구 3개 제안" 프롬프트 | 콘텐츠 | 해당 없음 |

**결론**: 영상의 15개 중 Ouroboros가 가져올 가치가 있는 건 둘(#2 스킬 버튼, #7 루틴)이고, 둘은 **한 기능**이다. 예약이 없는 루틴 = 스킬 버튼. 나머지는 Claude Code 자체 기능(1·4·11), Brian이 자기 파일에 적을 콘텐츠(3·5·12·15), 범위 밖(6·14), 미출시(10), 지난번부터 보류한 원격 머신(9)이다.

## 빈칸 (중요한 순)

### 1. 루틴 = 저장 프롬프트 + 예약 (권장: 만들자)

**무엇**: 프로젝트별 루틴 목록. 루틴 하나 = 이름, 프롬프트, 받는 카드(제목으로 고른 기존 카드, 또는 "새 카드": 엔진·모델·effort·역할 — `create_agent`의 제목 재사용 규칙 그대로), 예약(없음 / 매일 HH:MM / 평일 HH:MM / n시간마다), 마지막 실행 시각·결과. **▶ 지금 실행** 버튼이 있으니 예약 없는 루틴이 곧 영상의 "스킬 버튼"이다.

**어디서 실행**: 메인 프로세스의 타이머가 분 단위로 확인 → 기존 `sendPrompt`(`src/main/ipc.ts:243`, 유휴 Claude 카드는 inbox로 깨움, Codex/Gemini는 타이핑) 또는 기존 카드 생성 경로. 앱이 켜져 있을 때만 — Claude 데스크톱의 예약된 작업과 같은 한계이고, 그렇게 **설정 화면에 적는다**. 놓친 예약(앱이 꺼져 있었음)은 다음 켤 때 "놓침"으로 표시만 하고 실행하지 않는다(아침 9시 브리핑을 오후 3시에 받는 건 의미 없고, 켜자마자 카드가 우르르 생기는 건 위험).

**어디에 보이나**: 오른쪽 패널 새 탭 "Routines"(또는 Tasks 탭 아래 섹션) + Today 탭에 "다음 루틴 09:00 Morning briefing" 한 줄 + 실행하면 보통 카드처럼 보고 라인·Obsidian·Notion·Discord 게시가 다 따라온다. 이게 Claude 데스크톱 예약된 작업과의 차이: **결과가 보드 위에 떨어진다**(Conductor가 받을 수 있고, 태스크 원장·모닝 리포트에 남는다).

**자율 모드와**: 자율 실행 중에 루틴이 불을 붙이면 기존 새 카드 캡·역할 재생성 캡·auto 모드 launch가 그대로 적용된다(새 코드 경로 없음). 보드 파일에 저장하므로 프롬프트 텍스트는 **privilege field 취급**(앱 밖에서 보드 파일을 고쳐 루틴 프롬프트를 바꾸면 다음 열 때 board-trust가 잡아 둔다, `src/shared/board-trust.ts`).

**트레이드오프**
- (+) Brian이 매일 치는 프롬프트("상황 어때", "오늘 브리핑", "리뷰 돌려")가 버튼이 된다. 영상의 아침 브리핑을 Conductor에게 시키면 캘린더·Gmail MCP가 있는 한 그대로 된다.
- (+) 기존 경로만 재사용(sendPrompt, create_agent 규칙, Today, board-trust). 새 네트워크·권한 없음.
- (−) 중형 작업: shared 모델+순수 스케줄 계산(테스트 가능), main 타이머, IPC 3개, 패널 UI, Today 한 줄, CHANGELOG. 예상 1 브랜치.
- (−) "앱이 켜져 있을 때만"은 못 넘는다. 영상의 답(Hermes+Syncthing)은 앱 밖이다.
- (−) 시간대·DST: `HH:MM`을 로컬 시각으로만 다루고 cron 문법은 받지 않는다(단순함 우선).

### 2. 파일 카드 (보류 권장)

프로젝트의 `.md`를 캔버스에 노트처럼 띄우고 파일이 바뀌면 따라가는 카드(영상의 마크다운 뷰어 2~3개 나란히 = 카드 2~3장). 노트 렌더러와 open-path 검사는 이미 있어 작지만, Brian은 Obsidian 미러를 쓰고 있고 Obsidian이 그 뷰어다. 루틴을 써 보고 "리포트를 캔버스에서 바로 보고 싶다"가 나오면 그때.

### 3. 원격 머신 (보류, Herdr 때와 같음)

VPS/남는 PC에서 돌리는 상시 루틴. SSH 원격 카드 빈칸의 다른 얼굴이고, 폰 페이지·Ouro가 "밖에서 보기"는 이미 준다. 루틴이 생기고 나서 "PC를 밤새 켜 두는 게 싫다"가 되면 그때 SSH 카드와 함께.

### 가져오되 코드가 아닌 것 (Brian의 파일)

- 프로젝트 `CLAUDE.md`에 **길잡이 표**(분야 → 먼저 볼 안내 문서 → 찾는 법) 한 섹션. Build board가 읽는 역할 프롬프트와 겹치지 않는다.
- `~/.claude/skills`에 "스킬 개선 스킬"(최근 N일 발동 대화 → 개선안 표)과 "커넥터 찾기"(MCP > CLI > API). 영상의 PDF 프롬프트를 다듬으면 된다.

## 추천

**루틴 하나만 만든다.** 순서: (1) `src/shared/routines.ts` 순수 모델 — 타입, 유효성, `nextRunAt(routine, now)`, `due(routines, lastTick, now)`, 보드 파일 직렬화, 테스트; (2) main 스케줄러 + IPC(list/save/remove/run-now) + 실행 로그 한 줄; (3) Routines 패널 + Today 한 줄; (4) board-trust 연동 + CHANGELOG + 버그헌팅. 파일 카드·원격은 보류.

---

## English summary

Watched in full (yt-dlp, no captions available → Whisper base, 60 frames). The video is not an orchestrator demo: a Korean solo-business creator shows the "AI work system" she built on Claude Desktop + Claude Code in four layers — Skills (skill-creator, reference files inside a skill, a skill that improves stale skills), Second brain (AGENTS.md as a router to topic hub files, a Claude-built file graph explorer instead of Obsidian/Notion), Routines (Claude Desktop scheduled tasks such as a 09:00 morning briefing; they run only while the app is open, so an always-on box runs Hermes with Syncthing), Extensions (Claude Desktop connectors, finding MCP > CLI > API, building your own small tools such as a side-by-side markdown viewer and asset libraries).

Against Ouroboros `main` (125cdce): skills, AGENTS.md and connectors already come with the CLIs inside the cards (the composer autocompletes skills on `/`); the dashboard, file graph and knowledge hubs are out of scope or belong in Brian's own files; Managed Agents is unreleased; the always-on machine is the same remote-card gap as in the Herdr report (still deferred). The one real gap is **Routines**: no saved prompts, no one-click run, no scheduled prompt (grep for schedule/cron/routine finds only other meanings; RESEARCH §6-4 lists "scheduled runs" as a candidate). A routine with no schedule is the video's skill button; a routine with one is its morning briefing — and in Ouroboros the result lands on the board (report lines, task ledger, Obsidian/Notion/Discord). Recommendation: build Routines only (pure model + tests, main timer on the existing `sendPrompt`/create paths, a panel plus one Today line, privilege-field handling through board-trust); defer the file card and the remote machine.
