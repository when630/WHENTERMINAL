import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GitBranch } from '@shared/types'

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

/** 지금 브랜치. 분리된 HEAD면 짧은 커밋. git 저장소가 아니면 null */
export async function branchOf(path: string): Promise<GitBranch | null> {
  let name: string
  let detached = false
  try {
    name = await git(path, 'symbolic-ref', '--short', '-q', 'HEAD')
  } catch {
    try {
      name = await git(path, 'rev-parse', '--short', 'HEAD')
      detached = true
    } catch {
      return null
    }
  }
  let dirty = false
  try {
    dirty = (await git(path, 'status', '--porcelain', '--untracked-files=no')).length > 0
  } catch {
    // 상태는 몰라도 된다
  }
  return { name, detached, dirty }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true'
  } catch {
    return false
  }
}

/**
 * 작업 공간 폴더가 저장소 안이면 git이 새 파일로 보지 않게 저장소의 info/exclude에 적는다 (.gitignore는 건드리지 않는다).
 * 이미 무시되는 경로면 그대로
 */
async function ignoreInRepo(projectPath: string, root: string): Promise<void> {
  const top = await git(projectPath, 'rev-parse', '--show-toplevel')
  const rel = relative(resolve(top), root)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
  try {
    await git(projectPath, 'check-ignore', '-q', root)
    return
  } catch {
    // 무시되지 않음 (종료 코드 1) → 적는다
  }
  const exclude = join(resolve(projectPath, await git(projectPath, 'rev-parse', '--git-common-dir')), 'info', 'exclude')
  const line = `/${rel.split(/[\\/]/).join('/')}/`
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (cur.split(/\r?\n/).includes(line)) return
  mkdirSync(join(exclude, '..'), { recursive: true })
  appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# WHENTERMINAL 하위 대화 작업 공간\n${line}\n`)
}

/**
 * 하위 대화용 작업 공간 (OPEN-002): 같은 프로젝트의 대화끼리 파일을 덮어쓰지 않게, HEAD에서 새 브랜치를 따서 따로 체크아웃한다.
 * 위치는 설정 worktreeDir: 상대 경로면 프로젝트 폴더 기준(기본 .claude/worktrees/<대화 앞 8자>, 프로젝트와 같은 드라이브),
 * 절대 경로면 여러 프로젝트가 같이 쓰므로 <프로젝트>-<대화 앞 8자>
 */
export async function createWorktree(projectPath: string, dir: string, conversationId: string): Promise<{ path: string; branch: string }> {
  const short = conversationId.slice(0, 8)
  const branch = `wt/${short}`
  const shared = isAbsolute(dir)
  const root = shared ? dir : resolve(projectPath, dir)
  const path = join(root, shared ? `${basename(projectPath)}-${short}` : short)
  mkdirSync(root, { recursive: true })
  await ignoreInRepo(projectPath, root).catch((err) => console.warn('작업 공간 폴더를 git 무시 목록에 넣지 못함', err))
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
    // 사용자가 프로젝트 폴더에서 하던 병합이 있으면 건드리지 않는다 (실패해도 그 병합을 되돌리면 안 된다)
    if (await merging(projectPath)) return { ok: false, message: '프로젝트 폴더에서 진행 중인 병합이 있어요. 그 병합을 끝낸 뒤에 합쳐 주세요' }
    const target = await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')
    const ahead = Number(await git(projectPath, 'rev-list', '--count', `${target}..${wt.branch}`)) || 0
    if (ahead === 0) return { ok: true, message: `${target} 브랜치에 이미 모두 들어가 있어요` }
    await git(projectPath, 'merge', '--no-ff', '-m', `Merge ${wt.branch}: ${title}`, wt.branch)
    return { ok: true, message: `${wt.branch}의 커밋 ${ahead}개를 ${target} 브랜치에 합쳤어요` }
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    // 위에서 진행 중인 병합이 없음을 확인했으므로, 지금 병합 중이면 이 함수가 시작한 것이다
    if (await merging(projectPath)) {
      try {
        await git(projectPath, 'merge', '--abort')
      } catch {
        // 되돌리지 못하면 사용자에게 보이는 오류로 충분하다
      }
    }
    return { ok: false, message: (e.stderr || e.stdout || e.message || '합치지 못했어요').trim() }
  }
}

/** 프로젝트 폴더가 병합 중인지 (MERGE_HEAD가 있는지) */
async function merging(projectPath: string): Promise<boolean> {
  try {
    await git(projectPath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
    return true
  } catch {
    return false
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
