import { test, expect } from './fixtures'
import type { ElectronApplication } from '@playwright/test'

async function emit(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { projectId: 'p1', conversationId: 'c1', event: ev })
  }, event)
}

test('Ctrl+Shift+T로 새 탭을 연다', async ({ win }) => {
  await win.keyboard.press('Alt+a')
  await expect(win.locator('.tab-wrap')).toHaveCount(1)
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+Shift+t')
  await expect(win.locator('.tab-wrap')).toHaveCount(2)
  await expect(win.locator('.tab-wrap.active .tab-n')).toHaveText('02')
})

test('Ctrl+Shift+F 대화 검색: 찾고, 고르면 그 대화의 그 메시지로 스크롤한다', async ({ app, win }) => {
  // 세션 기록 대신 검색 결과를 흉내 낸다 (메인의 실제 검색은 세션 기록 파일을 읽는다)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('conversations:search')
    ipcMain.handle('conversations:search', (_e, query: string) =>
      query.includes('worktree')
        ? [
            { projectId: 'p1', projectIndex: 0, projectName: 'alpha', conversationId: 'c1', title: '대화 1', role: 'assistant', snippet: '첫 번째 worktree 설명', ordinal: 0, modified: 2 },
            { projectId: 'p1', projectIndex: 0, projectName: 'alpha', conversationId: 'c1', title: '대화 1', role: 'user', snippet: '두 번째 worktree 질문', ordinal: 1, modified: 2 },
          ]
        : [],
    )
  })
  // 대화 기록: 맞는 메시지 두 개 사이에 긴 글을 넣어 스크롤이 필요하게 한다
  await win.keyboard.press('Alt+a')
  await emit(app, { kind: 'assistant_text', text: '첫 번째 worktree 설명' })
  for (let i = 0; i < 30; i++) await emit(app, { kind: 'assistant_text', text: `채우는 문단 ${i}\n\n${'긴 내용 '.repeat(40)}` })
  await emit(app, { kind: 'user', text: '두 번째 worktree 질문' })
  await emit(app, { kind: 'assistant_text', text: '마지막 답' })
  await win.keyboard.press('Control+h')

  // 홈에서 열고 (전체화면 대신 검색), 찾는 말이 없으면 안내
  await win.keyboard.press('Control+Shift+f')
  const search = win.locator('.search')
  const input = win.locator('#search-input')
  await expect(input).toBeFocused()
  await input.fill('nothing')
  await expect(search.locator('.empty')).toContainText("'nothing'가 들어간 메시지가 없어요")

  await input.fill('worktree')
  await expect(search.locator('.search-hit')).toHaveCount(2)
  await expect(search.locator('.search-hit').first().locator('mark')).toHaveText('worktree')
  await expect(search.locator('.search-hit.on .search-role')).toHaveText('CLAUDE')
  // Ctrl+J로 두 번째를 고르고 Enter
  await input.press('Control+j')
  await expect(search.locator('.search-hit.on .search-role')).toHaveText('YOU')
  await input.press('Enter')
  await expect(search).toHaveCount(0)

  // 그 대화가 열리고, 두 번째로 맞은 메시지(내 질문)가 강조된 채 보인다
  const hit = win.locator('.transcript > .hit')
  await expect(hit).toHaveText('두 번째 worktree 질문')
  await expect(hit).toBeInViewport()
  await expect(win.locator('.transcript > .hit')).toHaveCount(0, { timeout: 5000 })

  // 같은 키로 닫고, Esc로도 닫는다
  await win.keyboard.press('Control+Shift+f')
  await expect(search).toBeVisible()
  await win.keyboard.press('Control+Shift+f')
  await expect(search).toHaveCount(0)
  await win.keyboard.press('Control+Shift+f')
  await win.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
})
