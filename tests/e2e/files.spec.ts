import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#e33"/></svg>'

test.use({
  seed: {
    projects: [
      {
        name: 'alpha',
        // git이면 목록을 git ls-files로 받는다 (한글 경로 이스케이프 확인)
        git: true,
        files: {
          'README.md': '# 알파 문서\n\n본문이에요.\n\n![로고](img/logo.svg)\n\n[가이드 보기](docs/guide.md)\n',
          'docs/guide.md': '# 가이드\n\n두 번째 문서예요.\n',
          'img/logo.svg': SVG,
          'src/app.ts': 'export const answer = 42\nconsole.log(answer)\n',
          '문서/기획서 초안.md': '# 안녕하세요\n\n한글 이름 파일이에요.\n',
          'page.html': '<!doctype html><h1 id="t">static</h1><script>document.getElementById("t").textContent = "scripted"</script>',
        },
      },
    ],
  },
})

test('파일 찾기: 폴더 둘러보기·md 읽기 모드·html 미리 보기·경로 넣기', async ({ app, win }) => {
  await win.keyboard.press('Alt+KeyA')
  const composer = win.locator('#composer-input')
  await expect(composer).toBeVisible()
  await composer.focus()
  await win.keyboard.press('Control+KeyP')
  const overlay = win.locator('.overlay.files')
  await expect(overlay).toBeVisible()
  const input = overlay.locator('.search-input')
  await expect(input).toBeFocused()

  // 맨 위 폴더: 폴더가 먼저, 그다음 파일
  const rows = overlay.locator('.files-row:not(.up) .files-name')
  // 폴더가 먼저 (이름 순서는 시스템 언어를 따라 한글·영어 중 어느 쪽이 앞일지 다르다)
  await expect(rows.first()).toHaveText(/\/$/)
  await expect(rows).toContainText(['docs/', 'img/', 'src/', 'page.html', 'README.md'])

  // README.md: 읽기 모드, 상대 경로 그림은 wt-file로 읽힌다
  await overlay.locator('.files-row', { hasText: 'README.md' }).hover()
  const read = overlay.locator('.fv-read')
  await expect(read.locator('h1')).toHaveText('알파 문서')
  const img = read.locator('img')
  await expect(img).toHaveAttribute('src', /^wt-file:\/\/[0-9a-f]+\/img\/logo\.svg$/)
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(40)
  await win.screenshot({ path: test.info().outputPath('markdown.png') })

  // 원문 보기 (Tab) → 다시 읽기 모드
  await input.focus()
  await win.keyboard.press('Tab')
  await expect(overlay.locator('.cm-content')).toContainText('# 알파 문서')
  await expect(overlay.locator('.cm-lineNumbers')).toContainText('2')
  await win.keyboard.press('Tab')
  await expect(read.locator('h1')).toBeVisible()

  // 문서 안의 상대 경로 링크는 앱 안에서 그 파일을 연다. 버튼·링크를 눌러도 포커스는 찾기 칸으로
  await read.getByText('가이드 보기').click()
  await expect(overlay.locator('.fv-path')).toHaveText('docs/guide.md')
  await expect(overlay.locator('.fv-read h1')).toHaveText('가이드')
  await expect(input).toBeFocused()

  // 이름으로 찾기 → html 미리 보기: 스크립트가 돈다
  await input.fill('page')
  await expect(overlay.locator('.files-row.on .files-name')).toHaveText('page.html')
  const frame = overlay.frameLocator('iframe.fv-frame')
  await expect(frame.locator('#t')).toHaveText('scripted')
  await win.screenshot({ path: test.info().outputPath('html.png') })

  // 폴더로 들어가고(Enter) 빈 찾기 칸에서 Backspace로 나온다
  await input.fill('')
  await overlay.locator('.files-row', { hasText: 'src/' }).hover()
  await input.focus()
  await win.keyboard.press('Enter')
  await expect(overlay.locator('.files-crumbs')).toContainText('src')
  await expect(rows).toHaveText(['app.ts'])
  await expect(overlay.locator('.cm-content')).toContainText('export const answer = 42')
  // 문법 색: export는 키워드 색 (포스터 테마 --syn-keyword #5b2bb5)
  await expect
    .poll(() => overlay.locator('.cm-content span', { hasText: /^export$/ }).first().evaluate((el) => getComputedStyle(el).color))
    .toBe('rgb(91, 43, 181)')
  await win.keyboard.press('Backspace')
  await expect(rows.filter({ hasText: /^docs\/$/ })).toHaveCount(1)

  // 파일에서 Enter: 입력창에 @경로를 넣고 닫는다
  await input.fill('app.ts')
  await expect(overlay.locator('.files-row.on .files-name')).toHaveText('app.ts')
  await win.keyboard.press('Enter')
  await expect(overlay).toHaveCount(0)
  await expect(composer).toHaveValue('@src/app.ts ')
  await expect(composer).toBeFocused()

  // /files로도 열고, Esc로 닫는다 (실행 중단으로 가지 않는다)
  await composer.fill('/files')
  await win.keyboard.press('Enter')
  await expect(overlay).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
})

test('wt-file은 열어 준 폴더 밖의 파일을 내주지 않는다', async ({ app, win }) => {
  await win.keyboard.press('Alt+KeyA')
  await win.locator('#composer-input').focus()
  await win.keyboard.press('Control+KeyP')
  await win.locator('.overlay.files .files-row', { hasText: 'README.md' }).hover()
  const src = await win.locator('.fv-read img').getAttribute('src')
  const base = src!.replace(/img\/logo\.svg$/, '')
  const status = (path: string): Promise<number> =>
    app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, base + path)
  expect(await status('README.md')).toBe(200)
  expect(await status('..%2F..%2Fud%2Fsettings.json')).toBe(403)
  // 점 두 개는 주소가 먼저 풀어 폴더 안 경로가 된다: 없는 파일
  expect(await status('%2E%2E/%2E%2E/ud/settings.json')).toBe(404)
  expect(await app.evaluate(async ({ net }) => (await net.fetch('wt-file://0000000000000000/README.md')).status)).toBe(404)
})

test('큰 파일은 나눠 읽고(MORE) 화면에 보이는 줄만 그린다. 큰 md는 원문으로', async ({ env, win }) => {
  const line = 'INFO 2026-10-13 12:00:00 request handled in 12ms path=/api/items?page=1\n'
  writeFileSync(join(env.path('alpha'), 'big.log'), line.repeat(Math.ceil((25 * 1024 * 1024) / line.length)))
  writeFileSync(join(env.path('alpha'), 'big.md'), `# 큰 문서\n\n${'긴 문단이에요. '.repeat(200)}\n\n`.repeat(700))
  await win.keyboard.press('Alt+KeyA')
  await win.locator('#composer-input').focus()
  await win.keyboard.press('Control+KeyP')
  const overlay = win.locator('.overlay.files')
  const input = overlay.locator('.search-input')
  await input.fill('big.log')
  await expect(overlay.locator('.files-row.on .files-name')).toHaveText('big.log')
  const meta = overlay.locator('.fv-meta')
  await expect(meta).toHaveText(/^TEXT · 4\.0 MB \/ 25\.0 MB$/)
  await expect(overlay.locator('.cm-content')).toContainText('request handled')
  // CodeMirror는 보이는 줄만 그린다
  expect(await overlay.locator('.cm-line').count()).toBeLessThan(300)
  const moreBtn = overlay.locator('.fv-head .btn', { hasText: /^(MORE|…)$/ })
  await overlay.locator('.btn', { hasText: 'MORE' }).click()
  await expect(meta).toHaveText(/^TEXT · 8\.0 MB \/ 25\.0 MB$/)
  // 끝까지 읽으면 MORE가 사라진다
  for (let i = 0; i < 6 && (await moreBtn.count()); i++) {
    await expect(overlay.locator('.btn', { hasText: 'MORE' })).toBeEnabled()
    await overlay.locator('.btn', { hasText: 'MORE' }).click()
    await expect(overlay.locator('.btn', { hasText: '…' })).toHaveCount(0)
  }
  await expect(moreBtn).toHaveCount(0)
  await expect(meta).toHaveText('TEXT · 25.0 MB')
  await win.screenshot({ path: test.info().outputPath('big.png') })

  // 2MB 넘는 md는 읽기 모드 대신 원문
  await input.fill('big.md')
  await expect(overlay.locator('.files-row.on .files-name')).toHaveText('big.md')
  await expect(overlay.locator('.fv-bar')).toContainText('원문으로')
  await expect(overlay.locator('.cm-content')).toContainText('# 큰 문서')
  await expect(overlay.locator('.btn', { hasText: 'SOURCE' })).toHaveCount(0)
})

test('md의 외부 그림은 막아 두었다가 누르면 앱이 받아 와서 보인다', async ({ env, win }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    if (req.url === '/dot.png') res.writeHead(200, { 'content-type': 'image/png' }).end(png)
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<p>not an image</p>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    writeFileSync(join(env.path('alpha'), 'remote.md'), `# 외부 그림\n\n![점](http://127.0.0.1:${port}/dot.png)\n\n![가짜](http://127.0.0.1:${port}/page)\n`)
    await win.keyboard.press('Alt+KeyA')
    await win.locator('#composer-input').focus()
    await win.keyboard.press('Control+KeyP')
    const overlay = win.locator('.overlay.files')
    await overlay.locator('.search-input').fill('remote.md')
    await expect(overlay.locator('.files-row.on .files-name')).toHaveText('remote.md')
    // 처음에는 자리만, 요청도 가지 않는다
    await expect(overlay.locator('.md-remote')).toHaveCount(2)
    await expect(overlay.locator('.fv-bar')).toContainText('외부 그림 2개를 막아 두었어요')
    expect(hits).toBe(0)
    await overlay.locator('.btn', { hasText: 'LOAD REMOTE IMAGES' }).click()
    const img = overlay.locator('.fv-read img')
    await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
    // 그림이 아닌 주소는 자리 그대로
    await expect(overlay.locator('.md-remote')).toHaveCount(1)
    await expect(overlay.locator('.fv-bar')).toContainText('1개는 그림이 아니거나 받지 못했어요')
    await win.screenshot({ path: test.info().outputPath('remote.png') })
  } finally {
    server.close()
  }
})

test('git 프로젝트의 한글 이름 파일·폴더도 찾고, 둘러보고, 읽는다', async ({ win }) => {
  await win.keyboard.press('Alt+KeyA')
  const composer = win.locator('#composer-input')
  await composer.focus()
  await win.keyboard.press('Control+KeyP')
  const overlay = win.locator('.overlay.files')
  const input = overlay.locator('.search-input')
  const rows = overlay.locator('.files-row:not(.up) .files-name')
  // 둘러보기: 한글 폴더가 이스케이프 없이 보인다
  await expect(rows.filter({ hasText: /^문서\/$/ })).toHaveCount(1)
  await overlay.locator('.files-row', { hasText: '문서/' }).click()
  await expect(overlay.locator('.files-crumbs')).toContainText('문서')
  await expect(rows).toHaveText(['기획서 초안.md'])
  await expect(overlay.locator('.fv-read h1')).toHaveText('안녕하세요')
  // 이름으로 찾기
  await input.fill('')
  await win.keyboard.press('Backspace')
  await input.fill('기획')
  await expect(overlay.locator('.files-row.on .files-name')).toHaveText('기획서 초안.md')
  await expect(overlay.locator('.files-row.on .files-dir')).toHaveText('문서/')
  await expect(overlay.locator('.fv-path')).toHaveText('문서/기획서 초안.md')
  await expect(overlay.locator('.fv-read')).toContainText('한글 이름 파일이에요.')
  await win.keyboard.press('Enter')
  await expect(composer).toHaveValue('@문서/기획서 초안.md ')
})

test('원문의 찾기 칸에서 Esc는 찾기만 닫고 실행을 멈추지 않는다', async ({ app, win }) => {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { interrupted: number }
    g.interrupted = 0
    ipcMain.removeHandler('agent:interrupt')
    ipcMain.handle('agent:interrupt', () => void g.interrupted++)
  })
  await win.keyboard.press('Alt+KeyA')
  await win.keyboard.press('Control+p')
  const overlay = win.locator('.overlay.files')
  await win.keyboard.type('app.ts')
  await expect(overlay.locator('.cm-content')).toContainText('export const answer = 42')
  await overlay.locator('.cm-content').click()
  await win.keyboard.press('Control+f')
  const find = overlay.locator('.cm-search input[name="search"]')
  await expect(find).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(overlay.locator('.cm-search')).toHaveCount(0)
  expect(await app.evaluate(() => (globalThis as unknown as { interrupted: number }).interrupted)).toBe(0)
})
