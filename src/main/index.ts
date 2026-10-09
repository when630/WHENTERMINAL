import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type AgentEventEnvelope, type AgentMode, type PermissionDecision, type RateLimitInfo } from '@shared/types'
import { ProjectStore } from './store'
import { AgentManager } from './agent/manager'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isMac = process.platform === 'darwin'
// 앞에서부터 등록을 시도. Ctrl+Space는 한글 IME 등이 선점하고 있으면 실패한다 (OPEN-005)
// Windows PC에서는 Control+Space / Control+Alt+Space / Alt+Space가 다른 앱에 선점되어 있음 (2026-10-09 확인)
// macOS는 Control+Space(입력 소스 전환)를 가로채도 등록이 성공해 버리므로 아예 후보에서 뺀다.
// Control+Option+Space는 '다음 입력 소스', Cmd+Space는 Spotlight 기본값
const GLOBAL_HOTKEYS = isMac ? ['Control+Shift+Space', 'Alt+Shift+Space'] : ['Control+Space', 'Control+Shift+Space']
let activeHotkey: string | null = null

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap)
}

function bootstrap(): void {
  const store = new ProjectStore()
  const send = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const manager = new AgentManager(
    store,
    (e: AgentEventEnvelope) => send(IPC.event, e),
    (info: RateLimitInfo) => send(IPC.rateLimit, info),
  )
  const projectsChanged = (): void => send(IPC.projectsChanged, store.list())

  ipcMain.handle(IPC.getHotkey, () => activeHotkey?.replace('Control', 'Ctrl') ?? null)
  ipcMain.handle(IPC.listProjects, () => store.list())
  ipcMain.handle(IPC.addProject, async () => {
    const res = await dialog.showOpenDialog(win!, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const project = store.addProject(res.filePaths[0])
    projectsChanged()
    return project
  })
  ipcMain.handle(IPC.removeProject, (_e, projectId: string) => {
    manager.disposeProject(projectId)
    store.removeProject(projectId)
    projectsChanged()
  })
  ipcMain.handle(IPC.addConversation, (_e, projectId: string) => {
    const conv = store.addConversation(projectId)
    projectsChanged()
    return conv
  })
  ipcMain.handle(IPC.startTask, (_e, projectId: string, text: string) => {
    const conv = store.conversationForTask(projectId, text, (c) => !manager.hasSession(c.id))
    projectsChanged()
    manager.send(projectId, conv.id, text)
    return conv.id
  })
  ipcMain.handle(IPC.send,(_e, projectId: string, conversationId: string, text: string) =>
    manager.send(projectId, conversationId, text),
  )
  ipcMain.handle(IPC.interrupt, (_e, projectId: string, conversationId: string) => manager.interrupt(projectId, conversationId))
  ipcMain.handle(IPC.setMode, async (_e, projectId: string, conversationId: string, mode: AgentMode) => {
    await manager.setMode(projectId, conversationId, mode)
    projectsChanged()
  })
  ipcMain.handle(IPC.compact, (_e, projectId: string, conversationId: string, instructions?: string) =>
    manager.compact(projectId, conversationId, instructions),
  )
  ipcMain.handle(IPC.clear, (_e, projectId: string, conversationId: string) => manager.clear(projectId, conversationId))
  ipcMain.handle(
    IPC.respondPermission,
    (_e, _projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) =>
      manager.respondPermission(conversationId, requestId, decision),
  )

  // Windows: 기본 메뉴의 Alt 니모닉(Alt+F 파일, Alt+H 도움말 …)이 Alt+홈 줄 프로젝트 이동과 겹치므로 메뉴를 없앤다.
  // 메뉴가 없어도 입력창의 복사·붙여넣기는 그대로 동작한다.
  // macOS: 메뉴 막대는 창과 별개라 니모닉이 없고, Edit 메뉴가 없으면 Cmd+C/V/A/Z가 동작하지 않으므로 최소 메뉴를 둔다.
  // 메뉴 단축키는 모두 Cmd 기반이라 앱의 Ctrl/Alt 단축키와 겹치지 않는다
  Menu.setApplicationMenu(isMac ? buildMacMenu() : null)
  createWindow()
  createTray()

  activeHotkey = GLOBAL_HOTKEYS.find((key) => globalShortcut.register(key, toggleWindow)) ?? null
  if (activeHotkey !== GLOBAL_HOTKEYS[0]) console.warn(`global hotkey ${GLOBAL_HOTKEYS[0]} unavailable; using ${activeHotkey ?? 'none'}`)

  app.on('before-quit', () => {
    quitting = true
    manager.disposeAll()
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  // 상주형: 창을 닫아도 트레이에 남는다
  app.on('window-all-closed', () => {})
  // macOS: Dock 아이콘을 누르면 숨긴 창을 다시 연다
  app.on('activate', showWindow)
}

/** macOS 메뉴 막대. Cmd+W는 창 닫기(=숨기기), Cmd+Q는 종료 */
function buildMacMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu', label: app.name },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
  if (process.env.ELECTRON_RENDERER_URL) {
    template.splice(2, 0, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] })
  }
  return Menu.buildFromTemplate(template)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'WHENTERMINAL',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer gone]', details.reason))
  if (process.env.ELECTRON_RENDERER_URL) {
    // 개발 중에는 렌더러 콘솔 경고/오류를 터미널로 넘겨 본다
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
    })
    // 기본 메뉴를 없앴으므로 개발용 단축키만 직접 붙인다 (F키 없는 40% 배열 기준)
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !input.control || !input.shift) return
      if (input.code === 'KeyI') { win?.webContents.toggleDevTools(); e.preventDefault() }
      if (input.code === 'KeyR') { win?.webContents.reload(); e.preventDefault() }
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray(): void {
  tray = new Tray(makeTrayIcon())
  tray.setToolTip('WHENTERMINAL')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '열기', click: showWindow },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]),
  )
  tray.on('click', showWindow)
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

const TRAY_PROMPT = new Set(['4,4', '5,5', '6,6', '7,7', '6,8', '5,9', '4,10', '5,4', '6,5', '7,6', '8,7', '7,8', '6,9', '5,10'])
const isPromptPixel = (x: number, y: number): boolean => TRAY_PROMPT.has(`${x},${y}`) || (y === 11 && x >= 9 && x <= 12)

/** 16x16 트레이 아이콘을 코드로 그린다 (리소스 파일 없이). 둥근 사각형 + 프롬프트 기호 '>' */
function makeTrayIcon(): Electron.NativeImage {
  if (isMac) return makeMacTrayIcon()
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const corner = (x === 0 || x === size - 1) && (y === 0 || y === size - 1)
      if (corner) continue
      const fg = isPromptPixel(x, y)
      // BGRA
      buf[i] = fg ? 0xff : 0xe0
      buf[i + 1] = fg ? 0xff : 0x8a
      buf[i + 2] = fg ? 0xff : 0x3b
      buf[i + 3] = 0xff
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/**
 * macOS 메뉴 막대용 템플릿 이미지: 검정 + 투명만 쓰면 OS가 밝은/어두운 메뉴 막대에 맞춰 색을 입힌다.
 * Retina에서 흐리지 않게 16pt를 2배(32px)로 그리고, 프롬프트 기호 '>_'만 남긴다
 */
function makeMacTrayIcon(): Electron.NativeImage {
  const scale = 2
  const size = 16 * scale
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isPromptPixel(Math.floor(x / scale), Math.floor(y / scale))) continue
      buf[(y * size + x) * 4 + 3] = 0xff // BGRA: 검정 + 불투명
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: scale })
  img.setTemplateImage(true)
  return img
}
