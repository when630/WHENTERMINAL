import { defineConfig } from '@playwright/test'

// 실제 Electron 앱(out/)을 띄워 조작한다. 앱은 전역 단축키·트레이를 쓰므로 한 번에 하나씩
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  outputDir: '../../out/test-results',
})
