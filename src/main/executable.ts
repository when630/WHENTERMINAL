import { app } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

let cached: string | undefined | null = null

/**
 * 패키징한 앱에서 SDK가 띄울 Claude Code 실행 파일 경로.
 * SDK는 운영체제별 패키지(@anthropic-ai/claude-agent-sdk-<os>-<arch>)의 네이티브 바이너리를 쓰는데,
 * app.asar 안의 파일은 실행할 수 없으므로 빌드 때 풀어 둔 app.asar.unpacked 쪽 경로를 넘긴다.
 * 개발 실행에서는 undefined (SDK 기본 동작)
 */
export function claudeExecutable(): string | undefined {
  if (cached !== null) return cached
  cached = undefined
  if (!app.isPackaged) return cached
  cached = bundledBinary()
  return cached
}

/** SDK가 번들한 운영체제별 Claude Code 바이너리 (개발 실행에서도). 없으면 undefined */
function bundledBinary(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const bin = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude')
    return bin.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  } catch (err) {
    console.error('Claude Code 실행 파일을 찾지 못함', err)
    return undefined
  }
}

/** 터미널에서 로그인(claude auth login)할 때 칠 명령. 번들 바이너리가 있으면 그 경로로, 없으면 PATH의 claude */
export function loginCommand(): string {
  const bin = bundledBinary()
  const exe = bin ? (/\s/.test(bin) ? `"${bin}"` : bin) : 'claude'
  // PowerShell은 경로를 따옴표로 감싸면 & 가 필요하다
  const prefix = process.platform === 'win32' && exe.startsWith('"') ? '& ' : ''
  return `${prefix}${exe} auth login`
}
