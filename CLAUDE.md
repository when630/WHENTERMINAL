# WHENTERMINAL

개인 전용 상주형 Claude 에이전트 데스크톱 앱. Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)를 Electron 메인 프로세스에서 돌리고, 프로젝트별 대화를 카드로 나열해 키보드로 오간다. 기획: `docs/기획서_v0.1.md`.

## 명령

- `npm run dev` — 개발 실행 (renderer HMR)
- `npm run typecheck` — main/preload(`tsconfig.node.json`) + renderer(`tsconfig.web.json`)
- `npm run build` — `out/`으로 빌드
- `npm run smoke` — SDK 단발 호출로 구독 인증 확인 (`apiKeySource=none`이면 구독)
- `npm run test:e2e` — 실제 앱(out/)을 Playwright로 띄워 조작하는 테스트. 모델을 부르지 않음 (설정·단축키·/·@ 메뉴·첨부·대화 닫기·보고함·작업 공간). 기능을 바꾸면 이걸 먼저 돌릴 것
- `npm run test:e2e:live` — 모델을 실제로 부르는 `@live` 테스트 (승인 흐름·대기열·컴팩트·클리어). 구독 사용량을 조금 씀
  - 테스트마다 임시 사용자 데이터·프로젝트를 만든다(`tests/e2e/fixtures.ts`의 `seed`). 실제 데이터는 건드리지 않음
- `npm run test:session` — `AgentSession` 통합 테스트 (권한 요청→허용→파일 생성). 구독 사용량을 조금 씀

## 구조

- `src/shared/types.ts` — 메인↔렌더러 공용 타입, IPC 채널, 상태/모드 정의. 새 IPC는 여기 → `src/main/index.ts` → `src/preload/index.ts` 순서로 추가
- `src/main/agent/session.ts` — 대화 1개 = SDK `query()` 1개 (스트리밍 입력). `canUseTool`로 권한 요청을 렌더러에 넘기고 응답을 기다림
- `src/main/agent/manager.ts` — 대화별 세션 보관. 동시 실행 제한(OPEN-003)은 여기에
- 세션 관리: 대화 하나 = SDK 세션 하나이고, 같은 대화의 메시지는 같은 세션에 이어진다. 홈 작업 지시창은 작업마다 새 대화를 만든다
  - 모델은 세션마다 다를 수 있다. 매 턴 시작 메시지(`system/init`)의 `model`을 받아 `Conversation.model/modelLabel`에 저장. 표시 이름은 `supportedModels()`에서 ID가 정확히 같은 행만 쓰고(별칭 행은 '기본값' 같은 이름이라 제외), 없으면 `modelLabel()`이 ID를 풀어 쓴다
  - 대화창 상단 둘째 줄: 왼쪽 하위 대화 탭, 오른쪽 모델·모드(누르면 다음 모드)
  - 대화창을 열면 메시지 없이 `peek`으로 컨텍스트 사용률·모델을 읽는다 (저장된 세션을 이어 연 CLI 또는 빈 CLI에서 `getContextUsage` 후 바로 닫음, 0.3~0.7초)
  - 컨텍스트 사용률은 응답이 끝날 때마다 `getContextUsage({ detail: 'summary' })`로 받아 `Conversation.contextPercent`에 저장
  - 컴팩트는 같은 세션에 `/compact`를 보낸다. 이때 오는 result는 작업 완료가 아니므로 상태·보고서를 바꾸지 않는다 (`manualCompact`)
  - 대화 닫기는 세션을 끝내고(실행 중이면 중단) 대화를 목록에서 뺀다. 마지막 대화면 빈 대화를 새로 만든다. `Ctrl+W` 두 번·탭 × 두 번, `/close`는 바로 닫음. 확인 로직은 클리어와 같은 `confirmTwice`(App.tsx)
  - 클리어는 세션을 닫고 `sessionId`를 지운다. 다음 메시지가 새 세션을 만든다. 실수 방지로 `Ctrl+L`을 3초 안에 두 번 눌러야 한다
- `src/main/store.ts` — `userData/projects.json`에 프로젝트·대화·SDK 세션 ID 저장 (재시작 시 resume)
- `src/renderer/src/App.tsx` — 전역 키 처리 (기획서 7장 단축키 맵)

## 규칙

- 인증은 구독 전용: 자식 프로세스 env에서 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`을 제거한다 (`subscriptionEnv`). 이 동작을 바꾸지 말 것
- SDK API는 추측하지 말고 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`에서 확인
- 권한 모드는 `MODE_CYCLE`(기본 → 편집 자동 허용 → 자동 → 플랜). 자동(`auto`)은 모델 분류기가 승인/거절하고 판단 못 한 것만 `canUseTool`로 묻는다. 모드 변경이 거절되면 원래 모드로 되돌리고, 세션이 스스로 바꾼 모드(status 메시지의 `permissionMode`)도 저장값에 맞춘다
- `canUseTool` 옵션의 `defaultToNo`(한 키 승인 금지)와 `suppressAlwaysAllowRule`(항상 허용 금지)을 UI에서 반드시 지킨다
- 대화창에서 `Esc`는 실행 중단 전용. 나가기(홈)는 `Ctrl+H` (기획서 초안의 ``Ctrl+` ``에서 변경)
- 사용자는 40% 배열 키보드를 쓴다. 단축키는 알파벳 + Ctrl/Alt/Shift만으로 되게 하고, 숫자·방향키·F키·백틱은 보조로만 둔다 (`src/renderer/src/keys.ts`)
  - 프로젝트 이동: `Alt+A S D F G H J K L` = 1~9 (보조: `Ctrl+1~9`, 홈에서 `1~9`)
  - 홈 카드 선택: `H J K L` (보조: 방향키), 열기 `O`/`Enter`
  - 중단: `Esc` / `Ctrl+[` / 선택 글자 없을 때 `Ctrl+C`
  - Alt 니모닉과 겹치지 않도록 Windows에서는 기본 메뉴를 없앴다 (`Menu.setApplicationMenu(null)`). 개발 중 `Ctrl+Shift+I` 개발자 도구, `Ctrl+Shift+R` 새로고침
- macOS도 지원한다 (`isMac` 분기, `src/main/index.ts`)
  - 단축키는 macOS에서도 Ctrl 기반 그대로. Cmd로 바꾸지 말 것. 화면의 Alt 표기만 `⌥`로 바꾼다 (`ALT_LABEL`)
  - 메뉴는 없애지 않고 앱·편집·윈도우 메뉴만 둔다. Edit 메뉴가 없으면 Cmd+C/V가 죽는다
  - 전역 호출 키 후보에서 `Control+Space`를 뺀다. macOS 입력 소스 전환 키라 등록이 성공해도 한/영 전환을 가로챈다
  - 트레이 아이콘은 템플릿 이미지(검정+투명), Dock 아이콘 클릭(`activate`)으로 창 다시 열기
- 구독 한도(사이드바): `src/main/agent/usage.ts`가 SDK `usage_EXPERIMENTAL…`(실험적 API, 이름이 바뀔 수 있음)로 5시간·주간·모델별 주간 창을 받는다. 살아 있는 세션이 없으면 `withProbe`로 CLI만 띄움. 앱 시작·작업 완료 2.5초 뒤·5분마다 갱신, `rate_limit_event`는 해당 창에 바로 반영
- 기록·보고서: 대화창을 열 때 화면 기록이 비어 있으면 `getSessionMessages`로 되살린다(`agent/history.ts`). 끝난 작업의 보고서는 `Conversation.lastTask`에 저장하고, 보관 전 보고서가 있는 대화를 닫으면 `closedAt`으로 숨기기만 한다. 탭·목록은 `openConversations()` 기준
- 첨부는 경로로: 입력창에 파일을 끌어다 놓기·첨부 버튼(`pickFiles`)·이미지 붙여넣기(`saveImage`로 userData/attachments에 저장)를 하면 경로를 넣는다. 작업 폴더 안은 `@상대경로`. 끌어다 놓은 파일 경로는 sandbox라 preload의 `webUtils.getPathForFile`로
- 답변은 `Markdown.tsx`(react-markdown, 원시 HTML 비허용). 링크는 메인이 외부 브라우저로만 연다 (`setWindowOpenHandler`, `will-navigate` 차단)
- 알림(`main/notify.ts`): 확인 요청·작업 끝남. 누르면 `IPC.navigate`로 그 대화로. 배지는 렌더러가 `setBadge`로 보낸다
- 대기열(OPEN-003): `AgentManager.send`가 `maxConcurrent`를 넘으면 `queued`로 두고, 상태가 끝나면 `drain()`. 확인 대기도 자리를 차지한다
- 작업 공간(OPEN-002, `main/worktree.ts`): 탭 +로 만든 대화만 `userData/worktrees`에 git worktree(`wt/<id>`). 세션·기록·peek의 폴더는 `cwdOf()`. 닫을 때 깨끗하면 정리
- 패키징: electron-builder(`package.json`의 `build`). SDK의 OS별 CLI 바이너리는 `asarUnpack`으로 풀고, 패키징한 앱에서는 `claudeExecutable()` 경로를 `pathToClaudeCodeExecutable`로 넘긴다. 렌더러에서만 쓰는 패키지는 devDependencies에 둘 것 (번들에 들어가므로)
- 설정(`SettingsScreen.tsx`, `Ctrl+,` / macOS 메뉴 ⌘,): `userData/settings.json` (`src/main/settings.ts`). 첫 화면 전에 preload가 동기로 읽어(`initialSettings`) 테마 깜빡임이 없다
  - 테마: `:root[data-theme]`로 색 토큰만 바꾼다 (포스터·종이·세이지·먹·밤). 새 색을 쓸 때는 직접 색 대신 역할 토큰(`--sel-bg/fg`, `--on-signal`, `--code-bg/fg`, `--line`, `--shadow`)을 쓸 것
  - 단축키: 동작 목록·기본값은 `src/shared/keymap.ts`(`ACTIONS`), 판정은 `matches()`(keys.ts). App의 키 처리와 화면의 키 표시는 모두 `useKeymap()`을 거친다. 새 단축키는 ACTIONS에 추가하고 하드코딩하지 말 것
  - 고정 키(바꿀 수 없음): Esc, ⌥A~L·Ctrl+1~9 프로젝트 이동, 선택 없을 때 Ctrl+C, 방향키. 대화창·전역 범위 키는 Ctrl/Alt/Meta가 있어야 한다 (입력 중 오작동 방지)
  - 전역 호출 키(`summon`)는 메인이 다시 등록한다. 실패하면 이전 키를 되살리고 저장하지 않는다
- 단축키 표시는 `<Keys keys="ctrl shift L" />`(`KeyHint.tsx`)를 쓴다. 수정·특수 키는 아이콘, 글자는 그대로. 파일 이름이 `keys.ts`와 대소문자만 다르면 macOS에서 충돌하므로 `KeyHint`
- 슬래시 명령 후보: 입력창에 `/`를 치면 `SlashMenu`. 목록은 살아 있는 세션의 `supportedCommands()`, 없으면 메시지 없이 CLI만 띄워 받아 프로젝트 폴더별로 5분 캐시 (`src/main/agent/commands.ts`). `/compact` `/clear`는 앱이 직접 처리
  - 메뉴가 열린 입력창에는 `data-menu-open`을 달아 App의 전역 키 처리(Esc 중단, Ctrl+K 등)를 건너뛴다
- preload는 sandbox라 CJS(`index.cjs`)로 빌드됨. preload에서는 `electron` 외 모듈 import 금지 (`@shared` 상수는 번들에 포함되므로 허용)
- UI 문구는 한국어
- 디자인은 G안(스위스 포스터): 흰 종이 + 검은 굵은 선 + 신호색 빨강 하나. 토큰은 `src/renderer/src/styles.css` 맨 위
  - 빨강은 사람이 봐야 할 것(승인 대기·오류)에만 쓴다. 실행 중은 검정, 완료는 외곽선 글자
  - 큰 글자는 Archivo 900(라틴·숫자)과 Black Han Sans(한글), 본문은 Pretendard, 코드는 Geist Mono. 모두 npm 패키지로 번들한다 (오프라인 동작)
  - 움직임 토큰(`--ease-out` 나타남, `--ease-io` 상태 전환, `--spring` 숫자)과 시간(`--t-fast/med/slow`)을 쓴다. 깜빡임은 `steps()` 대신 부드러운 맥동으로
  - 사라지는 요소는 `usePresence`(motion.tsx)로 잠시 붙잡아 `leaving` 클래스로 나가게 한다. 대화 기록은 연 뒤에 새로 들어온 항목만 `enter`로 등장
  - 반복 애니메이션은 transform·opacity만 움직인다 (배경 위치 등 다시 그리기 유발 금지). 전광판은 rAF로 일정 속도
  - 글꼴 조각이 data URI로 인라인되므로 CSP에 `font-src 'self' data:`가 필요하다
  - 모서리는 둥글리지 않는다. `data-layout-id` 요소(진행 띠·보고 줄)에는 CSS 등장 애니메이션을 걸지 말 것. 위치 이동 애니메이션(`motion.tsx`)과 충돌한다
