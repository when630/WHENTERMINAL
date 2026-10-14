import { test, expect } from './fixtures'

test.use({ seed: { projects: [{ name: 'alpha', git: true }, { name: 'beta' }] } })

test('Ctrl+Shift+P 명령 팔레트: 이름으로 찾아 동작·명령·프로젝트·테마를 실행한다', async ({ win }) => {
  await win.keyboard.press('Alt+a')
  const input = win.locator('#composer-input')
  await input.fill('쓰던 글')

  const open = async (): Promise<void> => {
    await win.keyboard.press('Control+Shift+p')
    await expect(win.locator('.palette .search-input')).toBeFocused()
  }

  // 키맵 동작: 도움말 (단축키와 같은 처리)
  await open()
  await win.keyboard.type('keyboard short')
  await expect(win.locator('.palette .pal-row').first()).toContainText('Keyboard shortcuts')
  // 같은 일을 하는 단축키가 줄 오른쪽에
  await expect(win.locator('.palette .pal-row').first().locator('.pal-keys')).toContainText('Ctrl+/')
  await win.keyboard.press('Enter')
  await expect(win.locator('.palette')).toHaveCount(0)
  await expect(win.locator('.help')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.locator('.help')).toHaveCount(0)

  // 입력창 명령: /git. 쓰던 글은 그대로 남는다
  await open()
  await win.keyboard.type('/git')
  await win.keyboard.press('Enter')
  await expect(win.locator('.git')).toBeVisible()
  await expect(input).toHaveValue('쓰던 글')
  await win.keyboard.press('Control+b')
  await expect(win.locator('.git')).toHaveCount(0)

  // 방금 쓴 것은 빈 칸일 때 맨 위에 RECENT로
  await open()
  await expect(win.locator('.palette .pal-row').first()).toContainText('/git')
  await expect(win.locator('.palette .pal-row').first().locator('.pal-recent')).toHaveText('RECENT')

  // 프로젝트로 옮기기: 두 번째 줄 이동으로 고른다
  await win.keyboard.type('beta')
  const rows = win.locator('.palette .pal-row')
  await expect(rows.filter({ hasText: 'PROJECT' })).toHaveCount(1)
  await rows.filter({ hasText: 'PROJECT' }).click()
  await expect(win.locator('.tb-name b')).toHaveText('beta')

  // 테마
  await open()
  await win.keyboard.type('theme sumi')
  await win.keyboard.press('Enter')
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'sumi')

  // 없는 말이면 안내, Esc로 닫으면 입력창으로
  await open()
  await win.keyboard.type('zzzz')
  await expect(win.locator('.palette .empty')).toContainText('맞는 명령이 없어요')
  await win.keyboard.press('Escape')
  await expect(win.locator('.palette')).toHaveCount(0)
  await expect(input).toBeFocused()
})

test('홈에서는 대화창 동작이 빠지고 홈 동작이 보인다', async ({ win }) => {
  await win.keyboard.press('Control+Shift+p')
  const rows = win.locator('.palette .pal-row')
  await expect(rows.filter({ hasText: 'Add project' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'Compact' })).toHaveCount(0)
  await expect(rows.filter({ hasText: '/git' })).toHaveCount(0)
})
