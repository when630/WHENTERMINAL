import { test, expect } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'

/** 질문 창의 숨은 프로젝트·대화 (메인 store가 만든다) */
async function quickIds(win: Page): Promise<{ projectId: string; conversationId: string }> {
  return win.evaluate(async () => {
    const p = await window.api.quickProject()
    return { projectId: p.id, conversationId: p.conversations[0].id }
  })
}

async function emit(app: ElectronApplication, ids: { projectId: string; conversationId: string }, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { ids, event }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { ...ids, event })
  }, { ids, event })
}

test('Ctrl+Shift+K 질문 창: 프로젝트 목록에 없고, 보내면 숨은 프로젝트로, Esc로 닫는다', async ({ app, win }) => {
  // 모델을 부르지 않도록 보내기·클리어를 가로채 기록만 한다
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { sent: unknown[]; cleared: number }
    g.sent = []
    g.cleared = 0
    ipcMain.removeHandler('agent:send')
    ipcMain.handle('agent:send', (_e, projectId: string, conversationId: string, text: string) => void g.sent.push({ projectId, conversationId, text }))
    ipcMain.removeHandler('agent:clear')
    ipcMain.handle('agent:clear', () => void g.cleared++)
  })
  const ids = await quickIds(win)
  expect(ids.projectId).toBe('quick')
  // 프로젝트 목록(사이드바)에는 나오지 않는다
  await expect(win.locator('.side-project')).toHaveCount(1)

  await win.keyboard.press('Control+Shift+k')
  const sheet = win.locator('.overlay.quick')
  const input = win.locator('#quick-input')
  await expect(sheet).toBeVisible()
  await expect(input).toBeFocused()
  await expect(sheet.locator('.quick-empty')).toContainText('무엇이든 물어봐요')
  // 빠른 모델로 시작한다
  await expect(sheet.locator('.model-v')).toContainText(/haiku/i)

  await input.fill('정규식에서 lookbehind가 뭐야?')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  const sent = await app.evaluate(() => (globalThis as unknown as { sent: unknown[] }).sent)
  expect(sent).toEqual([{ ...ids, text: '정규식에서 lookbehind가 뭐야?' }])

  // 답이 오면 창 안에 보인다
  await emit(app, ids, { kind: 'user', text: '정규식에서 lookbehind가 뭐야?' })
  await emit(app, ids, { kind: 'assistant_text', text: '앞쪽을 확인하는 **조건**이에요' })
  await expect(sheet.locator('.msg.user')).toHaveText('정규식에서 lookbehind가 뭐야?')
  await expect(sheet.locator('.msg.assistant strong')).toHaveText('조건')

  // 클리어는 두 번 눌러야
  await input.press('Control+l')
  await expect(sheet.locator('.confirm')).toContainText('한 번 더 누르면')
  await input.press('Control+l')
  await expect(sheet.locator('.confirm')).toHaveCount(0)
  expect(await app.evaluate(() => (globalThis as unknown as { cleared: number }).cleared)).toBe(1)

  // 쉬고 있을 때 Esc는 닫기. 다시 열면 같은 대화
  await input.press('Escape')
  await expect(sheet).toHaveCount(0)
  await win.keyboard.press('Control+Shift+k')
  await expect(win.locator('.overlay.quick .msg.assistant')).toContainText('앞쪽을 확인하는')
  // 같은 키로 닫는다
  await win.keyboard.press('Control+Shift+k')
  await expect(win.locator('.overlay.quick')).toHaveCount(0)
})

test('질문 창: 답하는 중의 Esc는 닫지 않고 멈춘다', async ({ app, win }) => {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { interrupted: number }
    g.interrupted = 0
    ipcMain.removeHandler('agent:interrupt')
    ipcMain.handle('agent:interrupt', () => void g.interrupted++)
  })
  const ids = await quickIds(win)
  await win.keyboard.press('Control+Shift+k')
  await emit(app, ids, { kind: 'status', status: 'running' })
  await expect(win.locator('.overlay.quick .working')).toBeVisible()
  await win.locator('#quick-input').press('Escape')
  await expect(win.locator('.overlay.quick')).toBeVisible()
  expect(await app.evaluate(() => (globalThis as unknown as { interrupted: number }).interrupted)).toBe(1)
})
