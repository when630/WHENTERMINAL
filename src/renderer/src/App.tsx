import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MODE_CYCLE, type AgentMode, type PermissionDecision, type Project, type RateLimitInfo } from '@shared/types'
import { applyEvent, collectTasks, mostUrgentConversation, type ConversationMap, type TaskInfo, type TaskRef } from './state'
import { Home, type DispatchOrigin } from './Home'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import { Ticker } from './Ticker'
import { isEscape, isInterruptCopy, physicalCode, projectIndexFromKey } from './keys'

export type View = { screen: 'home' } | { screen: 'chat'; projectId: string; conversationId: string }

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [convs, setConvs] = useState<ConversationMap>({})
  const [view, setView] = useState<View>({ screen: 'home' })
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null)
  const [hotkey, setHotkey] = useState<string | null>(null)
  const [dispatchIndex, setDispatchIndex] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openReportId, setOpenReportId] = useState<string | null>(null)
  const [focusInput, setFocusInput] = useState(0)
  const [clearArmed, setClearArmed] = useState<string | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dispatchOrigin = useRef<DispatchOrigin | null>(null)
  const sheetCloseRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    window.api.listProjects().then(setProjects)
    window.api.getHotkey().then(setHotkey)
    const offs = [
      window.api.onProjectsChanged(setProjects),
      window.api.onRateLimit(setRateLimit),
      window.api.onEvent(({ conversationId, event }) => setConvs((prev) => ({ ...prev, [conversationId]: applyEvent(prev[conversationId], event) }))),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const patchTask = useCallback((conversationId: string, patch: Partial<TaskInfo>) => {
    setConvs((prev) => {
      const s = prev[conversationId]
      if (!s?.task) return prev
      return { ...prev, [conversationId]: { ...s, task: { ...s.task, ...patch } } }
    })
  }, [])

  // 보고 있는 대화의 보고서는 읽은 것으로 처리
  const viewing = view.screen === 'chat' ? view.conversationId : null
  useEffect(() => {
    if (viewing && convs[viewing]?.task?.unread) patchTask(viewing, { unread: false })
  }, [viewing, convs, patchTask])

  // 다른 화면에서 Ctrl+K를 누르면 홈으로 온 뒤 작업 지시창에 포커스
  useEffect(() => {
    if (focusInput && view.screen === 'home') inputRef.current?.focus()
  }, [focusInput, view.screen])

  const { running, reports } = useMemo(() => collectTasks(projects, convs), [projects, convs])
  const flat = useMemo(() => [...running, ...reports], [running, reports])
  const unreadTotal = reports.filter((r) => r.task.unread).length

  const openChat = useCallback((projectId: string, conversationId: string) => {
    setOpenReportId(null)
    const i = projects.findIndex((p) => p.id === projectId)
    if (i >= 0) setDispatchIndex(i)
    setView({ screen: 'chat', projectId, conversationId })
  }, [projects])

  const openProject = useCallback(
    (index: number) => {
      const p = projects[index]
      if (p) openChat(p.id, mostUrgentConversation(p, convs))
    },
    [projects, convs, openChat],
  )

  const respond = useCallback((projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) => {
    void window.api.respondPermission(projectId, conversationId, requestId, decision)
  }, [])

  const openReport = useCallback((id: string) => {
    setSelectedId(id)
    setOpenReportId(id)
    patchTask(id, { unread: false })
  }, [patchTask])

  const archive = useCallback((id: string) => {
    patchTask(id, { archived: true, unread: false })
    setOpenReportId((cur) => (cur === id ? null : cur))
  }, [patchTask])

  const newTaskFor = useCallback((projectIndex: number) => {
    setOpenReportId(null)
    setDispatchIndex(projectIndex)
    setView({ screen: 'home' })
    setFocusInput((n) => n + 1)
  }, [])

  const dispatch = useCallback((text: string) => {
    const p = projects[dispatchIndex]
    if (!p) return
    void window.api.startTask(p.id, text).then((id) => setSelectedId(id))
  }, [projects, dispatchIndex])

  // 클리어는 되돌릴 수 없으므로 두 번 눌러야 한다 (3초 안에)
  const requestClear = useCallback((projectId: string, conversationId: string) => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
    if (clearArmed === conversationId) {
      setClearArmed(null)
      void window.api.clear(projectId, conversationId)
      return
    }
    setClearArmed(conversationId)
    clearTimer.current = setTimeout(() => setClearArmed(null), 3000)
  }, [clearArmed])

  const modeOf = (projectId: string, conversationId: string): AgentMode => {
    const fromEvents = convs[conversationId]?.mode
    const conv = projects.find((p) => p.id === projectId)?.conversations.find((c) => c.id === conversationId)
    return fromEvents ?? conv?.mode ?? 'default'
  }

  // 전역 키 처리 (기획서 7장, 40% 배열 기준은 keys.ts). 최신 상태를 쓰기 위해 ref로 핸들러를 갱신한다.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent) => {
    const code = physicalCode(e)
    const tag = (e.target as HTMLElement | null)?.tagName
    const typing = tag === 'TEXTAREA' || tag === 'INPUT'
    const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey

    // 어디서든: Alt+홈 줄(또는 Ctrl+숫자) 프로젝트 이동, Ctrl+H 홈, Ctrl+K 작업 지시
    const target = projectIndexFromKey(e, code)
    if (target !== null) {
      e.preventDefault()
      openProject(target)
      return
    }
    if (plainCtrl && code === 'KeyH') {
      e.preventDefault()
      setOpenReportId(null)
      setView({ screen: 'home' })
      return
    }
    if (plainCtrl && code === 'KeyK') {
      e.preventDefault()
      setOpenReportId(null)
      setView({ screen: 'home' })
      setFocusInput((n) => n + 1)
      return
    }

    if (view.screen === 'home') {
      if (plainCtrl && code === 'KeyN') {
        e.preventDefault()
        void window.api.addProject()
        return
      }
      if (typing) {
        if (isEscape(e, code)) {
          e.preventDefault()
          ;(e.target as HTMLElement).blur()
        }
        return
      }
      if (!bare) return

      // 보고서 상세가 열려 있을 때
      const open = reports.find((r) => r.conversationId === openReportId)
      if (open) {
        if (isEscape(e, code)) sheetCloseRef.current?.()
        else if (code === 'KeyO' || e.key === 'Enter') openChat(open.project.id, open.conversationId)
        else if (code === 'KeyE') archive(open.conversationId)
        else if (code === 'KeyI') newTaskFor(open.projectIndex)
        else return
        e.preventDefault()
        return
      }
      if (isEscape(e, code)) {
        setSelectedId(null)
        return
      }

      if (code === 'KeyI') {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (/^Digit[1-9]$/.test(code)) {
        e.preventDefault()
        openProject(Number(code.slice(5)) - 1)
        return
      }
      const idx = flat.findIndex((r) => r.conversationId === selectedId)
      const sel: TaskRef | undefined = flat[idx]
      // J K: 위아래, H L: 진행 중 / 보고함 첫 항목 (방향키도 같은 동작)
      const step = code === 'KeyJ' || e.key === 'ArrowDown' ? 1 : code === 'KeyK' || e.key === 'ArrowUp' ? -1 : 0
      if (step !== 0 && flat.length > 0) {
        e.preventDefault()
        const next = idx < 0 ? 0 : Math.min(Math.max(idx + step, 0), flat.length - 1)
        setSelectedId(flat[next].conversationId)
        return
      }
      if (code === 'KeyH' || e.key === 'ArrowLeft') {
        e.preventDefault()
        if (running[0]) setSelectedId(running[0].conversationId)
        return
      }
      if (code === 'KeyL' || e.key === 'ArrowRight') {
        e.preventDefault()
        if (reports[0]) setSelectedId(reports[0].conversationId)
        return
      }
      if ((code === 'KeyO' || e.key === 'Enter') && sel) {
        e.preventDefault()
        if (running.includes(sel)) openChat(sel.project.id, sel.conversationId)
        else openReport(sel.conversationId)
        return
      }
      if (code === 'KeyE' && sel && reports.includes(sel)) {
        e.preventDefault()
        const after = flat[idx + 1] ?? flat[idx - 1]
        archive(sel.conversationId)
        setSelectedId(after && after !== sel ? after.conversationId : null)
        return
      }
      if (code === 'KeyY' || code === 'KeyA' || code === 'KeyN') {
        const t = sel && sel.state.permissions[0] ? sel : running.find((r) => r.state.permissions[0])
        const req = t?.state.permissions[0]
        if (!t || !req) return
        e.preventDefault()
        const decision: PermissionDecision = code === 'KeyY' ? 'allow' : code === 'KeyA' ? 'always' : 'deny'
        if (decision !== 'deny' && req.defaultToNo) return // 한 키 승인 금지 요청은 클릭으로
        if (decision === 'always' && req.suppressAlwaysAllow) return
        respond(t.project.id, t.conversationId, req.requestId, decision)
      }
      return
    }

    // 대화창
    const { projectId, conversationId } = view
    const project = projects.find((p) => p.id === projectId)
    if (!project) return

    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      const ids = project.conversations.map((c) => c.id)
      const next = (ids.indexOf(conversationId) + (e.shiftKey ? -1 : 1) + ids.length) % ids.length
      setView({ screen: 'chat', projectId, conversationId: ids[next] })
      return
    }
    if (e.ctrlKey && !e.altKey && code === 'KeyL') {
      e.preventDefault()
      if (e.shiftKey) void window.api.compact(projectId, conversationId)
      else requestClear(projectId, conversationId)
      return
    }
    if (e.shiftKey && e.key === 'Tab') {
      e.preventDefault()
      const cur = modeOf(projectId, conversationId)
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length]
      void window.api.setMode(projectId, conversationId, next)
      return
    }
    // 중단: Esc, Ctrl+[ , 또는 선택한 글자가 없을 때의 Ctrl+C (터미널과 같은 감각)
    if (isEscape(e, code) || isInterruptCopy(e, code)) {
      e.preventDefault()
      void window.api.interrupt(projectId, conversationId)
      return
    }
    const pending = convs[conversationId]?.permissions[0]
    if (pending && !typing && bare) {
      const decision: PermissionDecision | null =
        code === 'KeyY' ? 'allow' : code === 'KeyA' ? 'always' : code === 'KeyN' ? 'deny' : null
      if (!decision) return
      e.preventDefault()
      if (decision !== 'deny' && pending.defaultToNo) return
      if (decision === 'always' && pending.suppressAlwaysAllow) return
      respond(projectId, conversationId, pending.requestId, decision)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => handlerRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const chatProject = view.screen === 'chat' ? projects.find((p) => p.id === view.projectId) : undefined

  return (
    <div className="shell">
      <Sidebar
        projects={projects}
        convs={convs}
        activeProjectId={chatProject?.id ?? null}
        activeConversationId={view.screen === 'chat' ? view.conversationId : null}
        unreadTotal={unreadTotal}
        rateLimit={rateLimit}
        onHome={() => setView({ screen: 'home' })}
        onOpenProject={openProject}
        onOpenConversation={openChat}
        onAddProject={() => void window.api.addProject()}
      />
      <div className="content">
        <Ticker running={running} reports={reports} hotkey={hotkey} />
        {view.screen === 'chat' && chatProject ? (
          <Chat
            project={chatProject}
            projects={projects}
            conversationId={view.conversationId}
            convs={convs}
            mode={modeOf(view.projectId, view.conversationId)}
            clearArmed={clearArmed === view.conversationId}
            onClearRequest={() => requestClear(chatProject.id, view.conversationId)}
            onSelectConversation={(conversationId) => setView({ screen: 'chat', projectId: chatProject.id, conversationId })}
            onRespond={respond}
          />
        ) : (
          <Home
            projects={projects}
            running={running}
            reports={reports}
            selectedId={selectedId}
            openReportId={openReportId}
            dispatchIndex={Math.min(dispatchIndex, Math.max(projects.length - 1, 0))}
            hotkey={hotkey}
            inputRef={inputRef}
            dispatchOrigin={dispatchOrigin}
            sheetCloseRef={sheetCloseRef}
            onDispatchIndex={setDispatchIndex}
            onDispatch={dispatch}
            onSelect={setSelectedId}
            onOpenTask={(r) => openChat(r.project.id, r.conversationId)}
            onOpenReport={openReport}
            onCloseReport={() => setOpenReportId(null)}
            onArchive={archive}
            onNewTaskFor={newTaskFor}
            onRespond={respond}
            onAddProject={() => void window.api.addProject()}
          />
        )}
      </div>
    </div>
  )
}
