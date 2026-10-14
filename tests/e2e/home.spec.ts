import { test, expect } from './fixtures'
import type { ElectronApplication } from '@playwright/test'

const done = (title: string, ago: number): Record<string, unknown> => ({
  instruction: title, startedAt: Date.now() - ago - 60_000, stage: 4, activity: '', tools: 1, files: [], finishedAt: Date.now() - ago, summary: '요약', unread: true, archived: false, status: 'done',
})

test.use({
  seed: {
    projects: [
      {
        name: 'alpha',
        conversations: [
          { id: 'c1', title: '대화 1', mode: 'default', lastTask: done('앞서 끝난 일', 60_000) },
          { id: 'c2', title: '대화 2', mode: 'default', lastTask: { ...done('보관한 일', 120_000), archived: true } },
          { id: 'c3', title: '대화 3', mode: 'default' },
        ],
      },
    ],
  },
})

async function emit(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { projectId: 'p1', conversationId: 'c1', event: ev })
  }, event)
}

test('홈: 쉬는 대화는 RUNNING 아래 NO RUNNING에, 작업을 시작하면 위로 올라가고 끝나면 내려오며 보고서가 따로 생긴다', async ({ app, win }) => {
  const idle = win.locator('.idle-row')
  // 작업을 끝낸 적 있는 열린 대화만 (보관한 보고서도 쉬는 대화로는 남는다). 한 번도 쓰지 않은 대화는 없다
  await expect(idle).toHaveCount(2)
  await expect(win.locator('.col-h-sub')).toContainText('NO RUNNING')
  await expect(win.locator('.rep')).toHaveCount(1)

  await emit(app, { kind: 'user', text: '새 일' })
  await emit(app, { kind: 'status', status: 'running' })
  await expect(win.locator('.task[data-layout-id="c1"]')).toBeVisible()
  await expect(win.locator('.idle-row[data-layout-id="c1"]')).toHaveCount(0)
  await expect(win.locator('.rep')).toHaveCount(0)

  await emit(app, { kind: 'result', subtype: 'success', durationMs: 10 })
  await emit(app, { kind: 'status', status: 'done' })
  await expect(win.locator('.task[data-layout-id="c1"]')).toHaveCount(0)
  await expect(idle.first()).toHaveAttribute('data-layout-id', 'c1')
  await expect(idle.first().locator('.idle-tt')).toHaveText('새 일')
  await expect(win.locator('.rep[data-layout-id="rep:c1"]')).toBeVisible()

  // 키 이동: NO RUNNING → REPORTS. 같은 대화라도 쉬는 줄과 보고서 카드는 따로 고른다
  await win.keyboard.press('Escape')
  await win.keyboard.press('j')
  await expect(idle.first()).toHaveClass(/selected/)
  await expect(win.locator('.rep').first()).not.toHaveClass(/selected/)
  await win.keyboard.press('j')
  await win.keyboard.press('j')
  await expect(win.locator('.rep').first()).toHaveClass(/selected/)
  await expect(idle.first()).not.toHaveClass(/selected/)
})

test.describe('보고서가 많을 때', () => {
  test.use({
    seed: {
      projects: [{ name: 'alpha', conversations: Array.from({ length: 24 }, (_, i) => ({ id: `c${i + 1}`, title: `대화 ${i + 1}`, mode: 'default', lastTask: done(`끝난 일 ${i + 1}`, i * 60_000) })) }],
    },
  })
  test('홈 전체는 스크롤하지 않고 REPORTS 열 안에서만 스크롤한다. 키로 고른 카드는 보이는 곳까지', async ({ win }) => {
    await win.setViewportSize({ width: 1400, height: 800 })
    await expect(win.locator('.rep')).toHaveCount(24)
    const overflow = (sel: string): Promise<number> => win.locator(sel).evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(await overflow('.home')).toBeLessThanOrEqual(0)
    expect(await overflow('.col-rep')).toBeGreaterThan(0)
    // 작업 지시창·머리는 그대로 보인다
    await expect(win.locator('#ask-input')).toBeInViewport()

    // 보고함 마지막 카드까지 키로 내려가면 열이 따라 스크롤하고, 열 머리는 위에 남는다
    await win.locator('#ask-input').press('Escape')
    await win.keyboard.press('l')
    for (let i = 0; i < 23; i++) await win.keyboard.press('j')
    await expect(win.locator('.rep.selected')).toContainText('끝난 일 24')
    await expect(win.locator('.rep.selected')).toBeInViewport()
    expect(await win.locator('.col-rep').evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect(win.locator('.col-rep > .col-h').first()).toBeInViewport()
  })
})
