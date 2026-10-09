import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

// @live: 모델을 실제로 부른다 (구독 사용량을 조금 씀). npm run test:e2e:live
test.describe('@live', () => {
  test.setTimeout(240_000)
  test.use({ seed: { projects: [{ name: 'alpha', files: { 'notes.txt': 'hello\n' } }, { name: 'beta' }] } })

  test('지시 → 확인 요청 → 허용 → 완료 → 보고서', async ({ win, env }) => {
    await win.locator('#ask-input').fill('notes.txt 끝에 bye 라는 줄을 하나 추가해줘')
    await win.locator('#ask-input').press('Enter')
    await expect(win.locator('.task.waiting')).toBeVisible({ timeout: 120_000 })
    await win.locator('.task .link').click()
    await expect(win.locator('.permission')).toBeVisible()
    await expect(win.locator('.chat-body.open .status-panel.waiting')).toBeVisible()
    await win.waitForTimeout(800)
    await win.screenshot({ path: test.info().outputPath('panel-waiting.png') })
    await win.keyboard.press('y')
    await expect(win.locator('.badge-done')).toBeVisible({ timeout: 120_000 })
    expect(readFileSync(join(env.path('alpha'), 'notes.txt'), 'utf8')).toContain('bye')
    await win.keyboard.press('Control+KeyH')
    await expect(win.locator('.rep')).toHaveCount(1)
  })

  test('동시 실행 1개면 두 번째는 대기했다가 시작', async ({ win }) => {
    await win.evaluate(async () => window.api.setSettings({ ...window.api.initialSettings, maxConcurrent: 1 }))
    await win.locator('#ask-input').fill('숫자 1만 답해. 도구 쓰지 마.')
    await win.locator('#ask-input').press('Enter')
    await win.locator('#ask-input').press('Tab')
    await win.locator('#ask-input').fill('숫자 2만 답해. 도구 쓰지 마.')
    await win.locator('#ask-input').press('Enter')
    await expect(win.locator('.task .stage-word', { hasText: 'QUEUED' })).toBeVisible()
    await expect(win.locator('.task')).toHaveCount(0, { timeout: 180_000 })
    await expect(win.locator('.rep')).toHaveCount(2)
  })

  test('컴팩트·클리어', async ({ win }) => {
    await win.keyboard.press('Alt+KeyA')
    await win.locator('#composer-input').fill('한 단어로 인사해줘. 도구 쓰지 마.')
    await win.locator('#composer-input').press('Enter')
    // 실행 중에는 대화 맨 아래에 작업 중 줄이 있고, 끝나면 사라진다
    await expect(win.locator('.working')).toBeVisible()
    await expect(win.locator('.chat-body.open')).toBeVisible()
    await win.waitForTimeout(600)
    await win.screenshot({ path: test.info().outputPath('working.png') })
    await expect(win.locator('.badge-done')).toBeVisible({ timeout: 120_000 })
    await expect(win.locator('.working')).toHaveCount(0)
    await expect(win.locator('.chat-body.open')).toHaveCount(0)
    await win.locator('#composer-input').fill('/compact')
    await win.locator('#composer-input').press('Escape')
    await win.locator('#composer-input').press('Enter')
    await expect(win.locator('.divider')).toContainText('COMPACT', { timeout: 180_000 })
    await win.locator('.transcript').click()
    await win.keyboard.press('Control+KeyL')
    await win.keyboard.press('Control+KeyL')
    await expect(win.locator('.divider')).toContainText('비웠어요')
    await expect(win.locator('.ctx b')).not.toHaveText('–')
  })
})
