import type { Project, RateLimitInfo } from '@shared/types'
import { STATUS_LABEL } from '@shared/types'
import { ALT_LABEL, HOME_ROW } from './keys'
import { isActive, projectStatus, STAGES, type ConversationMap } from './state'

interface Props {
  projects: Project[]
  convs: ConversationMap
  activeProjectId: string | null
  activeConversationId: string | null
  unreadTotal: number
  rateLimit: RateLimitInfo | null
  onHome: () => void
  onOpenProject: (index: number) => void
  onOpenConversation: (projectId: string, conversationId: string) => void
  onAddProject: () => void
}

const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '7일',
  seven_day_opus: '7일 Opus',
  seven_day_sonnet: '7일 Sonnet',
  overage: '초과 사용',
}

export function Sidebar(props: Props): React.JSX.Element {
  const { projects, convs, activeProjectId, activeConversationId, unreadTotal, rateLimit } = props
  return (
    <nav className="side" aria-label="프로젝트">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">WT<b>_</b></span>
        <span className="brand-name">WHENTERMINAL</span>
      </div>

      <button type="button" className={`nav nav-home ${activeProjectId === null ? 'on' : ''}`} onClick={props.onHome}>
        <span className="nav-name">홈</span>
        {unreadTotal > 0 && <span className="pill">{unreadTotal}</span>}
        <kbd>Ctrl H</kbd>
      </button>

      <div className="side-label">
        <span>프로젝트</span>
        <button type="button" className="side-add" onClick={props.onAddProject} title="프로젝트 추가 (Ctrl+N)">
          + 추가
        </button>
      </div>

      {projects.map((p, i) => {
        const status = projectStatus(p, convs)
        const on = p.id === activeProjectId
        const unread = p.conversations.filter((c) => convs[c.id]?.task?.unread).length
        const live = p.conversations.map((c) => convs[c.id]).find((s) => s && isActive(s.status) && s.task)
        const progress = live?.task ? Math.min(1, (live.task.stage + 0.5) / STAGES.length) : 0
        return (
          <div key={p.id} className="side-project">
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
            {on && p.conversations.length > 1 && (
              <div className="threads">
                {p.conversations.map((c) => {
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

      <div className="usage">
        <div className="usage-top">
          <span>구독 {rateLimit ? (LIMIT_LABEL[rateLimit.rateLimitType ?? ''] ?? rateLimit.rateLimitType ?? '') : ''}<br />한도</span>
          <b className={rateLimit?.status === 'rejected' ? 'danger' : rateLimit?.status === 'allowed_warning' ? 'warn' : ''}>
            {rateLimit?.utilization !== undefined ? `${Math.round(rateLimit.utilization * 100)}%` : '–'}
          </b>
        </div>
        <div className="meter">
          <i
            className={rateLimit?.status === 'allowed_warning' || rateLimit?.status === 'rejected' ? 'warn' : ''}
            style={{ width: `${Math.round((rateLimit?.utilization ?? 0) * 100)}%` }}
          />
        </div>
        <div className="usage-foot">
          {rateLimit?.resetsAt ? `${formatReset(rateLimit.resetsAt)} 초기화` : '첫 응답 후 표시'}
        </div>
      </div>
    </nav>
  )
}

/** 컨텍스트 사용률. 80% 이상이면 빨강 */
function CtxPct({ percent }: { percent?: number }): React.JSX.Element | null {
  if (percent === undefined) return null
  return <span className={`ctx-pct ${percent >= 80 ? 'hot' : ''}`} title="컨텍스트 사용률">{percent}%</span>
}

function formatReset(t: number): string {
  // SDK 값이 초 단위인지 밀리초 단위인지 명시돼 있지 않아 크기로 구분한다
  const d = new Date(t > 1e12 ? t : t * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
