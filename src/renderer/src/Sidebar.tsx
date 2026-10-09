import type { Project, RateLimitInfo } from '@shared/types'
import { STATUS_LABEL } from '@shared/types'
import { HOME_ROW } from './keys'
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
        <span className="brand-mark">W</span>
        WHENTERMINAL
      </div>

      <button type="button" className={`nav ${activeProjectId === null ? 'on' : ''}`} onClick={props.onHome}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 10.5L12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
        </svg>
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
            <button type="button" className={`nav ${on ? 'on' : ''}`} onClick={() => props.onOpenProject(i)} title={`${p.path}\nAlt+${HOME_ROW[i] ?? '-'}`}>
              <span className="nav-key">{HOME_ROW[i] ?? ''}</span>
              <span className="nav-name">{p.name}</span>
              {unread > 0 && <span className="pill">{unread}</span>}
              {live ? (
                <svg className="ring" viewBox="0 0 16 16" aria-label={`진행 ${Math.round(progress * 100)}%`}>
                  <circle className="ring-bg" cx="8" cy="8" r="6" />
                  <circle className={`ring-fg ${status === 'waiting_approval' ? 'wait' : ''}`} cx="8" cy="8" r="6" strokeDasharray="37.7" strokeDashoffset={37.7 * (1 - progress)} />
                </svg>
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
          <span>구독 {rateLimit ? (LIMIT_LABEL[rateLimit.rateLimitType ?? ''] ?? rateLimit.rateLimitType ?? '') : ''} 한도</span>
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

function formatReset(t: number): string {
  // SDK 값이 초 단위인지 밀리초 단위인지 명시돼 있지 않아 크기로 구분한다
  const d = new Date(t > 1e12 ? t : t * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
