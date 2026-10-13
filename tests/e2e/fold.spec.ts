import { expect, test } from './fixtures'

/** 메인이 렌더러로 보내는 대화 이벤트를 흉내 낸다 (모델을 부르지 않는다) */
async function emit(app: import('@playwright/test').ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, e) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { projectId: 'p1', conversationId: 'c1', event: e })
  }, event)
}

test('백그라운드 에이전트의 긴 보고는 한 줄로 접고, 펼치면 본문을 보인다. 메인 답은 접지 않는다', async ({ app, win }) => {
  await win.keyboard.press('Alt+KeyA')
  await expect(win.locator('#composer-input')).toBeVisible()
  await emit(app, { kind: 'task_note', text: 'TASK DONE · Background command "sleep 5" completed (exit code 0)' })
  const report = ['조사를 마쳤어요.', '', '## 찾은 것', '', ...Array.from({ length: 30 }, (_, i) => `- 항목 ${i + 1}`)].join('\n')
  await emit(app, { kind: 'task_note', text: `TASK DONE · ${report}` })
  await emit(app, { kind: 'assistant_text', text: Array.from({ length: 80 }, (_, i) => `- 메인 답 ${i + 1}`).join('\n') })

  // 짧은 알림은 그대로 한 줄
  const short = win.locator('div.divider')
  await expect(short).toHaveCount(1)
  await expect(short).toContainText('sleep 5')

  // 긴 보고: 머리와 첫 줄만, 본문은 닫혀 있다
  const fold = win.locator('details.divider.fold')
  await expect(fold).toHaveCount(1)
  await expect(fold.locator('.divider-k')).toHaveText('■ TASK DONE')
  await expect(fold.locator('.divider-first')).toHaveText('조사를 마쳤어요.')
  await expect(fold.getByText('항목 30')).toBeHidden()
  expect((await fold.boundingBox())!.height).toBeLessThan(60)
  await fold.scrollIntoViewIfNeeded()
  await win.screenshot({ path: test.info().outputPath('folded.png') })

  await fold.locator('summary').click()
  await expect(fold.getByText('항목 30')).toBeVisible()
  await expect(fold.locator('.divider-body h2')).toHaveText('찾은 것')
  await win.screenshot({ path: test.info().outputPath('open.png') })

  // 메인 답은 길어도 다 보인다
  await expect(win.locator('.msg.assistant .answer-fold')).toHaveCount(0)
  await expect(win.getByText('메인 답 80')).toBeVisible()
})
