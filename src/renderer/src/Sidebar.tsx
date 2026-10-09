import { useState } from 'react'
import { openConversations, type Project, type UsageInfo, type UsageWindow } from '@shared/types'
import { STATUS_LABEL } from '@shared/types'
import { ALT_LABEL, HOME_ROW } from './keys'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'
import { isActive, projectStatus, STAGES, type ConversationMap } from './state'

interface Props {
  projects: Project[]
  convs: ConversationMap
  activeProjectId: string | null
  activeConversationId: string | null
  unreadTotal: number
  usage: UsageInfo | null
  onRefreshUsage: () => Promise<unknown>
  onHome: () => void
  onSettings: () => void
  settingsOpen: boolean
  onOpenProject: (index: number) => void
  onOpenConversation: (projectId: string, conversationId: string) => void
  onAddProject: () => void
  /** 닫기 확인을 기다리는 프로젝트 (× 또는 단축키 한 번) */
  armedProjectId: string | null
  onRemoveProjectRequest: (projectId: string) => void
}

export function Sidebar(props: Props): React.JSX.Element {
  const km = useKeymap()
  const { projects, convs, activeProjectId, activeConversationId, unreadTotal, usage } = props
  return (
    <nav className="side" aria-label="프로젝트">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">WT<b>_</b></span>
        <span className="brand-name">WHENTERMINAL</span>
      </div>

      <button type="button" className={`nav nav-home ${activeProjectId === null && !props.settingsOpen ? 'on' : ''}`} onClick={props.onHome}>
        <span className="nav-name">HOME</span>
        {unreadTotal > 0 && <span className="pill">{unreadTotal}</span>}
        <Keys keys={km.goHome} />
      </button>

      <div className="side-label">
        <span>PROJECTS</span>
        <button type="button" className="side-add" onClick={props.onAddProject} title="프로젝트 추가 (Ctrl+N)">
          + ADD
        </button>
      </div>

      {projects.map((p, i) => {
        const status = projectStatus(p, convs)
        const on = p.id === activeProjectId
        const unread = p.conversations.filter((c) => convs[c.id]?.task?.unread).length
        const live = p.conversations.map((c) => convs[c.id]).find((s) => s && isActive(s.status) && s.task)
        const progress = live?.task ? Math.min(1, (live.task.stage + 0.5) / STAGES.length) : 0
        return (
          <div key={p.id} className={`side-project ${props.armedProjectId === p.id ? 'armed' : ''}`}>
            <div className="side-row">
            <button type="button" className={`nav ${on ? 'on' : ''}`} onClick={() => props.onOpenProject(i)} title={`${p.path}\n${ALT_LABEL}+${HOME_ROW[i] ?? '-'}`}>
              <span className="nav-key">{HOME_ROW[i] ?? ''}</span>
              <span className="nav-name">{p.name}</span>
              {unread > 0 && <span className="pill">{unread}</span>}
              {live ? (
                <span className={`minibar ${status === 'waiting_approval' ? 'wait' : ''}`} role="img" aria-label={`${STATUS_LABEL[status]} · 진행 ${Math.round(progress * 100)}%`}>
                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
              ) : (
                <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} />
              )}
            </button>
            <button
              type="button"
              className="side-x"
              aria-label={props.armedProjectId === p.id ? '한 번 더 누르면 닫혀요' : `${p.name} 프로젝트 닫기`}
              title={props.armedProjectId === p.id ? '한 번 더 누르면 목록에서 닫혀요. 폴더와 파일은 그대로예요' : `프로젝트 닫기 (${km.closeProject} 두 번)`}
              onClick={() => props.onRemoveProjectRequest(p.id)}
            >
              {props.armedProjectId === p.id ? 'CLOSE?' : '×'}
            </button>
            </div>
            {on && openConversations(p).length > 1 && (
              <div className="threads">
                {openConversations(p).map((c) => {
                  const st = convs[c.id]?.status ?? 'idle'
                  return (
                    <button
                      type="button"
                      key={c.id}
                      className={`thread ${c.id === activeConversationId ? 'on' : ''}`}
                      onClick={() => props.onOpenConversation(p.id, c.id)}
                    >
                      <span className="nav-name">{c.title}</span>
                      <CtxPct percent={convs[c.id]?.context?.percent ?? c.contextPercent} />
                      <span className={`dot dot-${st}`} title={STATUS_LABEL[st]} />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <span className="side-spacer" />

      <button type="button" className={`nav nav-settings ${props.settingsOpen ? 'on' : ''}`} onClick={props.onSettings}>
        <span className="nav-name">SETTINGS</span>
        <Keys keys={km.openSettings} />
      </button>

      <Usage usage={usage} onRefresh={props.onRefreshUsage} />
    </nav>
  )
}

/** 컨텍스트 사용률. 80% 이상이면 빨강 */
function CtxPct({ percent }: { percent?: number }): React.JSX.Element | null {
  if (percent === undefined) return null
  return <span className={`ctx-pct ${percent >= 80 ? 'hot' : ''}`} title="컨텍스트 사용률">{percent}%</span>
}

/** 구독 한도: 5시간 · 주간 · 모델별 주간. 80% 이상이거나 한도 경고가 오면 빨강 */
function Usage({ usage, onRefresh }: { usage: UsageInfo | null; onRefresh: () => Promise<unknown> }): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const refresh = (): void => {
    if (loading) return
    setLoading(true)
    void onRefresh().finally(() => setLoading(false))
  }
  return (
    <div className="usage" aria-label="구독 한도">
      <div className="usage-head">
        <span>USAGE</span>
        {usage?.plan && <span className="usage-plan">{usage.plan.toUpperCase()}</span>}
        <button type="button" className={`usage-refresh ${loading ? 'spin' : ''}`} onClick={refresh} aria-label="한도 새로 고침" title="새로 고침">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" />
          </svg>
        </button>
      </div>
      {!usage && <div className="usage-foot">불러오는 중…</div>}
      {usage && !usage.available && <div className="usage-foot">API 키로 인증 중이라 구독 한도가 없어요</div>}
      {usage?.available && usage.windows.length === 0 && <div className="usage-foot">한도 정보가 없어요</div>}
      {usage?.windows.map((w, i) => <UsageRow key={w.id} w={w} big={i === 0} />)}
      {usage?.error && <div className="usage-foot err">{usage.error}</div>}
    </div>
  )
}

function UsageRow({ w, big }: { w: UsageWindow; big: boolean }): React.JSX.Element {
  const hot = (w.percent ?? 0) >= 80 || w.status === 'allowed_warning' || w.status === 'rejected'
  return (
    <div className={`uw ${big ? 'uw-big' : ''} ${hot ? 'hot' : ''}`} title={w.status === 'rejected' ? '한도에 도달했어요' : undefined}>
      <div className="uw-top">
        <span className="uw-label">{w.label}</span>
        <b>{w.percent !== null ? `${w.percent}%` : '–'}</b>
      </div>
      <div className="meter">
        <i style={{ width: `${Math.min(100, w.percent ?? 0)}%` }} />
      </div>
      {w.resetsAt && <div className="uw-reset">{formatReset(w.resetsAt)}</div>}
    </div>
  )
}

/** 하루 안이면 '17:40 초기화 · 2시간 뒤', 그 뒤면 '10/14(화) 09:00 초기화' */
function formatReset(ms: number): string {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const left = ms - Date.now()
  if (left < 24 * 3600_000) {
    const h = Math.floor(left / 3600_000)
    const m = Math.max(0, Math.round((left % 3600_000) / 60_000))
    return `${hm} 초기화 · ${h > 0 ? `${h}시간 ` : ''}${m}분 뒤`
  }
  return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]}) ${hm} 초기화`
}
