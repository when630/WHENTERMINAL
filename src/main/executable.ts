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
  try {
    const req = createRequire(import.meta.url)
    const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const bin = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude')
    cached = bin.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  } catch (err) {
    console.error('Claude Code 실행 파일을 찾지 못함', err)
  }
  return cached
}
