import { test, expect } from './fixtures'
import type { ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test.describe('백그라운드 작업 세부 내용', () => {
  const sessionId = `e2e-${randomUUID()}`
  // CLI가 쓰는 자리(<임시 폴더>/claude/<프로젝트>/<세션 ID>/tasks/<작업 ID>.output)에 출력 파일을 만들어 둔다
  const sessionDir = join(tmpdir(), 'claude', 'wt-e2e-project', sessionId)
  test.use({ seed: { projects: [{ name: 'alpha', conversations: [{ id: 'c1', title: '대화 1', mode: 'default', sessionId }] }] } })
  test.beforeAll(() => {
    mkdirSync(join(sessionDir, 'tasks'), { recursive: true })
    writeFileSync(join(sessionDir, 'tasks', 'b1.output'), 'tick 1\ntick 2\n')
  })
  test.afterAll(() => rmSync(join(tmpdir(), 'claude', 'wt-e2e-project'), { recursive: true, force: true }))

  test('셸 줄을 누르면 출력이 펼쳐지고 늘어나는 대로 따라온다', async ({ app, win }) => {
    await win.keyboard.press('Alt+a')
    await emit(app, { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'for i in 1 2 3; do echo tick $i; sleep 1; done', run_in_background: true } })
    await emit(app, { kind: 'background', tasks: [{ id: 'b1', type: 'local_bash', description: 'Tick loop', toolUseId: 't1', startedAt: Date.now() }] })

    const panel = win.locator('.status-panel')
    await panel.locator('.sp-bg-open').click()
    const detail = win.locator('.td')
    await expect(detail.locator('.wt-title .kr')).toHaveText('SHELL')
    await expect(detail.locator('.td-state')).toHaveText('RUNNING')
    await expect(detail.locator('.td-cmd')).toContainText('echo tick')
    await expect(detail.locator('.td-log')).toContainText('tick 2')
    await expect(panel.locator('.sp-bg li')).toHaveClass(/sel/)

    // 도는 동안 1초마다 다시 읽는다
    writeFileSync(join(sessionDir, 'tasks', 'b1.output'), 'tick 1\ntick 2\ntick 3\n')
    await expect(detail.locator('.td-log')).toContainText('tick 3')

    // 끝나 목록에서 빠져도 마지막 출력을 계속 보인다
    await emit(app, { kind: 'background', tasks: [] })
    await expect(detail.locator('.td-state')).toHaveText('ENDED')
    await expect(detail.locator('.td-log')).toContainText('tick 3')

    await detail.getByRole('button', { name: 'BACK TO CHAT' }).click()
    await expect(win.locator('.transcript')).toBeVisible()
  })
})

test('하위 에이전트가 하는 일을 패널·세부 화면·대화 기록에서 본다', async ({ app, win }) => {
  await win.keyboard.press('Alt+a')
  await emit(app, { kind: 'user', text: '조사해 줘' })
  await emit(app, { kind: 'status', status: 'running' })
  await emit(app, { kind: 'tool_use', toolUseId: 'a1', name: 'Agent', input: { description: 'Find session code', subagent_type: 'Explore', prompt: 'session.ts를 찾아요' } })
  await emit(app, { kind: 'sub', parent: 'a1', item: { type: 'text', text: '파일을 찾아볼게요' } })
  await emit(app, { kind: 'sub', parent: 'a1', item: { type: 'tool', toolUseId: 's1', name: 'Read', input: { file_path: 'C:/x/session.ts' } } })

  const panel = win.locator('.status-panel')
  const row = panel.locator('section[aria-label="하위 에이전트"] li')
  await expect(row).toHaveCount(1)
  await expect(row.locator('.sp-bg-type')).toHaveText('Explore')
  await expect(row.locator('.sp-bg-d')).toHaveText('Find session code')
  await expect(row.locator('.sp-bg-now')).toHaveText('READ session.ts')
  // 앞에서 기다리는 에이전트면 작업 줄에도 그 에이전트가 하는 일이 보인다
  await expect(win.locator('.working-act')).toHaveText('AGENT · READ session.ts')

  await row.locator('.sp-bg-open').click()
  const detail = win.locator('.td')
  await expect(detail.locator('.wt-title .kr')).toHaveText('AGENT')
  await expect(detail.locator('.td-desc')).toHaveText('Find session code')
  await expect(detail.locator('.sub-text')).toHaveText('파일을 찾아볼게요')
  await expect(detail.locator('.sub-tool .sub-st')).toHaveText('RUNNING')
  await emit(app, { kind: 'sub_result', parent: 'a1', toolUseId: 's1', content: 'export class AgentSession', isError: false })
  await expect(detail.locator('.sub-tool .sub-st')).toHaveText('DONE')

  await emit(app, { kind: 'tool_result', toolUseId: 'a1', content: 'session.ts에 있어요', isError: false })
  await expect(detail.locator('.td-state')).toHaveText('DONE')
  await expect(detail.locator('.td-result')).toContainText('session.ts에 있어요')
  await expect(row).toHaveCount(0)

  // 대화 기록의 Agent 도구를 펼치면 같은 기록이 있다
  await detail.getByRole('button', { name: 'BACK TO CHAT' }).click()
  const tool = win.locator('details.tool', { hasText: 'Find session code' })
  await expect(tool.locator('.tool-sub')).toContainText('1 TOOLS')
  await tool.locator('> summary').click()
  await expect(tool.locator('.sub-tool .sub-name')).toHaveText('Read')
})

test('단축키로 패널 항목의 세부 내용을 차례로 열고, 돌아오고, 멈춘다', async ({ app, win }) => {
  // 멈춤 요청이 어떤 작업으로 가는지 본다 (세션이 없어 실제 stopTask는 아무 일도 안 한다)
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:stop-task')
    ipcMain.handle('agent:stop-task', (_e, _p: string, _c: string, taskId: string) => {
      ;(globalThis as { stopped?: string[] }).stopped = [...((globalThis as { stopped?: string[] }).stopped ?? []), taskId]
    })
  })
  await win.keyboard.press('Alt+a')
  await emit(app, { kind: 'status', status: 'running' })
  await emit(app, { kind: 'tool_use', toolUseId: 'a1', name: 'Agent', input: { description: 'Find session code', subagent_type: 'Explore', prompt: 'x' } })
  await emit(app, { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } })
  await emit(app, { kind: 'tool_use', toolUseId: 't2', name: 'Monitor', input: { command: 'tail -f dev.log', description: 'errors in dev log' } })
  await emit(app, { kind: 'background', tasks: [
    { id: 'b1', type: 'local_bash', description: 'Start dev server', toolUseId: 't1', startedAt: Date.now() },
    { id: 'b2', type: 'monitor', description: 'errors in dev log', toolUseId: 't2', startedAt: Date.now() },
  ] })

  // 입력창에 글을 쓰는 중에도 동작한다 (Ctrl 조합)
  const input = win.locator('#composer-input')
  await input.click()
  await input.fill('메모')
  const title = win.locator('.td .wt-title .kr')
  // 패널 섹션 제목에 단축키가 보인다
  await expect(win.locator('.status-panel section[aria-label="하위 에이전트"] .sp-k')).toContainText('Ctrl+J')

  // 패널 순서대로 AGENTS → BACKGROUND, 마지막 다음은 대화 기록
  await win.keyboard.press('Control+j')
  await expect(title).toHaveText('AGENT')
  await expect(win.locator('.status-panel section[aria-label="하위 에이전트"] li')).toHaveClass(/sel/)
  await win.keyboard.press('Control+j')
  await expect(title).toHaveText('SHELL')
  await win.keyboard.press('Control+j')
  await expect(title).toHaveText('MONITOR')
  await win.keyboard.press('Control+j')
  await expect(win.locator('.td')).toHaveCount(0)
  await expect(win.locator('.transcript')).toBeVisible()

  // 거꾸로: 대화 기록 → 마지막 항목
  await win.keyboard.press('Control+Shift+j')
  await expect(title).toHaveText('MONITOR')
  await expect(win.locator('.td .btn', { hasText: 'STOP' })).toContainText('Ctrl+Shift+X')
  await expect(win.locator('.td .btn', { hasText: 'BACK TO CHAT' })).toContainText('Ctrl+B')

  // 펼친 작업만 멈춘다
  await win.keyboard.press('Control+Shift+x')
  await expect.poll(() => app.evaluate(() => (globalThis as { stopped?: string[] }).stopped)).toEqual(['b2'])

  await win.keyboard.press('Control+b')
  await expect(win.locator('.td')).toHaveCount(0)
  // 대화 기록에서는 멈출 대상이 없다
  await win.keyboard.press('Control+Shift+x')
  await expect(input).toHaveValue('메모')
  expect(await app.evaluate(() => (globalThis as { stopped?: string[] }).stopped)).toEqual(['b2'])
})

test('백그라운드 작업 알림은 사람이 쓴 글이 아니라 한 줄 구분선으로 보인다', async ({ app, win }) => {
  await win.keyboard.press('Alt+a')
  await emit(app, { kind: 'task_note', text: 'TASK DONE · Monitor "test monitor" stream ended · monitor test event 5/5' })
  await expect(win.locator('.transcript .divider')).toHaveText('■ TASK DONE · Monitor "test monitor" stream ended · monitor test event 5/5')
  await expect(win.locator('.transcript .msg.user')).toHaveCount(0)
})

test('대화 기록은 가로로 스크롤되지 않는다', async ({ win }) => {
  await win.keyboard.press('Alt+a')
  await expect(win.locator('.transcript')).toHaveCSS('overflow-x', 'hidden')
})
