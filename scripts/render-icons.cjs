// 앱 아이콘 렌더링: build/icons/*.svg → resources/icons/<이름>.png (1024, 투명 배경)
// 글자가 들어간 아이콘은 Archivo 900으로 그려야 해서 브라우저(Electron 오프스크린 창)로 렌더링한다.
// 실행: npx electron scripts/render-icons.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, readdirSync, writeFileSync, mkdirSync } = require('node:fs')
const { join, basename } = require('node:path')
const { pathToFileURL } = require('node:url')

const root = join(__dirname, '..')
const font = pathToFileURL(join(root, 'node_modules/@fontsource/archivo/files/archivo-latin-900-normal.woff2')).href
const outDir = join(root, 'resources/icons')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  win.webContents.setFrameRate(60)
  for (const file of readdirSync(join(root, 'build/icons')).filter((f) => f.endsWith('.svg'))) {
    const svg = readFileSync(join(root, 'build/icons', file), 'utf8')
    const html = `<!doctype html><html><head><style>
      @font-face { font-family: 'Archivo'; font-weight: 900; src: url('${font}') format('woff2'); }
      html, body { margin: 0; background: transparent; width: 1024px; height: 1024px; overflow: hidden; }
      svg { display: block; width: 1024px; height: 1024px; }
    </style></head><body>${svg}</body></html>`
    const tmp = join(app.getPath('temp'), `wt-icon-${basename(file, '.svg')}.html`)
    writeFileSync(tmp, html)
    await win.loadFile(tmp)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))')
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
    const png = img.resize({ width: 1024, height: 1024 }).toPNG()
    writeFileSync(join(outDir, `${basename(file, '.svg')}.png`), png)
    console.log('rendered', basename(file, '.svg'), img.getSize())
  }
  // 미리보기 시트: 밝은 바탕 큰 크기 + 어두운 Dock 줄 + 작은 크기 (build/icons/preview.png)
  const names = ['wordmark', 'prompt', 'keycap', 'bands', 'question', 'slots']
  const label = { wordmark: '01 WT_', prompt: '02 프롬프트', keycap: '03 키캡 A', bands: '04 진행 띠', question: '05 물음표', slots: '06 슬롯 9칸' }
  const src = (n) => pathToFileURL(join(outDir, `${n}.png`)).href
  const sheet = new BrowserWindow({ width: 1560, height: 610, show: false, webPreferences: { offscreen: true } })
  const html = `<!doctype html><html><head><style>
    @font-face { font-family: 'Archivo'; font-weight: 900; src: url('${font}') format('woff2'); }
    body { margin: 0; width: 1560px; height: 610px; background: #fff; font: 700 18px/1.2 -apple-system, 'Apple SD Gothic Neo', sans-serif; color: #0a0a0a; }
    .row { display: flex; } .cell { width: 260px; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 26px 0 18px; border-right: 2px solid #0a0a0a; }
    .cell:last-child { border-right: 0; } .big { width: 200px; height: 200px; filter: drop-shadow(0 8px 12px rgba(0,0,0,.2)); }
    .sizes { display: flex; align-items: flex-end; gap: 14px; height: 70px; }
    .dock { display: flex; justify-content: center; gap: 40px; padding: 26px 0; margin: 0 40px; background: #2a2a2c; border-radius: 28px; }
    .dock img { width: 96px; height: 96px; } h1 { margin: 0; padding: 22px 30px 14px; font: 900 30px/1 'Archivo', sans-serif; border-bottom: 6px solid #0a0a0a; }
  </style></head><body><h1>WHENTERMINAL · APP ICONS</h1><div class="row">${names
    .map((n) => `<div class="cell"><img class="big" src="${src(n)}"><div class="sizes"><img src="${src(n)}" width="64"><img src="${src(n)}" width="32"><img src="${src(n)}" width="16"></div><div>${label[n]}</div></div>`)
    .join('')}</div><div class="dock">${names.map((n) => `<img src="${src(n)}">`).join('')}</div></body></html>`
  const tmp = join(app.getPath('temp'), 'wt-icon-sheet.html')
  writeFileSync(tmp, html)
  await sheet.loadFile(tmp)
  await sheet.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode()))).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))')
  writeFileSync(join(root, 'build/icons/preview.png'), (await sheet.webContents.capturePage()).toPNG())
  console.log('preview sheet written')
  app.quit()
})
