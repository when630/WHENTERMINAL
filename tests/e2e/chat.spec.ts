import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, pasteImage, test } from './fixtures'

test.use({
  seed: {
    projects: [
      { name: 'alpha', files: { 'README.md': '# alpha\n', 'src/main/session.ts': 'export {}\n', 'src/renderer/App.tsx': 'export {}\n' } },
      {
        name: 'beta',
        conversations: [
          { id: 'b1', title: '대화 1', mode: 'default' },
          {
            id: 'b2',
            title: '끝난 작업',
            mode: 'default',
            lastTask: { instruction: '끝난 작업', startedAt: 1, stage: 4, activity: '', tools: 2, files: [], finishedAt: 2, summary: '**요약**입니다', unread: true, archived: false, status: 'done' },
          },
        ],
      },
    ],
  },
})

test('/ 명령 후보: 걸러지고 Esc는 메뉴만 닫는다', async ({ win }) => {
  await win.keyboard.press('Alt+KeyA')
  await win.locator('#composer-input').focus()
  await win.keyboard.type('/')
  await expect(win.locator('.slash-row').first()).toBeVisible()
  await win.keyboard.type('comp')
  await expect(win.locator('.slash-row').first()).toContainText('/compact')
  await win.keyboard.press('Escape')
  await expect(win.locator('.slash')).toHaveCount(0)
  await expect(win.locator('.badge:not(.other)')).toHaveText('IDLE')
  // macOS 입력창에서 Ctrl+A는 줄 처음으로 가는 키라 fill로 비운다
  await win.locator('#composer-input').fill('')
  await win.keyboard.type('/cle')
  await win.keyboard.press('Tab')
  await expect(win.locator('#composer-input')).toHaveValue('/clear ')
})

test('@ 파일 후보: 띄엄띄엄 찾고 Tab으로 넣는다', async ({ win }) => {
  await win.keyboard.press('Alt+KeyA')
  await win.locator('#composer-input').focus()
  await win.keyboard.type('봐줘 @sess')
  await expect(win.locator('.file-row').first()).toContainText('session.ts')
  await win.keyboard.press('Tab')
  await expect(win.locator('#composer-input')).toHaveValue('봐줘 @src/main/session.ts ')
})

test('스크린샷 붙여넣기: 파일로 저장하고 경로를 넣는다 (대화창·홈)', async ({ win }) => {
  await pasteImage(win, '#ask-input')
  await expect(win.locator('#ask-input')).toHaveValue(/screenshot-.*\.png/)
  const saved = /(\S+screenshot-\S+\.png)/.exec(await win.locator('#ask-input').inputValue())![1]
  expect(existsSync(saved)).toBe(true)
  await win.keyboard.press('Alt+KeyA')
  await pasteImage(win, '#composer-input')
  await expect(win.locator('#composer-input')).toHaveValue(/screenshot-.*\.png/)
})

test('보고함은 재시작해도 남고, 닫은 대화의 보고서는 보관할 때까지 남는다', async ({ win, env }) => {
  await expect(win.locator('.rep')).toHaveCount(1)
  await expect(win.locator('.rep .rep-tt')).toHaveText('끝난 작업')
  await win.locator('.rep').click()
  await expect(win.locator('.sheet strong')).toHaveText('요약')
  await win.keyboard.press('KeyO')
  await win.locator('.transcript').click()
  await win.keyboard.press('Control+KeyW')
  await win.keyboard.press('Control+KeyW')
  await expect(win.locator('.tab-wrap')).toHaveCount(1)
  await win.keyboard.press('Control+KeyH')
  await expect(win.locator('.rep')).toHaveCount(1)
  const beta = () => JSON.parse(readFileSync(join(env.userData, 'projects.json'), 'utf8')).find((p: { name: string }) => p.name === 'beta')
  expect(beta().conversations.find((c: { id: string }) => c.id === 'b2').closedAt).toBeTruthy()
  await win.locator('.rep').click()
  await win.keyboard.press('KeyE')
  await expect(win.locator('.rep')).toHaveCount(0)
  await expect.poll(() => beta().conversations.some((c: { id: string }) => c.id === 'b2')).toBe(false)
})

test('Ctrl+W 두 번으로 대화를 닫고, 마지막이면 빈 대화가 생긴다', async ({ win }) => {
  await win.keyboard.press('Alt+KeyA')
  await win.locator('.transcript').click()
  await win.keyboard.press('Control+KeyW')
  await expect(win.locator('.confirm')).toBeVisible()
  await win.keyboard.press('Control+KeyW')
  await expect(win.locator('.tab-wrap')).toHaveCount(1)
  await expect(win.locator('.tab.active .tab-t')).toHaveText('대화 1')
})

test('프로젝트 닫기: 사이드바 × 두 번, 대화창 Ctrl+Shift+W 두 번. 폴더는 남는다', async ({ win, env }) => {
  const names = () => JSON.parse(readFileSync(join(env.userData, 'projects.json'), 'utf8')).map((p: { name: string }) => p.name)
  // 사이드바 ×: 한 번은 확인, 두 번째에 닫힘
  const beta = win.locator('.side-project', { hasText: 'beta' })
  await beta.hover()
  await beta.locator('.side-x').click()
  await expect(beta.locator('.side-x')).toHaveText('CLOSE?')
  await win.waitForTimeout(400)
  await win.screenshot({ path: test.info().outputPath('side-armed.png') })
  await beta.locator('.side-x').click()
  await expect(win.locator('.side-project')).toHaveCount(1)
  await expect.poll(names).toEqual(['alpha'])
  expect(existsSync(env.path('beta'))).toBe(true)
  // 대화창 단축키: 보고 있던 프로젝트를 닫으면 홈으로
  await win.keyboard.press('Alt+KeyA')
  await win.locator('.transcript').click()
  await win.keyboard.press('Control+Shift+KeyW')
  await expect(win.locator('.confirm')).toContainText('alpha')
  await win.keyboard.press('Control+Shift+KeyW')
  await expect(win.locator('.side-project')).toHaveCount(0)
  await expect(win.locator('.home')).toBeVisible()
  await expect.poll(names).toEqual([])
  expect(existsSync(env.path('alpha'))).toBe(true)
})
