import { app, net, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'

// 자동 업데이트: GitHub 릴리즈(공개 저장소)를 본다.
// - Windows 설치판(NSIS): electron-updater가 latest.yml을 읽어 백그라운드로 받고, 재시작(또는 종료) 때 설치
// - 그 밖(Windows zip, macOS 임시 서명): 스스로 바꿀 수 없으므로 새 릴리즈만 알아채고 릴리즈 페이지로 안내.
//   macOS는 Squirrel.Mac이 서명을 검증하는데 임시 서명은 빌드마다 달라져 설치가 막힌다

const REPO = 'when630/WHENTERMINAL'
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** NSIS로 설치한 앱에만 제거 프로그램이 실행 파일 옆에 있다 (zip을 푼 앱에는 없음) */
function isNsisInstall(): boolean {
  return app.isPackaged && process.platform === 'win32' && existsSync(join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`))
}

/** '0.10.0' > '0.9.1'. 숫자 부분만 비교한다 (릴리즈는 v0.3.0 같은 정식 버전만 낸다) */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const b = current.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

export class Updater {
  private state: UpdateState
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly autoUpdater = electronUpdater.autoUpdater

  constructor(
    private readonly emit: (state: UpdateState) => void,
    /** 설치하려고 앱을 끝내기 직전. 창 닫기를 트레이 숨김으로 막는 것을 풀어야 한다 */
    private readonly beforeInstall: () => void,
  ) {
    this.state = { status: 'idle', current: app.getVersion(), autoInstall: isNsisInstall() }
    if (this.state.autoInstall) this.wireAutoUpdater()
  }

  get(): UpdateState {
    return this.state
  }

  /** 패키징한 앱에서만 주기적으로 확인한다 (개발 실행은 설정의 CHECK로만) */
  start(): void {
    if (!app.isPackaged) return
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async check(): Promise<UpdateState> {
    // 받는 중이거나 받아 둔 업데이트가 있으면 다시 확인하지 않는다
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return this.state
    this.set({ status: 'checking', error: undefined })
    try {
      if (this.state.autoInstall) await this.autoUpdater.checkForUpdates()
      else await this.checkRelease()
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return this.state
  }

  /** 받아 둔 업데이트가 있으면 앱을 끝내고 설치한 뒤 다시 켠다. 없으면 릴리즈 페이지를 연다 */
  apply(): void {
    if (this.state.status === 'ready') {
      this.beforeInstall()
      // 조용히 설치하고(설치 마법사 없이) 끝나면 다시 실행
      this.autoUpdater.quitAndInstall(true, true)
      return
    }
    void shell.openExternal(this.state.url ?? `https://github.com/${REPO}/releases/latest`)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch, checkedAt: patch.status === 'checking' ? this.state.checkedAt : Date.now() }
    this.emit(this.state)
  }

  private async checkRelease(): Promise<void> {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WHENTERMINAL' },
    })
    if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`)
    const rel = (await res.json()) as { tag_name: string; html_url: string }
    const latest = rel.tag_name.replace(/^v/, '')
    if (isNewer(latest, this.state.current)) this.set({ status: 'available', latest, url: rel.html_url })
    else this.set({ status: 'latest', latest })
  }

  private wireAutoUpdater(): void {
    const u = this.autoUpdater
    u.autoDownload = true
    u.autoInstallOnAppQuit = true
    u.logger = null
    u.on('update-available', (info) =>
      this.set({ status: 'downloading', latest: info.version, percent: 0, url: `https://github.com/${REPO}/releases/tag/v${info.version}` }),
    )
    u.on('update-not-available', (info) => this.set({ status: 'latest', latest: info.version }))
    u.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }))
    u.on('update-downloaded', (info) => this.set({ status: 'ready', latest: info.version, percent: 100 }))
    u.on('error', (err) => this.set({ status: 'error', error: err?.message ?? String(err) }))
  }
}
