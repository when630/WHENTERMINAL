import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const saved = (userData: string): { title: string; titleSource?: string }[] =>
  JSON.parse(readFileSync(join(userData, 'projects.json'), 'utf8'))[0].conversations

test('탭 이름 바꾸기: 더블클릭·/rename·단축키, Esc는 취소, 직접 붙인 이름으로 저장', async ({ win, env }) => {
  await win.keyboard.press('Alt+a')
  const tab = win.locator('.tab-wrap.active')

  // 더블클릭 → 이름 칸 → Enter
  await tab.locator('.tab').dblclick()
  const edit = tab.locator('.tab-edit')
  await expect(edit).toBeFocused()
  await expect(edit).toHaveValue('대화 1')
  await edit.fill('배포 준비')
  await edit.press('Enter')
  await expect(tab.locator('.tab-t')).toHaveText('배포 준비')
  await expect(win.locator('#composer-input')).toBeFocused()
  await expect.poll(() => saved(env.userData)[0]).toMatchObject({ title: '배포 준비', titleSource: 'custom' })

  // 단축키로 열고 Esc는 취소 (실행 중단으로 가지 않는다)
  await win.keyboard.press('Control+Shift+e')
  await expect(edit).toBeFocused()
  await edit.fill('버릴 이름')
  await edit.press('Escape')
  await expect(tab.locator('.tab-t')).toHaveText('배포 준비')

  // /rename 이름은 바로 바꾸고, 이름 없이 치면 칸을 연다
  const input = win.locator('#composer-input')
  await input.fill('/rename 릴리즈 0.6.1')
  await input.press('Enter')
  await expect(tab.locator('.tab-t')).toHaveText('릴리즈 0.6.1')
  await expect(input).toHaveValue('')
  await input.fill('/rename')
  await input.press('Escape') // 명령 후보 메뉴를 닫는다
  await input.press('Enter')
  await expect(edit).toBeFocused()
  await edit.press('Escape')
  await expect.poll(() => saved(env.userData)[0].title).toBe('릴리즈 0.6.1')
})
