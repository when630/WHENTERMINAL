import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MODE_CYCLE, MODE_LABEL, openConversations, STATUS_LABEL, type UsageInfo, type SlashCommandInfo, type AgentMode, type PermissionDecision, type PermissionRequest, type Project, type BackgroundTask, type AgentProgress, type SubItem } from '@shared/types'
import { agentInfo, artifactsOf, describeBackground, emptyConversation, isAgentTool, relPath, runningAgents, STAGES, subActivity, summarizeInput, type ArtifactLink, type ConversationMap, type TaskInfo, type ToolItem, type TranscriptItem } from './state'
import { HOME_ROW } from './keys'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'
import { Roll, usePresence } from './motion'
import { clock, useNow } from './time'
import { SubLog, TaskDetail, type DetailTarget } from './TaskDetail'
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
  /** App의 전역 키 처리가 오른쪽 패널 세부 내용을 다루는 손잡이 (Chat이 그릴 때마다 갱신) */
  panelRef: React.MutableRefObject<PanelControl | null>
}

/** App의 전역 키 처리가 대화창을 다루는 손잡이: 오른쪽 패널 세부 내용(panelNext·panelPrev·panelBack·stopTask)과 이름 바꾸기 */
export interface PanelControl {
  /** 패널 항목을 차례로 펼친다. 마지막 다음은 대화 기록으로 돌아온다 */
  step: (dir: 1 | -1) => void
  back: () => void
  /** 펼친 백그라운드 작업을 멈춘다 */
  stop: () => void
  /** 지금 탭의 이름을 고치는 칸을 연다 */
  rename: () => void
}

export function Chat({ project, projects, conversationId, convs, mode, usage, clearArmed, closeArmedId, projectArmed, onClearRequest, onCloseRequest, onClose, onSelectConversation, onRespond, panelRef }: Props): React.JSX.Element {
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
  // 턴이 끝나도 남아 있는 것들: 백그라운드 셸·모니터, 이 대화에서 올린 아티팩트. 있으면 사이드 패널을 계속 펼친다
  const background = state.background ?? []
  const artifacts = useMemo(() => artifactsOf(state.items), [state.items])
  // 중단하면 결과 없이 남는 도구 호출이 있어, 실행 중일 때만 센다
  const agents = useMemo(
    () => (state.status === 'running' || state.status === 'waiting_approval' ? runningAgents(state.items, background) : []),
    [state.items, state.status, background],
  )

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
  // 이름을 고치는 중인 탭 (더블클릭·/rename·단축키)
  const [editingId, setEditingId] = useState<string | null>(null)
  const renameDone = useRef(false)
  useEffect(() => {
    renameDone.current = false
  }, [editingId])
  const commitRename = (id: string, value: string, before: string): void => {
    if (renameDone.current) return
    renameDone.current = true
    setEditingId(null)
    const v = value.trim()
    if (v && v !== before) void window.api.renameConversation(project.id, id, v)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  // 오른쪽 패널에서 고른 백그라운드 작업·하위 에이전트의 세부 내용 (대화 기록 자리에 펼친다)
  const [detail, setDetail] = useState<DetailTarget | null>(null)
  useEffect(() => {
    setShowChanges(false)
    setDetail(null)
  }, [conversationId])
  // 패널에 보이는 순서대로: AGENTS, BACKGROUND
  const targets: DetailTarget[] = [
    ...agents.map((a): DetailTarget => ({ kind: 'agent', toolUseId: a.toolUseId })),
    ...background.map((b): DetailTarget => ({ kind: 'task', taskId: b.id })),
  ]
  const shownTask = detail?.kind === 'task' ? background.find((b) => b.id === detail.taskId) : undefined
  panelRef.current = {
    step: (dir) => {
      if (targets.length === 0 && !detail) return
      setShowChanges(false)
      setDetail((cur) => {
        // -1은 대화 기록. 끝난 작업을 보고 있었으면 대화 기록에서 출발한 것으로 친다
        const at = cur ? targets.findIndex((t) => sameTarget(t, cur)) : -1
        const n = targets.length + 1
        return targets[((at + 1 + dir + n) % n) - 1] ?? null
      })
    },
    back: () => setDetail(null),
    stop: () => {
      if (shownTask) void window.api.stopTask(project.id, conversationId, shownTask.id)
    },
    rename: () => setEditingId(conversationId),
  }
  const attach = useAttach({ inputRef, value: draft, setValue: setDraft, root: conv?.worktree?.path ?? project.path, onCaret: setCaret })

  const submit = (raw = draft): void => {
    const text = raw.trim()
    if (!text) return
    // 앱이 직접 처리하는 명령: /compact [요약 지시], /clear, /close, /rename [이름]
    const cmd = /^\/(compact|clear|reset|new|close|rename)\b\s*([\s\S]*)$/.exec(text)
    if (cmd) {
      setDraft('')
      if (cmd[1] === 'compact') compact(cmd[2])
      else if (cmd[1] === 'close') onClose(conversationId)
      else if (cmd[1] === 'rename') {
        // 이름을 같이 적으면 바로 바꾸고, 없으면 탭의 이름 칸을 연다
        if (cmd[2].trim()) void window.api.renameConversation(project.id, conversationId, cmd[2])
        else setEditingId(conversationId)
      }
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
            <button type="button" className={`tb-btn ${showChanges ? 'armed' : ''}`} onClick={() => { setDetail(null); setShowChanges((v) => !v) }} title={`작업 공간 ${conv.worktree.branch}의 변경을 보고 합쳐요`}>
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
                {editingId === c.id ? (
                  <span className={`tab tab-editing ${c.id === conversationId ? 'active' : ''}`}>
                    <span className="tab-n">{String(i + 1).padStart(2, '0')}</span>
                    <input
                      className="tab-edit"
                      aria-label="대화 이름"
                      // 고치는 동안은 이 칸이 키를 처리한다 (Esc가 실행 중단으로 가지 않게)
                      data-keys-own="true"
                      defaultValue={c.title}
                      maxLength={80}
                      ref={(el) => {
                        if (el && document.activeElement !== el) {
                          el.focus()
                          el.select()
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          commitRename(c.id, e.currentTarget.value, c.title)
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          commitRename(c.id, c.title, c.title)
                        }
                      }}
                      onBlur={(e) => commitRename(c.id, e.currentTarget.value, c.title)}
                    />
                  </span>
                ) : (
                <button
                  type="button"
                  className={`tab ${c.id === conversationId ? 'active' : ''}`}
                  // 선택한 탭이 가려져 있으면 보이는 곳까지 부드럽게 끌어온다
                  ref={c.id === conversationId ? (el) => { el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }) } : undefined}
                  onClick={() => onSelectConversation(c.id)}
                  onDoubleClick={() => setEditingId(c.id)}
                  title={`${c.title} · ${STATUS_LABEL[st]}\n더블클릭하면 이름을 바꿔요`}
                >
                  <span className="tab-n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="tab-t">{c.title}</span>
                {c.worktree && <span className="wt-tag" title={`작업 공간 ${c.worktree.branch}`}>WT</span>}
                  <span className={`dot dot-${st}`} />
                </button>
                )}
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

      <div className={`chat-body ${busy || state.status === 'queued' || background.length > 0 || artifacts.length > 0 ? 'open' : ''}`}>
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
      ) : detail ? (
        <TaskDetail
          key={detail.kind === 'task' ? detail.taskId : detail.toolUseId}
          target={detail}
          state={state}
          projectId={project.id}
          conversationId={conversationId}
          root={project.path}
          onClose={() => setDetail(null)}
          onStopTask={(taskId) => window.api.stopTask(project.id, conversationId, taskId)}
          keys={{ back: km.panelBack, stop: km.stopTask }}
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
            <Item key={idx} item={item} n={item.type === 'tool' ? ++toolCount : 0} root={project.path} enter={idx >= seen.current.count} subs={state.subs} progress={state.progress} />
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
        {(state.task || background.length > 0 || artifacts.length > 0) && (
          <StatusPanel
            task={state.task}
            status={state.status}
            background={background}
            agents={agents}
            artifacts={artifacts}
            items={state.items}
            subs={state.subs}
            progress={state.progress}
            root={project.path}
            selected={detail}
            onOpen={(t) => {
              setShowChanges(false)
              setDetail((cur) => (cur && sameTarget(cur, t) ? null : t))
            }}
            onStopTask={(taskId) => window.api.stopTask(project.id, conversationId, taskId)}
          />
        )}
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
        {(targets.length > 0 || detail) && <span><Keys keys={km.panelNext} /> DETAILS</span>}
        {detail && <span><Keys keys={km.panelBack} /> BACK</span>}
        {pending && <span><Keys keys={`${km.allow} ${km.always} ${km.deny}`} /> APPROVE</span>}
      </footer>
    </div>
  )
}

interface PanelProps {
  task?: TaskInfo
  status: string
  background: BackgroundTask[]
  /** 앞에서 기다리는 하위 에이전트 (결과가 아직 안 온 Agent 도구 호출) */
  agents: ToolItem[]
  artifacts: ArtifactLink[]
  items: TranscriptItem[]
  subs?: Record<string, SubItem[]>
  progress?: Record<string, AgentProgress>
  root: string
  /** 지금 세부 내용을 펼쳐 둔 것 */
  selected: DetailTarget | null
  onOpen: (target: DetailTarget) => void
  onStopTask: (taskId: string) => Promise<void>
}

const sameTarget = (a: DetailTarget, b: DetailTarget): boolean =>
  a.kind === 'task' ? b.kind === 'task' && a.taskId === b.taskId : b.kind === 'agent' && a.toolUseId === b.toolUseId

/**
 * 오른쪽 상태 패널: 실행 중이거나, 백그라운드 셸·모니터가 돌거나, 아티팩트가 연결돼 있으면 펼쳐진다.
 * 그 밖에는 끝난 뒤 마지막 단계를 잠깐 보여 주고 접힌다
 */
function StatusPanel({ task, status, background, agents, artifacts, items, subs, progress, root, selected, onOpen, onStopTask }: PanelProps): React.JSX.Element {
  const now = useNow(1000)
  // 멈춤을 눌렀지만 아직 목록에서 빠지지 않은 작업
  const [stopping, setStopping] = useState<string[]>([])
  const stop = (id: string): void => {
    setStopping((xs) => [...xs, id])
    void onStopTask(id).finally(() => setStopping((xs) => xs.filter((x) => x !== id)))
  }
  const waiting = status === 'waiting_approval'
  const live = status === 'running' || waiting || status === 'queued'
  // 작업이 끝났는데 패널이 남아 있는 건 백그라운드·아티팩트 때문이니 그것만 보인다
  const showTask = !!task && (live || (background.length === 0 && artifacts.length === 0))
  const isSel = (t: DetailTarget): boolean => !!selected && sameTarget(selected, t)
  const km = useKeymap()
  return (
    <aside className={`status-panel ${waiting ? 'waiting' : ''} ${live ? 'live' : ''}`} aria-label="작업 상태">
      {showTask && task && <TaskStatus task={task} status={status} now={now} />}
      {agents.length > 0 && (
        <section className="sp-sec" aria-label="하위 에이전트">
          <div className="sp-sec-h">
            <span className="sp-k">AGENTS <Keys keys={km.panelNext} /></span>
            <span className="sp-n">{agents.length}</span>
          </div>
          <ul className="sp-bg">
            {agents.map((a) => {
              const info = agentInfo(a.input)
              const target: DetailTarget = { kind: 'agent', toolUseId: a.toolUseId }
              return (
                <li key={a.toolUseId} className={isSel(target) ? 'sel' : ''}>
                  <button type="button" className="sp-bg-open" onClick={() => onOpen(target)} title={`${info.description}\n누르면 이 에이전트가 하는 일을 자세히 봐요`}>
                    <span className="sp-bg-row">
                      <span className="sp-bg-sq" aria-hidden="true" />
                      <b>AGENT</b>
                      {info.type && <span className="sp-bg-type">{info.type}</span>}
                      <span className="sp-bg-t">{clock(now - a.at)}</span>
                    </span>
                    <span className="sp-bg-d">{info.description || 'AGENT'}</span>
                    <span className="sp-bg-now">{subActivity(subs?.[a.toolUseId], progress?.[a.toolUseId])}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {background.length > 0 && (
        <section className="sp-sec" aria-label="백그라운드 작업">
          <div className="sp-sec-h">
            <span className="sp-k">BACKGROUND {agents.length === 0 && <Keys keys={km.panelNext} />}</span>
            <span className="sp-n">{background.length}</span>
          </div>
          <ul className="sp-bg">
            {background.map((b) => {
              const d = describeBackground(b, items)
              const cmd = relPath(d.command, root)
              const desc = d.text === d.command ? cmd : d.text
              const busy = stopping.includes(b.id)
              const target: DetailTarget = { kind: 'task', taskId: b.id }
              const agent = d.label === 'AGENT' && b.toolUseId ? b.toolUseId : undefined
              return (
                <li key={b.id} className={isSel(target) ? 'sel' : ''}>
                  <button type="button" className="sp-bg-open" onClick={() => onOpen(target)} title={`${cmd && cmd !== desc ? `${desc}\n${cmd}` : desc}\n누르면 ${agent ? '이 에이전트가 하는 일을' : '출력을'} 자세히 봐요`}>
                    <span className="sp-bg-row">
                      <span className="sp-bg-sq" aria-hidden="true" />
                      <b>{d.label}</b>
                      <span className="sp-bg-t">{clock(now - b.startedAt)}</span>
                    </span>
                    <span className="sp-bg-d">{desc}</span>
                    {agent && <span className="sp-bg-now">{subActivity(subs?.[agent], progress?.[agent])}</span>}
                  </button>
                  <button type="button" className="sp-bg-x" disabled={busy} onClick={() => stop(b.id)} title="이 작업만 멈춰요" aria-label={`${d.label} 멈추기`}>
                    {busy ? '…' : 'STOP'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {artifacts.length > 0 && (
        <section className="sp-sec" aria-label="연결된 아티팩트">
          <div className="sp-sec-h">
            <span className="sp-k">ARTIFACTS</span>
            <span className="sp-n">{artifacts.length}</span>
          </div>
          <ul className="sp-art">
            {artifacts.map((a) => (
              <li key={a.url}>
                {/* 메인의 setWindowOpenHandler가 외부 브라우저로 연다 */}
                <a href={a.url} target="_blank" rel="noreferrer" title={`${a.title}\n${a.url}`}>
                  <span>{a.title}</span>
                  <i aria-hidden="true">↗</i>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}

function TaskStatus({ task, status, now }: { task: TaskInfo; status: string; now: number }): React.JSX.Element {
  const waiting = status === 'waiting_approval'
  const live = status === 'running' || waiting || status === 'queued'
  const stage = Math.min(task.stage, STAGES.length - 1)
  const word = status === 'queued' ? 'QUEUED' : waiting ? 'APPROVE' : STAGES[stage]
  const ms = task.durationMs ?? (task.finishedAt ?? now) - task.startedAt
  return (
    <>
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
    </>
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

function Item({ item, n, root, enter, subs, progress }: { item: TranscriptItem; n: number; root: string; enter: boolean; subs?: Record<string, SubItem[]>; progress?: Record<string, AgentProgress> }): React.JSX.Element {
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
      // 하위 에이전트: 그 안에서 한 일을 펼쳐 볼 수 있게 한다
      const sub = isAgentTool(item.name) ? subs?.[item.toolUseId] : undefined
      const subTools = progress?.[item.toolUseId]?.tools ?? sub?.filter((i) => i.type === 'tool').length ?? 0
      return (
        <details className={`tool ${item.isError ? 'error' : ''}${e}`}>
          <summary>
            <span className="tool-n">{String(n).padStart(2, '0')}</span>
            <span className="tool-name">{item.name}</span>
            <span className="tool-arg">
              {relPath(summarizeInput(item.input), root)}
              {sub && <span className="tool-sub"> · {subTools} TOOLS</span>}
            </span>
            <span className={`tool-st ${item.result === undefined ? 'run' : ''}`}>{status}</span>
          </summary>
          <div className="tool-body">
            <ToolInput name={item.name} input={item.input} />
            {sub && sub.length > 0 && (
              <>
                <h5>AGENT LOG · {sub.length}</h5>
                <SubLog list={sub} subs={subs ?? {}} root={root} />
              </>
            )}
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

