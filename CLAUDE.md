# WHENTERMINAL

개인 전용 상주형 Claude 에이전트 데스크톱 앱. Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)를 Electron 메인 프로세스에서 돌리고, 프로젝트별 대화를 카드로 나열해 키보드로 오간다. 기획: `docs/기획서_v0.1.md`.

## 명령

- `npm run dev` — 개발 실행 (renderer HMR)
- `npm run typecheck` — main/preload(`tsconfig.node.json`) + renderer(`tsconfig.web.json`)
- `npm run build` — `out/`으로 빌드
- `npm run smoke` — SDK 단발 호출로 구독 인증 확인 (`apiKeySource=none`이면 구독)
- `npm run test:session` — `AgentSession` 통합 테스트 (권한 요청→허용→파일 생성). 구독 사용량을 조금 씀

## 구조

- `src/shared/types.ts` — 메인↔렌더러 공용 타입, IPC 채널, 상태/모드 정의. 새 IPC는 여기 → `src/main/index.ts` → `src/preload/index.ts` 순서로 추가
- `src/main/agent/session.ts` — 대화 1개 = SDK `query()` 1개 (스트리밍 입력). `canUseTool`로 권한 요청을 렌더러에 넘기고 응답을 기다림
- `src/main/agent/manager.ts` — 대화별 세션 보관. 동시 실행 제한(OPEN-003)은 여기에
- 세션 관리: 대화 하나 = SDK 세션 하나이고, 같은 대화의 메시지는 같은 세션에 이어진다. 홈 작업 지시창은 작업마다 새 대화를 만든다
  - 컨텍스트 사용률은 응답이 끝날 때마다 `getContextUsage({ detail: 'summary' })`로 받아 `Conversation.contextPercent`에 저장
  - 컴팩트는 같은 세션에 `/compact`를 보낸다. 이때 오는 result는 작업 완료가 아니므로 상태·보고서를 바꾸지 않는다 (`manualCompact`)
  - 클리어는 세션을 닫고 `sessionId`를 지운다. 다음 메시지가 새 세션을 만든다. 실수 방지로 `Ctrl+L`을 3초 안에 두 번 눌러야 한다
- `src/main/store.ts` — `userData/projects.json`에 프로젝트·대화·SDK 세션 ID 저장 (재시작 시 resume)
- `src/renderer/src/App.tsx` — 전역 키 처리 (기획서 7장 단축키 맵)

## 규칙

- 인증은 구독 전용: 자식 프로세스 env에서 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`을 제거한다 (`subscriptionEnv`). 이 동작을 바꾸지 말 것
- SDK API는 추측하지 말고 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`에서 확인
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
- preload는 sandbox라 CJS(`index.cjs`)로 빌드됨. preload에서는 `electron` 외 모듈 import 금지 (`@shared` 상수는 번들에 포함되므로 허용)
- UI 문구는 한국어
- 디자인은 G안(스위스 포스터): 흰 종이 + 검은 굵은 선 + 신호색 빨강 하나. 토큰은 `src/renderer/src/styles.css` 맨 위
  - 빨강은 사람이 봐야 할 것(승인 대기·오류)에만 쓴다. 실행 중은 검정, 완료는 외곽선 글자
  - 큰 글자는 Archivo 900(라틴·숫자)과 Black Han Sans(한글), 본문은 Pretendard, 코드는 Geist Mono. 모두 npm 패키지로 번들한다 (오프라인 동작)
  - 모서리는 둥글리지 않는다. `data-layout-id` 요소(진행 띠·보고 줄)에는 CSS 등장 애니메이션을 걸지 말 것. 위치 이동 애니메이션(`motion.tsx`)과 충돌한다
