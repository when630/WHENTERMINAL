import { spawn as spawnPty, type IPty } from 'node-pty'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalInfo, TerminalShell, TerminalShellOption } from '@shared/types'

// 대화창 아래 터미널 (대화마다 하나). node-pty로 진짜 셸을 띄워 색·커서·대화형 입력(로그인·비밀번호·vim)이 그대로 된다.
// 셸은 앱이 끝날 때까지 산다. 탭을 옮겨도 살아 있고, 대화·프로젝트를 닫거나 작업 공간을 버리면 끝낸다

const isWin = process.platform === 'win32'

// 셸 찾기 결과 (실행 파일 경로·WSL 배포판 유무). 처음 한 번만 찾는다
const lookups = new Map<string, string | null>()
type Probe = [file: string, args: string[], parse: (out: string) => string | null]

const firstLine = (out: string): string | null => out.split(/\r?\n/).find(Boolean)?.trim() ?? null
const pathProbe = (exe: string): Probe => [isWin ? 'where' : 'which', [exe], firstLine]
// 배포판은 HKCU\…\Lxss 아래 하위 키로 있다 (wsl.exe -l은 서비스를 깨우느라 느릴 수 있고, 배포판이 없으면 설치 안내를 띄운다)
const WSL_PROBE: Probe = ['reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'], (out) => (/\\Lxss\\\{/i.test(out) ? 'wsl.exe' : null)]

function lookupSync(key: string, [file, args, parse]: Probe): string | null {
  if (!lookups.has(key)) {
    try {
      lookups.set(key, parse(execFileSync(file, args, { encoding: 'utf8', timeout: 3000, windowsHide: true })))
    } catch {
      lookups.set(key, null)
    }
  }
  return lookups.get(key)!
}

function lookup(key: string, [file, args, parse]: Probe): Promise<void> {
  if (lookups.has(key)) return Promise.resolve()
  return new Promise((resolve) =>
    execFile(file, args, { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, out) => {
      lookups.set(key, err ? null : parse(out))
      resolve()
    }),
  )
}

const onPath = (exe: string): string | null => lookupSync(exe, pathProbe(exe))
const hasWslDistro = (): boolean => isWin && !!lookupSync('wsl', WSL_PROBE)

function gitBash(): string | null {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    const p = base && join(base, 'Git', 'bin', 'bash.exe')
    if (p && existsSync(p)) return p
  }
  return null
}

interface ShellSpec {
  id: TerminalShell
  file: string
  args: string[]
  label: string
}

/** 고른 셸의 실행 파일. 없으면 null */
function find(choice: TerminalShell): ShellSpec | null {
  if (isWin) {
    switch (choice) {
      case 'pwsh': {
        const pwsh = onPath('pwsh.exe')
        return pwsh ? { id: 'pwsh', file: pwsh, args: ['-NoLogo'], label: 'pwsh' } : null
      }
      case 'powershell':
        return { id: 'powershell', file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
      case 'gitbash': {
        const bash = gitBash()
        return bash ? { id: 'gitbash', file: bash, args: ['--login', '-i'], label: 'Git Bash' } : null
      }
      case 'cmd':
        return { id: 'cmd', file: 'cmd.exe', args: [], label: 'cmd' }
      case 'wsl':
        // 인자 없이 띄우면 지금 폴더(/mnt/c/…)에서 시작한다
        return hasWslDistro() ? { id: 'wsl', file: 'wsl.exe', args: [], label: 'WSL' } : null
      default:
        return null
    }
  }
  if (choice === 'zsh' || choice === 'bash' || choice === 'fish') {
    const file = onPath(choice)
    return file ? { id: choice, file, args: ['-l'], label: choice } : null
  }
  return null
}

function loginShell(): ShellSpec {
  if (isWin) return find('pwsh') ?? find('powershell')!
  const sh = process.env.SHELL || '/bin/zsh'
  const name = sh.split('/').pop() ?? sh
  const id: TerminalShell = name === 'bash' || name === 'zsh' || name === 'fish' ? name : 'auto'
  return { id, file: sh, args: ['-l'], label: name }
}

/** 설정의 셸 → 실행 파일·인자·표시 이름. 고른 셸이 없으면 기본 셸로 */
export function resolveShell(choice: TerminalShell): ShellSpec {
  return (choice !== 'auto' && find(choice)) || loginShell()
}

const CANDIDATES: TerminalShell[] = isWin ? ['pwsh', 'powershell', 'gitbash', 'cmd', 'wsl'] : ['zsh', 'bash', 'fish']
const LABELS: Record<TerminalShell, string> = { auto: 'AUTO', pwsh: 'PWSH', powershell: 'POWERSHELL', gitbash: 'GIT BASH', cmd: 'CMD', wsl: 'WSL', zsh: 'ZSH', bash: 'BASH', fish: 'FISH' }

/** 이 컴퓨터에 있는 셸. 찾기는 메인 스레드를 막지 않게 한꺼번에 돌려 둔다 */
export async function availableShells(): Promise<TerminalShellOption[]> {
  await Promise.all(isWin ? [lookup('pwsh.exe', pathProbe('pwsh.exe')), lookup('wsl', WSL_PROBE)] : ['zsh', 'bash', 'fish'].map((exe) => lookup(exe, pathProbe(exe))))
  const auto = loginShell()
  const found = CANDIDATES.map(find).filter((s): s is ShellSpec => !!s)
  return [
    { id: 'auto', kind: auto.id, label: LABELS.auto, note: isWin ? `pwsh가 있으면 pwsh, 없으면 Windows PowerShell (지금은 ${auto.label})` : `로그인 셸 ($SHELL: ${auto.file})` },
    ...found.map((s) => ({ id: s.id, kind: s.id, label: LABELS[s.id], note: s.file })),
  ]
}

/** 다시 붙였을 때 보여 줄 출력 (렌더러가 화면을 새로 만든 경우) */
const SCROLLBACK = 200_000

interface Term {
  pty: IPty
  info: TerminalInfo
  conversationId: string
  buffer: string
  /** 앱이 끝낸 셸 (셸을 바꿀 때 등): 남은 출력·종료를 렌더러에 보내지 않는다 */
  closed?: boolean
}

/** 터미널은 termId로 구분한다. 대화마다 여러 개 (렌더러가 `대화 ID#번호`로 만든다) */
export class TerminalManager {
  private terms = new Map<string, Term>()

  constructor(
    private readonly onData: (termId: string, data: string) => void,
    private readonly onExit: (termId: string, code: number) => void,
    private readonly shell: () => TerminalShell,
  ) {}

  /** 살아 있으면 그대로, 없으면 새로 띄운다. 지금까지의 출력을 함께 돌려준다. shell을 주면 그 셸 (다른 셸이 떠 있으면 끝내고 새로) */
  open(termId: string, conversationId: string, cwd: string, cols: number, rows: number, shell?: TerminalShell): TerminalInfo & { buffer: string } {
    const sh = resolveShell(shell ?? this.shell())
    const live = this.terms.get(termId)
    if (live && (!shell || live.info.kind === sh.id)) {
      this.resize(termId, cols, rows)
      return { ...live.info, buffer: live.buffer }
    }
    if (live) this.close(termId)
    // 사용자의 평소 셸이라 환경 변수는 그대로 넘긴다 (구독 전용 정리는 Claude CLI에만 해당)
    const env = { ...process.env, TERM_PROGRAM: 'WHENTERMINAL', COLORTERM: 'truecolor' } as Record<string, string>
    const p = spawnPty(sh.file, sh.args, { name: 'xterm-256color', cols: Math.max(cols, 20), rows: Math.max(rows, 4), cwd: existsSync(cwd) ? cwd : process.cwd(), env, useConpty: true })
    const term: Term = { pty: p, info: { shell: sh.label, kind: sh.id, cwd, pid: p.pid }, conversationId, buffer: '' }
    this.terms.set(termId, term)
    p.onData((d) => {
      if (term.closed) return
      term.buffer = (term.buffer + d).slice(-SCROLLBACK)
      this.onData(termId, d)
    })
    p.onExit(({ exitCode }) => {
      if (this.terms.get(termId) === term) this.terms.delete(termId)
      if (!term.closed) this.onExit(termId, exitCode)
    })
    return { ...term.info, buffer: '' }
  }

  write(termId: string, data: string): void {
    this.terms.get(termId)?.pty.write(data)
  }

  resize(termId: string, cols: number, rows: number): void {
    const t = this.terms.get(termId)
    if (!t || cols < 2 || rows < 2) return
    try {
      t.pty.resize(cols, rows)
    } catch {
      // 막 끝난 셸
    }
  }

  /** 이 대화의 터미널을 모두 끝낸다 (대화·프로젝트 닫기, 작업 공간 버리기 전) */
  closeConversation(conversationId: string): void {
    for (const [id, t] of [...this.terms]) if (t.conversationId === conversationId) this.close(id)
  }

  /** 셸을 끝낸다 (대화 닫기·작업 공간 버리기 전에도: Windows에서는 셸이 폴더를 잡고 있으면 지울 수 없다) */
  close(termId: string): void {
    const t = this.terms.get(termId)
    if (!t) return
    this.terms.delete(termId)
    t.closed = true
    // Windows: node-pty의 kill은 셸의 자식 프로세스 정리를 비동기로 미룬다. 앱을 끝내는 중이면 그 정리가 돌지 못해
    // 셸·conhost가 남고, 출력 읽기 스레드가 끝나지 않아 앱 종료가 멈춘다. 셸 프로세스 트리를 먼저 바로 끝낸다
    if (isWin) {
      try {
        execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(t.pty.pid)], { timeout: 3000, windowsHide: true, stdio: 'ignore' })
      } catch {
        // 이미 끝났다
      }
    }
    try {
      t.pty.kill()
    } catch {
      // 이미 끝났다
    }
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id)
  }
}
