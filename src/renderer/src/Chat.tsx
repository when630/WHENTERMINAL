import { useEffect, useRef, useState } from 'react'
import { MODE_LABEL, STATUS_LABEL, type AgentMode, type PermissionDecision, type PermissionRequest, type Project } from '@shared/types'
import { emptyConversation, type ConversationMap, type TranscriptItem } from './state'
import { ALT_LABEL, HOME_ROW } from './keys'

interface Props {
  project: Project
  projects: Project[]
  conversationId: string
  convs: ConversationMap
  mode: AgentMode
  /** Ctrl+L을 한 번 눌러 클리어 확인을 기다리는 중 */
  clearArmed: boolean
  onClearRequest: () => void
  onSelectConversation: (conversationId: string) => void
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) => void
}

export function Chat({ project, projects, conversationId, convs, mode, clearArmed, onClearRequest, onSelectConversation, onRespond }: Props): React.JSX.Element {
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

  const conv = project.conversations.find((c) => c.id === conversationId)
  const ctxPercent = state.context?.percent ?? conv?.contextPercent
  const autoAt = state.context?.autoCompactAt
  const busy = state.status === 'running' || state.status === 'waiting_approval'
  const hot = ctxPercent !== undefined && ctxPercent >= (autoAt !== undefined ? autoAt - 10 : 80)
  const canCompact = !busy && !state.compacting && (!!conv?.sessionId || state.items.length > 0)

  const compact = (instructions?: string): void => {
    void window.api.compact(project.id, conversationId, instructions)
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    // CLI와 같은 슬래시 명령: /compact [요약 지시], /clear
    const cmd = /^\/(compact|clear|reset|new)\b\s*([\s\S]*)$/.exec(text)
    if (cmd) {
      setDraft('')
      if (cmd[1] === 'compact') compact(cmd[2])
      else void window.api.clear(project.id, conversationId)
      return
    }
    setDraft('')
    void window.api.send(project.id, conversationId, text)
  }

  const projectIndex = projects.findIndex((p) => p.id === project.id)
  let toolCount = 0

  return (
    <div className="screen">
      <header className="topbar">
        <div className="tb-proj">
          <span className="tb-key" aria-hidden="true">{HOME_ROW[projectIndex] ?? ''}</span>
          <span className="tb-name">
            <b>{project.name}</b>
            <span>{project.path}</span>
          </span>
        </div>
        <div className="tb-right">
          {otherWaiting.map(({ p, i, n }) => (
            <span key={p.id} className="badge other">
              <kbd>{ALT_LABEL}+{HOME_ROW[i]}</kbd> {p.name} 승인 대기 {n}
            </span>
          ))}
          <div className={`ctx ${hot ? 'hot' : ''}`} title={state.context ? `${state.context.tokens.toLocaleString()} / ${state.context.max.toLocaleString()} 토큰${autoAt ? ` · ${autoAt}%에서 자동 컴팩트` : ''}` : '첫 응답 뒤에 표시'}>
            <span className="ctx-label">컨텍스트</span>
            <b>{ctxPercent !== undefined ? `${ctxPercent}%` : '–'}</b>
            <span className="ctx-bar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, ctxPercent ?? 0)}%` }} />
              {autoAt !== undefined && <em style={{ left: `${autoAt}%` }} />}
            </span>
          </div>
          <button type="button" className="tb-btn" disabled={!canCompact} onClick={() => compact()} title="대화를 요약해 컨텍스트를 줄입니다 (/compact)">
            {state.compacting ? '컴팩트 중' : '컴팩트'} <kbd>Ctrl⇧L</kbd>
          </button>
          <button type="button" className={`tb-btn ${clearArmed ? 'armed' : ''}`} onClick={onClearRequest} title="컨텍스트를 비우고 새 세션으로 시작합니다 (/clear)">
            {clearArmed ? '한 번 더' : '클리어'} <kbd>Ctrl L</kbd>
          </button>
          <span className={`badge badge-${state.status}`}>{STATUS_LABEL[state.status]}</span>
        </div>
        <nav className="tabs" aria-label="하위 대화">
          {project.conversations.map((c, i) => {
            const st = convs[c.id]?.status ?? 'idle'
            return (
              <button key={c.id} type="button" className={`tab ${c.id === conversationId ? 'active' : ''}`} onClick={() => onSelectConversation(c.id)} title={STATUS_LABEL[st]}>
                <span className="tab-n">{String(i + 1).padStart(2, '0')}</span>
                <span className="tab-t">{c.title}</span>
                <span className={`dot dot-${st}`} />
              </button>
            )
          })}
          <button
            type="button"
            className="tab add"
            title="하위 대화 추가"
            aria-label="하위 대화 추가"
            onClick={async () => onSelectConversation((await window.api.addConversation(project.id)).id)}
          >
            +
          </button>
        </nav>
      </header>

      <main className="transcript">
        {state.items.length === 0 && (
          <div className="placeholder">
            무엇을 할까요?
            <span className="mono">{project.path}</span>
          </div>
        )}
        {state.items.map((item, idx) => (
          <Item key={idx} item={item} n={item.type === 'tool' ? ++toolCount : 0} root={project.path} />
        ))}
        {state.compacting && <div className="msg compacting">컴팩트 중 · 지금까지의 대화를 요약하고 있어요</div>}
        {pending && <PermissionBox key={pending.requestId} req={pending} onRespond={(d) => onRespond(project.id, conversationId, pending.requestId, d)} />}
        <div ref={bottomRef} />
      </main>

      {clearArmed && (
        <div className="confirm" role="alert">
          <b>Ctrl L</b> 을 한 번 더 누르면 컨텍스트를 비우고 새 세션으로 시작합니다
        </div>
      )}
      <div className="composer">
        <span className="composer-prompt" aria-hidden="true">&gt;</span>
        <div className="composer-body">
          <label htmlFor="composer-input" className="sr-only">메시지</label>
          <textarea
            id="composer-input"
            ref={inputRef}
            value={draft}
            rows={2}
            placeholder="메시지 입력 · /compact 요약 · /clear 비우기"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-meta">
            <span className={`mode mode-${mode}`}>{MODE_LABEL[mode]} <kbd>Shift+Tab</kbd></span>
          </div>
        </div>
      </div>

      <footer className="hints">
        <span><kbd>Ctrl H</kbd> 홈</span>
        <span><kbd>Ctrl Tab</kbd> 하위 대화</span>
        <span><kbd>{ALT_LABEL} A S D…</kbd> 다른 프로젝트</span>
        <span><kbd>Esc</kbd> 중단</span>
        <span><kbd>Ctrl L</kbd> 클리어</span>
        <span><kbd>Ctrl⇧L</kbd> 컴팩트</span>
        {pending && <span><kbd>Y A N</kbd> 허용 · 항상 · 거절</span>}
      </footer>
    </div>
  )
}

function Item({ item, n, root }: { item: TranscriptItem; n: number; root: string }): React.JSX.Element {
  switch (item.type) {
    case 'user':
      return <div className="msg user">{item.text}</div>
    case 'assistant':
      return <div className={`msg assistant ${item.streaming ? 'streaming' : ''}`}>{item.text}</div>
    case 'notice':
      return <div className={`msg notice ${item.tone}`}>{item.text}</div>
    case 'divider':
      return <div className="divider" role="separator">■ {item.text}</div>
    case 'tool': {
      const status = item.result === undefined ? '실행 중' : item.isError ? '오류' : '완료'
      return (
        <details className={`tool ${item.isError ? 'error' : ''}`}>
          <summary>
            <span className="tool-n">{String(n).padStart(2, '0')}</span>
            <span className="tool-name">{item.name}</span>
            <span className="tool-arg">{relPath(summarizeInput(item.input), root)}</span>
            <span className={`tool-st ${item.result === undefined ? 'run' : ''}`}>{status}</span>
          </summary>
          <div className="tool-body">
            <ToolInput name={item.name} input={item.input} />
            {item.result !== undefined && (
              <>
                <h5>결과</h5>
                <pre>{item.result || '(출력 없음)'}</pre>
              </>
            )}
          </div>
        </details>
      )
    }
  }
}

const DIFF_LINE_LIMIT = 60

/** 파일 수정 도구는 바뀐 줄을 diff로, 그 밖의 도구는 입력값을 그대로 보여준다 */
function ToolInput({ name, input }: { name: string; input: unknown }): React.JSX.Element {
  const o = (input ?? {}) as Record<string, unknown>
  const edits: { old: string; neu: string }[] =
    typeof o.old_string === 'string' && typeof o.new_string === 'string'
      ? [{ old: o.old_string, neu: o.new_string }]
      : Array.isArray(o.edits)
        ? (o.edits as Record<string, unknown>[]).filter((e) => typeof e.old_string === 'string').map((e) => ({ old: String(e.old_string), neu: String(e.new_string ?? '') }))
        : name === 'Write' && typeof o.content === 'string'
          ? [{ old: '', neu: o.content }]
          : []
  if (edits.length === 0) {
    return (
      <>
        <h5>입력</h5>
        <pre>{JSON.stringify(input, null, 2)}</pre>
      </>
    )
  }
  const lines = edits.flatMap((e) => [
    ...(e.old ? e.old.split('\n').map((t) => ({ k: 'del', t })) : []),
    ...e.neu.split('\n').map((t) => ({ k: 'add', t })),
  ])
  return (
    <>
      <h5>변경 · {typeof o.file_path === 'string' ? o.file_path : ''}</h5>
      <div className="diff">
        {lines.slice(0, DIFF_LINE_LIMIT).map((l, i) => (
          <span key={i} className={l.k}>{l.k === 'add' ? '+ ' : '- '}{l.t}</span>
        ))}
        {lines.length > DIFF_LINE_LIMIT && <span className="muted">… {lines.length - DIFF_LINE_LIMIT}줄 더</span>}
      </div>
    </>
  )
}

function PermissionBox({ req, onRespond }: { req: PermissionRequest; onRespond: (d: PermissionDecision) => void }): React.JSX.Element {
  return (
    <div className="permission" role="alert">
      <div className="permission-head">
        <span className="q" aria-hidden="true">?</span>
        <div>
          <div className="permission-title">{req.title ?? `${req.toolName} 실행할까요`}</div>
          {req.description && <div className="permission-desc">{req.description}</div>}
        </div>
      </div>
      <pre>{JSON.stringify(req.input, null, 2)}</pre>
      <div className="permission-actions">
        <button type="button" onClick={() => onRespond('allow')}>허용 {!req.defaultToNo && <kbd>Y</kbd>}</button>
        {!req.suppressAlwaysAllow && <button type="button" onClick={() => onRespond('always')}>항상 허용 {!req.defaultToNo && <kbd>A</kbd>}</button>}
        <button type="button" onClick={() => onRespond('deny')}>거절 <kbd>N</kbd></button>
      </div>
      {req.defaultToNo && <div className="muted">이 요청은 단축키로 승인할 수 없습니다. 버튼을 클릭하세요.</div>}
    </div>
  )
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 120) : ''
}

/** 프로젝트 폴더 안의 경로는 앞부분을 떼고 보여준다 */
function relPath(text: string, root: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const t = text.replace(/\\/g, '/')
  return t.toLowerCase().startsWith(r.toLowerCase() + '/') ? t.slice(r.length + 1) : text
}
