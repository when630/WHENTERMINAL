import { useEffect, useState } from 'react'
import { Presence } from './motion'
import type { WorktreeChanges } from '@shared/types'

interface Props {
  projectId: string
  conversationId: string
  /** 대화가 끝나 변경이 생겼을 수 있을 때마다 바뀌는 값 (다시 읽기용) */
  refreshKey: string
  onClose: () => void
  onDiscarded: (nextConversationId: string) => void
}

export const STATUS_LABEL: Record<string, string> = { A: 'NEW', M: 'MODIFIED', D: 'DELETED', R: 'RENAMED', C: 'COPIED' }

/** unified diff → 파일별 묶음 */
export function splitDiff(diff: string): { path: string; lines: string[] }[] {
  const out: { path: string; lines: string[] }[] = []
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (m) {
      out.push({ path: m[2], lines: [] })
      continue
    }
    if (!out.length || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to))/.test(line)) continue
    out[out.length - 1].lines.push(line)
  }
  return out
}

/**
 * 하위 대화의 작업 공간(git worktree) 변경: 파일 목록·diff, 합치기, 버리기(두 번).
 * 합치기는 커밋 안 한 변경을 대화 제목으로 커밋하고 프로젝트의 현재 브랜치에 --no-ff로 병합한다
 */
export function WorktreePanel({ projectId, conversationId, refreshKey, onClose, onDiscarded }: Props): React.JSX.Element {
  const [data, setData] = useState<WorktreeChanges | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [armed, setArmed] = useState(false)

  const load = (): void => {
    void window.api.worktreeChanges(projectId, conversationId).then(setData)
  }
  useEffect(load, [projectId, conversationId, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 앱(편집기·터미널)에서 고치고 돌아오면 다시 읽는다
  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [projectId, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])

  const merge = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.worktreeMerge(projectId, conversationId)
    setMessage({ ok: res.ok, text: res.message })
    setBusy(false)
    load()
  }
  const discard = async (): Promise<void> => {
    if (!armed) return setArmed(true)
    setBusy(true)
    onDiscarded(await window.api.worktreeDiscard(projectId, conversationId))
  }

  const nothing = !!data && data.files.length === 0 && data.ahead === 0

  return (
    <section className="wt-panel" aria-label="작업 공간 변경">
      <header className="wt-head">
        <div className="wt-title">
          <span className="kr">CHANGES</span>
          {data && (
            <span className="mono">
              {data.branch} → {data.target}
            </span>
          )}
        </div>
        <div className="wt-actions">
          <button type="button" className="btn-pri" disabled={busy || !data || nothing} onClick={() => void merge()}>
            {data?.dirty ? 'COMMIT & MERGE' : 'MERGE'}
          </button>
          <button type="button" className={`btn ${armed ? 'armed' : ''}`} disabled={busy || !data} onClick={() => void discard()}>
            {armed ? 'DISCARD? 한 번 더' : 'DISCARD'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={load} title="변경을 다시 읽어요">
            REFRESH
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            BACK TO CHAT
          </button>
        </div>
      </header>
      <Presence as="div" show={!!message} className={`wt-msg ${message?.ok ? 'ok' : 'bad'}`} role="status">{message?.text}</Presence>
      <div className="wt-body">
        {data === undefined && <div className="empty">변경을 읽는 중…</div>}
        {data === null && <div className="empty">작업 공간이 없는 대화예요.</div>}
        {nothing && <div className="empty">바뀐 것이 없어요. {data!.target} 브랜치와 같아요.</div>}
        {data && data.files.length === 0 && data.ahead > 0 && <div className="empty">커밋 {data.ahead}개가 아직 {data.target} 브랜치에 들어가지 않았어요.</div>}
        {data && <DiffBody files={data.files} diff={data.diff} />}
        {data?.truncated && <div className="empty">diff가 너무 길어 앞부분만 보여요.</div>}
      </div>
    </section>
  )
}

/** +12 −3 (바뀐 줄이 없으면 그리지 않는다) */
function DiffCount({ n }: { n?: { add: number; del: number } }): React.JSX.Element | null {
  if (!n || (!n.add && !n.del)) return null
  return (
    <span className="diff-count mono">
      {n.add > 0 && <span className="plus">+{n.add}</span>}
      {n.del > 0 && <span className="minus">−{n.del}</span>}
    </span>
  )
}

/** 바뀐 파일 목록과 파일별 diff (작업 공간 CHANGES·git 화면). 목록의 파일을 누르면 그 diff로 */
export function DiffBody({ files, diff }: { files: { path: string; status: string }[]; diff: string }): React.JSX.Element {
  const parts = splitDiff(diff)
  // 파일마다 더한 줄·뺀 줄 수 (머리줄 ---/+++는 splitDiff가 이미 뺐다)
  const counts = new Map(parts.map((f) => [f.path, { add: f.lines.filter((l) => l.startsWith('+')).length, del: f.lines.filter((l) => l.startsWith('-')).length }]))
  const jump = (path: string, e: React.MouseEvent): void => {
    const box = (e.currentTarget as HTMLElement).closest('.wt-diffs')
    box?.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  return (
    <div className="wt-diffs">
      {files.length > 0 && (
        <ul className="wt-files">
          {files.map((f) => (
            <li key={f.path} onClick={(e) => jump(f.path, e)}>
              <span className={`wt-st st-${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
              <span className="mono">{f.path}</span>
              <DiffCount n={counts.get(f.path)} />
            </li>
          ))}
        </ul>
      )}
      {parts.map((f) => (
        <div key={f.path} className="wt-file" data-diff-path={f.path}>
          <div className="wt-file-h mono">
            <span>{f.path}</span>
            <DiffCount n={counts.get(f.path)} />
          </div>
          <pre className="wt-diff">
            {/* 줄마다 블록이라 줄바꿈 글자 없이도 복사하면 줄이 나뉜다. 바뀐 줄은 칸 폭 전체에 색을 깐다 */}
            {f.lines.map((l, i) => (
              <span key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'}>
                {l}
              </span>
            ))}
          </pre>
        </div>
      ))}
    </div>
  )
}
