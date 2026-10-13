import { app, session, shell, type BrowserWindow, type WebContents } from 'electron'
import { ARTIFACT_PARTITION, IPC, type GuestKey } from '@shared/types'

// 앱 안에서 보는 claude.ai 아티팩트 (<webview>, Chat의 ARTIFACT 화면).
// claude.ai는 frame-ancestors 'self'라 iframe에는 안 뜨고, webview는 독립된 최상위 페이지라 뜬다.
// 비공개 아티팩트는 claude.ai 로그인 쿠키가 있어야 보이므로 따로 저장되는 세션(persist:claude)에서 한 번 로그인해 둔다.
// 손님 페이지에는 앱 기능(preload·node)을 붙이지 않는다

const CLAUDE_HOST = /^(?:[\w-]+\.)*(?:claude\.ai|anthropic\.com)$/
// 구글로 로그인: 이 세션 안에서 끝나야 쿠키가 남는다 (크롬으로 내보내면 claude.ai가 로그인 오류를 낸다)
const AUTH_HOST = /^accounts\.google\.com$/

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.hostname : null
  } catch {
    return null
  }
}

function isClaudeUrl(url: string): boolean {
  const host = hostOf(url)
  return !!host && CLAUDE_HOST.test(host)
}

/** 손님 페이지 안에서 열어도 되는 주소: claude.ai와 로그인 */
function staysInside(url: string): boolean {
  const host = hostOf(url)
  return !!host && (CLAUDE_HOST.test(host) || AUTH_HOST.test(host))
}

function openOutside(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

/**
 * 손님 페이지에서 Ctrl·Alt·⌘이 붙은 키는 앱 단축키로 넘긴다 (포커스가 webview에 있으면 앱 창에 키가 오지 않는다).
 * 글 편집·찾기 키는 페이지가 그대로 받는다
 */
const GUEST_OWN = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyF'])

function forwardsKey(input: Electron.Input): boolean {
  if (!input.control && !input.alt && !input.meta) return false
  if ((input.control || input.meta) && !input.alt && GUEST_OWN.has(input.code)) return false
  return true
}

/** 앱 준비 뒤 한 번: webview를 붙일 때 설정을 강제하고 손님 페이지를 다룬다 */
export function setupArtifactView(getWin: () => BrowserWindow | null, toggleFullscreen: () => void): void {
  // 손님 세션의 권한 요청(카메라·위치 등)은 거절. 복사·전체 화면만
  const ses = session.fromPartition(ARTIFACT_PARTITION)
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
  })
  // 구글은 앱 이름·Electron이 들어간 브라우저의 로그인을 막으므로 크롬과 같은 이름으로
  ses.setUserAgent(app.userAgentFallback.replace(/ (?:Electron|WHENTERMINAL|whenterminal)\/\S+/g, ''))

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e, prefs, params) => {
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.nodeIntegrationInSubFrames = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      if (params.partition !== ARTIFACT_PARTITION || !isClaudeUrl(params.src)) e.preventDefault()
    })
    contents.on('did-attach-webview', (_e, guest) => wireGuest(guest, getWin, toggleFullscreen))
  })
}

/** 새 창·이동: claude.ai·로그인은 이 세션 안에서(로그인 팝업은 작은 창), 나머지는 외부 브라우저로 */
function keepInside(contents: WebContents, getWin: () => BrowserWindow | null): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (!staysInside(url)) {
      openOutside(url)
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 700,
        autoHideMenuBar: true,
        parent: getWin() ?? undefined,
        webPreferences: { partition: ARTIFACT_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
      },
    }
  })
  contents.on('did-create-window', (child) => {
    child.setMenu(null)
    keepInside(child.webContents, getWin)
  })
  contents.on('will-navigate', (e, url) => {
    if (staysInside(url)) return
    e.preventDefault()
    openOutside(url)
  })
}

function wireGuest(guest: WebContents, getWin: () => BrowserWindow | null, toggleFullscreen: () => void): void {
  keepInside(guest, getWin)
  guest.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11' && !input.control && !input.alt && !input.shift && !input.meta) {
      toggleFullscreen()
      e.preventDefault()
      return
    }
    if (!forwardsKey(input)) return
    const win = getWin()
    if (!win) return
    e.preventDefault()
    const key: GuestKey = { key: input.key, code: input.code, ctrl: input.control, alt: input.alt, shift: input.shift, meta: input.meta }
    win.webContents.send(IPC.guestKey, key)
  })
}
