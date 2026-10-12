import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { needsChoice, type EffortInfo, type EffortLevel, type PermissionDecision, type PermissionExtra, type Project, type UsageInfo } from '@shared/types'
import { emptyConversation, type ConversationMap } from './state'
import { Item, PermissionBox, Working } from './Chat'
import { EffortPicker, ModelPicker } from './ModelPicker'
import { useDraft } from './drafts'
import { isEscape, matches, physicalCode } from './keys'
import { useKeymap } from './settings'
import { usePresence } from './motion'

interface Props {
  convs: ConversationMap
  usage: UsageInfo | null
  leaving: boolean
  onClose: () => void
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision, extra?: PermissionExtra) => void
}

/**
 * 프로젝트 없이 묻는 질문 창 (키맵 quickAsk). 숨은 프로젝트(QUICK_PROJECT_ID)의 대화 하나를 이어 쓴다.
 * 읽기·웹 도구만 쓰므로 승인창은 거의 뜨지 않는다. Esc는 답하는 중이면 멈춤, 아니면 닫기. 클리어는 두 번
 */
export function QuickAsk({ convs, usage, leaving, onClose, onRespond }: Props): React.JSX.Element {
  const km = useKeymap()
  // 세션 ID·모델 선택은 메인에 저장되어 있으므로 열 때마다 새로 읽는다
  const [project, setProject] = useState<Project | null>(null)
  useEffect(() => {
    void window.api.quickProject().then(setProject)
  }, [])
  const conv = project?.conversations[0]
  const conversationId = conv?.id ?? ''
  const state = (conversationId && convs[conversationId]) || emptyConversation()
  const [draft, setDraft] = useDraft('quick')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const busy = state.status === 'running' || state.status === 'waiting_approval'
  const pending = state.permissions[0]
  const permission = usePresence(pending)
  const working = usePresence(state.status === 'running' && !state.compacting ? true : null)

  // 지난 대화를 되살리고 컨텍스트·모델을 읽는다 (대화창과 같게)
  useEffect(() => {
    if (!project || !conv) return
    if (!state.context) void window.api.peek(project.id, conv.id)
    if (state.items.length === 0 && conv.sessionId) void window.api.loadHistory(project.id, conv.id)
  }, [project?.id, conv?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const model = state.model ?? (conv?.model ? { id: conv.model, label: conv.modelLabel ?? conv.model } : undefined)
  const [effort, setEffortInfo] = useState<EffortInfo | null>(null)
  // 모델·effort를 고르면 메인 저장값이 바뀌므로 대화 정보도 다시 읽는다
  const refresh = useCallback(() => void window.api.quickProject().then(setProject), [])
  useEffect(() => {
    if (!project || !conv) return
    let alive = true
    void window.api.getEffort(project.id, conv.id).then((info) => alive && setEffortInfo(info))
    return () => {
      alive = false
    }
  }, [project?.id, conv?.id, model?.id, conv?.modelChoice]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state.model) refresh()
  }, [state.model?.id, refresh])

  // 입력창은 글이 늘면 따라 커진다
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  // 맨 아래를 보고 있을 때만 따라 내려간다
  const stick = useRef(true)
  const lastItem = state.items[state.items.length - 1]
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stick.current) return
    const streaming = lastItem?.type === 'assistant' && lastItem.streaming
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'instant' : 'smooth' })
  }, [state.items.length, lastItem, !!permission.item, working.item])

  // 열 때·확인 요청이 끝났을 때 입력창으로. 확인 요청이 오면 Y/A/N을 위해 비운다
  useEffect(() => {
    if (pending) inputRef.current?.blur()
    else inputRef.current?.focus()
  }, [pending?.requestId, project?.id])

  // 이 창을 연 뒤에 들어온 항목만 등장 애니메이션
  const seen = useRef<number | null>(null)
  if (seen.current === null && project) seen.current = state.items.length
  if (seen.current !== null && state.items.length < seen.current) seen.current = 0
  if ((state.restored ?? 0) > (seen.current ?? 0)) seen.current = state.restored!

  // 클리어는 3초 안에 두 번
  const [armed, setArmed] = useState(false)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (armTimer.current) clearTimeout(armTimer.current)
  }, [])
  const clear = (): void => {
    if (!project || !conv) return
    if (armTimer.current) clearTimeout(armTimer.current)
    if (!armed) {
      setArmed(true)
      armTimer.current = setTimeout(() => setArmed(false), 3000)
      return
    }
    setArmed(false)
    void window.api.clear(project.id, conv.id).then(refresh)
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text || !project || !conv) return
    if (text === '/clear') {
      setDraft('')
      void window.api.clear(project.id, conv.id).then(refresh)
      return
    }
    const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text)
    if (compact) {
      setDraft('')
      void window.api.compact(project.id, conv.id, compact[1])
      return
    }
    setDraft('')
    stick.current = true
    void window.api.send(project.id, conv.id, text).then(refresh)
  }

  const respond = (decision: PermissionDecision, extra?: PermissionExtra): void => {
    if (project && conv && pending) onRespond(project.id, conv.id, pending.requestId, decision, extra)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const ev = e.nativeEvent
    const code = physicalCode(ev)
    // 펼친 목록(모델·effort)은 제 키를 스스로 처리한다 (Esc로 목록만 닫기)
    if ((e.target as HTMLElement).closest('[data-keys-own]') || e.defaultPrevented) return
    if (isEscape(ev, code)) {
      e.preventDefault()
      if (busy && project && conv) void window.api.interrupt(project.id, conv.id)
      else onClose()
      return
    }
    if (matches(ev, km.clear)) {
      e.preventDefault()
      clear()
      return
    }
    const typing = (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT'
    if (pending && !typing && !needsChoice(pending.toolName)) {
      const decision: PermissionDecision | null = matches(ev, km.allow) ? 'allow' : matches(ev, km.always) ? 'always' : matches(ev, km.deny) ? 'deny' : null
      if (!decision) return
      e.preventDefault()
      if (decision !== 'deny' && pending.defaultToNo) return
      if (decision === 'always' && pending.suppressAlwaysAllow) return
      respond(decision)
    }
  }

  const ctx = state.context?.percent ?? conv?.contextPercent
  return (
    <div className={`overlay quick ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-label="빠른 질문" onKeyDown={onKey} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet quick-sheet" onClick={(e) => {
        // 버튼·빈 곳을 누른 뒤에도 입력창으로 (확인 요청이 떠 있으면 Y/A/N을 위해 비워 둔다)
        const t = e.target as HTMLElement
        if (!pending && !t.closest('input, textarea, select, [role="listbox"], [data-keys-own]') && !window.getSelection()?.toString()) requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
      }}>
        <header className="quick-head">
          <span className="kr" aria-hidden="true">ASK</span>
          <span className="quick-note">읽기·웹만 써요</span>
          <span className="quick-meta">
            {project && conv && <ModelPicker projectId={project.id} conversationId={conv.id} current={model} choice={conv.modelChoice} usage={usage} />}
            {project && conv && (
              <EffortPicker
                choice={conv.effort}
                info={effort}
                onPick={(level: EffortLevel | null) => void window.api.setEffort(project.id, conv.id, level).then(refresh)}
              />
            )}
            {ctx !== undefined && (
              <span className={`meta quick-ctx ${ctx >= 80 ? 'hot' : ''}`} title="컨텍스트 사용률">
                <span className="meta-k">CONTEXT</span>
                <span className="meta-v">{ctx}%</span>
              </span>
            )}
            <button type="button" className={`btn sm ${armed ? 'armed' : ''}`} onClick={clear} title="대화를 비우고 새로 시작해요">
              {armed ? 'CLEAR?' : 'CLEAR'}
            </button>
            <button type="button" className="btn sm" onClick={onClose} title="닫아요. 대화는 남아요">
              CLOSE
            </button>
          </span>
        </header>
        {armed && <div className="confirm" role="status">한 번 더 누르면 대화를 비워요</div>}
        <main
          className="transcript quick-log"
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current
            if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {state.items.length === 0 && !busy && (
            <div className="quick-empty">
              무엇이든 물어봐요. 파일은 읽기만 하고, 고치거나 명령을 실행하지는 않아요.
            </div>
          )}
          {state.items.map((item, idx) => (
            <Item
              key={`${conversationId}:${idx}`}
              item={item}
              n={0}
              root={project?.path ?? ''}
              enter={idx >= (seen.current ?? 0)}
              subs={state.subs}
              progress={state.progress}
              onExpand={(toolUseId) => (project && conv ? window.api.toolResult(project.id, conv.id, toolUseId) : Promise.resolve(null))}
            />
          ))}
          {working.item && <Working status={state.status} activity={state.task?.activity} startedAt={state.task?.startedAt} leaving={working.leaving} />}
          {permission.item && (
            <PermissionBox key={permission.item.requestId} req={permission.item} leaving={permission.leaving} onRespond={(d, extra) => !permission.leaving && respond(d, extra)} />
          )}
        </main>
        <form
          className="composer quick-composer"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <span className="composer-prompt" aria-hidden="true">?</span>
          <div className="composer-body">
            <label htmlFor="quick-input" className="sr-only">질문</label>
            <textarea
              id="quick-input"
              ref={inputRef}
              value={draft}
              rows={1}
              placeholder={busy ? '답하는 중이에요 · 지금 입력하면 다음 차례로 보내요' : '질문 입력 · /clear · /compact'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
        </form>
      </div>
    </div>
  )
}
