import { expect, test } from './fixtures'

/** 메인이 렌더러로 보내는 대화 이벤트를 흉내 낸다 (모델을 부르지 않는다) */
async function emit(app: import('@playwright/test').ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, e) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { projectId: 'p1', conversationId: 'c1', event: e })
  }, event)
}

test('긴 답은 앞부분만 보이고 SHOW ALL로 펼친다', async ({ app, win }) => {
  await win.keyboard.press('Alt+KeyA')
  await expect(win.locator('#composer-input')).toBeVisible()
  await emit(app, { kind: 'assistant_text', text: '짧은 답이에요.' })
  const long = ['## 결론', '', '먼저 결론이에요.', '', ...Array.from({ length: 80 }, (_, i) => `- 세부 항목 ${i + 1}`)].join('\n')
  await emit(app, { kind: 'assistant_text', text: long })

  const answers = win.locator('.msg.assistant')
  await expect(answers).toHaveCount(2)
  // 짧은 답은 접지 않는다
  await expect(answers.nth(0).locator('.answer-fold')).toHaveCount(0)

  const tall = answers.nth(1)
  const btn = tall.locator('.answer-fold')
  await expect(tall).toHaveClass(/folded/)
  await expect(btn).toHaveText(/SHOW ALL · \d+ LINES/)
  const folded = (await tall.locator('.answer-body').boundingBox())!.height
  expect(folded).toBeLessThan(520)
  await win.screenshot({ path: test.info().outputPath('folded.png') })

  await btn.click()
  await expect(tall).not.toHaveClass(/folded/)
  await expect(btn).toHaveText('FOLD')
  await expect.poll(async () => (await tall.locator('.answer-body').boundingBox())!.height).toBeGreaterThan(1200)
  await expect(tall.getByText('세부 항목 80')).toBeVisible()

  await btn.click()
  await expect(tall).toHaveClass(/folded/)
})

test('쓰는 중에는 접지 않고, 다 쓰면 펼친 높이에서 줄어들며 접힌다', async ({ app, win }) => {
  await win.keyboard.press('Alt+KeyA')
  await expect(win.locator('#composer-input')).toBeVisible()
  const long = ['## 결론', '', ...Array.from({ length: 80 }, (_, i) => `- 세부 항목 ${i + 1}`)].join('\n')
  await emit(app, { kind: 'text_delta', text: long })
  const answer = win.locator('.msg.assistant')
  await expect(answer).toHaveClass(/streaming/)
  await expect(answer.locator('.answer-fold')).toHaveCount(0)
  const full = (await answer.locator('.answer-body').boundingBox())!.height
  expect(full).toBeGreaterThan(1200)

  // 다 쓴 순간부터 높이를 프레임마다 재서 중간 높이를 거쳤는지 본다
  const sampling = win.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const el = document.querySelector<HTMLElement>('.msg.assistant .answer-body')!
        const hs: number[] = []
        const t0 = performance.now()
        const tick = (): void => {
          hs.push(el.getBoundingClientRect().height)
          if (performance.now() - t0 < 1200) requestAnimationFrame(tick)
          else resolve(hs)
        }
        requestAnimationFrame(tick)
      }),
  )
  await emit(app, { kind: 'assistant_text', text: long })
  const hs = await sampling
  expect(hs.some((h) => h > 600 && h < full - 100)).toBe(true)
  await expect(answer).toHaveClass(/folded/)
  expect((await answer.locator('.answer-body').boundingBox())!.height).toBeLessThan(520)
})
