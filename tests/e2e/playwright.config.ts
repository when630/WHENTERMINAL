import { defineConfig } from '@playwright/test'

// 실제 Electron 앱(out/)을 띄워 조작한다. 테스트마다 사용자 데이터 폴더가 따로라 앱 여러 개를 함께 띄워도 된다.
// 키 입력은 OS가 아니라 창에 바로 보내므로 서로 섞이지 않는다. 4개부터는 CPU를 나눠 쓰느라 더 빨라지지 않는다
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 3,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  outputDir: '../../out/test-results',
})
