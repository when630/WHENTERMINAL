import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const convOf = (userData: string, id = 'c1'): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(userData, 'projects.json'), 'utf8')) as { conversations: Record<string, unknown>[] }[]).flatMap((p) => p.conversations).find((c) => c.id === id)!

test('입력 초안: 탭을 옮기거나 새로 고쳐도 대화마다 남고, 보내면 지워진다', async ({ win }) => {
  await win.keyboard.press('Alt+a')
  const input = win.locator('#composer-input')
  await input.click()
  await win.keyboard.type('쓰던 글')
  // 새 탭은 빈 입력창
  await win.keyboard.press('Control+Shift+t')
  await expect(win.locator('.tab-wrap')).toHaveCount(2)
  await expect(input).toHaveValue('')
  await input.click()
  await win.keyboard.type('둘째 탭 글')
  await win.locator('.tab-wrap').first().locator('.tab').click()
  await expect(input).toHaveValue('쓰던 글')
  // 앱을 새로 고쳐도
  await win.reload()
  await win.waitForSelector('.shell')
  await win.keyboard.press('Alt+a')
  await expect(input).toHaveValue('쓰던 글')
  await win.locator('.tab-wrap').nth(1).locator('.tab').click()
  await expect(input).toHaveValue('둘째 탭 글')
  // /clear처럼 앱이 처리하는 명령도 보내면 초안이 지워진다
  await input.fill('/rename 새 이름')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await win.reload()
  await win.waitForSelector('.shell')
  await win.keyboard.press('Alt+a')
  await win.locator('.tab-wrap').nth(1).locator('.tab').click()
  await expect(input).toHaveValue('')
})

test('effort: 칸에서 고르면 저장되고, Ctrl+Shift+O로 다음 단계, Default로 되돌린다', async ({ win, env }) => {
  test.setTimeout(60_000)
  await win.keyboard.press('Alt+a')
  const effort = win.locator('.meta', { hasText: 'EFFORT' })
  await expect(effort).toBeVisible()
  await effort.click()
  const list = win.locator('.effort-list')
  await expect(list.locator('.model-row', { hasText: /^HIGH/ })).toBeVisible({ timeout: 30_000 })
  await expect(list.locator('.model-row').first()).toContainText('Default')
  await list.locator('.model-row', { hasText: /^HIGH/ }).click()
  await expect(list).toHaveCount(0)
  await expect(effort.locator('.effort-v')).toHaveText('HIGH')
  await expect.poll(() => convOf(env.userData).effort).toBe('high')

  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+Shift+o')
  await expect(effort.locator('.effort-v')).toHaveText('XHIGH')
  await expect.poll(() => convOf(env.userData).effort).toBe('xhigh')

  await effort.click()
  await list.locator('.model-row').first().click()
  await expect.poll(() => convOf(env.userData).effort).toBeUndefined()
  await expect(effort).toHaveClass(/meta-default/)
})

test('effort: 마지막으로 고른 값으로 새 대화가 시작하고, Default로 되돌리면 잊는다', async ({ win, env }) => {
  test.setTimeout(60_000)
  await win.keyboard.press('Alt+a')
  const effort = win.locator('.meta', { hasText: 'EFFORT' })
  const list = win.locator('.effort-list')
  await effort.click()
  await list.locator('.model-row', { hasText: /^LOW/ }).click({ timeout: 30_000 })
  await expect.poll(() => convOf(env.userData).effort).toBe('low')

  // 새 탭은 고른 값으로
  await win.keyboard.press('Control+Shift+t')
  await expect(win.locator('.tab-wrap')).toHaveCount(2)
  await expect(effort.locator('.effort-v')).toHaveText('LOW')
  const second = (): Record<string, unknown> =>
    (JSON.parse(readFileSync(join(env.userData, 'projects.json'), 'utf8')) as { conversations: Record<string, unknown>[] }[])[0].conversations[1]
  expect(second().effort).toBe('low')

  // 되돌리면 다음 새 대화는 기본값
  await effort.click()
  await list.locator('.model-row').first().click({ timeout: 30_000 })
  await expect.poll(() => second().effort).toBeUndefined()
  await win.keyboard.press('Control+Shift+t')
  await expect(win.locator('.tab-wrap')).toHaveCount(3)
  await expect(effort).toHaveClass(/meta-default/)
})

test.describe('브랜치', () => {
  test.use({ seed: { projects: [{ name: 'repo', git: true, files: { 'a.txt': 'hello\n' } }] } })

  test('대화창 위에 브랜치를 보이고, 바뀌거나 커밋 안 한 변경이 생기면 따라간다', async ({ win, env }) => {
    const repo = env.path('repo')
    const current = execSync('git branch --show-current', { cwd: repo }).toString().trim()
    await win.keyboard.press('Alt+a')
    const branch = win.locator('.tb-proj .tb-branch')
    await expect(branch).toHaveText(current)
    await expect(win.locator('.tb-proj .wt-tag')).toHaveText('BRANCH')

    execSync('git checkout -qb feature-x', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    // 창으로 돌아오면 다시 읽는다
    await win.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(branch).toHaveText('feature-x*')
    await expect(branch).toHaveClass(/dirty/)
  })
})

test('git이 아닌 폴더는 브랜치 없이 경로만', async ({ win }) => {
  await win.keyboard.press('Alt+a')
  await expect(win.locator('.tb-proj .tb-name > span')).toContainText('alpha')
  await expect(win.locator('.tb-proj .tb-branch')).toHaveCount(0)
})

test('한도 경고: 80% 넘으면 알리고, 다 썼을 때 초기화 시각을 알면 보내 두고 모르면 Enter를 한 번 더 눌러야 보낸다', async ({ app, win }) => {
  await win.keyboard.press('Alt+a')
  // 실제 사용량을 다 받은 뒤에 덮어써야 나중에 온 값에 지워지지 않는다
  await expect(win.locator('.usage .uw, .usage .usage-foot:not(:has-text("불러오는 중"))').first()).toBeVisible({ timeout: 30_000 })
  const send = async (percent: number, knownReset = true): Promise<void> => {
    await app.evaluate(({ BrowserWindow }, [p, known]) => {
      BrowserWindow.getAllWindows()[0].webContents.send('usage:changed', {
        plan: 'max',
        available: true,
        fetchedAt: Date.now(),
        windows: [
          { id: 'five_hour', label: '5H', percent: p, resetsAt: known ? Date.now() + 2 * 3600_000 : null },
          { id: 'seven_day', label: 'WEEKLY', percent: 10, resetsAt: Date.now() + 5 * 86400_000 },
        ],
      })
    }, [percent, knownReset] as const)
  }
  const warn = win.locator('.limit-warn')
  await send(50)
  await expect(warn).toHaveCount(0)
  await send(88)
  await expect(warn).toContainText('5H 88%')
  await expect(warn).not.toHaveClass(/full/)

  await send(100)
  await expect(warn).toHaveClass(/full/)
  await expect(warn).toContainText('한도를 다 썼어요')
  // 모델을 부르지 않게 보내기를 가로채 기록만 한다
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { sent: string[] }
    g.sent = []
    ipcMain.removeHandler('agent:send')
    ipcMain.handle('agent:send', (_e, _p: string, _c: string, text: string) => void g.sent.push(text))
  })
  const sent = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { sent: string[] }).sent)
  const input = win.locator('#composer-input')
  // 초기화 시각을 알면 확인 없이 보낸다 (메인이 대기열에 잡아 두었다가 초기화 뒤 시작)
  await expect(warn).toContainText('초기화된 뒤 자동으로 시작해요')
  await input.fill('보내 두기')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect.poll(sent).toEqual(['보내 두기'])
  // 초기화 시각을 모르면 한 번 더 확인한다
  await send(100, false)
  await expect(warn).toContainText('보내면 거절될 수 있어요')
  await input.fill('한도 시험')
  await input.press('Enter')
  await expect(input).toHaveValue('한도 시험')
  await expect(warn).toHaveClass(/armed/)
  expect(await sent()).toEqual(['보내 두기'])
  // 글을 고치면 확인이 풀린다
  await input.press('End')
  await win.keyboard.type('!')
  await expect(warn).not.toHaveClass(/armed/)
  await input.press('Enter')
  await expect(warn).toHaveClass(/armed/)
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect.poll(sent).toEqual(['보내 두기', '한도 시험!'])
})
