import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', ['-C', cwd, ...args], { timeout: 20_000 })).stdout.trim()

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true'
  } catch {
    return false
  }
}

/**
 * 하위 대화용 작업 공간 (OPEN-002): 같은 프로젝트의 대화끼리 파일을 덮어쓰지 않게, HEAD에서 새 브랜치를 따서 따로 체크아웃한다.
 * 위치는 userData/worktrees/<프로젝트>-<대화 앞 8자>
 */
export async function createWorktree(projectPath: string, root: string, conversationId: string): Promise<{ path: string; branch: string }> {
  const short = conversationId.slice(0, 8)
  const branch = `wt/${short}`
  const path = join(root, `${basename(projectPath)}-${short}`)
  mkdirSync(root, { recursive: true })
  await git(projectPath, 'worktree', 'add', '-b', branch, path, 'HEAD')
  return { path, branch }
}

/** 변경이 없을 때만 작업 공간을 지운다 (브랜치는 남긴다). 지웠으면 true */
export async function removeWorktreeIfClean(projectPath: string, path: string): Promise<boolean> {
  try {
    if ((await git(path, 'status', '--porcelain')) !== '') return false
    await git(projectPath, 'worktree', 'remove', path)
    return true
  } catch {
    return false
  }
}
