import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('설정: Ctrl+, 로 열고 Esc로 닫는다', async ({ win }) => {
  await win.keyboard.press('Control+Comma')
  await expect(win.locator('.settings')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.locator('.settings')).toHaveCount(0)
})

test('색 테마를 바꾸면 바로 적용되고 저장된다', async ({ win, env }) => {
  await win.keyboard.press('Control+Comma')
  await win.locator('.theme').filter({ has: win.locator('.theme-name').getByText('SUMI', { exact: true }) }).click()
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'sumi')
  expect(JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')).theme).toBe('sumi')
})

test('단축키: 글자만은 거부, 바꾼 키는 저장·표시·동작한다', async ({ win, env }) => {
  await win.keyboard.press('Control+Comma')
  await win.locator('.set-tab', { hasText: 'SHORTCUTS' }).click()
  const row = win.locator('.krow').filter({ has: win.locator('.krow-label').getByText('Clear (twice)', { exact: true }) })
  await row.locator('.kbind').click()
  await win.keyboard.press('KeyL')
  await expect(row.locator('.krow-msg')).toContainText('Ctrl')
  await win.keyboard.press('Control+KeyE')
  await expect(row.locator('.kbind')).toHaveAttribute('aria-label', /Ctrl\+E/)
  expect(JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')).keymap.clear).toBe('Ctrl+E')
  // 대화창에서 새 키로 클리어 확인이 뜬다
  await win.keyboard.press('Escape')
  await win.keyboard.press('Alt+KeyA')
  await win.locator('.transcript').click()
  await win.keyboard.press('Control+KeyE')
  await expect(win.locator('.confirm')).toBeVisible()
  await expect(win.locator('.confirm')).toContainText('컨텍스트를 비우고')
})

test('겹치는 키는 충돌로 표시하고 Backspace로 기본값', async ({ win }) => {
  await win.keyboard.press('Control+Comma')
  await win.locator('.set-tab', { hasText: 'SHORTCUTS' }).click()
  const compact = win.locator('.krow').filter({ has: win.locator('.krow-label').getByText('Compact', { exact: true }) })
  await compact.locator('.kbind').click()
  await win.keyboard.press('Control+KeyL')
  await expect(compact.locator('.krow-msg')).toContainText('CONFLICT')
  await compact.locator('.kbind').click()
  await win.keyboard.press('Backspace')
  await expect(compact.locator('.kbind')).toHaveAttribute('aria-label', /Ctrl\+Shift\+L/)
})

test('설정은 GENERAL·SHORTCUTS 탭으로 나뉘고, 키로 넘기며, 마지막 탭을 기억한다', async ({ win }) => {
  await win.keyboard.press('Control+Comma')
  const general = win.locator('.set-tab', { hasText: 'GENERAL' })
  const keys = win.locator('.set-tab', { hasText: 'SHORTCUTS' })
  // 처음은 일반 설정: 테마는 보이고 단축키 칸은 없다
  await expect(general).toHaveAttribute('aria-selected', 'true')
  await expect(win.locator('.theme').first()).toBeVisible()
  await expect(win.locator('#set-panel-keys')).toHaveCount(0)
  // 다음 탭 키(기본 Ctrl+Tab)로 넘어간다
  await win.keyboard.press('Control+Tab')
  await expect(keys).toHaveAttribute('aria-selected', 'true')
  await expect(win.locator('#set-panel-keys .kbind').first()).toBeVisible()
  await win.screenshot({ path: test.info().outputPath('keys.png') })
  await expect(win.locator('#set-panel-general')).toHaveCount(0)
  // 닫았다 다시 열면 마지막 탭 그대로
  await win.keyboard.press('Escape')
  await expect(win.locator('.settings')).toHaveCount(0)
  await win.keyboard.press('Control+Comma')
  await expect(keys).toHaveAttribute('aria-selected', 'true')
  await general.click()
  await expect(win.locator('.theme').first()).toBeVisible()
  await win.screenshot({ path: test.info().outputPath('general.png') })
})
