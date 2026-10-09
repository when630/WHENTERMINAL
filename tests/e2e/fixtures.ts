import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// package.json이 type: module이라 __dirname 대신 import.meta.url
const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string

export interface Seed {
  /** 프로젝트 폴더 이름 → 만들 파일들 */
  projects?: { name: string; git?: boolean; files?: Record<string, string>; conversations?: Record<string, unknown>[] }[]
  settings?: Record<string, unknown>
}

export interface Env {
  root: string
  userData: string
  path: (project: string) => string
  launch: () => Promise<{ app: ElectronApplication; win: Page; errors: string[] }>
}

/**
 * 테스트마다 임시 폴더에 사용자 데이터(projects.json·settings.json)와 프로젝트 폴더를 새로 만든다.
 * 실제 사용자 데이터는 건드리지 않는다 (--user-data-dir)
 */
export function makeEnv(seed: Seed): Env {
  const root = mkdtempSync(join(tmpdir(), 'wt-e2e-'))
  const userData = join(root, 'ud')
  mkdirSync(userData, { recursive: true })
  const path = (name: string): string => join(root, name)
  const projects = (seed.projects ?? []).map((p, i) => {
    const dir = path(p.name)
    mkdirSync(dir, { recursive: true })
    for (const [f, body] of Object.entries(p.files ?? { 'README.md': `# ${p.name}\n` })) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), body)
    }
    if (p.git) {
      execSync('git init -q && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm init', { cwd: dir })
      execSync('git config user.email e2e@test && git config user.name e2e', { cwd: dir })
    }
    return { id: `p${i + 1}`, name: p.name, path: dir, conversations: p.conversations ?? [{ id: `c${i + 1}`, title: '대화 1', mode: 'default' }] }
  })
  writeFileSync(join(userData, 'projects.json'), JSON.stringify(projects, null, 2))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ theme: 'poster', keymap: {}, ...seed.settings }))
  return {
    root,
    userData,
    path,
    launch: async () => {
      const app = await _electron.launch({ executablePath: electronPath, args: [repo, `--user-data-dir=${userData}`], cwd: repo })
      const win = await app.firstWindow()
      const errors: string[] = []
      win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      win.on('pageerror', (e) => errors.push(e.message))
      await win.waitForSelector('.shell')
      return { app, win, errors }
    },
  }
}

/** 테스트 하나 = 앱 하나. 끝나면 닫고 임시 폴더를 지운다. 화면 오류가 있으면 실패 */
export const test = base.extend<{ seed: Seed; env: Env; app: ElectronApplication; win: Page }>({
  seed: [{ projects: [{ name: 'alpha' }] }, { option: true }],
  env: async ({ seed }, use) => {
    const env = makeEnv(seed)
    await use(env)
    rmSync(env.root, { recursive: true, force: true })
  },
  app: async ({ env }, use) => {
    const { app, errors } = await env.launch()
    await use(app)
    await app.close()
    if (errors.length) throw new Error(`화면 오류: ${errors.join(' / ')}`)
  },
  win: async ({ app }, use) => {
    await use(await app.firstWindow())
  },
})

export { expect } from '@playwright/test'

/** 화면을 고정해 두고 1x1 PNG를 붙여넣는다 (스크린샷 붙여넣기 흉내) */
export async function pasteImage(win: Page, selector: string): Promise<void> {
  await win.evaluate((sel) => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }))
    document.querySelector(sel)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, selector)
}
