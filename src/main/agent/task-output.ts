import { open, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TaskOutput } from '@shared/types'

// 백그라운드 셸·모니터의 출력은 CLI가 <임시 폴더>/claude…/<프로젝트>/<세션 ID>/tasks/<작업 ID>.output에 쓴다.
// SDK는 끝날 때(task_notification.output_file)만 경로를 알려 주므로, 도는 중에는 같은 세션의 폴더를 찾아 읽는다

const TAIL_BYTES = 64 * 1024

/** 세션 ID → 그 세션의 tasks 폴더 */
const taskDirs = new Map<string, string>()

/** 도구 결과·task_notification에서 알게 된 출력 파일 경로를 기억해 같은 세션의 다른 작업도 바로 찾게 한다 */
export function rememberTaskOutput(sessionId: string, file: string): void {
  taskDirs.set(sessionId, dirname(file))
}

/** 백그라운드 Bash 도구 결과의 'Output is being written to: …' */
export function outputPathIn(text: string): string | undefined {
  return /Output is being written to: (.+?\.output)/.exec(text)?.[1]
}

async function exists(file: string): Promise<boolean> {
  try {
    await (await open(file, 'r')).close()
    return true
  } catch {
    return false
  }
}

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

async function find(sessionId: string, taskId: string): Promise<string | null> {
  const name = `${taskId}.output`
  const known = taskDirs.get(sessionId)
  if (known && (await exists(join(known, name)))) return join(known, name)
  const roots = [process.env.CLAUDE_CODE_TMPDIR, tmpdir(), process.platform === 'win32' ? undefined : '/tmp'].filter((r): r is string => !!r)
  for (const root of new Set(roots)) {
    for (const base of (await dirs(root)).filter((d) => d.startsWith('claude'))) {
      for (const project of await dirs(join(root, base))) {
        const file = join(root, base, project, sessionId, 'tasks', name)
        if (await exists(file)) {
          rememberTaskOutput(sessionId, file)
          return file
        }
      }
    }
  }
  return null
}

/** 출력 파일의 끝부분 (앞을 잘랐으면 첫 줄의 조각은 버린다) */
export async function readTaskOutput(sessionId: string, taskId: string): Promise<TaskOutput | null> {
  const file = await find(sessionId, taskId)
  if (!file) return null
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { path: file, text, truncated: start > 0, size }
  } finally {
    await fh.close()
  }
}
