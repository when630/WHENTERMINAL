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

test('아래 터미널: 셸 이름을 눌러 다른 셸로 바꾸고, 다음 터미널의 기본값이 된다', async ({ win }) => {
  test.setTimeout(90_000)
  test.skip(process.platform !== 'win32', 'cmd는 Windows에만 있다')
  await win.keyboard.press('Alt+a')
  const term = win.locator('.term')
  const rows = term.locator('.xterm-rows')
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+t')
  await expect(term.locator('.term-shell')).not.toHaveText('…', { timeout: 20_000 })

  // 설치된 셸만 나오고, 고르면 그 셸이 새로 뜬다 (EXITED 없이)
  await term.locator('.term-shell').click()
  const list = term.locator('.term-shells')
  await expect(list.locator('.model-row', { hasText: 'AUTO' })).toBeVisible()
  await list.locator('.model-row', { hasText: /^CMD/ }).click()
  await expect(list).toHaveCount(0)
  await expect(term.locator('.term-shell')).toHaveText(/^cmd/, { timeout: 20_000 })
  await expect(term.locator('.term-exit')).toHaveCount(0)
  await expect(rows).toContainText('>', { timeout: 20_000 })
  await win.keyboard.type('echo %COMSPEC%')
  await win.keyboard.press('Enter')
  await expect(rows).toContainText(/cmd\.exe/i, { timeout: 20_000 })

  // 닫았다 다시 열어도 cmd (설정의 기본값이 바뀌었다)
  await term.locator('.term-x').click()
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+t')
  await expect(term.locator('.term-shell')).toHaveText(/^cmd/, { timeout: 20_000 })
})

test('아래 터미널: 탭 여러 개 (+·Ctrl+Alt+T 만들기, Ctrl+Alt+J/K 옮기기, ×·Ctrl+Alt+W 닫기)', async ({ win }) => {
  test.setTimeout(90_000)
  await win.keyboard.press('Alt+a')
  const term = win.locator('.term')
  const rows = term.locator('.xterm-rows')
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+t')
  await expect(rows).not.toBeEmpty({ timeout: 20_000 })
  // 탭이 하나면 탭 줄은 없다
  await expect(term.locator('.term-tab')).toHaveCount(0)
  await win.keyboard.type('echo first-tab')
  await win.keyboard.press('Enter')
  await expect(rows).toContainText(/first-tab[\s\S]*first-tab/, { timeout: 20_000 })

  // +: 새 탭이 지금 탭이 되고 새 셸이 뜬다
  await term.locator('.term-add').click()
  await expect(term.locator('.term-tab')).toHaveCount(2)
  await expect(term.locator('.term-tab').nth(1)).toHaveClass(/on/)
  await expect(rows).not.toContainText('first-tab')
  await expect(rows).not.toBeEmpty({ timeout: 20_000 })
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[data-terminal]'))).toBe(true)
  await win.keyboard.type('echo second-tab')
  await win.keyboard.press('Enter')
  await expect(rows).toContainText(/second-tab[\s\S]*second-tab/, { timeout: 20_000 })

  // Ctrl+Alt+J/K: 터미널에 포커스가 있어도 앱이 받는다
  await win.keyboard.press('Control+Alt+j')
  await expect(term.locator('.term-tab').first()).toHaveClass(/on/)
  await expect(rows).toContainText('first-tab')
  await win.keyboard.press('Control+Alt+k')
  await expect(term.locator('.term-tab').nth(1)).toHaveClass(/on/)
  await expect(rows).toContainText('second-tab')

  // Ctrl+Alt+T: 하나 더
  await win.keyboard.press('Control+Alt+t')
  await expect(term.locator('.term-tab')).toHaveCount(3)

  // ×: 지금 탭만 닫는다. 하나 남으면 탭 줄이 사라진다
  await term.locator('.term-x').click()
  await expect(term.locator('.term-tab')).toHaveCount(2)
  await term.locator('.term-tab').nth(1).click()
  await expect(rows).toContainText('second-tab')
  // Ctrl+Alt+W: 터미널에서 눌러도 앱이 받아 지금 탭을 닫고, 남은 탭의 터미널로
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[data-terminal]'))).toBe(true)
  await win.keyboard.press('Control+Alt+w')
  await expect(term.locator('.term-tab')).toHaveCount(0)
  await expect(rows).toContainText('first-tab')
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[data-terminal]'))).toBe(true)
  // 마지막 탭이면 서랍을 닫고 입력창으로 돌아간다
  await win.keyboard.press('Control+Alt+w')
  await expect(term).toHaveCount(0)
  await expect(win.locator('#composer-input')).toBeFocused()

  // 입력창에서도 닫힌다 (포커스는 입력창 그대로)
  await win.keyboard.press('Control+t')
  await expect(rows).not.toBeEmpty({ timeout: 20_000 })
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+Alt+w')
  await expect(term).toHaveCount(0)
  await expect(win.locator('#composer-input')).toBeFocused()
})

test('아래 터미널: Ctrl+F 찾기, 경로 Ctrl+클릭은 입력창에 @경로', async ({ win }) => {
  test.setTimeout(90_000)
  await win.keyboard.press('Alt+a')
  const term = win.locator('.term')
  const rows = term.locator('.xterm-rows')
  const input = win.locator('#composer-input')
  await input.click()
  await win.keyboard.press('Control+t')
  await expect(rows).not.toBeEmpty({ timeout: 20_000 })
  await win.keyboard.type('echo src/app.ts:12')
  await win.keyboard.press('Enter')
  await expect(rows).toContainText(/src\/app\.ts:12[\s\S]*src\/app\.ts:12/, { timeout: 20_000 })

  // 찾기: 터미널에서 Ctrl+F. 맞은 수가 보이고 Esc로 닫으면 터미널로
  await win.keyboard.press('Control+f')
  const find = term.locator('.term-find')
  await expect(find).toBeVisible()
  await expect(find.locator('input')).toBeFocused()
  await win.keyboard.type('app.ts')
  await expect(find.locator('.term-find-n')).toHaveText(/^\d+\/[2-9]$/)
  await win.keyboard.press('Enter')
  await win.keyboard.press('Escape')
  await expect(find).toHaveCount(0)
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[data-terminal]'))).toBe(true)

  // 출력 줄의 경로를 Ctrl+클릭 (그냥 누르면 아무 일 없다)
  const line = rows.locator('div', { hasText: /^src\/app\.ts:12\s*$/ }).first()
  await line.hover({ position: { x: 30, y: 6 } })
  await win.waitForTimeout(300)
  await line.click({ position: { x: 30, y: 6 } })
  await expect(input).toHaveValue('')
  await line.click({ position: { x: 30, y: 6 }, modifiers: ['Control'] })
  await expect(input).toHaveValue('@src/app.ts (L12) ')
  await expect(input).toBeFocused()
})

test.describe('명령 끝남', () => {
  // OS 알림은 끄고 화면 표시만 본다
  test.use({ seed: { projects: [{ name: 'alpha' }], settings: { notify: { approval: true, done: true, terminal: false, usage: false, whenFocused: false } } } })

  test('아래 터미널: 다른 탭을 보는 동안 오래(앱은 10초, 여기서는 2초) 돈 명령이 끝나면 그 탭에 표시, 보면 지운다', async ({ win }) => {
    test.setTimeout(120_000)
    test.skip(process.platform !== 'win32', 'PowerShell 명령')
    await win.evaluate(() => {
      ;(window as { __termLongMs?: number }).__termLongMs = 2000
    })
    await win.keyboard.press('Alt+a')
    const term = win.locator('.term')
    const rows = term.locator('.xterm-rows')
    await win.locator('#composer-input').click()
    await win.keyboard.press('Control+t')
    await expect(rows).toContainText('>', { timeout: 20_000 })
    await win.keyboard.type('Start-Sleep -Seconds 3; echo slept-done')
    await win.keyboard.press('Enter')
    // 짧게 끝나는 명령은 표시하지 않는다: 다른 탭에서 바로 끝나는 echo
    await win.keyboard.press('Control+Alt+t')
    await expect(term.locator('.term-tab')).toHaveCount(2)
    await expect(rows).toContainText('>', { timeout: 20_000 })
    await win.keyboard.type('echo quick')
    await win.keyboard.press('Enter')
    await expect(term.locator('.term-tab').first().locator('.term-tab-done')).toBeVisible({ timeout: 30_000 })
    await expect(term.locator('.term-tab').nth(1).locator('.term-tab-done')).toHaveCount(0)
    // 그 탭을 보면 표시가 사라진다
    await term.locator('.term-tab').first().click()
    await expect(rows).toContainText('slept-done')
    await expect(term.locator('.term-tab-done')).toHaveCount(0)
  })
})

test('아래 터미널: 붙여넣기는 Ctrl+V·Ctrl+Shift+V 모두 한 번만', async ({ app, win }) => {
  test.setTimeout(90_000)
  await win.keyboard.press('Alt+a')
  const term = win.locator('.term')
  const rows = term.locator('.xterm-rows')
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+t')
  await expect(term).toHaveClass(/open/)
  await expect(rows).not.toBeEmpty({ timeout: 20_000 })
  const count = async (word: string): Promise<number> => ((await rows.innerText()).match(new RegExp(word, 'g')) ?? []).length

  for (const [key, word] of [['Control+Shift+v', 'pasteshift'], ['Control+v', 'pasteplain']] as const) {
    await app.evaluate(({ clipboard }, w) => clipboard.writeText(w), word)
    await win.keyboard.press(key)
    await expect.poll(() => count(word), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    // 두 번째 붙여넣기가 늦게 들어오는지 잠시 더 본다
    await win.waitForTimeout(800)
    expect(await count(word), key).toBe(1)
    // 입력줄을 비운다 (실행하지 않는다)
    await win.keyboard.press('Control+c')
  }
})

test('입력창 !명령: 터미널에서 바로 실행하고 출력을 메인으로 (모델은 부르지 않음), 빈 !는 터미널로', async ({ app, win }) => {
  test.setTimeout(90_000)
  // 보내기와 출력 전달을 가로채 기록만 한다
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { sent: string[]; shell: { command: string; output: string }[] }
    g.sent = []
    g.shell = []
    ipcMain.removeHandler('agent:send')
    ipcMain.handle('agent:send', (_e, _p: string, _c: string, text: string) => void g.sent.push(text))
    ipcMain.removeHandler('agent:shell-output')
    ipcMain.handle('agent:shell-output', (_e, _p: string, _c: string, r: { command: string; output: string }) => void g.shell.push(r))
  })
  const shell = (): Promise<{ command: string; output: string }[]> => app.evaluate(() => (globalThis as unknown as { shell: { command: string; output: string }[] }).shell)
  await win.keyboard.press('Alt+a')
  const term = win.locator('.term')
  const rows = term.locator('.xterm-rows')
  const input = win.locator('#composer-input')
  await input.fill('!echo bang-mode')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  // 서랍이 펼쳐지고 명령이 돈다 (친 줄 + 출력). 포커스는 입력창에 그대로
  await expect(term).toHaveClass(/open/)
  await expect.poll(async () => ((await rows.innerText()).match(/bang-mode/g) ?? []).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  await expect(input).toBeFocused()
  // 프롬프트로 돌아오면 출력(메아리 줄은 빼고)이 메인으로 간다. 모델은 부르지 않는다
  await expect.poll(shell, { timeout: 30_000 }).toHaveLength(1)
  const [r] = await shell()
  expect(r.command).toBe('echo bang-mode')
  expect(r.output).toMatch(/bang-mode/)
  expect(r.output).not.toMatch(/echo bang-mode/)
  expect(await app.evaluate(() => (globalThis as unknown as { sent: string[] }).sent)).toEqual([])
  // 빈 !는 터미널을 열고 포커스를 옮긴다
  await input.fill('!')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('[data-terminal]'))).toBe(true)
})
