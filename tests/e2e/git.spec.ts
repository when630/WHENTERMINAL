import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'

test.use({ seed: { projects: [{ name: 'alpha', git: true, files: { 'README.md': '# alpha\n', 'src/a.ts': 'export const a = 1\n' } }] } })

test('Ctrl+G git 화면: 브랜치·커밋 기록·커밋 diff·커밋 안 한 변경을 보고, 키로 오간다', async ({ env, win }) => {
  // 커밋 둘(한 브랜치에 하나 더) + 커밋 안 한 변경
  const dir = env.path('alpha')
  execSync('git checkout -qb feature && git commit -q --allow-empty -m "빈 커밋" && git checkout -q -', { cwd: dir })
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')
  execSync('git commit -qam "a를 2로"', { cwd: dir })
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 3\n')
  writeFileSync(join(dir, 'new.txt'), '새 파일\n')

  await win.keyboard.press('Alt+a')
  await win.locator('#composer-input').click()
  await win.keyboard.press('Control+g')
  const git = win.locator('.git')
  await expect(git).toBeVisible()

  // 브랜치 목록: 지금 브랜치에 HEAD, feature도 있다
  await expect(git.locator('.git-ref.current .git-head')).toHaveText('HEAD')
  await expect(git.locator('.git-ref-name', { hasText: 'feature' })).toBeVisible()

  // 커밋 안 한 변경이 있으면 그것부터: 새 파일과 고친 파일
  await expect(git.locator('.git-meta-line')).toContainText('UNCOMMITTED')
  await expect(git.locator('.git-diff .wt-files')).toContainText('new.txt')
  await expect(git.locator('.git-diff .wt-files')).toContainText('src/a.ts')

  // 커밋 칸에 포커스: J로 맨 위 커밋, 그 커밋의 diff
  await expect(git.locator('.git-log')).toBeFocused()
  await win.keyboard.press('j')
  await expect(git.locator('.git-meta-subject')).toHaveText('a를 2로')
  await expect(git.locator('.git-diff .wt-diff')).toContainText('+export const a = 2')
  await win.keyboard.press('j')
  await expect(git.locator('.git-meta-subject')).toHaveText('init')

  // H로 왼쪽 칸, J로 다음 줄들을 지나 feature 브랜치를 고르면 그 기록으로
  await win.keyboard.press('h')
  await expect(git.locator('.git-refs')).toBeFocused()
  await git.locator('.git-ref-name', { hasText: 'feature' }).click()
  await expect(git.locator('.git-log .git-h')).toHaveText('feature')
  await expect(git.locator('.git-meta-subject')).toHaveText('빈 커밋')

  // ALL BRANCHES: 두 브랜치의 커밋이 함께
  await git.locator('.git-ref-name', { hasText: 'ALL BRANCHES' }).click()
  await expect(git.locator('.git-row')).toHaveCount(3)

  // 커밋: 커밋 안 한 변경을 고르고 메시지 칸에서 Enter 두 번 (한 번이면 확인만)
  await git.locator('.git-ref-name', { hasText: 'UNCOMMITTED' }).click()
  const msg = git.locator('.git-commit-input')
  await msg.fill('변경 커밋')
  await msg.press('Enter')
  await expect(git.locator('.git-commit .btn.armed')).toHaveText('COMMIT? 한 번 더')
  await msg.press('Enter')
  await expect(git.locator('.wt-msg')).toContainText('커밋했어요')
  expect(execSync('git log -1 --format=%s', { cwd: dir }).toString().trim()).toBe('변경 커밋')
  expect(execSync('git status --porcelain', { cwd: dir }).toString().trim()).toBe('')
  await expect(git.locator('.git-ref', { hasText: 'UNCOMMITTED' })).toContainText('0 FILES')

  // 체크아웃: feature를 고른 채 C 두 번
  await git.locator('.git-ref-name', { hasText: 'feature' }).click()
  await expect(git.locator('.wt-actions .btn-pri')).toHaveText('CHECKOUT feature')
  await git.locator('.git-refs').focus()
  await win.keyboard.press('c')
  await expect(git.locator('.wt-actions .btn.armed')).toHaveText('CHECKOUT? 한 번 더')
  await win.keyboard.press('c')
  await expect(git.locator('.wt-msg')).toContainText('feature 브랜치로 옮겼어요')
  await expect(git.locator('.git-ref.current .git-ref-name')).toHaveText('feature')
  expect(execSync('git branch --show-current', { cwd: dir }).toString().trim()).toBe('feature')

  // /git과 같은 키로 닫는다
  await win.keyboard.press('Control+g')
  await expect(git).toHaveCount(0)
  await expect(win.locator('#composer-input')).toBeFocused()
})

test.describe('git 저장소가 아닌 프로젝트', () => {
  test.use({ seed: { projects: [{ name: 'plain' }] } })
  test('GIT 버튼이 없고 /git은 안내를 보인다', async ({ win }) => {
    await win.keyboard.press('Alt+a')
    await expect(win.locator('.tb-btn', { hasText: /^GIT$/ })).toHaveCount(0)
    const input = win.locator('#composer-input')
    await input.fill('/git')
    await input.press('Escape')
    await input.press('Enter')
    await expect(win.locator('.git .empty')).toHaveText('git 저장소가 아닌 폴더예요.')
  })
})
