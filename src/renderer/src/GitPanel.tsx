import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitCommitInfo, GitDiff, GitDiffTarget, GitOverview } from '@shared/types'
import { DiffBody } from './WorktreePanel'
import { Presence } from './motion'
import { elapsed, useNow } from './time'

interface Props {
  projectId: string
  conversationId: string
  /** 대화가 끝나 커밋·변경이 생겼을 수 있을 때마다 바뀌는 값 (다시 읽기용) */
  refreshKey: string
  /** 대화가 실행 중이면 체크아웃·커밋을 막는다 (에이전트가 고치는 파일 밑에서 브랜치가 바뀌지 않게) */
  busy: boolean
  onClose: () => void
}

/** 왼쪽 칸의 줄: 커밋 안 한 변경(작업 공간마다) 또는 브랜치 (null = 모든 브랜치) */
type RefRow = { kind: 'working'; path: string; label: string; sub: string; here: boolean; branch?: string } | { kind: 'branch'; name: string | null }

const LOG_PAGE = 300
const COLS = 3

const sameTarget = (a: GitDiffTarget | null, b: GitDiffTarget | null): boolean =>
  !!a && !!b && (a.kind === 'commit' ? b.kind === 'commit' && a.sha === b.sha : b.kind === 'working' && a.path === b.path)

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

// ── 갈래 선: 커밋마다 한 줄, 줄마다 그 줄 높이만큼의 선을 그려 위아래 줄과 이어지게 한다 ──
const ROW_H = 26
const LANE_W = 14
const MAX_LANES = 12
const laneX = (i: number): number => Math.min(i, MAX_LANES) * LANE_W + LANE_W / 2

export interface GraphRow {
  /** 이 커밋이 놓인 칸 */
  node: number
  /** [x1, y1, x2, y2] */
  lines: [number, number, number, number][]
  /** 그림 폭에 필요한 칸 수 */
  lanes: number
}

/**
 * 최근 것부터 놓인 커밋들의 갈래 선. 칸(lane)마다 '다음에 올 커밋'을 기억해 두고, 커밋이 오면 그 칸(들)에서 모여 점이 되고
 * 부모들로 다시 갈라진다. 칸은 옮기지 않고 빈 칸을 다시 쓴다 (페이지를 더 읽어도 앞부분 그림이 바뀌지 않는다)
 */
export function layoutGraph(commits: GitCommitInfo[]): GraphRow[] {
  let lanes: (string | null)[] = []
  const mid = ROW_H / 2
  return commits.map((c) => {
    const hits = lanes.flatMap((s, j) => (s === c.sha ? [j] : []))
    const free = (): number => {
      const i = lanes.indexOf(null)
      return i < 0 ? lanes.length : i
    }
    const node = hits[0] ?? free()
    const lines: GraphRow['lines'] = []
    // 위 절반: 이 커밋을 기다리던 칸은 점으로 모이고, 나머지 칸은 그대로 지나간다
    lanes.forEach((s, j) => {
      if (s === null) return
      if (s === c.sha) lines.push([laneX(j), 0, laneX(node), mid])
      else lines.push([laneX(j), 0, laneX(j), ROW_H])
    })
    const width = lanes.length
    for (const j of hits) lanes[j] = null
    // 아래 절반: 첫 부모는 같은 칸으로, 나머지 부모(병합)는 이미 기다리는 칸이 있으면 그리로, 없으면 새 칸으로
    lanes[node] = null
    c.parents.forEach((p, k) => {
      let at = k === 0 ? node : lanes.indexOf(p)
      if (at < 0) at = free()
      lanes[at] = p
      lines.push([laneX(node), mid, laneX(at), ROW_H])
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

    return { node, lines, lanes: Math.min(Math.max(width, lanes.length, node + 1), MAX_LANES + 1) }
  })
}

/** lanes: 목록 전체에서 가장 넓은 칸 수 (줄마다 폭이 같아야 옆 글이 한 줄로 선다) */
function Graph({ row, lanes, merge }: { row: GraphRow; lanes: number; merge: boolean }): React.JSX.Element {
  const w = lanes * LANE_W
  return (
    <svg className="git-graph" width={w} height={ROW_H} viewBox={`0 0 ${w} ${ROW_H}`} aria-hidden="true">
      {row.lines.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
      ))}
      <circle className={merge ? 'merge' : ''} cx={laneX(row.node)} cy={ROW_H / 2} r={merge ? 3.5 : 4} />
    </svg>
  )
}

/**
 * git 화면 (/git, 키맵 git): 브랜치·작업 공간 | 커밋 기록(갈래 선) | 고른 커밋·변경의 diff.
 * 쓰기는 두 가지만, 모두 두 번 눌러야 한다: 고른 브랜치로 체크아웃(왼쪽 칸 C), 커밋 안 한 변경을 커밋(메시지 칸 Enter)
 * 칸 사이는 H/L(←→), 칸 안은 J/K(↑↓). diff 칸은 J/K로 스크롤, Ctrl+D/U로 반 쪽씩
 */
export function GitPanel({ projectId, conversationId, refreshKey, busy, onClose }: Props): React.JSX.Element {
  const now = useNow(60_000)
  const [overview, setOverview] = useState<GitOverview | null | undefined>(undefined)
  /** 커밋 기록을 볼 브랜치. undefined면 아직 고르지 않음(지금 브랜치), null이면 모든 브랜치 */
  const [ref, setRef] = useState<string | null | undefined>(undefined)
  const [log, setLog] = useState<{ ref: string | null; rows: GitCommitInfo[]; more: boolean } | null>(null)
  const [target, setTarget] = useState<GitDiffTarget | null>(null)
  const [diff, setDiff] = useState<{ target: GitDiffTarget; data: GitDiff | null; error?: string } | null>(null)
  const [col, setCol] = useState(1)
  const colRefs = useRef<(HTMLElement | null)[]>([])
  // 체크아웃·커밋: 결과 안내, 두 번 누르기, 끝나면 다시 읽기(bump)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [armed, setArmed] = useState<'checkout' | 'commit' | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [writing, setWriting] = useState(false)
  const [bump, setBump] = useState(0)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 3000)
    return () => clearTimeout(t)
  }, [armed])
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 6000)
    return () => clearTimeout(t)
  }, [message])

  const loadOverview = useCallback(() => {
    void window.api.gitOverview(projectId, conversationId).then(setOverview, () => setOverview(null))
  }, [projectId, conversationId])
  useEffect(loadOverview, [loadOverview, refreshKey])
  useEffect(() => {
    window.addEventListener('focus', loadOverview)
    return () => window.removeEventListener('focus', loadOverview)
  }, [loadOverview])

  const shownRef = ref === undefined ? (overview && !overview.detached ? overview.head : null) : ref

  // 커밋 기록: 브랜치를 바꾸거나 다시 읽을 때 처음부터
  useEffect(() => {
    if (!overview) return
    let alive = true
    void window.api.gitLog(projectId, conversationId, shownRef, 0).then((rows) => {
      if (!alive) return
      setLog({ ref: shownRef, rows, more: rows.length >= LOG_PAGE })
    })
    return () => {
      alive = false
    }
  }, [projectId, conversationId, shownRef, overview])
  // 스크롤이 바닥에 닿을 때마다 불리므로 읽는 중에는 다시 부르지 않는다
  const loadingMore = useRef(false)
  const loadMore = (): void => {
    if (!log?.more || loadingMore.current) return
    loadingMore.current = true
    const skip = log.rows.length
    void window.api.gitLog(projectId, conversationId, log.ref, skip).then((rows) => {
      loadingMore.current = false
      setLog((cur) => (cur && cur.ref === log.ref && cur.rows.length === skip ? { ...cur, rows: [...cur.rows, ...rows], more: rows.length >= LOG_PAGE } : cur))
    }, () => {
      loadingMore.current = false
    })
  }

  const refRows = useMemo<RefRow[]>(() => {
    if (!overview) return []
    const wts = [...overview.worktrees].sort((a, b) => Number(b.here) - Number(a.here))
    const working: RefRow[] = wts.map((w) => ({
      kind: 'working',
      path: w.path,
      here: w.here,
      branch: w.branch,
      label: w.here ? 'UNCOMMITTED' : baseName(w.path),
      sub: w.here ? `${overview.changed} FILES` : w.branch ?? w.sha,
    }))
    return [...working, { kind: 'branch', name: null }, ...overview.branches.map((b): RefRow => ({ kind: 'branch', name: b.name }))]
  }, [overview])
  const commits = useMemo(() => (log && log.ref === shownRef ? log.rows : []), [log, shownRef])
  const graph = useMemo(() => layoutGraph(commits), [commits])
  const graphLanes = useMemo(() => graph.reduce((m, r) => Math.max(m, r.lanes), 1), [graph])

  // 처음 열면 맨 위 커밋을 보여 준다 (커밋 안 한 변경이 있으면 그것부터)
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !overview || !log) return
    started.current = true
    const here = overview.worktrees.find((w) => w.here)
    if (overview.changed > 0 && here) setTarget({ kind: 'working', path: here.path })
    else if (commits[0]) setTarget({ kind: 'commit', sha: commits[0].sha })
  }, [overview, log, commits])

  // 고른 것의 diff (키로 빠르게 지나갈 때는 멈춘 뒤에 읽는다)
  useEffect(() => {
    if (!target) return
    let alive = true
    const t = setTimeout(() => {
      void window.api.gitDiff(projectId, conversationId, target).then(
        (data) => alive && setDiff({ target, data }),
        (err) => alive && setDiff({ target, data: null, error: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err) }),
      )
    }, 90)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [projectId, conversationId, target, refreshKey, bump])

  const diffRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    diffRef.current?.scrollTo({ top: 0 })
  }, [diff?.target])

  // 선택한 줄이 보이게
  useEffect(() => {
    for (const el of colRefs.current) el?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [target, shownRef])

  // 저장소를 읽어 칸이 그려지면 커밋 칸에 포커스 (키로 바로 움직이게)
  const ready = !!overview
  useEffect(() => {
    if (ready) colRefs.current[1]?.focus({ preventScroll: true })
  }, [ready])
  const focusCol = (i: number): void => {
    const c = (i + COLS) % COLS
    setCol(c)
    colRefs.current[c]?.focus({ preventScroll: true })
  }

  const pickRef = (row: RefRow): void => {
    if (row.kind === 'working') {
      setTarget({ kind: 'working', path: row.path })
      if (row.branch) setRef(row.branch)
    } else {
      setRef(row.name)
      // 그 브랜치의 맨 위 커밋은 기록을 읽은 뒤에 고른다 (그 사이 커밋 안 한 변경이 골라진 채로 남지 않게 비운다)
      if (target?.kind === 'working') setTarget(null)
      pendingTop.current = true
    }
  }
  const pendingTop = useRef(false)
  useEffect(() => {
    if (!pendingTop.current || !log || log.ref !== shownRef) return
    pendingTop.current = false
    const first = commits[0]
    if (first) setTarget({ kind: 'commit', sha: first.sha })
  }, [log, shownRef, commits])

  const refIndex = refRows.findIndex((r) => (r.kind === 'working' ? target?.kind === 'working' && sameTarget(target, { kind: 'working', path: r.path }) : r.name === shownRef && target?.kind !== 'working'))
  const commitIndex = commits.findIndex((c) => target?.kind === 'commit' && c.sha === target.sha)

  const branchOf = (name: string): GitOverview['branches'][number] | undefined => overview?.branches.find((b) => b.name === name)
  // 체크아웃할 수 있는 브랜치: 왼쪽에서 고른 로컬 브랜치 중 지금 브랜치가 아니고 다른 작업 공간에 체크아웃되지 않은 것
  const picked = target?.kind !== 'working' && shownRef ? branchOf(shownRef) : undefined
  const checkoutable = picked && !picked.current && !picked.worktree ? picked : undefined
  const busyTip = '대화가 실행 중이에요. 끝난 뒤에 해 주세요'

  const write = async (kind: 'checkout' | 'commit', run: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    if (busy || writing) return
    if (armed !== kind) return setArmed(kind)
    setArmed(null)
    setWriting(true)
    const res = await run().catch((err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }))
    setWriting(false)
    setMessage({ ok: res.ok, text: res.message })
    if (!res.ok) return
    if (kind === 'commit') setCommitMsg('')
    // 체크아웃했으면 기록도 새 지금 브랜치를 따라가고 맨 위 커밋을 보인다
    if (kind === 'checkout') {
      setRef(undefined)
      pendingTop.current = true
    }
    loadOverview()
    setBump((n) => n + 1)
  }
  const checkout = (): void => {
    if (checkoutable) void write('checkout', () => window.api.gitCheckout(projectId, conversationId, checkoutable.name))
  }
  const commit = (path: string | undefined): void => {
    if (!commitMsg.trim()) return setMessage({ ok: false, text: '커밋 메시지를 적어 주세요' })
    void write('commit', () => window.api.gitCommit(projectId, conversationId, path, commitMsg))
  }

  const onKey = (e: React.KeyboardEvent): void => {
    // 커밋 메시지 칸은 글자 그대로
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.altKey || e.metaKey || e.nativeEvent.isComposing) return
    const ctrl = e.ctrlKey && !e.shiftKey
    if (e.ctrlKey && !ctrl) return
    const step = !e.ctrlKey && (e.code === 'KeyJ' || e.key === 'ArrowDown') ? 1 : !e.ctrlKey && (e.code === 'KeyK' || e.key === 'ArrowUp') ? -1 : 0
    const side = !e.ctrlKey && (e.code === 'KeyL' || e.key === 'ArrowRight') ? 1 : !e.ctrlKey && (e.code === 'KeyH' || e.key === 'ArrowLeft') ? -1 : 0
    const take = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (side) {
      take()
      return focusCol(col + side)
    }
    if (col === 2) {
      const box = diffRef.current
      if (!box) return
      if (step) {
        take()
        box.scrollBy({ top: step * 60 })
      } else if (ctrl && (e.code === 'KeyD' || e.code === 'KeyU')) {
        take()
        box.scrollBy({ top: (e.code === 'KeyD' ? 1 : -1) * box.clientHeight * 0.5, behavior: 'smooth' })
      }
      return
    }
    if (col === 0) {
      if (step && refRows.length) {
        take()
        pickRef(refRows[Math.min(Math.max((refIndex < 0 ? 0 : refIndex) + step, 0), refRows.length - 1)])
      } else if (e.key === 'Enter') {
        take()
        focusCol(target?.kind === 'working' ? 2 : 1)
      } else if (!e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && checkoutable) {
        take()
        checkout()
      }
      return
    }
    if (step && commits.length) {
      take()
      const next = Math.min(Math.max((commitIndex < 0 ? -1 : commitIndex) + step, 0), commits.length - 1)
      setTarget({ kind: 'commit', sha: commits[next].sha })
      if (next >= commits.length - 5) loadMore()
    } else if (e.key === 'Enter') {
      take()
      focusCol(2)
    }
  }

  const shown = diff && sameTarget(diff.target, target) ? diff : null
  const workingRow = target?.kind === 'working' ? refRows.find((r): r is Extract<RefRow, { kind: 'working' }> => r.kind === 'working' && r.path === target.path) : undefined

  return (
    <section className="wt-panel td git" aria-label="git">
      <header className="wt-head">
        <div className="wt-title">
          <span className="kr">GIT</span>
          {overview && (
            <span className="mono" title={overview.root}>
              {overview.detached ? `DETACHED ${overview.head}` : overview.head} · {overview.root}
            </span>
          )}
        </div>
        <div className="wt-actions">
          {checkoutable && (
            <button type="button" className={armed === 'checkout' ? 'btn armed' : 'btn-pri'} disabled={busy || writing} onClick={checkout} title={busy ? busyTip : `이 대화 폴더를 ${checkoutable.name} 브랜치로 옮겨요`}>
              {armed === 'checkout' ? 'CHECKOUT? 한 번 더' : `CHECKOUT ${checkoutable.name}`}
            </button>
          )}
          <button type="button" className="btn" onClick={loadOverview} title="브랜치·기록을 다시 읽어요">
            REFRESH
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            BACK TO CHAT
          </button>
        </div>
      </header>
      <Presence as="div" show={!!message} className={`wt-msg ${message?.ok ? 'ok' : 'bad'}`} role="status">{message?.text}</Presence>
      {overview === undefined && <div className="empty">저장소를 읽는 중…</div>}
      {overview === null && <div className="empty">git 저장소가 아닌 폴더예요.</div>}
      {overview && (
        <div className="git-cols" onKeyDown={onKey}>
          <div
            className={`git-col git-refs ${col === 0 ? 'on' : ''}`}
            role="listbox"
            aria-label="브랜치·작업 공간"
            tabIndex={0}
            ref={(el) => { colRefs.current[0] = el }}
            onFocus={() => setCol(0)}
          >
            <h3 className="git-h">WORKING</h3>
            {refRows.map((row, i) => {
              const on = i === refIndex
              if (row.kind === 'working') {
                return (
                  <div key={`w:${row.path}`} role="option" aria-selected={on} className={`git-ref ${on ? 'sel' : ''}`} onClick={() => pickRef(row)} title={row.path}>
                    <span className="git-ref-name">{row.label}</span>
                    {!row.here && <span className="wt-tag">WT</span>}
                    <span className="git-ref-sub mono">{row.sub}</span>
                  </div>
                )
              }
              const b = row.name ? branchOf(row.name) : undefined
              return (
                <div key={`b:${row.name ?? '*'}`} className="git-ref-wrap">
                  {row.name === null && <h3 className="git-h">BRANCHES</h3>}
                  <div role="option" aria-selected={on} className={`git-ref ${on ? 'sel' : ''} ${b?.current ? 'current' : ''}`} onClick={() => pickRef(row)} title={b ? `${b.name} · ${b.subject}${b.worktree ? `\n작업 공간 ${b.worktree}에 체크아웃되어 있어요` : ''}` : '모든 브랜치의 기록을 함께 봐요'}>
                    <span className="git-ref-name">{row.name ?? 'ALL BRANCHES'}</span>
                    {b?.current && <span className="git-head">HEAD</span>}
                    {b?.worktree && <span className="wt-tag">WT</span>}
                    {b && (b.ahead > 0 || b.behind > 0) && (
                      <span className="git-track mono" title={`${b.upstream}보다 앞선 커밋 ${b.ahead}개, 뒤처진 커밋 ${b.behind}개`}>
                        {b.ahead > 0 && `↑${b.ahead}`}
                        {b.behind > 0 && `↓${b.behind}`}
                      </span>
                    )}
                    {b && <span className="git-ref-sub mono">{elapsed(b.date, now)}</span>}
                  </div>
                </div>
              )
            })}
          </div>
          <div
            className={`git-col git-log ${col === 1 ? 'on' : ''}`}
            role="listbox"
            aria-label="커밋 기록"
            tabIndex={0}
            ref={(el) => { colRefs.current[1] = el }}
            onFocus={() => setCol(1)}
            onScroll={(e) => {
              const el = e.currentTarget
              if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) loadMore()
            }}
          >
            <h3 className="git-h">{shownRef === null ? 'ALL BRANCHES' : shownRef}</h3>
            {log && log.ref === shownRef && commits.length === 0 && <div className="empty">커밋이 아직 없어요.</div>}
            {commits.map((c, i) => {
              const on = target?.kind === 'commit' && target.sha === c.sha
              return (
                <div key={c.sha} role="option" aria-selected={on} className={`git-row ${on ? 'sel' : ''}`} onClick={() => setTarget({ kind: 'commit', sha: c.sha })} title={`${c.short} · ${c.author} · ${new Date(c.date).toLocaleString()}`}>
                  <Graph row={graph[i]} lanes={graphLanes} merge={c.parents.length > 1} />
                  <span className="git-sha mono">{c.short}</span>
                  {c.refs.map((x) => (
                    <span key={x} className={`git-badge ${x.startsWith('HEAD') ? 'head' : x.startsWith('tag:') ? 'tag' : ''}`}>{x.replace(/^HEAD -> /, '')}</span>
                  ))}
                  <span className="git-subject">{c.subject}</span>
                  <span className="git-when mono">{elapsed(c.date, now)}</span>
                </div>
              )
            })}
            {log?.more && log.ref === shownRef && (
              <button type="button" className="btn ghost git-more" onClick={loadMore}>
                MORE
              </button>
            )}
          </div>
          <div
            className={`git-col git-diff ${col === 2 ? 'on' : ''}`}
            tabIndex={0}
            aria-label="변경 내용"
            // 포커스가 있어도 입력창으로 끌려가지 않게 (focus.ts의 OWN)
            data-focus-stay="true"
            ref={(el) => {
              colRefs.current[2] = el
              diffRef.current = el as HTMLDivElement | null
            }}
            onFocus={() => setCol(2)}
          >
            {!target && <div className="empty">왼쪽에서 커밋이나 변경을 골라요.</div>}
            {target && !shown && <div className="empty">읽는 중…</div>}
            {shown?.error && <div className="empty">{shown.error}</div>}
            {shown?.data && (
              <>
                <div className="git-meta">
                  {shown.data.commit ? (
                    <>
                      <div className="git-meta-line mono">
                        <b>{shown.data.commit.short}</b> · {shown.data.commit.author} · {new Date(shown.data.commit.date).toLocaleString()}
                        {shown.data.commit.parents.length > 1 && <span className="git-badge">MERGE</span>}
                      </div>
                      <div className="git-meta-subject">{shown.data.commit.subject}</div>
                      {shown.data.commit.body && <pre className="git-meta-body">{shown.data.commit.body}</pre>}
                    </>
                  ) : (
                    <>
                      <div className="git-meta-line mono">
                        <b>UNCOMMITTED</b> · {workingRow?.branch ?? ''} · {workingRow?.path ?? ''}
                      </div>
                      {shown.data.files.length === 0 && <div className="git-meta-subject">커밋하지 않은 변경이 없어요.</div>}
                      {shown.data.files.length > 0 && (
                        <div className="git-commit">
                          <input
                            className="git-commit-input"
                            value={commitMsg}
                            placeholder="커밋 메시지"
                            aria-label="커밋 메시지"
                            spellCheck={false}
                            maxLength={500}
                            onChange={(e) => {
                              setCommitMsg(e.target.value)
                              if (armed === 'commit') setArmed(null)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                e.preventDefault()
                                commit(workingRow?.here ? undefined : workingRow?.path)
                              }
                            }}
                          />
                          <button
                            type="button"
                            className={armed === 'commit' ? 'btn armed' : 'btn-pri'}
                            disabled={busy || writing || !commitMsg.trim()}
                            onClick={() => commit(workingRow?.here ? undefined : workingRow?.path)}
                            title={busy ? busyTip : '바뀐 파일을 모두(새 파일 포함) 커밋해요'}
                          >
                            {armed === 'commit' ? 'COMMIT? 한 번 더' : `COMMIT ${shown.data.files.length} FILES`}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <DiffBody files={shown.data.files} diff={shown.data.diff} />
                {shown.data.truncated && <div className="empty">diff가 너무 길어 앞부분만 보여요.</div>}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
