import { useEffect, useRef, useState } from 'react'
import { MODE_LABEL, STATUS_LABEL, type AgentMode, type PermissionDecision, type PermissionRequest, type Project } from '@shared/types'
import { emptyConversation, type ConversationMap, type TranscriptItem } from './state'
import { HOME_ROW } from './keys'

interface Props {
  project: Project
  projects: Project[]
  conversationId: string
  convs: ConversationMap
  mode: AgentMode
  onSelectConversation: (conversationId: string) => void
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) => void
}

export function Chat({ project, projects, conversationId, convs, mode, onSelectConversation, onRespond }: Props): React.JSX.Element {
  const state = convs[conversationId] ?? emptyConversation()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pending = state.permissions[0]

  // 다른 프로젝트의 승인 대기 (우측 상단 배지)
  const otherWaiting = projects
    .map((p, i) => ({ p, i, n: p.id === project.id ? 0 : p.conversations.filter((c) => convs[c.id]?.status === 'waiting_approval').length }))
    .filter((x) => x.n > 0)

  // 블록 본문 필수: 최신 Chromium의 scrollIntoView()는 Promise를 반환해 React가 정리 함수로 오인한다
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [state.items.length, state.items[state.items.length - 1]])
  // 권한 요청이 오면 입력창에서 포커스를 빼서 Y/A/N이 바로 먹게 한다
  useEffect(() => {
    if (pending) inputRef.current?.blur()
    else inputRef.current?.focus()
  }, [pending?.requestId, conversationId])

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void window.api.send(project.id, conversationId, text)
  }

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">{project.name}</span>
        <nav className="tabs">
          {project.conversations.map((c) => {
            const st = convs[c.id]?.status ?? 'idle'
            return (
              <button key={c.id} className={`tab ${c.id === conversationId ? 'active' : ''}`} onClick={() => onSelectConversation(c.id)}>
                {c.title} <span className={`dot dot-${st}`} title={STATUS_LABEL[st]} />
              </button>
            )
          })}
          <button
            className="tab add"
            title="하위 대화 추가"
            onClick={async () => onSelectConversation((await window.api.addConversation(project.id)).id)}
          >
            +
          </button>
        </nav>
        <span className="spacer" />
        {otherWaiting.map(({ p, i, n }) => (
          <span key={p.id} className="badge badge-waiting_approval">
            <kbd>Alt+{HOME_ROW[i]}</kbd> {p.name} 승인 대기 {n}
          </span>
        ))}
        <span className={`badge badge-${state.status}`}>{STATUS_LABEL[state.status]}</span>
      </header>

      <main className="transcript">
        {state.items.length === 0 && <div className="placeholder">{project.path}에서 대화를 시작하세요.</div>}
        {state.items.map((item, idx) => (
          <Item key={idx} item={item} />
        ))}
        {pending && <PermissionBox req={pending} onRespond={(d) => onRespond(project.id, conversationId, pending.requestId, d)} />}
        <div ref={bottomRef} />
      </main>

      <div className="composer">
        <textarea
          ref={inputRef}
          value={draft}
          rows={3}
          placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-meta">
          <span className={`mode mode-${mode}`}>모드: {MODE_LABEL[mode]}</span>
        </div>
      </div>

      <footer className="hints">
        <span><kbd>Ctrl+H</kbd> 홈</span>
        <span><kbd>Ctrl+Tab</kbd> 하위 대화</span>
        <span><kbd>Alt+A S D F…</kbd> 다른 프로젝트</span>
        <span><kbd>Esc</kbd>/<kbd>Ctrl+[</kbd>/<kbd>Ctrl+C</kbd> 중단</span>
        <span><kbd>Shift+Tab</kbd> 모드</span>
        {pending && <span><kbd>Y</kbd>/<kbd>A</kbd>/<kbd>N</kbd> 허용/항상/거절</span>}
      </footer>
    </div>
  )
}

function Item({ item }: { item: TranscriptItem }): React.JSX.Element {
  switch (item.type) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'assistant':
      return <div className={`msg assistant ${item.streaming ? 'streaming' : ''}`}>{item.text}</div>
    case 'notice':
      return <div className={`msg notice ${item.tone}`}>{item.text}</div>
    case 'tool':
      return (
        <details className={`tool ${item.isError ? 'error' : ''}`}>
          <summary>
            <span className="tool-name">{item.name}</span> <span className="tool-arg">{summarizeInput(item.input)}</span>
            {item.result === undefined && <span className="muted"> 실행 중…</span>}
          </summary>
          <pre className="tool-input">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== undefined && <pre className="tool-result">{item.result}</pre>}
        </details>
      )
  }
}

function PermissionBox({ req, onRespond }: { req: PermissionRequest; onRespond: (d: PermissionDecision) => void }): React.JSX.Element {
  return (
    <div className="permission">
      <div className="permission-title">{req.title ?? `${req.toolName} 실행 권한 요청`}</div>
      {req.description && <div className="permission-desc">{req.description}</div>}
      <pre className="tool-input">{JSON.stringify(req.input, null, 2)}</pre>
      <div className="permission-actions">
        <button onClick={() => onRespond('allow')}>허용 {!req.defaultToNo && <kbd>Y</kbd>}</button>
        {!req.suppressAlwaysAllow && <button onClick={() => onRespond('always')}>항상 허용 {!req.defaultToNo && <kbd>A</kbd>}</button>}
        <button className="deny" onClick={() => onRespond('deny')}>거절 <kbd>N</kbd></button>
      </div>
      {req.defaultToNo && <div className="muted">이 요청은 단축키로 승인할 수 없습니다. 버튼을 클릭하세요.</div>}
    </div>
  )
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
  return typeof v === 'string' ? v.slice(0, 120) : ''
}
