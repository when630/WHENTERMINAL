# WHENTERMINAL

Claude Agent SDK로 만든 개인용 상주형 데스크톱 에이전트 앱입니다. 여러 프로젝트에 작업을 맡기고, 진행 상황을 지켜보고, 끝나면 보고서를 받습니다. 모든 동작은 키보드(40% 배열 기준)로 할 수 있습니다.

- 인증: Claude 구독 계정 (API 키를 쓰지 않음)
- 형태: Electron + React + TypeScript, Windows 기준
- 기획: [`docs/기획서_v0.1.md`](docs/기획서_v0.1.md)

## 실행

```sh
npm install
npm run dev
```

먼저 터미널에서 `claude`로 구독 계정에 로그인되어 있어야 합니다. `ANTHROPIC_API_KEY` 환경변수는 앱이 자식 프로세스에 넘기지 않으므로 항상 구독으로 인증됩니다.

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 실행 |
| `npm run build` | `out/`으로 빌드 |
| `npm run typecheck` | 타입 검사 |
| `npm run smoke` | SDK 1회 호출로 구독 인증 확인 |
| `npm run test:session` | 권한 요청 → 허용 → 파일 생성 흐름 통합 테스트 (구독 사용량을 조금 씀) |

## 화면

- **홈**: 작업 지시창 → 진행 중(계획·탐색·수정·검증·보고 단계) → 보고함
- **대화창**: Claude Code CLI와 같은 대화 흐름, 권한 요청은 `Y` / `A` / `N`
- **사이드바**: 프로젝트별 진행률, 새 보고 수, 구독 사용량

## 단축키

| 동작 | 키 |
|---|---|
| 어디서든 앱 호출 | `Ctrl+Shift+Space` (`Ctrl+Space`가 비어 있으면 그것) |
| 작업 지시 | `Ctrl+K`, 홈에서 `I` |
| 프로젝트 1~9로 이동 | `Alt+A S D F G H J K L` (보조: `Ctrl+1~9`) |
| 홈으로 | `Ctrl+H` |
| 홈에서 위아래 / 진행 중·보고함 | `J` `K` / `H` `L` |
| 열기 / 보고서 보관 | `O` / `E` |
| 실행 중단 | `Ctrl+[`, `Esc`, 선택한 글자가 없을 때 `Ctrl+C` |
| 하위 대화 전환 / 모드 전환 | `Ctrl+Tab` / `Shift+Tab` |
