import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { refocusAfterClick, useRefocus } from './focus'
import { ALWAYS_SCOPE_LABEL, ALWAYS_SCOPE_TIP, ELICITATION_TOOL, MODE_CYCLE, MODE_LABEL, openConversations, REFUSAL_TOOL, STATUS_LABEL, type AgentOption, type AskQuestion, type EffortInfo, type EffortLevel, type GitBranch, type UsageInfo, type SlashCommandInfo, type AgentMode, type PermissionDecision, type PermissionExtra, type PermissionRequest, type Project, type BackgroundTask, type AgentProgress, type RefusalChoice, type SubItem } from '@shared/types'
import { agentInfo, artifactsOf, describeBackground, emptyConversation, isAgentTool, relPath, runningAgents, STAGES, subActivity, summarizeInput, type ArtifactLink, type ConversationMap, type TaskInfo, type ToolItem, type TranscriptItem } from './state'
import { PANEL_TITLE, ToolPanelView, type ToolPanel } from './panels'
import { usePromptHistory } from './drafts'
import { HOME_ROW } from './keys'
import { matchesTerms, searchableText, searchTerms } from '@shared/search'
import { Equalizer, Roll, usePresence } from './motion'
import { clock, useNow } from './time'
import { SubLog, TaskDetail, type DetailTarget } from './TaskDetail'
import { closeTerminal, forgetTerminals, pathForComposer, runInTerminal, TerminalDrawer, toggleTerminal } from './terminal'
import { Markdown } from './Markdown'
import { AttachButton, useAttach } from './attach'
import { WorktreePanel } from './WorktreePanel'
import { EffortPicker, ModelPicker } from './ModelPicker'
import { useDraft } from './drafts'
import { formatReset, worstLimit } from '@shared/usage'
import { FileMenu, mentionText, rankCommands, SlashMenu, useSlashCommands, type Mention } from './SlashMenu'

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
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision, extra?: PermissionExtra) => void
  /** App의 전역 키 처리가 오른쪽 패널 세부 내용을 다루는 손잡이 (Chat이 그릴 때마다 갱신) */
  panelRef: React.MutableRefObject<PanelControl | null>
  /** 대화 검색에서 고른 메시지: 이 대화에서 검색어가 맞은 ordinal번째 항목으로 스크롤한다 */
  jump?: { query: string; ordinal: number; nonce: number } | null
  /** 열자마자 펼칠 명령 화면 (홈 보고서의 TOOLS에서 왔을 때) */
  openPanel?: { panel: ToolPanel; nonce: number } | null
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
  /** 아래 터미널: 펼치고 터미널로 / 터미널 ↔ 입력창 / 터미널에서 누르면 접기 */
  terminal: () => void
  /** 지금 터미널 탭을 닫는다 */
  closeTerminal: () => void
  /** effort를 다음 단계로 (기본값 → LOW → … → 기본값) */
  cycleEffort: () => void
  /** 되감기 화면 (/rewind) */
  rewind: () => void
}

export function Chat({ project, projects, conversationId, convs, mode, usage, clearArmed, closeArmedId, projectArmed, onClearRequest, onCloseRequest, onClose, onSelectConversation, onRespond, panelRef, jump, openPanel }: Props): React.JSX.Element {
  const state = convs[conversationId] ?? emptyConversation()
  // 쓰던 글은 대화마다 남는다 (탭을 옮기거나 앱을 껐다 켜도)
  const [draft, setDraft] = useDraft(conversationId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 입력창은 한 줄로 시작해 글이 늘면 따라 커진다 (최대 높이는 CSS max-height)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
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
  // 검색 결과로 열었으면 그 메시지로 스크롤하고 잠깐 강조한다. 기록을 되살리는 중이면 다 들어올 때까지 기다린다
  const jumped = useRef(0)
  useEffect(() => {
    if (!jump || jumped.current === jump.nonce || state.items.length === 0) return
    const terms = searchTerms(jump.query)
    const hits: number[] = []
    state.items.forEach((item, i) => {
      const t = searchableText(item)
      if (t && matchesTerms(t.text, terms)) hits.push(i)
    })
    if (hits.length === 0) {
      // 기록이 아직 덜 들어왔을 수 있다 (되살린 기록은 한꺼번에 오므로 restored가 있으면 끝)
      if (state.restored === undefined && needsHistory) return
      jumped.current = jump.nonce
      return
    }
    jumped.current = jump.nonce
    const idx = hits[Math.min(jump.ordinal, hits.length - 1)]
    setDetail(null)
    setShowChanges(false)
    stick.current = false
    // 맨 아래로 따라가는 스크롤이 끝난 뒤에 옮긴다
    setTimeout(() => {
      const el = scrollRef.current?.children[idx] as HTMLElement | undefined
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      el.classList.add('hit')
      setTimeout(() => el.classList.remove('hit'), 2400)
    }, 120)
  }, [jump?.nonce, state.items.length, state.restored]) // eslint-disable-line react-hooks/exhaustive-deps

  // 권한 요청이 오면 입력창에서 포커스를 빼서 Y/A/N이 바로 먹게 한다
  useEffect(() => {
    if (pending) inputRef.current?.blur()
    else inputRef.current?.focus()
  }, [pending?.requestId, conversationId])
  // 포커스는 늘 입력창으로: 패널·세부 화면·덮개를 닫거나 버튼을 누른 뒤에도 (focus.ts). 확인 요청이 떠 있으면 Y/A/N을 위해 비워 둔다
  const focusComposer = useCallback((): void => {
    if (state.permissions.length) return
    const el = inputRef.current
    if (el && document.activeElement !== el && !document.activeElement?.closest('[data-terminal], [data-keys-own]')) el.focus({ preventScroll: true })
  }, [state.permissions.length])
  useRefocus(focusComposer)

  const conv = project.conversations.find((c) => c.id === conversationId)
  // 모델은 세션마다 다를 수 있다: 이번 실행에서 받은 값, 없으면 저장된 값
  const model = state.model ?? (conv?.model ? { id: conv.model, label: conv.modelLabel ?? conv.model } : undefined)
  const root = conv?.worktree?.path ?? project.path

  // effort: 모델이 받는 단계와 기본값. 모델이 바뀌면 다시 읽는다
  // 대화를 옮긴 직후 앞 대화의 단계로 고르지 않도록 어느 대화의 값인지 함께 둔다
  const [effortOf, setEffortOf] = useState<{ id: string; info: EffortInfo } | null>(null)
  const effortInfo = effortOf?.id === conversationId ? effortOf.info : null
  useEffect(() => {
    let alive = true
    void window.api.getEffort(project.id, conversationId).then((info) => alive && setEffortOf({ id: conversationId, info }))
    return () => {
      alive = false
    }
  }, [project.id, conversationId, model?.id, conv?.modelChoice])
  const setEffort = (e: EffortLevel | null): void => void window.api.setEffort(project.id, conversationId, e)

  // 브랜치: 대화를 열 때·작업이 끝날 때·창으로 돌아올 때·30초마다
  const branch = useBranch(project.id, conversationId, state.status)

  // 구독 한도: 이 모델로 보낼 때 걸리는 창 중 가장 위험한 것. 다 썼으면 Enter를 한 번 더 눌러야 보낸다
  const limit = worstLimit(usage, model?.id ?? model?.label)
  const [limitArmed, setLimitArmed] = useState(false)
  useEffect(() => setLimitArmed(false), [draft, conversationId])
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

  // @ 후보: 커서 바로 앞 단어가 @로 시작할 때. 파일·폴더(이 대화의 작업 폴더 기준)와 하위 에이전트(@agent-이름)
  const [caret, setCaret] = useState(0)
  const fileQuery = slashQuery === undefined ? /(^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret))?.[2] : undefined
  const [files, setFiles] = useState<{ q: string; list: string[] } | null>(null)
  const [agentsList, setAgentsList] = useState<{ projectId: string; list: AgentOption[] } | null>(null)
  useEffect(() => {
    if (fileQuery === undefined) return
    let alive = true
    const t = setTimeout(() => {
      void window.api.searchFiles(project.id, conversationId, fileQuery).then((list) => alive && setFiles({ q: fileQuery, list }))
    }, 60)
    // 에이전트 종류는 프로젝트마다 한 번만
    if (agentsList?.projectId !== project.id) void window.api.listAgents(project.id).then((list) => alive && setAgentsList({ projectId: project.id, list }), () => {})
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [fileQuery, project.id, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps
  const fileOpen = fileQuery !== undefined && dismissed !== draft
  const fileItems = useMemo((): Mention[] => {
    if (!fileOpen) return []
    const q = (fileQuery ?? '').toLowerCase()
    const agents: Mention[] = (agentsList?.projectId === project.id ? agentsList.list : [])
      .filter((a) => `agent-${a.name}`.toLowerCase().includes(q) || (q.length >= 2 && a.name.toLowerCase().includes(q)))
      .map((a) => ({ kind: 'agent', name: a.name, description: a.description }))
    const paths: Mention[] = (files?.q === fileQuery ? files.list : []).map((path) => ({ kind: 'file', path }))
    // 'agent'로 시작해 치면 에이전트가 위로
    return q.startsWith('a') && 'agent-'.startsWith(q.slice(0, 6)) ? [...agents, ...paths] : [...paths, ...agents.slice(0, 5)]
  }, [fileOpen, fileQuery, files, agentsList, project.id])

  const menuOpen = slashOpen || fileOpen
  const slashShown = usePresence(slashOpen ? true : null, 220)
  const fileShown = usePresence(fileOpen ? true : null, 220)
  const limitShown = usePresence(limit, 220)
  const menuCount = slashOpen ? menuItems.length : fileItems.length
  useEffect(() => setMenuIndex(0), [slashQuery, fileQuery])

  /** 커서 자리에 글을 넣고 커서를 그 뒤로 */
  const insertAtCaret = (text: string, replaceFrom = caret): void => {
    const next = `${draft.slice(0, replaceFrom)}${text}${draft.slice(caret)}`
    const pos = replaceFrom + text.length
    setDraft(next)
    setDismissed(null)
    setCaret(pos)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  /** '@쿼리'를 '@경로 '(또는 '@agent-이름 ')로 바꾸고 커서를 그 뒤로 */
  const pickFile = (m: Mention): void => {
    if (fileQuery === undefined) return
    insertAtCaret(`@${mentionText(m)} `, caret - fileQuery.length - 1)
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
  // 대화 기록 자리에 펼치는 명령 화면 (/rewind /resume /mcp …)
  const [tool, setTool] = useState<ToolPanel | null>(null)
  const openTool = (p: ToolPanel): void => {
    setShowChanges(false)
    setDetail(null)
    setTool(p)
  }
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
  // 아래 터미널이 열리며 기록 칸이 줄어들 때도 맨 아래를 붙잡는다
  const transcriptShown = !(showChanges && conv?.worktree) && !detail && !tool
  // 패널·세부 화면을 닫고 대화로 돌아오면 입력창으로
  const wasPanel = useRef(false)
  useEffect(() => {
    if (wasPanel.current && transcriptShown) requestAnimationFrame(focusComposer)
    wasPanel.current = !transcriptShown
  }, [transcriptShown, focusComposer])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [transcriptShown])
  useEffect(() => {
    setShowChanges(false)
    setDetail(null)
    setTool(null)
  }, [conversationId])
  // 홈 보고서의 TOOLS처럼 열면서 바로 펼쳐 달라고 한 화면
  const openedPanel = useRef(0)
  useEffect(() => {
    if (!openPanel || openedPanel.current === openPanel.nonce) return
    openedPanel.current = openPanel.nonce
    setShowChanges(false)
    setDetail(null)
    setTool(openPanel.panel)
  }, [openPanel])

  /** 명령 화면을 닫고 대화 기록의 그 도구 호출로 가서 펼친다 */
  const jumpToTool = (toolUseId: string): void => {
    setTool(null)
    setDetail(null)
    setShowChanges(false)
    stick.current = false
    setTimeout(() => {
      const el = scrollRef.current?.querySelector<HTMLDetailsElement>(`[data-tool-id="${toolUseId}"]`)
      if (!el) return
      el.open = true
      el.scrollIntoView({ block: 'center' })
      el.classList.add('hit')
      setTimeout(() => el.classList.remove('hit'), 2400)
    }, 60)
  }
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
      setTool(null)
      setDetail((cur) => {
        // -1은 대화 기록. 끝난 작업을 보고 있었으면 대화 기록에서 출발한 것으로 친다
        const at = cur ? targets.findIndex((t) => sameTarget(t, cur)) : -1
        const n = targets.length + 1
        return targets[((at + 1 + dir + n) % n) - 1] ?? null
      })
    },
    back: () => {
      setDetail(null)
      setTool(null)
    },
    rewind: () => openTool({ kind: 'rewind' }),
    stop: () => {
      if (shownTask) void window.api.stopTask(project.id, conversationId, shownTask.id)
    },
    rename: () => setEditingId(conversationId),
    terminal: () => toggleTerminal(project.id, conversationId, () => inputRef.current?.focus()),
    closeTerminal: () => closeTerminal(conversationId, () => inputRef.current?.focus()),
    cycleEffort: () => {
      if (!effortInfo?.levels.length) return
      const rows: (EffortLevel | null)[] = [null, ...effortInfo.levels]
      setEffort(rows[(rows.indexOf(conv?.effort ?? null) + 1) % rows.length])
    },
  }
  const attach = useAttach({ inputRef, setValue: setDraft, scope: conversationId, root, onCaret: setCaret })
  // 보낸 글 기록: 입력창이 비었거나 첫 줄에서 ↑를 누르면 앞서 보낸 글을 되살린다 (CLI처럼)
  const history = usePromptHistory(conversationId)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  const submit = (raw = draft): void => {
    const text = raw.trim()
    if (!text) return
    // 앱이 직접 처리하는 명령: /compact [요약 지시], /clear, /close, /rename [이름], 그리고 명령 화면들
    const cmd = /^\/(compact|clear|reset|new|close|rename|rewind|resume|fork|export|mcp|agents|permissions|hooks|add-dir|memory|status|login)\b\s*([\s\S]*)$/.exec(text)
    if (cmd) {
      setDraft('')
      const arg = cmd[2].trim()
      switch (cmd[1]) {
        case 'compact': return compact(cmd[2])
        case 'close': return onClose(conversationId)
        case 'rename':
          // 이름을 같이 적으면 바로 바꾸고, 없으면 탭의 이름 칸을 연다
          if (arg) void window.api.renameConversation(project.id, conversationId, arg)
          else setEditingId(conversationId)
          return
        case 'rewind': return openTool({ kind: 'rewind' })
        case 'resume': return openTool({ kind: 'resume' })
        case 'fork':
          void window.api.forkConversation(project.id, conversationId, arg || undefined).then(onSelectConversation, (err) => setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) }))
          return
        case 'export':
          void window.api.exportConversation(project.id, conversationId).then((path) => path && setNotice({ ok: true, text: `저장했어요 · ${path}` }), (err) => setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) }))
          return
        case 'mcp': return openTool({ kind: 'mcp' })
        case 'agents': return openTool({ kind: 'agents' })
        case 'permissions':
        case 'hooks': return openTool({ kind: 'permissions' })
        case 'add-dir':
          void window.api.addDirectory(project.id, conversationId, arg || undefined).then((dirs) => setNotice({ ok: true, text: dirs.length ? `더 쓰는 폴더 · ${dirs.join(' · ')}` : '더 쓰는 폴더가 없어요' }), (err) => setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) }))
          return
        case 'memory': return openTool({ kind: 'memory' })
        case 'status':
        case 'login': return openTool({ kind: 'status' })
        default: return void window.api.clear(project.id, conversationId)
      }
    }
    if (limit?.level === 100 && !limitArmed) {
      setLimitArmed(true)
      return
    }
    setDraft('')
    history.push(text)
    void window.api.send(project.id, conversationId, text)
  }

  /** ↑↓로 보낸 글 되살리기. 입력창이 비었거나 커서가 첫 줄/끝 줄에 있을 때만 (여러 줄 글 안에서는 줄 이동) */
  const historyKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return false
    const el = e.currentTarget
    const before = el.value.slice(0, el.selectionStart)
    const after = el.value.slice(el.selectionEnd)
    if (e.key === 'ArrowUp' && before.includes('\n')) return false
    if (e.key === 'ArrowDown' && after.includes('\n')) return false
    const next = e.key === 'ArrowUp' ? history.prev(draft) : history.next()
    if (next === null) return false
    setDraft(next)
    requestAnimationFrame(() => {
      const n = inputRef.current
      if (n) n.setSelectionRange(n.value.length, n.value.length)
    })
    return true
  }

  /** 기다리던 메시지를 꺼내 입력창에 되돌려 놓는다 (고쳐서 다시 보내게) */
  const editQueued = async (queuedId: string): Promise<void> => {
    const text = await window.api.dropQueued(project.id, conversationId, queuedId)
    if (text === null) return setNotice({ ok: false, text: '이미 보낸 메시지예요' })
    setDraft((d) => (d.trim() ? `${text}\n\n${d}` : text))
    inputRef.current?.focus()
  }
  const cancelQueued = async (queuedId: string): Promise<void> => {
    if ((await window.api.dropQueued(project.id, conversationId, queuedId)) === null) setNotice({ ok: false, text: '이미 보낸 메시지예요' })
  }

  const projectIndex = projects.findIndex((p) => p.id === project.id)
  let toolCount = 0

  return (
    <div className="screen" onClick={(e) => refocusAfterClick(e, () => (document.querySelector('.permission') ? null : inputRef.current))}>
      <header className="topbar">
        <div className="tb-proj">
          <span className="tb-key" aria-hidden="true">{HOME_ROW[projectIndex] ?? ''}</span>
          <span className="tb-name">
            <b>{project.name}</b>
            {conv?.worktree ? (
              <span className="tb-wt" title={conv.worktree.path}>
                <span className="wt-tag">WORKTREE</span> <BranchName branch={branch} fallback={conv.worktree.branch} /> <span className="tb-path">· {conv.worktree.path}</span>
              </span>
            ) : branch ? (
              <span className="tb-wt" title={project.path}>
                <span className="wt-tag">BRANCH</span> <BranchName branch={branch} /> <span className="tb-path">· {project.path}</span>
              </span>
            ) : (
              <span>{project.path}</span>
            )}
          </span>
        </div>
        <div className="tb-right">
          {otherWaiting.map(({ p, i, n }) => (
            <span key={p.id} className="badge other">
              {p.name} NEEDS YOU {n}
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
            {state.compacting ? 'COMPACTING' : 'COMPACT'}
          </button>
          <button type="button" className={`tb-btn ${clearArmed ? 'armed' : ''}`} onClick={onClearRequest} title="컨텍스트를 비우고 새 세션으로 시작해요 (/clear)">
            {clearArmed ? 'AGAIN' : 'CLEAR'}
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
                  title={armedHere ? '한 번 더 누르면 닫혀요' : '대화 닫기 · 두 번 누르면 닫혀요'}
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
            <EffortPicker choice={conv?.effort} info={effortInfo} onPick={setEffort} />
            <button type="button" className={`meta meta-mode mode-${mode}`} onClick={cycleMode} title="권한 모드 바꾸기">
              <span className="meta-k">MODE</span>
              <span className="meta-v">{MODE_LABEL[mode]}</span>
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
            forgetTerminals(conversationId)
          }}
        />
      ) : tool ? (
        <ToolPanelView
          key={tool.kind}
          panel={tool}
          projectId={project.id}
          conversationId={conversationId}
          items={state.items}
          busy={busy || state.status === 'queued' || !!state.compacting}
          onClose={() => {
            setTool(null)
            requestAnimationFrame(() => inputRef.current?.focus())
          }}
          onRewound={(text) => {
            if (text) setDraft((d) => (d.trim() ? `${text}\n\n${d}` : text))
          }}
          onOpenConversation={onSelectConversation}
          onRunInTerminal={(cmd) => void runInTerminal(project.id, conversationId, cmd)}
          onInsert={(text) => insertAtCaret(text)}
          onJumpToTool={jumpToTool}
          root={root}
        />
      ) : detail ? (
        <TaskDetail
          key={detail.kind === 'task' ? detail.taskId : detail.toolUseId}
          target={detail}
          state={state}
          projectId={project.id}
          conversationId={conversationId}
          root={root}
          onClose={() => setDetail(null)}
          onStopTask={(taskId) => window.api.stopTask(project.id, conversationId, taskId)}
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
            <Item
              key={`${conversationId}:${idx}`}
              item={item}
              n={item.type === 'tool' ? ++toolCount : 0}
              root={root}
              enter={idx >= seen.current.count}
              subs={state.subs}
              progress={state.progress}
              onRun={(cmd) => void runInTerminal(project.id, conversationId, cmd)}
              onQueueEdit={(id) => void editQueued(id)}
              onQueueCancel={(id) => void cancelQueued(id)}
              onRewind={!busy && state.status !== 'queued' ? (uuid) => openTool({ kind: 'rewind', uuid }) : undefined}
              onExpand={(toolUseId) => window.api.toolResult(project.id, conversationId, toolUseId)}
            />
          ))}
          {working.item && <Working status={state.status} activity={state.task?.activity} startedAt={state.task?.startedAt} leaving={working.leaving} />}
          {compacting.item && <div className={`msg compacting ${compacting.leaving ? 'leaving' : ''}`}>COMPACTING · 지금까지의 대화를 요약하고 있어요</div>}
          {permission.item && (
            <PermissionBox
              key={permission.item.requestId}
              req={permission.item}
              leaving={permission.leaving}
              onRespond={(d, extra) => permission.item && !permission.leaving && onRespond(project.id, conversationId, permission.item.requestId, d, extra)}
              onEditPrompt={() => {
                // 거절된 지시를 입력창으로 돌려줘 고쳐 보낼 수 있게
                const last = state.items.findLast((i) => i.type === 'user')
                if (last?.type === 'user') setDraft(last.text)
              }}
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
            root={root}
            selected={detail}
            onOpen={(t) => {
              setShowChanges(false)
              setTool(null)
              setDetail((cur) => (cur && sameTarget(cur, t) ? null : t))
            }}
            onTools={() => (tool?.kind === 'tools' ? setTool(null) : openTool({ kind: 'tools', since: state.task?.startedAt }))}
            onStopTask={(taskId) => window.api.stopTask(project.id, conversationId, taskId)}
          />
        )}
      </div>

      {confirm.item && (
        <div className={`confirm ${confirm.leaving ? 'leaving' : ''}`} role="alert">
          {confirm.item === 'project' ? (
            <>
              한 번 더 누르면 {project.name} 프로젝트를 목록에서 닫아요. 실행 중인 작업은 멈추고, 폴더와 파일은 그대로예요
            </>
          ) : confirm.item === 'close' ? (
            <>
              한 번 더 누르면 {state.status === 'running' || state.status === 'waiting_approval' ? '실행 중인 작업을 멈추고 ' : ''}이 대화를 닫아요
            </>
          ) : (
            <>
              한 번 더 누르면 컨텍스트를 비우고 새 세션으로 시작해요
            </>
          )}
        </div>
      )}
      <div className={`composer ${attach.dropping ? 'dropping' : ''}`} {...attach.dropProps}>
        {slashShown.item && (
          <SlashMenu items={menuItems} index={menuIndex} loading={slash.loading} leaving={slashShown.leaving} onHover={setMenuIndex} onPick={(c) => pickCommand(c, true)} />
        )}
        {fileShown.item && <FileMenu items={fileItems} index={menuIndex} loading={!files || files.q !== fileQuery} leaving={fileShown.leaving} onHover={setMenuIndex} onPick={pickFile} />}
        {notice && (
          <div className={`limit-warn ${notice.ok ? '' : 'full'}`} role="status">
            <b>{notice.ok ? 'OK' : 'ERROR'}</b>
            <span>{notice.text}</span>
          </div>
        )}
        {limitShown.item && (
          <div className={`limit-warn ${limitShown.item.level === 100 ? 'full' : ''} ${limitArmed ? 'armed' : ''} ${limitShown.leaving ? 'leaving' : ''}`} role="status">
            <b>LIMIT</b>
            <span>
              {limitShown.item.window.label} {limitShown.item.level === 100 ? '한도를 다 썼어요' : `${limitShown.item.window.percent ?? limitShown.item.level}%`}
              {limitShown.item.window.resetsAt ? ` · ${formatReset(limitShown.item.window.resetsAt)}` : ''}
            </span>
            {limitShown.item.level === 100 && <em>{limitArmed ? '지금 보내면 거절될 수 있어요 · 한 번 더 보내면 그대로 보내요' : '보내면 거절될 수 있어요'}</em>}
          </div>
        )}
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
            rows={1}
            placeholder={busy ? '작업 중이에요 · 지금 입력하면 다음 차례로 보내요' : '메시지 입력 · / 명령 · @ 파일'}
            onChange={(e) => {
              // 아직 세션이 없는 대화에 글을 치기 시작하면 CLI를 미리 띄워 첫 응답을 앞당긴다
              if (!draft && e.target.value && !conv?.sessionId && state.items.length === 0) void window.api.prewarm()
              setDraft(e.target.value)
              setCaret(e.target.selectionStart)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={attach.onPaste}
            onKeyDown={(e) => {
              if (menuKey(e) || historyKey(e)) {
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

      <TerminalDrawer
        projectId={project.id}
        conversationId={conversationId}
        onSend={(text) => {
          // 선택한 터미널 출력을 코드 블록으로 입력창 끝에 붙인다 (보내기 전에 질문을 덧붙일 수 있게)
          setDraft((d) => `${d.trimEnd() ? `${d.trimEnd()}\n\n` : ''}\`\`\`\n${text}\n\`\`\`\n`)
          requestAnimationFrame(() => {
            const el = inputRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }}
        onPath={(raw) => {
          // Ctrl+클릭한 경로를 커서 자리에 넣는다
          const text = pathForComposer(raw, root)
          const el = inputRef.current
          const at = el && document.activeElement === el ? el.selectionStart : draft.length
          const before = draft.slice(0, at)
          const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${text}`
          setDraft(before + insert + draft.slice(at))
          const pos = at + insert.length
          setCaret(pos)
          requestAnimationFrame(() => {
            inputRef.current?.focus()
            inputRef.current?.setSelectionRange(pos, pos)
          })
        }}
      />
    </div>
  )
}

/** 대화 폴더의 브랜치. 대화를 열 때·작업 상태가 바뀔 때·창으로 돌아올 때·30초마다 다시 읽는다 */
function useBranch(projectId: string, conversationId: string, status: string): GitBranch | null {
  const [branch, setBranch] = useState<{ id: string; value: GitBranch | null } | null>(null)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.api.gitBranch(projectId, conversationId).then((value) => alive && setBranch({ id: conversationId, value }), () => {})
    }
    read()
    const timer = setInterval(() => document.visibilityState === 'visible' && read(), 30_000)
    window.addEventListener('focus', read)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [projectId, conversationId, status])
  return branch?.id === conversationId ? branch.value : null
}

function BranchName({ branch, fallback }: { branch: GitBranch | null; fallback?: string }): React.JSX.Element {
  if (!branch) return <span className="tb-branch">{fallback}</span>
  return (
    <span className={`tb-branch ${branch.dirty ? 'dirty' : ''}`} title={`${branch.detached ? '분리된 HEAD' : '브랜치'} ${branch.name}${branch.dirty ? ' · 커밋하지 않은 변경이 있어요' : ''}`}>
      {branch.detached ? `DETACHED ${branch.name}` : branch.name}
      {branch.dirty && <i aria-label="커밋하지 않은 변경">*</i>}
    </span>
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
  /** TOOLS 수를 누르면: 이번 작업의 도구 목록 */
  onTools: () => void
  onStopTask: (taskId: string) => Promise<void>
}

const sameTarget = (a: DetailTarget, b: DetailTarget): boolean =>
  a.kind === 'task' ? b.kind === 'task' && a.taskId === b.taskId : b.kind === 'agent' && a.toolUseId === b.toolUseId

/**
 * 오른쪽 상태 패널: 실행 중이거나, 백그라운드 셸·모니터가 돌거나, 아티팩트가 연결돼 있으면 펼쳐진다.
 * 그 밖에는 끝난 뒤 마지막 단계를 잠깐 보여 주고 접힌다
 */
function StatusPanel({ task, status, background, agents, artifacts, items, subs, progress, root, selected, onOpen, onTools, onStopTask }: PanelProps): React.JSX.Element {
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
  return (
    <aside className={`status-panel ${waiting ? 'waiting' : ''} ${live ? 'live' : ''}`} aria-label="작업 상태">
      {showTask && task && <TaskStatus task={task} status={status} now={now} onTools={onTools} />}
      {agents.length > 0 && (
        <section className="sp-sec" aria-label="하위 에이전트">
          <div className="sp-sec-h">
            <span className="sp-k">AGENTS</span>
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
            <span className="sp-k">BACKGROUND</span>
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

function TaskStatus({ task, status, now, onTools }: { task: TaskInfo; status: string; now: number; onTools: () => void }): React.JSX.Element {
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
        <div>
          <dt>TOOLS</dt>
          <dd>
            <button type="button" className="sp-stat-btn" onClick={onTools} disabled={task.tools === 0} title="이번 작업에서 부른 도구를 모두 봐요">
              {task.tools}
            </button>
          </dd>
        </div>
        <div><dt>TIME</dt><dd>{clock(ms)}</dd></div>
        <div><dt>FILES</dt><dd>{task.files.length}</dd></div>
      </dl>
      <Equalizer mode={waiting ? 'waiting' : status === 'running' ? 'live' : 'idle'} />
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
      <span className="working-bar" aria-hidden="true"><i /></span>
    </div>
  )
}

interface ItemProps {
  item: TranscriptItem
  n: number
  root: string
  enter: boolean
  subs?: Record<string, SubItem[]>
  progress?: Record<string, AgentProgress>
  onRun?: (command: string) => void
  /** 차례를 기다리는 메시지를 꺼내 고치기 · 빼기 */
  onQueueEdit?: (queuedId: string) => void
  onQueueCancel?: (queuedId: string) => void
  /** 이 메시지 시점으로 되감기 (쉬고 있을 때만 온다) */
  onRewind?: (uuid: string) => void
  /** 잘린 도구 결과의 전문 읽기 */
  onExpand?: (toolUseId: string) => Promise<string | null>
}

function Item({ item, n, root, enter, subs, progress, onRun, onQueueEdit, onQueueCancel, onRewind, onExpand }: ItemProps): React.JSX.Element {
  const e = enter ? ' enter' : ''
  switch (item.type) {
    case 'user':
      return (
        <div className={`msg user ${item.pending ? 'pending' : ''}${e}`}>
          {item.text}
          {item.pending && item.queuedId && (
            <span className="msg-acts">
              <span className="msg-wait">NEXT</span>
              <button type="button" onClick={() => onQueueEdit?.(item.queuedId!)} title="보내지 않고 입력창으로 되돌려요">EDIT</button>
              <button type="button" onClick={() => onQueueCancel?.(item.queuedId!)} title="이 메시지를 보내지 않아요">CANCEL</button>
            </span>
          )}
          {!item.pending && item.uuid && onRewind && (
            <span className="msg-acts hover">
              <button type="button" onClick={() => onRewind(item.uuid!)} title="이 메시지 시점으로 파일·대화를 되돌려요">REWIND</button>
            </span>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className={`msg assistant ${item.streaming ? 'streaming' : ''}${e}`}>
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} enter={enter} />
    case 'notice':
      return item.mono ? (
        <pre className={`msg notice output ${item.tone}${e}`}>{item.text}</pre>
      ) : (
        <div className={`msg notice ${item.tone}${e}`}>{item.text}</div>
      )
    case 'divider':
      return <div className={`divider${e}`} role="separator">■ {item.text}</div>
    case 'hook': {
      const st = item.running ? 'RUNNING' : item.outcome === 'error' ? `ERROR${item.exitCode ? ` ${item.exitCode}` : ''}` : item.outcome === 'cancelled' ? 'CANCELLED' : 'OK'
      return (
        <details className={`hook ${item.outcome === 'error' ? 'error' : ''}${e}`}>
          <summary>
            <span className="hook-k">HOOK</span>
            <span className="hook-ev">{item.event}</span>
            <span className="hook-name" title={item.name}>{item.name}</span>
            <span className={`tool-st ${item.running ? 'run' : ''}`}>{st}</span>
          </summary>
          {item.output ? <pre className="hook-out">{item.output}</pre> : <div className="hook-out muted">출력이 없어요</div>}
        </details>
      )
    }
    case 'tool': {
      const status = item.result === undefined ? (item.elapsedS !== undefined ? `RUNNING ${item.elapsedS}s` : 'RUNNING') : item.isError ? 'ERROR' : 'DONE'
      // 하위 에이전트: 그 안에서 한 일을 펼쳐 볼 수 있게 한다
      const sub = isAgentTool(item.name) ? subs?.[item.toolUseId] : undefined
      const subTools = progress?.[item.toolUseId]?.tools ?? sub?.filter((i) => i.type === 'tool').length ?? 0
      return (
        <details className={`tool ${item.isError ? 'error' : ''}${e}`} data-tool-id={item.toolUseId}>
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
            {(item.name === 'Bash' || item.name === 'PowerShell') && typeof (item.input as { command?: unknown } | null)?.command === 'string' && onRun && (
              <button
                type="button"
                className="tool-run"
                onClick={() => onRun((item.input as { command: string }).command)}
                title="이 명령을 아래 터미널 입력줄에 넣어요. 실행은 직접 해요"
              >
                RUN IN TERMINAL
              </button>
            )}
            {sub && sub.length > 0 && (
              <>
                <h5>AGENT LOG · {sub.length}</h5>
                <SubLog list={sub} subs={subs ?? {}} root={root} />
              </>
            )}
            {item.result !== undefined && <ToolOutput toolUseId={item.toolUseId} text={item.result} truncated={item.truncated} onExpand={onExpand} />}
          </div>
        </details>
      )
    }
  }
}

/** 도구 결과. 화면에는 앞부분만 와 있으므로 SHOW ALL을 누르면 세션 기록에서 전문을 읽는다 */
function ToolOutput({ toolUseId, text, truncated, onExpand }: { toolUseId: string; text: string; truncated?: boolean; onExpand?: (toolUseId: string) => Promise<string | null> }): React.JSX.Element {
  const [full, setFull] = useState<{ id: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const shown = full?.id === toolUseId ? full.text : text
  const expand = async (): Promise<void> => {
    if (!onExpand) return
    setLoading(true)
    const t = await onExpand(toolUseId)
    setLoading(false)
    if (t !== null) setFull({ id: toolUseId, text: t })
  }
  return (
    <>
      <h5>
        OUTPUT
        {truncated && full?.id !== toolUseId && (
          <button type="button" className="tool-more" disabled={loading} onClick={() => void expand()} title="세션 기록에서 결과 전문을 읽어요">
            {loading ? '…' : 'SHOW ALL'}
          </button>
        )}
      </h5>
      <pre>{shown || '(no output)'}</pre>
      {truncated && full?.id !== toolUseId && <span className="muted">… 앞부분만 보여요</span>}
    </>
  )
}

/** 모델의 생각 (요약본). 접힌 채로 첫 줄만, 생각하는 동안은 맥동 */
function Thinking({ text, streaming, enter }: { text: string; streaming: boolean; enter: boolean }): React.JSX.Element {
  const first = text.trim().split('\n').find(Boolean) ?? ''
  return (
    <details className={`thinking ${streaming ? 'streaming' : ''}${enter ? ' enter' : ''}`}>
      <summary>
        <span className="thinking-k">{streaming ? 'THINKING' : 'THOUGHT'}</span>
        <span className="thinking-first">{first}</span>
      </summary>
      <div className="thinking-body">
        <Markdown text={text} />
      </div>
    </details>
  )
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

function PermissionBox({ req, leaving, onRespond, onEditPrompt }: { req: PermissionRequest; leaving: boolean; onRespond: (d: PermissionDecision, extra?: PermissionExtra) => void; onEditPrompt?: () => void }): React.JSX.Element {
  const cls = `permission ${leaving ? 'leaving' : ''}`
  // 모델이 묻는 질문: 선택지를 고르거나 직접 적어 답한다
  if (req.toolName === 'AskUserQuestion' && Array.isArray(req.input.questions)) {
    return <QuestionBox cls={cls} questions={req.input.questions as AskQuestion[]} agentId={req.agentId} onRespond={onRespond} />
  }
  // 플랜 승인: 계획을 읽고 어떤 모드로 실행할지 고른다
  if (req.toolName === 'ExitPlanMode') return <PlanBox cls={cls} req={req} onRespond={onRespond} />
  // MCP 서버의 입력 요청: 폼 값을 적거나 브라우저에서 인증하고 온다
  if (req.toolName === ELICITATION_TOOL && req.elicitation) return <ElicitationBox cls={cls} req={req} onRespond={onRespond} />
  // 모델이 답을 거절함: 다른 모델로 다시 시도할지 고른다
  if (req.toolName === REFUSAL_TOOL && req.refusal) return <RefusalBox cls={cls} req={req} onRespond={onRespond} onEditPrompt={onEditPrompt} />
  return (
    <div className={cls} role="alert">
      <div className="permission-head">
        <span className="q" aria-hidden="true">?</span>
        <div>
          <div className="permission-title">{req.title ?? `${req.toolName}, 실행할까요?`}</div>
          {req.description && <div className="permission-desc">{req.description}</div>}
          {req.agentId && <div className="permission-desc">하위 에이전트의 요청이에요</div>}
        </div>
      </div>
      <pre>{JSON.stringify(req.input, null, 2)}</pre>
      <div className="permission-actions">
        <button type="button" onClick={() => onRespond('allow')}>ALLOW</button>
        {!req.suppressAlwaysAllow && (
          <button type="button" onClick={() => onRespond('always')} title={req.always ? ALWAYS_SCOPE_TIP[req.always.scope] : undefined}>
            ALWAYS ALLOW
            {req.always && (
              <span className="always-what">
                <span className="always-rule" title={req.always.what}>{req.always.what}</span> · {ALWAYS_SCOPE_LABEL[req.always.scope]}
              </span>
            )}
          </button>
        )}
        <button type="button" onClick={() => onRespond('deny')}>DENY</button>
      </div>
      {req.defaultToNo && <div className="muted">이 요청은 단축키로 허락할 수 없어요. 버튼을 직접 눌러 주세요.</div>}
    </div>
  )
}

/** MCP elicitation의 폼 필드 하나 (JSON Schema 일부) */
interface FieldSchema {
  type?: string | string[]
  title?: string
  description?: string
  enum?: (string | number)[]
  default?: unknown
  format?: string
}

type FieldValue = string | number | boolean | string[]

function fieldType(f: FieldSchema): string {
  const t = Array.isArray(f.type) ? f.type.find((x) => x !== 'null') : f.type
  return t ?? 'string'
}

/**
 * MCP 서버가 사람에게 묻는 것. form: 스키마대로 값을 받아 accept와 함께 돌려준다. url: 브라우저에서 인증하고 DONE.
 * DECLINE은 서버에 거절로, CANCEL은 그냥 닫은 것으로 전해진다
 */
function ElicitationBox({ cls, req, onRespond }: { cls: string; req: PermissionRequest; onRespond: (d: PermissionDecision, extra?: PermissionExtra) => void }): React.JSX.Element {
  const info = req.elicitation!
  const url = info.mode === 'url'
  const schema = (info.schema ?? {}) as { properties?: Record<string, FieldSchema>; required?: string[] }
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema.properties])
  const required = schema.required ?? []
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {}
    for (const [key, f] of fields) {
      if (f.default !== undefined) init[key] = f.default as FieldValue
      else if (fieldType(f) === 'boolean') init[key] = false
    }
    return init
  })
  const set = (key: string, v: FieldValue): void => setValues((o) => ({ ...o, [key]: v }))
  const missing = !url && required.some((k) => values[k] === undefined || values[k] === '')
  const answer = (action: 'accept' | 'decline' | 'cancel'): void =>
    onRespond(action === 'accept' ? 'allow' : 'deny', { elicitation: { action, content: action === 'accept' && !url ? values : undefined } })
  return (
    <div className={`${cls} elicit`} role="alert">
      <div className="permission-head">
        <span className="q" aria-hidden="true">?</span>
        <div>
          <div className="permission-title">{info.title ?? (url ? '브라우저에서 인증해 주세요' : '서버가 입력을 기다려요')}</div>
          <div className="permission-desc">MCP · {info.serverName}{info.description ? ` · ${info.description}` : ''}</div>
        </div>
      </div>
      {info.message && <div className="elicit-msg">{info.message}</div>}
      {url && info.url && (
        <a className="elicit-url" href={info.url} target="_blank" rel="noreferrer noopener" title={info.url}>
          OPEN IN BROWSER
        </a>
      )}
      {!url && fields.length > 0 && (
        <div className="elicit-form">
          {fields.map(([key, f]) => {
            const t = fieldType(f)
            const id = `elicit-${req.requestId}-${key}`
            const label = (
              <label htmlFor={id}>
                {f.title ?? key}
                {required.includes(key) && <i aria-label="필수"> *</i>}
                {f.description && <span>{f.description}</span>}
              </label>
            )
            if (f.enum) {
              return (
                <div className="elicit-field" key={key}>
                  {label}
                  <select id={id} value={String(values[key] ?? '')} onChange={(e) => set(key, t === 'number' || t === 'integer' ? Number(e.target.value) : e.target.value)}>
                    <option value="">—</option>
                    {f.enum.map((v) => (
                      <option key={String(v)} value={String(v)}>{String(v)}</option>
                    ))}
                  </select>
                </div>
              )
            }
            if (t === 'boolean') {
              return (
                <div className="elicit-field check" key={key}>
                  <input id={id} type="checkbox" checked={values[key] === true} onChange={(e) => set(key, e.target.checked)} />
                  {label}
                </div>
              )
            }
            const numeric = t === 'number' || t === 'integer'
            const inputType = numeric ? 'number' : f.format === 'email' ? 'email' : f.format === 'uri' ? 'url' : f.format === 'date' ? 'date' : 'text'
            return (
              <div className="elicit-field" key={key}>
                {label}
                <input
                  id={id}
                  type={inputType}
                  step={t === 'integer' ? 1 : undefined}
                  value={values[key] === undefined ? '' : String(values[key])}
                  onChange={(e) => set(key, numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
                />
              </div>
            )
          })}
        </div>
      )}
      <div className="permission-actions">
        <button type="button" onClick={() => answer('accept')} disabled={missing}>{url ? 'DONE' : 'SUBMIT'}</button>
        <button type="button" onClick={() => answer('decline')}>DECLINE</button>
        <button type="button" onClick={() => answer('cancel')}>CANCEL</button>
      </div>
    </div>
  )
}

/** 'claude-opus-5-5' → 'OPUS 5.5'. 모르는 형식은 그대로 */
function shortModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/i.exec(id)
  return m ? `${m[1].toUpperCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

/**
 * 모델이 답을 거절했을 때 CLI가 묻는 것 (refusal_fallback_prompt): 다른 모델로 다시 시도 · 지시를 고쳐 보냄 · 그만.
 * EDIT PROMPT는 거절된 지시를 입력창으로 돌려준다
 */
function RefusalBox({ cls, req, onRespond, onEditPrompt }: { cls: string; req: PermissionRequest; onRespond: (d: PermissionDecision, extra?: PermissionExtra) => void; onEditPrompt?: () => void }): React.JSX.Element {
  const r = req.refusal!
  const pick = (choice: RefusalChoice): void => {
    if (choice === 'edit_prompt') onEditPrompt?.()
    onRespond(choice === 'cancelled' ? 'deny' : 'allow', { dialog: choice })
  }
  return (
    <div className={`${cls} refusal`} role="alert">
      <div className="permission-head">
        <span className="q" aria-hidden="true">!</span>
        <div>
          <div className="permission-title">{shortModel(r.originalModel)} 모델이 이 요청에 답하지 않았어요</div>
          <div className="permission-desc">
            {r.guidance ?? `${shortModel(r.fallbackModel)} 모델로 다시 시도하거나, 지시를 고쳐 다시 보낼 수 있어요`}
            {r.category ? ` · ${r.category}` : ''}
          </div>
        </div>
      </div>
      <div className="permission-actions">
        <button type="button" onClick={() => pick('retry_fallback')}>RETRY WITH {shortModel(r.fallbackModel)}</button>
        <button type="button" onClick={() => pick('edit_prompt')}>EDIT PROMPT</button>
        <button type="button" onClick={() => pick('cancelled')}>CANCEL</button>
      </div>
    </div>
  )
}

/**
 * AskUserQuestion: 질문마다 선택지(1~4)와 직접 적기. 복수 선택은 토글.
 * 답은 updatedInput으로 돌아가야 모델이 받으므로 SUBMIT에서 한꺼번에 보낸다 (SDK 문서의 answers 형식)
 */
function QuestionBox({ cls, questions, agentId, onRespond }: { cls: string; questions: AskQuestion[]; agentId?: string; onRespond: (d: PermissionDecision, extra?: PermissionExtra) => void }): React.JSX.Element {
  const [picked, setPicked] = useState<Record<number, Set<string>>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [cur, setCur] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    boxRef.current?.focus()
  }, [])
  const toggle = (qi: number, label: string): void => {
    const q = questions[qi]
    setPicked((p) => {
      const set = new Set(p[qi] ?? [])
      if (q.multiSelect) set.has(label) ? set.delete(label) : set.add(label)
      else {
        const was = set.has(label)
        set.clear()
        if (!was) set.add(label)
      }
      return { ...p, [qi]: set }
    })
    // 단일 선택이면 다음 질문으로
    if (!q.multiSelect) setCur((c) => Math.min(c + 1, questions.length - 1))
  }
  const answerOf = (qi: number): string => {
    const chosen = [...(picked[qi] ?? [])]
    const free = (other[qi] ?? '').trim()
    return [...chosen, ...(free ? [free] : [])].join(', ')
  }
  const done = questions.every((_, i) => answerOf(i))
  const submit = (): void => {
    if (!done) return
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => (answers[q.question] = answerOf(i)))
    onRespond('allow', { answers })
  }
  // 숫자 키로 고르기, Enter로 보내기 (입력칸 밖에서)
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT'
    if (e.key === 'Enter' && !typing) {
      e.preventDefault()
      submit()
    } else if (!typing && /^[1-4]$/.test(e.key)) {
      const opt = questions[cur]?.options[Number(e.key) - 1]
      if (opt) {
        e.preventDefault()
        toggle(cur, opt.label)
      }
    } else if (e.key === 'Tab' && !typing && questions.length > 1 && !e.shiftKey) {
      e.preventDefault()
      setCur((c) => (c + 1) % questions.length)
    }
  }
  return (
    <div className={`${cls} question`} role="alert" ref={boxRef} tabIndex={-1} data-keys-own="true" onKeyDown={onKey}>
      <div className="permission-head">
        <span className="q" aria-hidden="true">?</span>
        <div>
          <div className="permission-title">{questions.length > 1 ? `물어볼 게 ${questions.length}개 있어요` : '물어볼 게 있어요'}</div>
          {agentId && <div className="permission-desc">하위 에이전트의 질문이에요</div>}
        </div>
      </div>
      {questions.map((q, qi) => (
        <section key={qi} className={`qbox ${qi === cur ? 'cur' : ''}`} onClick={() => setCur(qi)}>
          <div className="qbox-head">
            <span className="chip">{q.header}</span>
            <span className="qbox-q">{q.question}</span>
            {q.multiSelect && <span className="qbox-multi">MULTI</span>}
          </div>
          <div className="qbox-opts">
            {q.options.map((o, oi) => {
              const on = picked[qi]?.has(o.label) ?? false
              return (
                <button key={o.label} type="button" className={`qbox-opt ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(qi, o.label)} title={o.description}>
                  <span className="qbox-n">{oi + 1}</span>
                  <span className="qbox-l">
                    <b>{o.label}</b>
                    <span>{o.description}</span>
                  </span>
                </button>
              )
            })}
            {(() => {
              const sel = q.options.find((o) => picked[qi]?.has(o.label) && o.preview)
              return sel?.preview ? <pre className="qbox-preview">{sel.preview}</pre> : null
            })()}
            <label className="qbox-other">
              <span className="qbox-n">+</span>
              <input value={other[qi] ?? ''} onChange={(e) => setOther((o) => ({ ...o, [qi]: e.target.value }))} placeholder="직접 적기" aria-label={`${q.header} 직접 적기`} onFocus={() => setCur(qi)} />
            </label>
          </div>
        </section>
      ))}
      <div className="permission-actions">
        <button type="button" disabled={!done} onClick={submit}>SUBMIT</button>
        <button type="button" onClick={() => onRespond('deny', { message: '사용자가 답하지 않고 넘어가길 원함' })}>SKIP</button>
      </div>
      <div className="muted">숫자 키로 고르고 Enter로 보내요. 여러 질문은 Tab으로 옮겨요.</div>
    </div>
  )
}

/** ExitPlanMode: 계획을 마크다운으로 보여 주고, 승인하면서 편집을 자동 허용할지 고른다 (CLI의 세 갈래) */
function PlanBox({ cls, req, onRespond }: { cls: string; req: PermissionRequest; onRespond: (d: PermissionDecision, extra?: PermissionExtra) => void }): React.JSX.Element {
  const plan = typeof req.input.plan === 'string' ? req.input.plan : ''
  const [open, setOpen] = useState(true)
  return (
    <div className={`${cls} plan`} role="alert">
      <div className="permission-head">
        <span className="q" aria-hidden="true">?</span>
        <div>
          <div className="permission-title">계획을 세웠어요. 실행할까요?</div>
          {req.description && <div className="permission-desc">{req.description}</div>}
        </div>
      </div>
      {plan ? (
        <details className="plan-body" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>PLAN</summary>
          <div className="md-wrap"><Markdown text={plan} /></div>
        </details>
      ) : (
        <div className="permission-desc">계획은 위의 답변에 있어요.</div>
      )}
      <div className="permission-actions">
        <button type="button" onClick={() => onRespond('allow', { planMode: 'acceptEdits' })} title="실행하고, 파일 편집은 묻지 않아요">YES · AUTO EDITS</button>
        <button type="button" onClick={() => onRespond('allow', { planMode: 'default' })} title="실행하되 편집마다 물어요">YES · ASK EACH</button>
        <button type="button" onClick={() => onRespond('deny', { message: '사용자가 계획을 더 다듬길 원함. 플랜 모드를 유지하고 무엇을 바꿀지 물어볼 것' })} title="플랜 모드에 남아 계획을 고쳐요">KEEP PLANNING</button>
      </div>
    </div>
  )
}

