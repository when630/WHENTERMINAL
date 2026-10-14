import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_PROJECTS, MODE_CYCLE, needsChoice, QUICK_PROJECT_ID, openConversations, type AgentMode, type StoredTask, type PermissionDecision, type PermissionExtra, type Project, type UpdateState, type UsageInfo } from '@shared/types'
import { applyEvent, collectBackground, collectTasks, IDLE_KEY, mostUrgentConversation, type ConversationMap, type TaskInfo, type TaskRef } from './state'
import { Home, type DispatchOrigin } from './Home'
import { Chat, type PanelControl } from './Chat'
import type { ToolPanel } from './panels'
import { Sidebar } from './Sidebar'
import { Ticker } from './Ticker'
import { isEscape, isInterruptCopy, matches, physicalCode, projectIndexFromKey } from './keys'
import { effectiveKeymap, type ActionId, type Settings } from '@shared/keymap'
import { applyTheme, KeymapContext } from './settings'
import { SettingsScreen } from './SettingsScreen'
import { HelpOverlay } from './HelpOverlay'
import { SearchOverlay } from './SearchOverlay'
import { QuickAsk } from './QuickAsk'
import type { SearchHit } from '@shared/types'
import { usePresence } from './motion'
import { forgetTerminals, newTerminal, showTerminal, stepTerminal } from './terminal'
import { pruneDrafts } from './drafts'
import { useTooltips } from './tooltip'
import { requestRefocus } from './focus'

export type View = { screen: 'home' } | { screen: 'chat'; projectId: string; conversationId: string } | { screen: 'settings'; back: View }

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [convs, setConvs] = useState<ConversationMap>({})
  const [view, setView] = useState<View>({ screen: 'home' })
  const [settings, setSettings] = useState<Settings>(window.api.initialSettings)
  const km = useMemo(() => effectiveKeymap(settings), [settings])
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [hotkey, setHotkey] = useState<string | null>(null)
  const [dispatchIndex, setDispatchIndex] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openReportId, setOpenReportId] = useState<string | null>(null)
  const [focusInput, setFocusInput] = useState(0)
  // 되돌릴 수 없는 동작(클리어·대화 닫기)은 3초 안에 두 번 눌러야 실행된다
  const [armed, setArmed] = useState<{ kind: 'clear' | 'close' | 'project'; id: string } | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dispatchOrigin = useRef<DispatchOrigin | null>(null)
  const sheetCloseRef = useRef<(() => void) | null>(null)
  const chatPanelRef = useRef<PanelControl | null>(null)
  // 단축키 도움말 (하단 안내 줄 대신)
  const [helpOpen, setHelpOpen] = useState(false)
  const help = usePresence(helpOpen ? true : null, 300)
  // 대화 검색 (Ctrl+Shift+F). 결과를 고르면 그 대화를 열고 jump로 그 메시지까지 스크롤한다
  const [searchOpen, setSearchOpen] = useState(false)
  const search = usePresence(searchOpen ? true : null, 300)
  // 프로젝트 없이 묻는 질문 창 (키맵 quickAsk). 닫아도 대화는 남는다
  const [quickOpen, setQuickOpen] = useState(false)
  const quick = usePresence(quickOpen ? true : null, 300)
  const [jump, setJump] = useState<{ conversationId: string; query: string; ordinal: number; nonce: number } | null>(null)
  const openHit = (hit: SearchHit, query: string): void => {
    setSearchOpen(false)
    openChat(hit.projectId, hit.conversationId)
    setJump({ conversationId: hit.conversationId, query, ordinal: hit.ordinal, nonce: Date.now() })
  }

  // 사이드바의 짧은 안내 (프로젝트 상한 등). 3초 뒤 사라진다
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashShown = usePresence(flash, 300)
  const showFlash = useCallback((text: string) => {
    setFlash(text)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 3000)
  }, [])
  // 프로젝트는 홈 열의 키 수(9개)까지만 (OPEN-007). 메인도 같은 상한을 지킨다
  const addProject = useCallback(() => {
    if (projects.length >= MAX_PROJECTS) return showFlash(`프로젝트는 ${MAX_PROJECTS}개까지예요. 하나를 닫고 추가해 주세요.`)
    void window.api.addProject()
  }, [projects.length, showFlash])

  useTooltips()
  // 테마: 처음에는 바로, 이후 바뀔 때는 부드럽게
  const themeApplied = useRef(false)
  useEffect(() => {
    applyTheme(settings.theme, themeApplied.current)
    themeApplied.current = true
  }, [settings.theme])
  useEffect(() => {
    const offs = [
      window.api.onSettingsChanged(setSettings),
      window.api.onOpenSettings(() => openSettingsRef.current()),
      window.api.onNavigate(({ projectId, conversationId, terminal }) => {
        // 질문 창의 알림은 그 창을 연다
        if (projectId === QUICK_PROJECT_ID) return setQuickOpen(true)
        openChatRef.current(projectId, conversationId)
        // 터미널 알림: 대화를 연 뒤 그 터미널을 펼친다
        if (terminal) requestAnimationFrame(() => showTerminal(conversationId, terminal))
      }),
      // 아티팩트 화면(webview)에 포커스가 있을 때 누른 앱 단축키: 앱 창에서 누른 것처럼 키 처리로
      window.api.onGuestKey((k) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, code: k.code, ctrlKey: k.ctrl, altKey: k.alt, shiftKey: k.shift, metaKey: k.meta, bubbles: true, cancelable: true }))
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    window.api.listProjects().then((list) => {
      setProjects(list)
      // 닫아서 없어진 대화의 입력 초안을 치운다 (홈 작업 지시창은 프로젝트별)
      pruneDrafts(new Set(list.flatMap((p) => [`home:${p.id}`, ...p.conversations.map((c) => c.id)])))
      // 저장된 보고서로 보고함을 되살린다 (이번 실행에서 이미 상태가 있는 대화는 그대로)
      setConvs((prev) => {
        const next = { ...prev }
        for (const p of list) {
          for (const c of p.conversations) {
            const t = c.lastTask
            if (!t || next[c.id]) continue
            const { status, ...task } = t
            next[c.id] = { status, items: [], permissions: [], updatedAt: t.finishedAt ?? t.startedAt, task }
          }
        }
        return next
      })
    })
    window.api.getHotkey().then(setHotkey)
    window.api.getUsage().then(setUsage)
    window.api.getUpdate().then(setUpdate)
    const offs = [
      window.api.onProjectsChanged(setProjects),
      window.api.onUsage(setUsage),
      window.api.onUpdate(setUpdate),
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

  // 끝난 작업의 보고서가 바뀔 때마다(완료·요약·읽음·보관) 저장한다. 같은 내용은 다시 보내지 않는다
  const savedTasks = useRef(new Map<string, string>())
  useEffect(() => {
    for (const p of projects) {
      for (const c of p.conversations) {
        const s = convs[c.id]
        if (!s) continue
        const t = s.task
        const busy = s.status === 'running' || s.status === 'waiting_approval'
        // 지금 작업이 아직 돌면, 그 작업에 밀려난 앞 작업의 보고서를 저장한다
        const stored: StoredTask | undefined = t?.finishedAt && !busy ? { ...t, status: s.status } : s.finishedTask
        if (!stored) continue
        const key = JSON.stringify(stored)
        if (savedTasks.current.get(c.id) === key) continue
        // 시작할 때 되살린 값과 같으면 저장할 필요가 없다
        if (!savedTasks.current.has(c.id) && c.lastTask && JSON.stringify(c.lastTask) === key) {
          savedTasks.current.set(c.id, key)
          continue
        }
        savedTasks.current.set(c.id, key)
        void window.api.saveTask(p.id, c.id, stored)
      }
    }
  }, [projects, convs])

  // 보고 있는 대화의 보고서는 읽은 것으로 처리
  const viewing = view.screen === 'chat' ? view.conversationId : null
  useEffect(() => {
    if (viewing && convs[viewing]?.task?.unread) patchTask(viewing, { unread: false })
  }, [viewing, convs, patchTask])

  // 다른 화면에서 Ctrl+K를 누르면 홈으로 온 뒤 작업 지시창에 포커스
  useEffect(() => {
    if (focusInput && view.screen === 'home') inputRef.current?.focus()
  }, [focusInput, view.screen])

  const all = useMemo(() => collectTasks(projects, convs), [projects, convs])
  // 홈 카드 태그 필터 (/tag). 키 이동도 거른 목록 기준이라 App에서 거른다
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const tags = useMemo(() => [...new Set([...all.running, ...all.idle, ...all.reports].map((r) => r.tag).filter((t): t is string => !!t))].sort(), [all])
  const activeTag = tagFilter && tags.includes(tagFilter) ? tagFilter : null
  const { running, idle, reports } = useMemo(() => {
    if (!activeTag) return all
    const only = (l: TaskRef[]): TaskRef[] => l.filter((r) => r.tag === activeTag)
    return { running: only(all.running), idle: only(all.idle), reports: only(all.reports) }
  }, [all, activeTag])
  const background = useMemo(() => collectBackground(projects, convs), [projects, convs])
  // 홈 카드 키 이동 순서: 진행 중 → 쉬는 대화 → 보고함. 쉬는 대화는 같은 대화의 보고서와 구분하려고 키에 IDLE_KEY를 붙인다
  const flat = useMemo(
    () => [...running.map((r) => ({ key: r.conversationId, r })), ...idle.map((r) => ({ key: IDLE_KEY + r.conversationId, r })), ...reports.map((r) => ({ key: r.conversationId, r }))],
    [running, idle, reports],
  )
  const unreadTotal = all.reports.filter((r) => r.task.unread).length

  // 대화를 열면서 바로 펼칠 명령 화면 (홈 보고서의 TOOLS)
  const [openPanel, setOpenPanel] = useState<{ conversationId: string; panel: ToolPanel; nonce: number } | null>(null)
  const openChat = useCallback((projectId: string, conversationId: string, panel?: ToolPanel) => {
    // 닫힌 대화의 보고서에서 '대화 열기'를 누르면 그 대화를 다시 탭으로
    const conv = projects.find((p) => p.id === projectId)?.conversations.find((c) => c.id === conversationId)
    if (conv?.closedAt) void window.api.reopenConversation(projectId, conversationId)
    setOpenReportId(null)
    const i = projects.findIndex((p) => p.id === projectId)
    if (i >= 0) setDispatchIndex(i)
    setView({ screen: 'chat', projectId, conversationId })
    if (panel) setOpenPanel({ conversationId, panel, nonce: Date.now() })
  }, [projects])

  const openChatRef = useRef(openChat)
  openChatRef.current = openChat

  // Dock 배지·트레이: 확인 대기 수 + 새 보고 수
  const waitingTotal = all.running.filter((r) => r.state.permissions.length > 0).length
  useEffect(() => window.api.setBadge(waitingTotal, unreadTotal), [waitingTotal, unreadTotal])

  const openProject = useCallback(
    (index: number) => {
      const p = projects[index]
      if (p) openChat(p.id, mostUrgentConversation(p, convs))
    },
    [projects, convs, openChat],
  )

  const respond = useCallback((projectId: string, conversationId: string, requestId: string, decision: PermissionDecision, extra?: PermissionExtra) => {
    void window.api.respondPermission(projectId, conversationId, requestId, decision, extra)
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

  const dispatch = useCallback((text: string, continueId?: string) => {
    const p = projects[dispatchIndex]
    if (!p) return
    void window.api.startTask(p.id, text, continueId).then((id) => setSelectedId(id))
  }, [projects, dispatchIndex])

  // '이어서' 대상: 지시할 프로젝트에서 가장 최근에 쓴 열린 대화 (세션이 있거나 이번 실행에서 쓴 것)
  const continueTarget = useMemo(() => {
    const p = projects[Math.min(dispatchIndex, projects.length - 1)]
    if (!p) return null
    let best: { id: string; title: string; at: number } | null = null
    for (const c of openConversations(p)) {
      const s = convs[c.id]
      if (!c.sessionId && !s?.items.length) continue
      const at = s?.updatedAt || c.lastTask?.finishedAt || 0
      if (!best || at > best.at) best = { id: c.id, title: c.title, at }
    }
    return best
  }, [projects, dispatchIndex, convs])

  const confirmTwice = useCallback((kind: 'clear' | 'close' | 'project', id: string, run: () => void) => {
    if (armTimer.current) clearTimeout(armTimer.current)
    if (armed?.kind === kind && armed.id === id) {
      setArmed(null)
      run()
      return
    }
    setArmed({ kind, id })
    armTimer.current = setTimeout(() => setArmed(null), 3000)
  }, [armed])

  const requestClear = useCallback((projectId: string, conversationId: string) => {
    confirmTwice('clear', conversationId, () => void window.api.clear(projectId, conversationId))
  }, [confirmTwice])

  /** 대화를 닫고, 보고 있던 대화였다면 옆 대화로 옮겨 간다 */
  const closeConversation = useCallback(async (projectId: string, conversationId: string) => {
    const next = await window.api.closeConversation(projectId, conversationId)
    forgetTerminals(conversationId)
    // 보고서가 보고함에 남을 수 있으므로 상태는 지우지 않는다. 실행 중이었다면 중단으로 바꾼다
    setConvs((prev) => {
      const s = prev[conversationId]
      if (!s || (s.status !== 'running' && s.status !== 'waiting_approval' && s.status !== 'queued')) return prev
      return { ...prev, [conversationId]: { ...s, status: 'stopped', permissions: [], task: s.task ? { ...s.task, finishedAt: s.task.finishedAt ?? Date.now() } : s.task } }
    })
    setView((v) => (v.screen === 'chat' && v.conversationId === conversationId ? { screen: 'chat', projectId, conversationId: next } : v))
  }, [])

  const requestClose = useCallback((projectId: string, conversationId: string) => {
    confirmTwice('close', conversationId, () => void closeConversation(projectId, conversationId))
  }, [confirmTwice, closeConversation])

  /** 프로젝트를 목록에서 닫는다 (폴더·파일은 그대로). 그 프로젝트를 보고 있었다면 홈으로 */
  const removeProject = useCallback(async (projectId: string) => {
    const ids = new Set(projects.find((p) => p.id === projectId)?.conversations.map((c) => c.id) ?? [])
    await window.api.removeProject(projectId)
    ids.forEach(forgetTerminals)
    setConvs((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.has(id))))
    setOpenReportId(null)
    setView((v) => (v.screen === 'chat' && v.projectId === projectId ? { screen: 'home' } : v))
  }, [projects])

  /** 프로젝트 순서 바꾸기: 화면은 바로 바꾸고 메인에 저장한다 (메인이 보내는 목록으로 다시 맞춰진다) */
  const moveProject = useCallback((projectId: string, to: number) => {
    setProjects((list) => {
      const from = list.findIndex((p) => p.id === projectId)
      const at = Math.max(0, Math.min(list.length - 1, to))
      if (from < 0 || at === from) return list
      const next = [...list]
      const [p] = next.splice(from, 1)
      next.splice(at, 0, p)
      return next
    })
    void window.api.moveProject(projectId, to)
  }, [])

  const requestRemoveProject = useCallback((projectId: string) => {
    confirmTwice('project', projectId, () => void removeProject(projectId))
  }, [confirmTwice, removeProject])

  const goHome = (): void => {
    setOpenReportId(null)
    setView({ screen: 'home' })
  }
  // 설정은 어느 화면에서든 열고, 닫으면 원래 화면으로 돌아간다
  const openSettings = (): void => setView((v) => (v.screen === 'settings' ? v : { screen: 'settings', back: v }))
  const closeSettings = (): void => setView((v) => (v.screen === 'settings' ? v.back : v))
  const openSettingsRef = useRef(openSettings)
  openSettingsRef.current = openSettings

  /** 자리 비움: 켜면 확인 요청을 묻지 않고 거절해 작업이 멈추지 않는다 (메인이 기다리던 요청도 바로 정리) */
  const toggleAway = (): void => {
    void window.api.setSettings({ ...settings, away: !settings.away }).then((r) => setSettings(r.settings))
    showFlash(settings.away ? 'AWAY OFF · 다시 확인 요청을 물어요' : 'AWAY ON · 확인 요청은 묻지 않고 거절해요')
  }

  const decisionOf = (e: KeyboardEvent): PermissionDecision | null =>
    matches(e, km.allow) ? 'allow' : matches(e, km.always) ? 'always' : matches(e, km.deny) ? 'deny' : null

  const modeOf = (projectId: string, conversationId: string): AgentMode => {
    const fromEvents = convs[conversationId]?.mode
    const conv = projects.find((p) => p.id === projectId)?.conversations.find((c) => c.id === conversationId)
    return fromEvents ?? conv?.mode ?? 'auto'
  }

  // 전역 키 처리 (기획서 7장, 40% 배열 기준은 keys.ts). 최신 상태를 쓰기 위해 ref로 핸들러를 갱신한다.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent) => {
    // 입력창의 명령 후보 메뉴나 설정의 키 입력칸, 펼친 목록·덮개(그 안의 찾기 칸 등 포함)는 그쪽이 키를 처리한다.
    // 단 data-pass-esc(질문 상자)의 Esc는 실행 중단으로
    const own = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-menu-open="true"], [data-keys-own="true"]')
    if (own && !(e.key === 'Escape' && own.dataset.passEsc === 'true')) return
    // 터미널에 포커스가 있으면 키는 셸 몫이다 (Esc·Ctrl+C·Ctrl+L·Ctrl+K …). 앱을 오가는 키 몇 개만 앱이 받는다
    if ((e.target as HTMLElement | null)?.closest?.('[data-terminal]')) {
      const app = (['terminal', 'terminalNew', 'terminalNext', 'terminalPrev', 'terminalClose', 'goHome', 'help', 'search', 'nextConversation', 'prevConversation', 'newConversation', 'openSettings'] as ActionId[]).some((id) => matches(e, km[id]))
      if (!app && projectIndexFromKey(e, physicalCode(e)) === null) return
      // 셸에는 가지 않게
      e.stopPropagation()
    }
    const code = physicalCode(e)
    const tag = (e.target as HTMLElement | null)?.tagName
    const typing = tag === 'TEXTAREA' || tag === 'INPUT'
    const is = (id: ActionId): boolean => matches(e, km[id])
    const take = (fn: () => void): void => {
      e.preventDefault()
      fn()
    }

    // 도움말: 어디서든 열고 닫는다. 열려 있는 동안은 Esc로 닫는 것 말고는 키를 받지 않는다
    // 질문 창: 어디서든 열고 닫는다. 열려 있는 동안 키는 그 창이 처리한다 (Esc·Y/A/N·클리어)
    if (is('quickAsk')) {
      return take(() => {
        setHelpOpen(false)
        setSearchOpen(false)
        setQuickOpen((v) => !v)
        // 질문 창에 leaving이 붙은 뒤에 (focus.ts의 data-focus-owner)
        if (quickOpen) requestAnimationFrame(requestRefocus)
      })
    }
    if (quickOpen) return
    // 자리 비움(AWAY) 켜고 끄기: 어디서든
    if (is('away')) return take(toggleAway)
    // 지금 연 프로젝트를 사이드바 목록에서 한 칸 위·아래로
    if (is('projectUp') || is('projectDown')) {
      const step = is('projectUp') ? -1 : 1
      return take(() => {
        if (view.screen !== 'chat') return
        const i = projects.findIndex((p) => p.id === view.projectId)
        if (i >= 0) moveProject(view.projectId, i + step)
      })
    }
    if (is('help')) {
      return take(() => {
        setSearchOpen(false)
        setHelpOpen((v) => !v)
        if (helpOpen) requestRefocus()
      })
    }
    if (is('search')) {
      return take(() => {
        setHelpOpen(false)
        setSearchOpen((v) => !v)
        if (searchOpen) requestRefocus()
      })
    }
    if (helpOpen || searchOpen) {
      if (isEscape(e)) {
        take(() => {
          setHelpOpen(false)
          setSearchOpen(false)
          requestRefocus()
        })
      }
      return
    }

    // 어디서든: Alt+홈 줄(또는 Ctrl+숫자) 프로젝트 이동 (고정), 홈·작업 지시·설정 (키맵)
    const target = projectIndexFromKey(e, code)
    if (target !== null) return take(() => openProject(target))
    if (is('goHome')) return take(() => goHome())
    if (is('dispatch')) {
      return take(() => {
        goHome()
        setFocusInput((n) => n + 1)
      })
    }
    if (is('openSettings')) return take(() => openSettings())

    if (view.screen === 'settings') {
      if (e.key === 'Escape' && !typing) take(() => closeSettings())
      return
    }

    if (view.screen === 'home') {
      if (is('addProject')) return take(addProject)
      if (typing) {
        if (isEscape(e)) take(() => (e.target as HTMLElement).blur())
        return
      }

      // 보고서 상세가 열려 있을 때
      const open = reports.find((r) => r.conversationId === openReportId)
      if (open) {
        if (isEscape(e)) take(() => sheetCloseRef.current?.())
        else if (is('open') || e.key === 'Enter') take(() => openChat(open.project.id, open.conversationId))
        else if (is('archive')) take(() => archive(open.conversationId))
        else if (is('newTask')) take(() => newTaskFor(open.projectIndex))
        return
      }
      if (isEscape(e)) return setSelectedId(null)
      if (is('focusAsk')) return take(() => inputRef.current?.focus())
      if (!e.ctrlKey && !e.altKey && !e.metaKey && /^Digit[1-9]$/.test(code)) return take(() => openProject(Number(code.slice(5)) - 1))

      const idx = flat.findIndex((x) => x.key === selectedId)
      const sel: TaskRef | undefined = flat[idx]?.r
      // 위아래, 진행 중 / 보고함 첫 항목 (방향키는 보조로 고정)
      const step = is('down') || e.key === 'ArrowDown' ? 1 : is('up') || e.key === 'ArrowUp' ? -1 : 0
      if (step !== 0 && flat.length > 0) {
        return take(() => {
          const next = idx < 0 ? 0 : Math.min(Math.max(idx + step, 0), flat.length - 1)
          setSelectedId(flat[next].key)
        })
      }
      if (is('toRunning') || e.key === 'ArrowLeft') return take(() => running[0] && setSelectedId(running[0].conversationId))
      if (is('toReports') || e.key === 'ArrowRight') return take(() => reports[0] && setSelectedId(reports[0].conversationId))
      if ((is('open') || e.key === 'Enter') && sel) {
        return take(() => (reports.includes(sel) ? openReport(sel.conversationId) : openChat(sel.project.id, sel.conversationId)))
      }
      if (is('archive') && sel && reports.includes(sel)) {
        return take(() => {
          const after = flat[idx + 1] ?? flat[idx - 1]
          archive(sel.conversationId)
          setSelectedId(after && after.r !== sel ? after.key : null)
        })
      }
      const decision = decisionOf(e)
      if (decision) {
        const t = sel && sel.state.permissions[0] ? sel : running.find((r) => r.state.permissions[0])
        const req = t?.state.permissions[0]
        if (!t || !req || needsChoice(req.toolName)) return
        e.preventDefault()
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

    if (is('nextConversation') || is('prevConversation')) {
      return take(() => {
        const ids = openConversations(project).map((c) => c.id)
        const next = (ids.indexOf(conversationId) + (is('prevConversation') ? -1 : 1) + ids.length) % ids.length
        setView({ screen: 'chat', projectId, conversationId: ids[next] })
      })
    }
    if (is('closeConversation')) return take(() => requestClose(projectId, conversationId))
    if (is('closeProject')) return take(() => requestRemoveProject(projectId))
    if (is('compact')) return take(() => void window.api.compact(projectId, conversationId))
    // 오른쪽 패널의 하위 에이전트·백그라운드 작업 세부 내용
    if (is('panelNext') || is('panelPrev')) return take(() => chatPanelRef.current?.step(is('panelPrev') ? -1 : 1))
    if (is('panelBack')) return take(() => chatPanelRef.current?.back())
    if (is('stopTask')) return take(() => chatPanelRef.current?.stop())
    if (is('renameConversation')) return take(() => chatPanelRef.current?.rename())
    if (is('terminal')) return take(() => chatPanelRef.current?.terminal())
    if (is('terminalNew')) return take(() => newTerminal(projectId, conversationId))
    if (is('terminalNext') || is('terminalPrev')) return take(() => stepTerminal(projectId, conversationId, is('terminalPrev') ? -1 : 1))
    if (is('terminalClose')) return take(() => chatPanelRef.current?.closeTerminal())
    if (is('cycleEffort')) return take(() => chatPanelRef.current?.cycleEffort())
    if (is('rewind')) return take(() => chatPanelRef.current?.rewind())
    if (is('files')) return take(() => chatPanelRef.current?.files())
    // 새 탭: 탭 줄의 +와 같다 (설정에 따라 작업 공간을 만든다)
    if (is('newConversation')) {
      return take(() => void window.api.addConversation(projectId).then((c) => setView({ screen: 'chat', projectId, conversationId: c.id })))
    }
    if (is('clear')) return take(() => requestClear(projectId, conversationId))
    if (is('cycleMode')) {
      return take(() => {
        const cur = modeOf(projectId, conversationId)
        void window.api.setMode(projectId, conversationId, MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length])
      })
    }
    // 중단: Esc(고정), 선택한 글자가 없을 때의 Ctrl+C (터미널과 같은 감각)
    if (e.key === 'Escape' || isInterruptCopy(e, code)) return take(() => void window.api.interrupt(projectId, conversationId))
    const pending = convs[conversationId]?.permissions[0]
    const decision = decisionOf(e)
    // 질문·플랜 승인·MCP 입력·거절 대화 상자는 한 키로 답할 수 없다 (답을 골라야 한다)
    if (pending && !typing && decision && !needsChoice(pending.toolName)) {
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
    <KeymapContext.Provider value={km}>
    <div className="shell">
      <Sidebar
        projects={projects}
        convs={convs}
        activeProjectId={chatProject?.id ?? null}
        activeConversationId={view.screen === 'chat' ? view.conversationId : null}
        unreadTotal={unreadTotal}
        usage={usage}
        update={update}
        onRefreshUsage={() => window.api.getUsage(true).then(setUsage)}
        onHome={goHome}
        onSettings={openSettings}
        onHelp={() => setHelpOpen((v) => !v)}
        helpOpen={helpOpen}
        settingsOpen={view.screen === 'settings'}
        onOpenProject={openProject}
        onOpenConversation={openChat}
        onAddProject={addProject}
        flash={flashShown.item ? { text: flashShown.item, leaving: flashShown.leaving } : null}
        armedProjectId={armed?.kind === 'project' ? armed.id : null}
        onRemoveProjectRequest={requestRemoveProject}
        onMoveProject={moveProject}
        away={settings.away}
        onToggleAway={toggleAway}
      />
      <div className="content">
        <Ticker running={all.running} reports={all.reports} background={background} />
        <div className="stage" key={view.screen === 'chat' ? `chat:${view.projectId}` : view.screen}>
          {view.screen === 'settings' ? (
            <SettingsScreen settings={settings} activeHotkey={hotkey} update={update} onClose={closeSettings} onSaved={(next, hk) => { setSettings(next); if (hk !== undefined) setHotkey(hk) }} />
          ) : view.screen === 'chat' && chatProject ? (
            <Chat
              project={chatProject}
              projects={projects}
              conversationId={view.conversationId}
              convs={convs}
              mode={modeOf(view.projectId, view.conversationId)}
              usage={usage}
              clearArmed={armed?.kind === 'clear' && armed.id === view.conversationId}
              closeArmedId={armed?.kind === 'close' ? armed.id : null}
              projectArmed={armed?.kind === 'project' && armed.id === chatProject.id}
              onClearRequest={() => requestClear(chatProject.id, view.conversationId)}
              onCloseRequest={(id) => requestClose(chatProject.id, id)}
              onClose={(id) => void closeConversation(chatProject.id, id)}
              onSelectConversation={(conversationId) => setView({ screen: 'chat', projectId: chatProject.id, conversationId })}
              onRespond={respond}
              panelRef={chatPanelRef}
              jump={jump?.conversationId === view.conversationId ? jump : null}
              openPanel={openPanel?.conversationId === view.conversationId ? openPanel : null}
              away={settings.away}
              suggestions={settings.promptSuggestions}
            />
          ) : (
            <Home
              projects={projects}
              running={running}
              idle={idle}
              reports={reports}
              selectedId={selectedId}
              openReportId={openReportId}
              dispatchIndex={Math.min(dispatchIndex, Math.max(projects.length - 1, 0))}
              inputRef={inputRef}
              dispatchOrigin={dispatchOrigin}
              sheetCloseRef={sheetCloseRef}
              onDispatchIndex={setDispatchIndex}
              onDispatch={dispatch}
            continueTarget={continueTarget}
              onSelect={setSelectedId}
              onOpenTask={(r) => openChat(r.project.id, r.conversationId)}
              onOpenTools={(r) => openChat(r.project.id, r.conversationId, { kind: 'tools', since: r.task.startedAt })}
              onOpenReport={openReport}
              onCloseReport={() => setOpenReportId(null)}
              onArchive={archive}
              onNewTaskFor={newTaskFor}
              onRespond={respond}
              onAddProject={addProject}
              tags={tags}
              tag={activeTag}
              onTag={(t) => {
                setTagFilter(t)
                setSelectedId(null)
              }}
              onApproveDenied={(r) => {
                const calls = r.task.denied ?? []
                if (!calls.length) return
                // 승인한 호출은 보고서에서 지우고 이어서 하라고 보낸다
                patchTask(r.conversationId, { denied: undefined, unread: false })
                setOpenReportId(null)
                void window.api.approveDenied(r.project.id, r.conversationId, calls)
              }}
            />
          )}
        </div>
      </div>
      {quick.item && (
        <QuickAsk
          convs={convs}
          usage={usage}
          leaving={quick.leaving}
          onRespond={respond}
          onClose={() => {
            setQuickOpen(false)
            requestAnimationFrame(requestRefocus)
          }}
        />
      )}
      {search.item && <SearchOverlay leaving={search.leaving} onOpen={openHit} onClose={() => { setSearchOpen(false); requestRefocus() }} />}
      {help.item && <HelpOverlay context={view.screen} hotkey={hotkey} leaving={help.leaving} onClose={() => { setHelpOpen(false); requestRefocus() }} />}
    </div>
    </KeymapContext.Provider>
  )
}
