import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MODE_CYCLE, MODE_LABEL, openConversations, STATUS_LABEL, type UsageInfo, type SlashCommandInfo, type AgentMode, type PermissionDecision, type PermissionRequest, type Project } from '@shared/types'
import { emptyConversation, STAGES, type ConversationMap, type TaskInfo, type TranscriptItem } from './state'
import { HOME_ROW } from './keys'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'
import { Roll, usePresence } from './motion'
import { useNow } from './time'
import { Markdown } from './Markdown'
import { AttachButton, useAttach } from './attach'
import { WorktreePanel } from './WorktreePanel'
import { ModelPicker } from './ModelPicker'
import { FileMenu, rankCommands, SlashMenu, useSlashCommands } from './SlashMenu'

interface Props {
  project: Project
  projects: Project[]
  conversationId: string
  convs: ConversationMap
  mode: AgentMode
  /** Ctrl+L을 한 번 눌러 클리어 확인을 기다리는 중 */
  usage: UsageInfo | null
  clearArmed: boolean
  /** 닫기 확인을 기다리는 대화 ID (Ctrl+W 또는 탭의 × 한 번) */
  closeArmedId: string | null
  /** 이 프로젝트 닫기 확인을 기다리는 중 */
  projectArmed: boolean
  onClearRequest: () => void
  onCloseRequest: (conversationId: string) => void
  /** 확인 없이 바로 닫기 (/close로 직접 입력했을 때) */
  onClose: (conversationId: string) => void
  onSelectConversation: (conversationId: string) => void
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) => void
}

export function Chat({ project, projects, conversationId, convs, mode, usage, clearArmed, closeArmedId, projectArmed, onClearRequest, onCloseRequest, onClose, onSelectConversation, onRespond }: Props): React.JSX.Element {
  const km = useKeymap()
  const state = convs[conversationId] ?? emptyConversation()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const pending = state.permissions[0]
  const permission = usePresence(pending)
  const closeArmed = closeArmedId === conversationId
  const confirm = usePresence(projectArmed ? 'project' : clearArmed ? 'clear' : closeArmed ? 'close' : null)
  const compacting = usePresence(state.compacting ? true : null)
  // 작업 중 줄: 생각하는 중·도구 사이처럼 화면에 새로 그려지는 게 없을 때도 일하고 있음을 보인다
  const working = usePresence((state.status === 'running' || state.status === 'queued') && !state.compacting ? true : null)

  // 이 대화를 연 시점에 이미 있던 기록은 그대로 두고, 새로 들어오는 항목만 등장 애니메이션
  const seen = useRef<{ id: string; count: number }>({ id: '', count: 0 })
  if (seen.current.id !== conversationId) seen.current = { id: conversationId, count: state.items.length }
  // 클리어로 기록이 줄면 기준도 내린다
  if (state.items.length < seen.current.count) seen.current.count = 0
  // 되살린 기록은 한꺼번에 들어오므로 등장 애니메이션 없이 그린다
  if ((state.restored ?? 0) > seen.current.count) seen.current.count = state.restored!

  // 다른 프로젝트의 승인 대기 (우측 상단 배지)
  const otherWaiting = projects
    .map((p, i) => ({ p, i, n: p.id === project.id ? 0 : p.conversations.filter((c) => convs[c.id]?.status === 'waiting_approval').length }))
    .filter((x) => x.n > 0)

  // 열자마자 컨텍스트 사용률·모델이 보이도록, 이번 실행에서 아직 받지 않았으면 메시지 없이 읽어 온다
  const needsPeek = !state.context
  const needsHistory = state.items.length === 0 && !!project.conversations.find((c) => c.id === conversationId)?.sessionId
  useEffect(() => {
    if (needsPeek) void window.api.peek(project.id, conversationId)
    // 앱을 다시 켠 뒤라 화면 기록이 비어 있으면 세션 기록 파일에서 되살린다
    if (needsHistory) void window.api.loadHistory(project.id, conversationId)
  }, [project.id, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 맨 아래를 보고 있을 때만 따라 내려간다. 위로 올려 읽는 중이면 끌고 내려가지 않는다
  const stick = useRef(true)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const lastItem = state.items[state.items.length - 1]
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
  }, [conversationId])
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stick.current) return
    // 새 항목은 부드럽게, 스트리밍으로 글자가 늘어날 때는 바로 따라간다 (부드러운 스크롤이 겹치면 끌려 다님)
    const streaming = lastItem?.type === 'assistant' && lastItem.streaming
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'instant' : 'smooth' })
  }, [state.items.length, lastItem, !!permission.item, compacting.item, working.item])
  // 권한 요청이 오면 입력창에서 포커스를 빼서 Y/A/N이 바로 먹게 한다
  useEffect(() => {
    if (pending) inputRef.current?.blur()
    else inputRef.current?.focus()
  }, [pending?.requestId, conversationId])

  const conv = project.conversations.find((c) => c.id === conversationId)
  // 모델은 세션마다 다를 수 있다: 이번 실행에서 받은 값, 없으면 저장된 값
  const model = state.model ?? (conv?.model ? { id: conv.model, label: conv.modelLabel ?? conv.model } : undefined)
  const cycleMode = (): void => {
    void window.api.setMode(project.id, conversationId, MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length])
  }
  const ctxPercent = state.context?.percent ?? conv?.contextPercent
  const autoAt = state.context?.autoCompactAt
  const busy = state.status === 'running' || state.status === 'waiting_approval'
  const hot = ctxPercent !== undefined && ctxPercent >= (autoAt !== undefined ? autoAt - 10 : 80)
  const canCompact = !busy && !state.compacting && (!!conv?.sessionId || state.items.length > 0)

  const compact = (instructions?: string): void => {
    void window.api.compact(project.id, conversationId, instructions)
  }

  // 슬래시 명령 후보: 첫 단어가 /로 시작하고 아직 띄어쓰기 전일 때
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1]
  const [menuIndex, setMenuIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const slash = useSlashCommands(project.id, slashQuery !== undefined)
  const menuItems = slashQuery !== undefined ? rankCommands(slash.list, slashQuery) : []
  const slashOpen = slashQuery !== undefined && dismissed !== draft

  // @ 파일 후보: 커서 바로 앞 단어가 @로 시작할 때 (이 대화의 작업 폴더 기준)
  const [caret, setCaret] = useState(0)
  const fileQuery = slashQuery === undefined ? /(^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret))?.[2] : undefined
  const [files, setFiles] = useState<{ q: string; list: string[] } | null>(null)
  useEffect(() => {
    if (fileQuery === undefined) return
    let alive = true
    const t = setTimeout(() => {
      void window.api.searchFiles(project.id, conversationId, fileQuery).then((list) => alive && setFiles({ q: fileQuery, list }))
    }, 60)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [fileQuery, project.id, conversationId])
  const fileOpen = fileQuery !== undefined && dismissed !== draft
  const fileItems = fileOpen && files ? files.list : []

  const menuOpen = slashOpen || fileOpen
  const menuCount = slashOpen ? menuItems.length : fileItems.length
  useEffect(() => setMenuIndex(0), [slashQuery, fileQuery])

  /** '@쿼리'를 '@경로 '로 바꾸고 커서를 그 뒤로 */
  const pickFile = (path: string): void => {
    if (fileQuery === undefined) return
    const start = caret - fileQuery.length - 1
    const next = `${draft.slice(0, start)}@${path} ${draft.slice(caret)}`
    const pos = start + path.length + 2
    setDraft(next)
    setDismissed(null)
    setCaret(pos)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  const pickCommand = (c: SlashCommandInfo, run: boolean): void => {
    setDismissed(null)
    if (run && !c.argumentHint) submit(`/${c.name}`)
    else setDraft(`/${c.name} `)
    inputRef.current?.focus()
  }

  /** 메뉴가 열려 있을 때의 키. 처리했으면 true */
  const menuKey = (e: React.KeyboardEvent): boolean => {
    if (!menuOpen) return false
    const plainCtrl = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    const step =
      e.key === 'ArrowDown' || (plainCtrl && (e.code === 'KeyN' || e.code === 'KeyJ')) ? 1
      : e.key === 'ArrowUp' || (plainCtrl && (e.code === 'KeyP' || e.code === 'KeyK')) ? -1
      : 0
    if (step && menuCount) {
      setMenuIndex((i) => (i + step + menuCount) % menuCount)
      return true
    }
    if (e.key === 'Escape' || (plainCtrl && e.code === 'BracketLeft')) {
      setDismissed(draft)
      return true
    }
    if (fileOpen) {
      const f = fileItems[menuIndex]
      if (f && ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing))) {
        pickFile(f)
        return true
      }
      return false
    }
    const c = menuItems[menuIndex]
    if (!c) return false
    if (e.key === 'Tab' && !e.shiftKey) {
      pickCommand(c, false)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      pickCommand(c, true)
      return true
    }
    return false
  }

  const [showChanges, setShowChanges] = useState(false)
  useEffect(() => setShowChanges(false), [conversationId])
  const attach = useAttach({ inputRef, value: draft, setValue: setDraft, root: conv?.worktree?.path ?? project.path, onCaret: setCaret })

  const submit = (raw = draft): void => {
    const text = raw.trim()
    if (!text) return
    // 앱이 직접 처리하는 명령: /compact [요약 지시], /clear, /close
    const cmd = /^\/(compact|clear|reset|new|close)\b\s*([\s\S]*)$/.exec(text)
    if (cmd) {
      setDraft('')
      if (cmd[1] === 'compact') compact(cmd[2])
      else if (cmd[1] === 'close') onClose(conversationId)
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
            {conv?.worktree ? (
              <span className="tb-wt" title={conv.worktree.path}>
                <span className="wt-tag">WORKTREE</span> {conv.worktree.branch} · {conv.worktree.path}
              </span>
            ) : (
              <span>{project.path}</span>
            )}
          </span>
        </div>
        <div className="tb-right">
          {otherWaiting.map(({ p, i, n }) => (
            <span key={p.id} className="badge other">
              <Keys keys={`alt ${HOME_ROW[i]}`} /> {p.name} NEEDS YOU {n}
            </span>
          ))}
          {conv?.worktree && (
            <button type="button" className={`tb-btn ${showChanges ? 'armed' : ''}`} onClick={() => setShowChanges((v) => !v)} title={`작업 공간 ${conv.worktree.branch}의 변경을 보고 합쳐요`}>
              CHANGES
            </button>
          )}
          <div className={`ctx ${hot ? 'hot' : ''}`} title={state.context ? `${state.context.tokens.toLocaleString()} / ${state.context.max.toLocaleString()} 토큰${autoAt ? ` · ${autoAt}%에서 자동으로 컴팩트해요` : ''}` : '첫 응답 뒤에 보여요'}>
            <span className="ctx-label">CONTEXT</span>
            <b>{ctxPercent !== undefined ? `${ctxPercent}%` : '–'}</b>
            <span className="ctx-bar" aria-hidden="true">
              <i style={{ width: `${Math.min(100, ctxPercent ?? 0)}%` }} />
              {autoAt !== undefined && <em style={{ left: `${autoAt}%` }} />}
            </span>
          </div>
          <button type="button" className="tb-btn" disabled={!canCompact} onClick={() => compact()} title="대화를 요약해 컨텍스트를 줄여요 (/compact)">
            {state.compacting ? 'COMPACTING' : 'COMPACT'} <Keys keys={km.compact} />
          </button>
          <button type="button" className={`tb-btn ${clearArmed ? 'armed' : ''}`} onClick={onClearRequest} title="컨텍스트를 비우고 새 세션으로 시작해요 (/clear)">
            {clearArmed ? 'AGAIN' : 'CLEAR'} <Keys keys={km.clear} />
          </button>
          <span className={`badge badge-${state.status}`}>{STATUS_LABEL[state.status]}</span>
        </div>
        <div className="tb-row2">
          <nav className="tabs" aria-label="하위 대화">
            {openConversations(project).map((c, i) => {
              const st = convs[c.id]?.status ?? 'idle'
              const armedHere = closeArmedId === c.id
              return (
                <span key={c.id} className={`tab-wrap ${c.id === conversationId ? 'active' : ''} ${armedHere ? 'armed' : ''}`}>
                <button
                  type="button"
                  className={`tab ${c.id === conversationId ? 'active' : ''}`}
                  // 선택한 탭이 가려져 있으면 보이는 곳까지 부드럽게 끌어온다
                  ref={c.id === conversationId ? (el) => { el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }) } : undefined}
                  onClick={() => onSelectConversation(c.id)}
                  title={STATUS_LABEL[st]}
                >
                  <span className="tab-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="tab-t">{c.title}</span>
                {c.worktree && <span className="wt-tag" title={`작업 공간 ${c.worktree.branch}`}>WT</span>}
                  <span className={`dot dot-${st}`} />
                </button>
                <button
                  type="button"
                  className="tab-x"
                  aria-label={armedHere ? '한 번 더 누르면 닫혀요' : `${c.title} 닫기`}
                  title={armedHere ? '한 번 더 누르면 닫혀요' : '대화 닫기 (Ctrl+W 두 번)'}
                  onClick={() => onCloseRequest(c.id)}
                >
                  {armedHere ? 'CLOSE?' : '×'}
                </button>
                </span>
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
          <div className="tb-meta">
            <ModelPicker projectId={project.id} conversationId={conversationId} current={model} choice={conv?.modelChoice} usage={usage} />
            <button type="button" className={`meta meta-mode mode-${mode}`} onClick={cycleMode} title="권한 모드 바꾸기">
              <span className="meta-k">MODE</span>
              <span className="meta-v">{MODE_LABEL[mode]}</span>
              <Keys keys={km.cycleMode} />
            </button>
          </div>
        </div>
      </header>

      <div className={`chat-body ${busy || state.status === 'queued' ? 'open' : ''}`}>
      {showChanges && conv?.worktree ? (
        <WorktreePanel
          projectId={project.id}
          conversationId={conversationId}
          refreshKey={`${state.status}:${state.items.length}`}
          onClose={() => setShowChanges(false)}
          onDiscarded={(next) => {
            setShowChanges(false)
            onSelectConversation(next)
          }}
        />
      ) : (
        <main className="transcript" ref={scrollRef} onScroll={onScroll}>
          {state.items.length === 0 && (
            <div className="placeholder">
              무엇을 맡길까요?
              <span className="mono">{project.path}</span>
            </div>
          )}
          {state.items.map((item, idx) => (
            <Item key={idx} item={item} n={item.type === 'tool' ? ++toolCount : 0} root={project.path} enter={idx >= seen.current.count} />
          ))}
          {working.item && <Working status={state.status} activity={state.task?.activity} startedAt={state.task?.startedAt} leaving={working.leaving} />}
          {compacting.item && <div className={`msg compacting ${compacting.leaving ? 'leaving' : ''}`}>COMPACTING · 지금까지의 대화를 요약하고 있어요</div>}
          {permission.item && (
            <PermissionBox
              key={permission.item.requestId}
              req={permission.item}
              leaving={permission.leaving}
              onRespond={(d) => permission.item && !permission.leaving && onRespond(project.id, conversationId, permission.item.requestId, d)}
            />
          )}
        </main>
      )}
        {state.task && <StatusPanel task={state.task} status={state.status} />}
      </div>

      {confirm.item && (
        <div className={`confirm ${confirm.leaving ? 'leaving' : ''}`} role="alert">
          {confirm.item === 'project' ? (
            <>
              <Keys keys={km.closeProject} /> 를 한 번 더 누르면 {project.name} 프로젝트를 목록에서 닫아요. 실행 중인 작업은 멈추고, 폴더와 파일은 그대로예요
            </>
          ) : confirm.item === 'close' ? (
            <>
              <Keys keys={km.closeConversation} /> 를 한 번 더 누르면 {state.status === 'running' || state.status === 'waiting_approval' ? '실행 중인 작업을 멈추고 ' : ''}이 대화를 닫아요
            </>
          ) : (
            <>
              <Keys keys={km.clear} /> 을 한 번 더 누르면 컨텍스트를 비우고 새 세션으로 시작해요
            </>
          )}
        </div>
      )}
      <div className={`composer ${attach.dropping ? 'dropping' : ''}`} {...attach.dropProps}>
        {slashOpen && (
          <SlashMenu items={menuItems} index={menuIndex} loading={slash.loading} onHover={setMenuIndex} onPick={(c) => pickCommand(c, true)} />
        )}
        {fileOpen && <FileMenu items={fileItems} index={menuIndex} loading={!files || files.q !== fileQuery} onHover={setMenuIndex} onPick={pickFile} />}
        <span className="composer-prompt" aria-hidden="true">&gt;</span>
        <AttachButton onClick={attach.pick} />
        <div className="composer-body">
          <label htmlFor="composer-input" className="sr-only">메시지</label>
          <textarea
            id="composer-input"
            ref={inputRef}
            value={draft}
            // 메뉴가 열려 있으면 전역 단축키(Esc 중단, Ctrl+K 등)가 이 키를 가로채지 않게 표시
            data-menu-open={menuOpen ? 'true' : undefined}
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            rows={2}
            placeholder={busy ? '작업 중이에요 · 지금 입력하면 다음 차례로 보내요' : '메시지 입력 · / 명령 · @ 파일'}
            onChange={(e) => {
              setDraft(e.target.value)
              setCaret(e.target.selectionStart)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={attach.onPaste}
            onKeyDown={(e) => {
              if (menuKey(e)) {
                e.preventDefault()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </div>
      </div>

      <footer className="hints">
        <span><Keys keys={km.goHome} /> HOME</span>
        <span><Keys keys={km.nextConversation} /> TABS</span>
        <span><Keys keys="alt A S D…" /> PROJECTS</span>
        <span><Keys keys="esc" /> STOP</span>
        <span><Keys keys={km.clear} /> CLEAR</span>
        <span><Keys keys={km.closeConversation} /> CLOSE</span>
        <span><Keys keys={km.compact} /> COMPACT</span>
        {pending && <span><Keys keys={`${km.allow} ${km.always} ${km.deny}`} /> APPROVE</span>}
      </footer>
    </div>
  )
}

function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0')
  const ss = String(sec % 60).padStart(2, '0')
  return sec >= 3600 ? `${Math.floor(sec / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 오른쪽 상태 패널: 실행 중에만 펼쳐지고, 끝나면 마지막 단계를 잠깐 보여 준 뒤 접힌다 */
function StatusPanel({ task, status }: { task: TaskInfo; status: string }): React.JSX.Element {
  const now = useNow(1000)
  const waiting = status === 'waiting_approval'
  const live = status === 'running' || waiting || status === 'queued'
  const stage = Math.min(task.stage, STAGES.length - 1)
  const word = status === 'queued' ? 'QUEUED' : waiting ? 'APPROVE' : STAGES[stage]
  const ms = task.durationMs ?? (task.finishedAt ?? now) - task.startedAt
  return (
    <aside className={`status-panel ${waiting ? 'waiting' : ''} ${live ? 'live' : ''}`} aria-label="작업 상태">
      <div className="sp-head">
        <span className="sp-k">STAGE</span>
        <span className="sp-word"><Roll text={word} /></span>
      </div>
      <div className="sp-meter" aria-label={`진행 단계: ${STAGES[stage]}`}>
        {STAGES.map((name, i) => (
          <span key={name} className={i < task.stage ? 'done' : i === stage && live ? 'cur' : ''} title={name}>
            <i />
            <em>{name}</em>
          </span>
        ))}
      </div>
      <dl className="sp-stats">
        <div><dt>TOOLS</dt><dd>{task.tools}</dd></div>
        <div><dt>TIME</dt><dd>{clock(ms)}</dd></div>
        <div><dt>FILES</dt><dd>{task.files.length}</dd></div>
      </dl>
      <div className="sp-eq" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ animationDelay: `${-((i * 7) % 11) * 0.13}s` }} />)}
      </div>
      <p className="sp-act">{waiting ? 'WAITING FOR YOU' : task.activity}</p>
      {task.files.length > 0 && (
        <ul className="sp-files">
          {task.files.map((f) => <li key={f} title={f}>{f.split(/[\\/]/).pop()}</li>)}
        </ul>
      )}
    </aside>
  )
}

/** 대화 맨 아래 작업 중 줄. 1초마다 다시 그려지므로 따로 떼어 둔다 */
function Working({ status, activity, startedAt, leaving }: { status: string; activity?: string; startedAt?: number; leaving: boolean }): React.JSX.Element {
  const now = useNow(1000)
  return (
    <div className={`working ${status === 'queued' ? 'queued' : ''} ${leaving ? 'leaving' : ''}`} role="status" aria-live="polite">
      <span className="working-sq" aria-hidden="true" />
      <span className="working-act">{activity ?? 'WORKING'}</span>
      {startedAt !== undefined && <span className="working-t">{clock(now - startedAt)}</span>}
      <span className="working-k"><Keys keys="esc" /> STOP</span>
      <span className="working-bar" aria-hidden="true"><i /></span>
    </div>
  )
}

function Item({ item, n, root, enter }: { item: TranscriptItem; n: number; root: string; enter: boolean }): React.JSX.Element {
  const e = enter ? ' enter' : ''
  switch (item.type) {
    case 'user':
      return <div className={`msg user${e}`}>{item.text}</div>
    case 'assistant':
      return (
        <div className={`msg assistant ${item.streaming ? 'streaming' : ''}${e}`}>
          <Markdown text={item.text} />
        </div>
      )
    case 'notice':
      return <div className={`msg notice ${item.tone}${e}`}>{item.text}</div>
    case 'divider':
      return <div className={`divider${e}`} role="separator">■ {item.text}</div>
    case 'tool': {
      const status = item.result === undefined ? 'RUNNING' : item.isError ? 'ERROR' : 'DONE'
      return (
        <details className={`tool ${item.isError ? 'error' : ''}${e}`}>
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
                <h5>OUTPUT</h5>
                <pre>{item.result || '(no output)'}</pre>
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
        <h5>INPUT</h5>
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
      <h5>DIFF · {typeof o.file_path === 'string' ? o.file_path : ''}</h5>
      <div className="diff">
        {lines.slice(0, DIFF_LINE_LIMIT).map((l, i) => (
          <span key={i} className={l.k}>{l.k === 'add' ? '+ ' : '- '}{l.t}</span>
        ))}
        {lines.length > DIFF_LINE_LIMIT && <span className="muted">… +{lines.length - DIFF_LINE_LIMIT} lines</span>}
      </div>
    </>
  )
}

function PermissionBox({ req, leaving, onRespond }: { req: PermissionRequest; leaving: boolean; onRespond: (d: PermissionDecision) => void }): React.JSX.Element {
  const km = useKeymap()
  return (
    <div className={`permission ${leaving ? 'leaving' : ''}`} role="alert">
      <div className="permission-head">
        <span className="q" aria-hidden="true">?</span>
        <div>
          <div className="permission-title">{req.title ?? `${req.toolName}, 실행할까요?`}</div>
          {req.description && <div className="permission-desc">{req.description}</div>}
        </div>
      </div>
      <pre>{JSON.stringify(req.input, null, 2)}</pre>
      <div className="permission-actions">
        <button type="button" onClick={() => onRespond('allow')}>ALLOW {!req.defaultToNo && <Keys keys={km.allow} />}</button>
        {!req.suppressAlwaysAllow && <button type="button" onClick={() => onRespond('always')}>ALWAYS ALLOW {!req.defaultToNo && <Keys keys={km.always} />}</button>}
        <button type="button" onClick={() => onRespond('deny')}>DENY <Keys keys={km.deny} /></button>
      </div>
      {req.defaultToNo && <div className="muted">이 요청은 단축키로 허락할 수 없어요. 버튼을 직접 눌러 주세요.</div>}
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
