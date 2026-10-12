import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'target', 'coverage'])
const MAX_FILES = 20_000
const TTL_MS = 30_000

const cache = new Map<string, { at: number; files: string[] }>()

/** 폴더의 파일 목록 (상대 경로). git이면 추적 중인 파일과 무시되지 않은 새 파일, 아니면 직접 훑는다 */
async function listAll(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files
  let files: string[]
  try {
    const { stdout } = await run('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 })
    files = stdout.split('\n').filter(Boolean)
  } catch {
    files = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || files.length >= MAX_FILES) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.github') continue
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) walk(full, depth + 1)
        } else files.push(relative(cwd, full))
        if (files.length >= MAX_FILES) return
      }
    }
    walk(cwd, 0)
  }
  files = files.slice(0, MAX_FILES).map((f) => f.replace(/\\/g, '/'))
  // 폴더도 @로 넣을 수 있게 (CLI처럼). 파일 경로에서 끌어내고 끝에 /를 붙여 구분한다
  const dirs = new Set<string>()
  for (const f of files) {
    let i = f.indexOf('/')
    while (i > 0) {
      dirs.add(`${f.slice(0, i)}/`)
      i = f.indexOf('/', i + 1)
    }
  }
  files = [...files, ...dirs]
  cache.set(cwd, { at: Date.now(), files })
  return files
}

/**
 * 글자를 띄엄띄엄 쳐도 찾는다 ('rsapp' → 'src/renderer/src/App.tsx').
 * 파일 이름에 붙어 맞을수록, 연속으로 맞을수록, 경로가 짧을수록 위로
 */
function score(path: string, q: string): number {
  if (!q) return 1000 - path.length
  const p = path.toLowerCase()
  // 폴더는 끝의 /를 뗀 이름으로 맞춘다
  const base = p.endsWith('/') ? p.slice(0, -1) : p
  const name = base.slice(base.lastIndexOf('/') + 1)
  if (name.startsWith(q)) return 5000 - path.length
  if (name.includes(q)) return 4000 - path.length
  if (p.includes(q)) return 3000 - path.length
  let i = 0
  let run = 0
  let best = 0
  for (const ch of p) {
    if (ch === q[i]) {
      i++
      run++
      best = Math.max(best, run)
      if (i === q.length) return 1000 + best * 20 - path.length
    } else run = 0
  }
  return -1
}

export async function searchFiles(cwd: string, query: string, limit = 50): Promise<string[]> {
  const q = query.toLowerCase()
  return (await listAll(cwd))
    .map((f) => ({ f, s: score(f, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f)
}
