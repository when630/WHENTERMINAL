import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GitBranchInfo, GitDiff, GitCommitInfo, GitDiffTarget, GitOverview, GitWorktreeInfo } from '@shared/types'

// git 화면(/git): 브랜치·작업 공간·커밋 기록(갈래 선)·커밋별 diff를 읽기만 한다. 체크아웃·병합 같은 쓰기는 하지 않는다

const run = promisify(execFile)
/** 한글 경로를 이스케이프하지 않게(core.quotepath), diff가 커도 받게(maxBuffer) */
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })).stdout.replace(/\s+$/, '')
const tryGit = async (cwd: string, ...args: string[]): Promise<string | null> => {
  try {
    return await git(cwd, ...args)
  } catch {
    return null
  }
}

const SEP = '\x1f'
const DIFF_LIMIT = 400_000
const LOG_PAGE = 300
/** 커밋이 하나도 없는 저장소에서 비교 기준으로 쓰는 빈 트리 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const samePath = (a: string, b: string): boolean => {
  const n = (p: string): string => resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/** 'HEAD -> main, origin/main, tag: v1' → ['HEAD -> main', 'origin/main', 'tag: v1'] */
const splitRefs = (d: string): string[] => d.split(',').map((s) => s.trim()).filter(Boolean)

export async function worktreesOf(cwd: string): Promise<GitWorktreeInfo[]> {
  const out = (await tryGit(cwd, 'worktree', 'list', '--porcelain')) ?? ''
  const list: GitWorktreeInfo[] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    if (!path) continue
    const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '')
    const sha = lines.find((l) => l.startsWith('HEAD '))?.slice(5, 12) ?? ''
    list.push({ path: resolve(path), branch, sha, here: samePath(path, cwd), main: list.length === 0 })
  }
  return list
}

/** 브랜치·작업 공간·커밋 안 한 변경 수. git 저장소가 아니면 null */
export async function gitOverview(cwd: string): Promise<GitOverview | null> {
  const top = await tryGit(cwd, 'rev-parse', '--show-toplevel')
  if (top === null) return null
  let head = await tryGit(cwd, 'symbolic-ref', '--short', '-q', 'HEAD')
  const detached = head === null
  if (head === null) head = (await tryGit(cwd, 'rev-parse', '--short', 'HEAD')) ?? 'HEAD'
  const worktrees = await worktreesOf(cwd)
  const here = worktrees.find((w) => w.here)
  const refs = (await tryGit(cwd, 'for-each-ref', '--sort=-committerdate', `--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(upstream:short)%1f%(upstream:track)%1f%(subject)`, 'refs/heads')) ?? ''
  const branches: GitBranchInfo[] = refs.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, sha, date, upstream, track, subject] = line.split(SEP)
    const elsewhere = worktrees.find((w) => w.branch === name && !w.here)
    return {
      name,
      current: !detached && name === head,
      sha,
      date: Number(date) * 1000,
      subject: subject ?? '',
      upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      worktree: elsewhere?.path,
    }
  })
  const status = (await tryGit(here?.path ?? cwd, 'status', '--porcelain')) ?? ''
  return { root: resolve(top), head, detached, branches, worktrees, changed: status.split(/\r?\n/).filter(Boolean).length }
}

/** 커밋 기록 (부모 포함, 갈래 선은 화면이 그린다). ref가 null이면 모든 브랜치. 커밋이 없는 저장소면 빈 목록 */
export async function gitLog(cwd: string, ref: string | null, skip: number): Promise<GitCommitInfo[]> {
  // 옵션으로 읽히는 이름은 받지 않는다
  if (ref !== null && (ref.startsWith('-') || !ref.trim())) return []
  const out = await tryGit(
    cwd,
    'log',
    '--date-order',
    `--format=%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ct${SEP}%D${SEP}%s`,
    `-n${LOG_PAGE}`,
    `--skip=${Math.max(0, Math.floor(skip))}`,
    ...(ref === null ? ['--all'] : [ref, '--']),
  )
  if (!out) return []
  return out.split(/\r?\n/).map((line): GitCommitInfo => {
    const [sha, short, parents, author, date, refs, ...subject] = line.split(SEP)
    return { sha, short, parents: parents ? parents.split(' ') : [], author, date: Number(date) * 1000, refs: splitRefs(refs ?? ''), subject: subject.join(SEP) }
  })
}

/** 실패한 git 명령의 메시지 (stderr가 가장 정확하다) */
const gitError = (err: unknown): string => {
  const e = err as { stderr?: string; stdout?: string; message?: string }
  return (e.stderr || e.stdout || e.message || 'git 명령이 실패했어요').trim()
}

/** 다른 작업 공간을 고르면 그 폴더. 이 저장소의 작업 공간만 받는다 */
async function workingDir(cwd: string, path?: string): Promise<string> {
  if (!path) return cwd
  const wt = (await worktreesOf(cwd)).find((w) => samePath(w.path, path))
  if (!wt) throw new Error('이 저장소의 작업 공간이 아니에요')
  return wt.path
}

/** 대화 폴더에서 로컬 브랜치로 옮긴다. 커밋 안 한 변경과 부딪치거나 다른 작업 공간에 체크아웃된 브랜치면 git이 거절한 메시지를 그대로 */
export async function gitCheckout(cwd: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const branches = ((await tryGit(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')) ?? '').split(/\r?\n/)
  if (!branches.includes(branch)) return { ok: false, message: `로컬 브랜치 ${branch}가 없어요` }
  try {
    await git(cwd, 'switch', branch)
    return { ok: true, message: `${branch} 브랜치로 옮겼어요` }
  } catch (err) {
    return { ok: false, message: gitError(err) }
  }
}

/** 작업 공간 폴더의 커밋 안 한 변경(새 파일 포함)을 모두 커밋한다 */
export async function gitCommit(cwd: string, path: string | undefined, message: string): Promise<{ ok: boolean; message: string }> {
  const text = message.trim()
  if (!text) return { ok: false, message: '커밋 메시지를 적어 주세요' }
  try {
    const dir = await workingDir(cwd, path)
    await git(dir, 'add', '-A')
    await git(dir, 'commit', '-m', text)
    const short = await git(dir, 'rev-parse', '--short', 'HEAD')
    return { ok: true, message: `커밋했어요 · ${short} ${text.split('\n')[0]}` }
  } catch (err) {
    return { ok: false, message: gitError(err) }
  }
}

/** git diff --name-status 결과 → 파일 목록 (이름이 바뀐 것은 새 이름) */
function parseNameStatus(out: string): { path: string; status: string }[] {
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [st, ...rest] = l.split('\t')
    return { status: st[0], path: rest[rest.length - 1] }
  })
}

/** 커밋 하나의 변경, 또는 작업 공간 폴더의 커밋 안 한 변경(새 파일 포함) */
export async function gitDiff(cwd: string, target: GitDiffTarget): Promise<GitDiff> {
  if (target.kind === 'commit') {
    if (!/^[0-9a-f]{7,40}$/i.test(target.sha)) throw new Error('커밋을 알 수 없어요')
    const meta = await git(cwd, 'show', '-s', `--format=%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ae${SEP}%ct${SEP}%D${SEP}%s${SEP}%b`, target.sha)
    const [sha, short, parents, author, email, date, refs, subject, ...body] = meta.split(SEP)
    const parentList = parents ? parents.split(' ') : []
    // 병합 커밋은 첫 부모와 비교한다 (그 병합으로 들어온 것), 첫 커밋은 빈 트리와
    const base = parentList[0] ?? EMPTY_TREE
    const files = parseNameStatus(await git(cwd, 'diff', '--name-status', '-M', base, sha))
    const diff = await git(cwd, 'diff', '-M', base, sha)
    return {
      files,
      diff: diff.slice(0, DIFF_LIMIT),
      truncated: diff.length > DIFF_LIMIT,
      commit: { sha, short, parents: parentList, author, email, date: Number(date) * 1000, refs: splitRefs(refs ?? ''), subject, body: body.join(SEP).trim() },
    }
  }
  const dir = await workingDir(cwd, target.path)
  const base = (await tryGit(dir, 'rev-parse', '--verify', '-q', 'HEAD')) ?? EMPTY_TREE
  const files = parseNameStatus(await git(dir, 'diff', '--name-status', '-M', base))
  let diff = await git(dir, 'diff', '-M', base)
  const untracked = ((await tryGit(dir, 'ls-files', '--others', '--exclude-standard', '-z')) ?? '').split('\0').filter(Boolean)
  for (const f of untracked) {
    files.push({ status: 'A', path: f })
    if (diff.length > DIFF_LIMIT) continue
    try {
      await run('git', ['-C', dir, '-c', 'core.quotepath=false', 'diff', '--no-index', '/dev/null', f], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
    } catch (err) {
      // 차이가 있으면 종료 코드 1이라 여기로 온다
      diff += '\n' + ((err as { stdout?: string }).stdout ?? '')
    }
  }
  return { files, diff: diff.slice(0, DIFF_LIMIT), truncated: diff.length > DIFF_LIMIT }
}
