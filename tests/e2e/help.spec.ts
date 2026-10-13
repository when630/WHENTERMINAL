import { expect, test } from './fixtures'

test.describe('단축키 도움말', () => {
  // 바꾼 키가 도움말에도 그대로 보이는지 보려고 하나를 바꿔 둔다
  test.use({ seed: { projects: [{ name: 'alpha' }], settings: { keymap: { compact: 'Ctrl+Alt+M' } } } })

  test('하단 안내 줄 대신 Ctrl+/ 도움말에서 지금 화면의 키를 먼저 보인다', async ({ win }) => {
    // 하단 안내 줄은 없다
    await expect(win.locator('.hints')).toHaveCount(0)
    const help = win.locator('.help')

    // 홈: HOME 묶음이 맨 앞
    await win.keyboard.press('Control+/')
    await expect(help).toBeVisible()
    await expect(help.locator('.help-group').first().locator('h2')).toContainText('HOME')
    await expect(help.locator('.help-group.here .help-here')).toHaveText('HERE')
    // 열려 있는 동안 다른 키는 먹지 않고, Esc로 닫힌다
    await win.keyboard.press('Alt+a')
    await expect(win.locator('.chat-body')).toHaveCount(0)
    await win.keyboard.press('Escape')
    await expect(help).toHaveCount(0)

    // 대화창: 입력 중에도 열리고 CHAT 묶음이 맨 앞, 바꾼 키가 보인다
    await win.keyboard.press('Alt+a')
    await win.locator('#composer-input').click()
    await win.keyboard.press('Control+/')
    const chat = help.locator('.help-group').first()
    await expect(chat.locator('h2')).toContainText('CHAT')
    await expect(chat.locator('dl > div', { hasText: 'Compact' }).locator('dt')).toContainText('Ctrl+Alt+M')
    await expect(chat.locator('dl > div', { hasText: 'Rename tab' }).locator('dt')).toContainText('Ctrl+Shift+E')
    await expect(help.locator('.help-group', { hasText: 'COMMANDS' })).toContainText('/rename')
    // 터미널 키는 TERMINAL 묶음에 따로 모인다
    const term = help.locator('.help-group', { has: win.locator('h2', { hasText: 'TERMINAL' }) })
    await expect(term.locator('dl > div', { hasText: 'find in output' }).locator('dt')).toContainText('Ctrl+F')
    await expect(term).toContainText('Ctrl+Click')
    await expect(chat).not.toContainText('Terminal:')
    // 같은 키를 다시 누르면 닫힌다
    await win.keyboard.press('Control+/')
    await expect(help).toHaveCount(0)

    // 사이드바 HELP 줄로도 열고, 바깥을 누르면 닫힌다
    await win.locator('.nav-help').click()
    await expect(help).toBeVisible()
    await help.click({ position: { x: 5, y: 5 } })
    await expect(help).toHaveCount(0)
  })
})

test('도움말은 흔한 창 크기에서 스크롤 없이 한 화면에 들어간다', async ({ app, win }) => {
  for (const [w, h] of [[1280, 820], [1366, 768], [1920, 1080]]) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => {
      const b = BrowserWindow.getAllWindows()[0]
      b.unmaximize()
      b.setSize(w, h)
    }, [w, h])
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(w)
    await win.keyboard.press('Control+Slash')
    const help = win.locator('.help')
    await expect(help.locator('.help-sheet')).toBeVisible()
    await expect.poll(() => help.evaluate((el) => el.scrollHeight <= el.clientHeight), { message: `${w}×${h}` }).toBe(true)
    await win.screenshot({ path: test.info().outputPath(`help-${w}.png`) })
    await win.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
  }
})
