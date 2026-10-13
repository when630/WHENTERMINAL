import { expect, test } from './fixtures'

test.use({ seed: { projects: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }] } })

test('사이드바 프로젝트 순서: 단축키로 한 칸씩, 끌어다 놓기로 옮기고 저장된다', async ({ win }) => {
  const names = win.locator('.side-project .nav-name:not(.thread .nav-name)')
  const order = (): Promise<string[]> => win.locator('.side-project > .side-row .nav-name').allInnerTexts()
  const saved = (): Promise<string[]> => win.evaluate(async () => (await window.api.listProjects()).map((p) => p.name))
  await expect(names.first()).toHaveText('alpha')

  // alpha를 열고 한 칸 아래로 → 홈 열 글자도 새 순서를 따른다
  await win.keyboard.press('Alt+KeyA')
  await expect(win.locator('#composer-input')).toBeVisible()
  await win.keyboard.press('Alt+Shift+KeyJ')
  await expect.poll(order).toEqual(['beta', 'alpha', 'gamma'])
  await expect.poll(saved).toEqual(['beta', 'alpha', 'gamma'])
  await expect(win.locator('.side-project', { hasText: 'alpha' }).locator('.nav-key')).toHaveText('S')
  // 맨 끝에서 더 내려도 그대로, 위로 두 번이면 맨 앞
  await win.keyboard.press('Alt+Shift+KeyJ')
  await win.keyboard.press('Alt+Shift+KeyJ')
  await expect.poll(order).toEqual(['beta', 'gamma', 'alpha'])
  await win.keyboard.press('Alt+Shift+KeyK')
  await win.keyboard.press('Alt+Shift+KeyK')
  await expect.poll(order).toEqual(['alpha', 'beta', 'gamma'])

  // gamma를 끌어 alpha 위에 놓는다
  const row = (n: string) => win.locator('.side-project', { hasText: n }).locator('> .side-row')
  await row('gamma').dragTo(row('alpha'), { targetPosition: { x: 40, y: 4 } })
  await expect.poll(order).toEqual(['gamma', 'alpha', 'beta'])
  await expect.poll(saved).toEqual(['gamma', 'alpha', 'beta'])
  // beta를 alpha 위로 (앞에서 옮긴 줄이 미끄러지는 동안에는 위치가 움직이므로 끝나기를 기다린다)
  await win.waitForTimeout(450)
  await row('beta').dragTo(row('alpha'), { targetPosition: { x: 40, y: 4 } })
  await expect.poll(order).toEqual(['gamma', 'beta', 'alpha'])

  // Alt+A는 이제 gamma
  await win.keyboard.press('Alt+KeyA')
  await expect(win.locator('.side-project', { hasText: 'gamma' }).locator('.nav.on')).toHaveCount(1)
  await win.screenshot({ path: test.info().outputPath('sidebar.png') })
})
