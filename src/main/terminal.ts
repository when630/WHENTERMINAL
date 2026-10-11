import { spawn as spawnPty, type IPty } from 'node-pty'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalInfo, TerminalShell } from '@shared/types'

// 대화창 아래 터미널 (대화마다 하나). node-pty로 진짜 셸을 띄워 색·커서·대화형 입력(로그인·비밀번호·vim)이 그대로 된다.
// 셸은 앱이 끝날 때까지 산다. 탭을 옮겨도 살아 있고, 대화·프로젝트를 닫거나 작업 공간을 버리면 끝낸다

const isWin = process.platform === 'win32'

function onPath(exe: string): string | null {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [exe], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    return out.split(/\r?\n/).find(Boolean)?.trim() ?? null
  } catch {
    return null
  }
}

function gitBash(): string | null {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    const p = base && join(base, 'Git', 'bin', 'bash.exe')
    if (p && existsSync(p)) return p
  }
  return null
}

/** 설정의 셸 → 실행 파일·인자·표시 이름. 고른 셸이 없으면 기본 셸로 */
export function resolveShell(choice: TerminalShell): { file: string; args: string[]; label: string } {
  if (isWin) {
    if (choice === 'gitbash') {
      const bash = gitBash()
      if (bash) return { file: bash, args: ['--login', '-i'], label: 'Git Bash' }
    }
    if (choice === 'cmd') return { file: 'cmd.exe', args: [], label: 'cmd' }
    if (choice === 'powershell') return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
    const pwsh = onPath('pwsh.exe')
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], label: 'pwsh' }
    return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
  }
  if (choice === 'bash' && onPath('bash')) return { file: 'bash', args: ['-l'], label: 'bash' }
  if (choice === 'zsh' && onPath('zsh')) return { file: 'zsh', args: ['-l'], label: 'zsh' }
  const sh = process.env.SHELL || '/bin/zsh'
  return { file: sh, args: ['-l'], label: sh.split('/').pop() ?? sh }
}

/** 다시 붙였을 때 보여 줄 출력 (렌더러가 화면을 새로 만든 경우) */
const SCROLLBACK = 200_000

interface Term {
  pty: IPty
  info: TerminalInfo
  buffer: string
}

export class TerminalManager {
  private terms = new Map<string, Term>()

  constructor(
    private readonly onData: (conversationId: string, data: string) => void,
    private readonly onExit: (conversationId: string, code: number) => void,
    private readonly shell: () => TerminalShell,
  ) {}

  /** 살아 있으면 그대로, 없으면 새로 띄운다. 지금까지의 출력을 함께 돌려준다 */
  open(conversationId: string, cwd: string, cols: number, rows: number): TerminalInfo & { buffer: string } {
    const live = this.terms.get(conversationId)
    if (live) {
      this.resize(conversationId, cols, rows)
      return { ...live.info, buffer: live.buffer }
    }
    const sh = resolveShell(this.shell())
    // 사용자의 평소 셸이라 환경 변수는 그대로 넘긴다 (구독 전용 정리는 Claude CLI에만 해당)
    const env = { ...process.env, TERM_PROGRAM: 'WHENTERMINAL', COLORTERM: 'truecolor' } as Record<string, string>
    const p = spawnPty(sh.file, sh.args, { name: 'xterm-256color', cols: Math.max(cols, 20), rows: Math.max(rows, 4), cwd: existsSync(cwd) ? cwd : process.cwd(), env, useConpty: true })
    const term: Term = { pty: p, info: { shell: sh.label, cwd, pid: p.pid }, buffer: '' }
    this.terms.set(conversationId, term)
    p.onData((d) => {
      term.buffer = (term.buffer + d).slice(-SCROLLBACK)
      this.onData(conversationId, d)
    })
    p.onExit(({ exitCode }) => {
      if (this.terms.get(conversationId) === term) this.terms.delete(conversationId)
      this.onExit(conversationId, exitCode)
    })
    return { ...term.info, buffer: '' }
  }

  write(conversationId: string, data: string): void {
    this.terms.get(conversationId)?.pty.write(data)
  }

  resize(conversationId: string, cols: number, rows: number): void {
    const t = this.terms.get(conversationId)
    if (!t || cols < 2 || rows < 2) return
    try {
      t.pty.resize(cols, rows)
    } catch {
      // 막 끝난 셸
    }
  }

  isOpen(conversationId: string): boolean {
    return this.terms.has(conversationId)
  }

  /** 셸을 끝낸다 (대화 닫기·작업 공간 버리기 전에도: Windows에서는 셸이 폴더를 잡고 있으면 지울 수 없다) */
  close(conversationId: string): void {
    const t = this.terms.get(conversationId)
    if (!t) return
    this.terms.delete(conversationId)
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
