// 통합 테스트(test:session·test:spare)를 Electron 없이 node로 돌릴 때 'electron' 자리에 끼우는 대역.
// executable.ts의 claudeExecutable()이 app.isPackaged만 보므로 그것만 둔다 (개발 실행과 같게 SDK 기본 CLI를 쓴다)
export const app = { isPackaged: false }
