import { test, expect } from './fixtures'
import type { ElectronApplication } from '@playwright/test'

async function emit(app: ElectronApplication, event: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:event', { projectId: 'p1', conversationId: 'c1', event: ev })
  }, event)
}

test('아래 터미널: 실제 셸 실행, 접기·펼치기, 탭을 옮겨도 유지, RUN IN TERMINAL, SEND TO CLAUDE, 닫기', async ({ app, win }) => {
  test.setTimeout(120_000)
  await win.keyboard.press('Alt+a')
  const term = win.locator('.term')
  const rows = term.locator('.xterm-rows')
  const input = win.locator('#composer-input')
  await expect(term).toHaveCount(0)

  // Ctrl+T: 펼치고 터미널로. 셸 이름·폴더가 보이고 실제 명령이 돈다
  await input.click()
  await win.keyboard.press('Control+t')
  await expect(term).toHaveClass(/open/)
  await expect(term.locator('.term-shell')).not.toBeEmpty({ timeout: 20_000 })
  await expect(term.locator('.term-cwd')).toContainText('alpha')
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[data-terminal]'))).toBe(true)
  await expect(rows).not.toBeEmpty({ timeout: 20_000 }) // 프롬프트
  await win.keyboard.type('echo hello-terminal')
  await win.keyboard.press('Enter')
  await expect(rows).toContainText(/hello-terminal[\s\S]*hello-terminal/, { timeout: 20_000 }) // 친 줄 + 출력

  // 터미널에서 Esc는 셸 몫 (대화창이 그대로 있다), Ctrl+T는 접고 입력창으로
  await win.keyboard.press('Escape')
  await win.keyboard.press('Control+t')
  await expect(term).toHaveClass(/folded/)
  await expect(input).toBeFocused()
  // 다시 펼치면 출력이 남아 있다
  await win.keyboard.press('Control+t')
  await expect(term).toHaveClass(/open/)
  await expect(rows).toContainText('hello-terminal')

  // 새 탭에는 터미널이 없고, 돌아오면 그대로
  await input.click()
  await win.keyboard.press('Control+Shift+t')
  await expect(win.locator('.tab-wrap')).toHaveCount(2)
  await expect(term).toHaveCount(0)
  await win.locator('.tab-wrap').first().locator('.tab').click()
  await expect(term).toHaveClass(/open/)
  await expect(rows).toContainText('hello-terminal')

  // RUN IN TERMINAL: Claude가 쓴 명령을 입력줄에 넣기만 하고, 실행은 Enter로
  await emit(app, { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'echo from-claude' } })
  await emit(app, { kind: 'tool_result', toolUseId: 't1', content: 'from-claude', isError: false })
  const tool = win.locator('details.tool', { hasText: 'echo from-claude' })
  await tool.locator('> summary').click()
  await tool.locator('.tool-run').click()
  await expect(rows).toContainText('echo from-claude')
  await win.waitForTimeout(800)
  await expect(rows).not.toContainText(/echo from-claude[\s\S]*\n?from-claude\s*$/m)
  await win.keyboard.press('Enter')
  await expect.poll(async () => ((await rows.innerText()).match(/from-claude/g) ?? []).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

  // SEND TO CLAUDE: 선택한 출력을 입력창에 코드 블록으로
  await expect(term.locator('.term-btn', { hasText: 'SEND TO CLAUDE' })).toBeDisabled()
  // 줄은 터미널 폭 전체라 가운데를 누르면 빈칸이 잡힌다. 글자가 있는 앞쪽을 두 번 누른다
  await rows.locator('div', { hasText: /^hello-terminal\s*$/ }).first().dblclick({ position: { x: 24, y: 6 } })
  await expect(term.locator('.term-btn', { hasText: 'SEND TO CLAUDE' })).toBeEnabled()
  await term.locator('.term-btn', { hasText: 'SEND TO CLAUDE' }).click()
  await expect(input).toHaveValue(/```\nhello-terminal\n```/)
  await expect(input).toBeFocused()

  // 닫기: 셸을 끝내고 서랍이 사라진다
  await term.locator('.term-x').click()
  await expect(term).toHaveCount(0)
})
