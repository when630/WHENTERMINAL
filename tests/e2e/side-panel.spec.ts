import { test, expect } from './fixtures'
import type { ElectronApplication } from '@playwright/test'

/** 메인에서 렌더러로 대화 이벤트를 흉내 낸다 (모델을 부르지 않고 패널만 본다) */
async function emit(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { projectId: 'p1', conversationId: 'c1', event: ev })
  }, event)
}

test('작업이 끝나도 백그라운드 셸·아티팩트가 있으면 사이드 패널이 남는다', async ({ app, win }) => {
  await win.keyboard.press('Alt+a')
  const body = win.locator('.chat-body')
  await expect(body).not.toHaveClass(/open/)

  await emit(app, { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } })
  await emit(app, { kind: 'tool_result', toolUseId: 't1', content: 'Command running in background', isError: false })
  await emit(app, { kind: 'background', tasks: [{ id: 'b1', type: 'local_bash', description: 'Start dev server', toolUseId: 't1', startedAt: Date.now() }] })

  const panel = win.locator('.status-panel')
  await expect(body).toHaveClass(/open/)
  await expect(panel.locator('.sp-bg li')).toHaveCount(1)
  await expect(panel.locator('.sp-bg li b')).toHaveText('SHELL')
  await expect(panel.locator('.sp-bg-d')).toHaveText('Start dev server')
  // 전광판에도 흐르고, 실행 중인 작업이 없다는 문구는 뜨지 않는다
  await expect(win.locator('.ticker')).toHaveAttribute('aria-label', /ALPHA {2}SHELL · Start dev server/)
  await expect(win.locator('.ticker')).not.toHaveAttribute('aria-label', /NO RUNNING TASKS/)
  // 멈춤 버튼: 세션이 없으면 아무 일 없이 돌아온다 (실제 멈춤은 SDK stopTask)
  await panel.locator('.sp-bg-x').click()
  await expect(panel.locator('.sp-bg-x')).toBeEnabled()

  await emit(app, { kind: 'tool_use', toolUseId: 't2', name: 'Artifact', input: { file_path: 'C:/x/report.html', title: 'Weekly report' } })
  await emit(app, { kind: 'tool_result', toolUseId: 't2', content: 'Published https://claude.ai/code/artifact/abc-123', isError: false })
  await expect(panel.locator('.sp-art a')).toHaveAttribute('href', 'https://claude.ai/code/artifact/abc-123')
  await expect(panel.locator('.sp-art a span')).toHaveText('Weekly report')

  // 셸이 끝나도 아티팩트가 남아 있으면 펼친 채로
  await emit(app, { kind: 'background', tasks: [] })
  await expect(panel.locator('.sp-bg')).toHaveCount(0)
  await expect(body).toHaveClass(/open/)
})

test('대화 기록은 가로로 스크롤되지 않는다', async ({ win }) => {
  await win.keyboard.press('Alt+a')
  await expect(win.locator('.transcript')).toHaveCSS('overflow-x', 'hidden')
})
