import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ seed: { projects: [{ name: 'repo', git: true, files: { 'a.txt': 'hello\n' } }, { name: 'plain' }] } })

const wtOf = (userData: string) =>
  JSON.parse(readFileSync(join(userData, 'projects.json'), 'utf8'))[0].conversations.find((c: { worktree?: unknown; closedAt?: number }) => c.worktree && !c.closedAt)

test('하위 대화는 worktree에서: 변경 보기·합치기·충돌·버리기', async ({ win, env }) => {
  const repo = env.path('repo')
  await win.keyboard.press('Alt+KeyA')
  await win.locator('.tab.add').click()
  await expect.poll(() => wtOf(env.userData)?.worktree?.path).toBeTruthy()
  const wt = wtOf(env.userData).worktree as { path: string; branch: string }
  await expect(win.locator('.tab.active .wt-tag')).toHaveText('WT')

  appendFileSync(join(wt.path, 'a.txt'), 'from worktree\n')
  writeFileSync(join(wt.path, 'new.md'), '# new\n')
  await win.locator('.tb-btn', { hasText: 'CHANGES' }).click()
  await expect(win.locator('.wt-files li')).toHaveCount(2)

  await win.locator('.wt-actions .btn-pri').click()
  await expect(win.locator('.wt-msg.ok')).toContainText('합쳤어요')
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\nfrom worktree\n')
  expect(existsSync(join(repo, 'new.md'))).toBe(true)

  // 같은 줄을 양쪽에서 다르게 고치면 충돌: 병합을 되돌리고 알린다
  writeFileSync(join(repo, 'a.txt'), 'main side\n')
  execSync('git commit -qam main-edit', { cwd: repo })
  writeFileSync(join(wt.path, 'a.txt'), 'worktree side\n')
  await win.locator('.wt-actions .btn', { hasText: 'REFRESH' }).click()
  await win.locator('.wt-actions .btn-pri').click()
  await expect(win.locator('.wt-msg.bad')).toContainText('CONFLICT')
  expect(execSync('git status --porcelain', { cwd: repo }).toString().trim()).toBe('')

  await win.locator('.wt-actions .btn', { hasText: 'DISCARD' }).click()
  await win.locator('.wt-actions .btn.armed').click()
  await expect(win.locator('.wt-panel')).toHaveCount(0)
  expect(existsSync(wt.path)).toBe(false)
  expect(execSync(`git branch --list ${wt.branch}`, { cwd: repo }).toString().trim()).toBe('')
})

test('git이 아닌 폴더의 하위 대화는 플랜 모드로 시작', async ({ win }) => {
  await win.keyboard.press('Alt+KeyS')
  await win.locator('.tab.add').click()
  await expect(win.locator('.meta-mode .meta-v')).toHaveText('PLAN')
})
