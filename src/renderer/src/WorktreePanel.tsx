import { useEffect, useState } from 'react'
import type { WorktreeChanges } from '@shared/types'

interface Props {
  projectId: string
  conversationId: string
  /** 대화가 끝나 변경이 생겼을 수 있을 때마다 바뀌는 값 (다시 읽기용) */
  refreshKey: string
  onClose: () => void
  onDiscarded: (nextConversationId: string) => void
}

const STATUS_LABEL: Record<string, string> = { A: '새 파일', M: '수정', D: '삭제', R: '이름 바꿈', C: '복사' }

/** unified diff → 파일별 묶음 */
function splitDiff(diff: string): { path: string; lines: string[] }[] {
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

  const files = data ? splitDiff(data.diff) : []
  const nothing = !!data && data.files.length === 0 && data.ahead === 0

  return (
    <section className="wt-panel" aria-label="작업 공간 변경">
      <header className="wt-head">
        <div className="wt-title">
          <span className="kr">변경</span>
          {data && (
            <span className="mono">
              {data.branch} → {data.target}
            </span>
          )}
        </div>
        <div className="wt-actions">
          <button type="button" className="btn-pri" disabled={busy || !data || nothing} onClick={() => void merge()}>
            {data?.dirty ? '커밋하고 합치기' : '합치기'}
          </button>
          <button type="button" className={`btn ${armed ? 'armed' : ''}`} disabled={busy || !data} onClick={() => void discard()}>
            {armed ? '한 번 더 누르면 버려요' : '버리기'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={load} title="변경 다시 읽기">
            새로 고침
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            대화로 돌아가기
          </button>
        </div>
      </header>
      {message && <div className={`wt-msg ${message.ok ? 'ok' : 'bad'}`} role="status">{message.text}</div>}
      <div className="wt-body">
        {data === undefined && <div className="empty">변경을 읽는 중…</div>}
        {data === null && <div className="empty">작업 공간이 없는 대화예요.</div>}
        {nothing && <div className="empty">바뀐 것이 없어요. {data!.target} 브랜치와 같아요.</div>}
        {data && data.files.length === 0 && data.ahead > 0 && <div className="empty">커밋 {data.ahead}개가 아직 {data.target} 브랜치에 들어가지 않았어요.</div>}
        {data && data.files.length > 0 && (
          <ul className="wt-files">
            {data.files.map((f) => (
              <li key={f.path}>
                <span className={`wt-st st-${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
                <span className="mono">{f.path}</span>
              </li>
            ))}
          </ul>
        )}
        {files.map((f) => (
          <div key={f.path} className="wt-file">
            <div className="wt-file-h mono">{f.path}</div>
            <pre className="wt-diff">
              {f.lines.map((l, i) => (
                <span key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                  {l}
                  {'\n'}
                </span>
              ))}
            </pre>
          </div>
        ))}
        {data?.truncated && <div className="empty">diff가 너무 길어 앞부분만 보여요.</div>}
      </div>
    </section>
  )
}
