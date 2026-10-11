import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> => (await run('git', ['-C', cwd, ...args], { timeout: 20_000 })).stdout.trim()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 작업 공간 폴더를 지운다. Windows에서는 그 폴더를 작업 폴더로 쓰는 프로세스(탭을 열 때 띄운 CLI 등)가
 * 막 끝나는 중이면 'Permission denied'로 실패하므로 잠깐씩 기다리며 다시 해 본다.
 * git이 파일만 일부 지우고 실패해 더는 작업 공간으로 안 보이면 폴더를 직접 지우고 git 기록을 정리한다
 */
async function removeWorktreeDir(projectPath: string, path: string, force: boolean): Promise<boolean> {
  for (const wait of [0, 300, 700, 1500, 3000]) {
    if (wait) await sleep(wait)
    try {
      await git(projectPath, 'worktree', 'remove', ...(force ? ['--force'] : []), path)
      return true
    } catch {
      if (!existsSync(path)) return true
      if (existsSync(join(path, '.git'))) continue
      try {
        await rm(path, { recursive: true, force: true })
        await git(projectPath, 'worktree', 'prune')
        return true
      } catch {
        // 아직 잡혀 있다. 다음에 다시
      }
    }
  }
  return false
}

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
    return await removeWorktreeDir(projectPath, path, false)
  } catch {
    return false
  }
}

const DIFF_LIMIT = 400_000

export interface WorktreeChanges {
  branch: string
  /** 합칠 대상: 프로젝트 폴더에서 지금 체크아웃된 브랜치 */
  target: string
  files: { path: string; status: string }[]
  /** 작업 공간에서 갈라진 지점 대비 전체 변경 (커밋 안 한 것·새 파일 포함) */
  diff: string
  truncated: boolean
  /** 아직 커밋하지 않은 변경이 있는지 */
  dirty: boolean
  /** 대상 브랜치에 아직 들어가지 않은 커밋 수 */
  ahead: number
}

/** 작업 공간의 변경 요약과 diff (프로젝트의 현재 브랜치와 갈라진 지점 기준) */
export async function worktreeChanges(projectPath: string, wt: { path: string; branch: string }): Promise<WorktreeChanges> {
  const target = await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')
  const base = await git(wt.path, 'merge-base', 'HEAD', target)
  const status = await git(wt.path, 'status', '--porcelain')
  const untracked = (await git(wt.path, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)
  const nameStatus = (await git(wt.path, 'diff', '--name-status', base)).split('\n').filter(Boolean)
  const files = [
    ...nameStatus.map((l) => {
      const [st, ...rest] = l.split('\t')
      return { status: st[0], path: rest[rest.length - 1] }
    }),
    ...untracked.map((path) => ({ status: 'A', path })),
  ]
  // 새 파일은 --no-index로 /dev/null과 비교해 diff에 넣는다
  let diff = await git(wt.path, 'diff', base)
  for (const f of untracked) {
    if (diff.length > DIFF_LIMIT) break
    try {
      await run('git', ['-C', wt.path, 'diff', '--no-index', '/dev/null', f], { timeout: 10_000 })
    } catch (err) {
      // 차이가 있으면 종료 코드 1이라 여기로 온다
      diff += '\n' + ((err as { stdout?: string }).stdout ?? '')
    }
  }
  const ahead = Number(await git(projectPath, 'rev-list', '--count', `${target}..${wt.branch}`)) || 0
  return { branch: wt.branch, target, files, diff: diff.slice(0, DIFF_LIMIT), truncated: diff.length > DIFF_LIMIT, dirty: status !== '', ahead }
}

/**
 * 합치기: 작업 공간의 커밋 안 한 변경을 커밋하고, 프로젝트의 현재 브랜치에 --no-ff로 병합한다.
 * 충돌 등으로 실패하면 병합을 되돌리고 git 메시지를 돌려준다. 작업 공간은 남겨 둬 대화를 이어 갈 수 있다
 */
export async function mergeWorktree(projectPath: string, wt: { path: string; branch: string }, title: string): Promise<{ ok: boolean; message: string }> {
  try {
    if ((await git(wt.path, 'status', '--porcelain')) !== '') {
      await git(wt.path, 'add', '-A')
      await git(wt.path, 'commit', '-m', title)
    }
    const target = await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')
    const ahead = Number(await git(projectPath, 'rev-list', '--count', `${target}..${wt.branch}`)) || 0
    if (ahead === 0) return { ok: true, message: `${target} 브랜치에 이미 모두 들어가 있어요` }
    await git(projectPath, 'merge', '--no-ff', '-m', `Merge ${wt.branch}: ${title}`, wt.branch)
    return { ok: true, message: `${wt.branch}의 커밋 ${ahead}개를 ${target} 브랜치에 합쳤어요` }
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    try {
      await git(projectPath, 'merge', '--abort')
    } catch {
      // 병합 중이 아니었으면 되돌릴 것도 없다
    }
    return { ok: false, message: (e.stderr || e.stdout || e.message || '합치지 못했어요').trim() }
  }
}

/** 버리기: 작업 공간과 브랜치를 지운다 (변경도 함께 사라진다) */
export async function discardWorktree(projectPath: string, wt: { path: string; branch: string }): Promise<void> {
  await removeWorktreeDir(projectPath, wt.path, true)
  try {
    await git(projectPath, 'branch', '-D', wt.branch)
  } catch {
    // 브랜치가 없을 수 있다
  }
}
