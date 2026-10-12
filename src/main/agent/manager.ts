import { forkSession, getSessionMessages, listSessions, resolveSettings, tagSession, type Query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { cwdOf, EFFORT_LEVELS, openConversations, QUICK_ALLOWED_TOOLS, QUICK_DISALLOWED_TOOLS, QUICK_PROJECT_ID, type AccountStatus, type AgentOption, type DeniedCall, type EffortInfo, type EffortLevel, type McpServerInfo, type ModelOption, type AgentEventEnvelope, type PermissionExtra, type RewindResult, type RewindScope, type SessionOption, type SessionStatus, type ShellResult, type TaskOutput, AgentMode, PermissionDecision, RateLimitInfo, SlashCommandInfo } from '@shared/types'
import type { LimitLevel } from '@shared/usage'
import type { ProjectStore } from '../store'
import { AgentSession, baseOptions, modelLabel, toContext, type BasePrefs } from './session'

/** 매니저가 설정에서 읽는 것 */
export interface ManagerPrefs extends BasePrefs {
  /** 동시 실행 수. 0이면 제한 없음 */
  maxConcurrent: number
  away: boolean
  budgetWhenHot: boolean
}

/** 구독 한도 단계별 토큰 예산 (taskBudget). 80%부터 걸고 95%면 더 좁힌다. 경험값이라 조정될 수 있다 */
export const BUDGET_BY_LEVEL: Partial<Record<LimitLevel, number>> = { 80: 150_000, 95: 60_000, 100: 60_000 }

/** 한도가 풀린 직후 바로 보내면 아직 거절될 수 있어 조금 기다린다 */
const HOLD_MARGIN_MS = 5_000
import { commandsFor, remember, withProbe } from './commands'
import { SpareKeeper } from './spare'
import { fullToolResult, readHistory } from './history'
import { readTaskOutput } from './task-output'
import { draftTitle, saveSessionTitle, sessionTitle } from './title'
import { removeWorktreeIfClean } from '../worktree'

/** 대화별 AgentSession을 만들고 보관한다. 동시 실행 제한(OPEN-003)과 대기열도 여기서 */
export class AgentManager {
  private sessions = new Map<string, AgentSession>()
  /** 질문 창의 대화 ID (동시 실행 수에 세지 않는다) */
  private quickIds = new Set<string>()

  /** 자리가 나길 기다리는 메시지 (OPEN-003). 들어온 순서대로 시작한다. id는 화면의 queuedId */
  private waiting: { id: string; projectId: string; conversationId: string; text: string }[] = []

  /** 미리 띄워 둔 CLI 하나. 새 세션의 첫 메시지가 기동을 기다리지 않게 */
  private readonly spare = new SpareKeeper((cb) => baseOptions(cb, this.prefs()))

  /** 홈·빈 대화에 글을 치기 시작했다: 새 세션이 곧 생길 수 있으니 CLI를 미리 띄운다 */
  prewarm(): void {
    this.spare.ensure()
  }

  /** 구독 한도: 지금 가장 높은 단계와, 다 썼을 때 풀리는 시각. 한도를 다 썼으면 대기열을 그때까지 잡아 둔다 */
  private limit: { level: LimitLevel; resetsAt: number | null } = { level: 0, resetsAt: null }
  private holdUntil: number | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly store: ProjectStore,
    private readonly broadcast: (e: AgentEventEnvelope) => void,
    private readonly onRateLimit: (info: RateLimitInfo) => void,
    private readonly prefs: () => ManagerPrefs = () => ({ maxConcurrent: 0, away: false, budgetWhenHot: false, promptSuggestions: false }),
    /** 저장된 대화 정보(제목 등)가 바뀌었을 때 */
    private readonly onProjectsChanged: () => void = () => {},
    /** 한도 보류가 풀렸다 (사용량을 다시 읽을 때) */
    private readonly onHoldEnd: () => void = () => {},
  ) {}

  /**
   * 사용량이 바뀔 때마다 (OPEN-006). 한도를 다 썼고 초기화 시각을 알면 새 작업을 그때까지 보류했다가 자동으로 흘려보낸다.
   * 실행 중인 작업은 건드리지 않는다 (CLI가 재시도한다)
   */
  setLimit(level: LimitLevel, resetsAt: number | null): void {
    this.limit = { level, resetsAt }
    const until = level === 100 && resetsAt && resetsAt > Date.now() ? resetsAt + HOLD_MARGIN_MS : null
    if (until === this.holdUntil) return
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    this.holdUntil = until
    if (until) {
      this.holdTimer = setTimeout(() => {
        this.holdUntil = null
        this.holdTimer = null
        this.onHoldEnd()
        this.drain()
      }, until - Date.now())
      this.announcePositions()
    } else this.drain()
  }

  /** 새 세션에 걸 토큰 예산. 설정이 꺼져 있거나 한도가 낮으면 없음 */
  private budgetFor(): number | null {
    if (!this.prefs().budgetWhenHot) return null
    return BUDGET_BY_LEVEL[this.limit.level] ?? null
  }

  /** AWAY 모드를 바꿨다. 켰으면 이미 기다리던 확인 요청도 거절해 작업이 이어지게 한다 */
  setAway(on: boolean): void {
    if (!on) return
    for (const s of this.sessions.values()) s.applyAway()
  }

  /** 세션 태그 (/tag). 세션 기록에도 남겨 CLI의 /resume 목록과 같게 */
  async setTag(projectId: string, conversationId: string, raw: string | null): Promise<void> {
    const tag = raw?.replace(/\s+/g, ' ').trim().slice(0, 40) || undefined
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv) return
    this.store.updateConversation(projectId, conversationId, { tag })
    if (conv.sessionId) {
      try {
        await tagSession(conv.sessionId, tag ?? null, { dir: cwdOf(project, conv) })
      } catch (err) {
        console.warn('세션 태그를 저장하지 못함', err)
      }
    }
  }

  /** AWAY에서 거절한 호출을 승인하고 이어서 하라고 보낸다 */
  approveDenied(projectId: string, conversationId: string, calls: DeniedCall[]): void {
    if (!calls.length) return
    this.getOrCreate(projectId, conversationId).preapprove(calls)
    const list = calls.map((c) => `- ${c.title ?? c.toolName}`).join('\n')
    this.send(projectId, conversationId, `자리를 비운 사이 거절됐던 다음 호출을 모두 승인했어요. 멈췄던 곳부터 이어서 해 주세요.\n${list}`)
  }

  /** CLI 명령(/goal …)을 세션에 보낸다. 작업으로 치지 않는다 */
  command(projectId: string, conversationId: string, text: string): void {
    this.getOrCreate(projectId, conversationId).command(text)
  }

  /** `!명령` 출력을 세션에 덧붙인다. 작업이 아니라 동시 실행 수·대기열과 무관 */
  shellOutput(projectId: string, conversationId: string, result: ShellResult): void {
    this.getOrCreate(projectId, conversationId).appendShell(result)
  }

  send(projectId: string, conversationId: string, text: string): void {
    const session = this.getOrCreate(projectId, conversationId)
    // 질문 창은 동시 실행 제한을 받지 않는다 (작업이 꽉 차 있어도 바로 답해야 하므로). 제목도 고정
    if (projectId === QUICK_PROJECT_ID) return session.send(text)
    this.draftTitle(projectId, conversationId, text)
    // 이미 실행 중인 대화에 이어 보내는 건 자리를 더 쓰지 않는다
    if (session.isBusy()) return session.send(text)
    const alreadyWaiting = this.waiting.some((w) => w.conversationId === conversationId)
    if (alreadyWaiting || this.atCapacity()) {
      const id = randomUUID()
      this.waiting.push({ id, projectId, conversationId, text })
      session.enqueue(text, id)
      this.announcePositions()
      return
    }
    session.send(text)
  }

  /** 차례를 기다리던 메시지를 빼고 그 글을 돌려준다 (자리 대기열 또는 세션이 들고 있던 것). 이미 보냈으면 null */
  dropQueued(projectId: string, conversationId: string, queuedId: string): string | null {
    const i = this.waiting.findIndex((w) => w.id === queuedId)
    if (i >= 0) {
      const [w] = this.waiting.splice(i, 1)
      const session = this.sessions.get(conversationId)
      // 이 대화가 더 기다리는 게 없으면 상태도 되돌린다
      if (session && !this.waiting.some((x) => x.conversationId === conversationId)) session.cancelQueued()
      this.broadcast({ projectId, conversationId, event: { kind: 'unqueued', queuedId } })
      this.announcePositions()
      return w.text
    }
    return this.sessions.get(conversationId)?.dropHeld(queuedId) ?? null
  }

  /** 새 세션의 첫 메시지(처음, 또는 클리어한 뒤)면 그 메시지로 임시 제목을 붙인다. 직접 붙인 이름은 그대로 */
  private draftTitle(projectId: string, conversationId: string, text: string): void {
    const conv = this.store.getConversation(projectId, conversationId)
    if (!conv || conv.titleSource === 'custom' || conv.sessionId || this.sessions.has(conversationId)) return
    const title = draftTitle(text)
    if (conv.title === title && conv.titleSource === 'draft') return
    this.store.updateConversation(projectId, conversationId, { title, titleSource: 'draft' })
    this.onProjectsChanged()
  }

  /** CLI가 만든 세션 제목으로 바꾼다. 첫 응답 직후에는 아직 없을 수 있어 한 번 더 본다 */
  private async refreshTitle(projectId: string, conversationId: string, retry = true): Promise<void> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv?.sessionId || conv.titleSource === 'custom') return
    try {
      const title = await sessionTitle(conv.sessionId, cwdOf(project, conv))
      const now = this.store.getConversation(projectId, conversationId)
      // 기다리는 사이 사용자가 이름을 붙였거나 클리어했으면 그대로 둔다
      if (!now || now.titleSource === 'custom' || now.sessionId !== conv.sessionId) return
      if (!title) {
        if (retry) setTimeout(() => void this.refreshTitle(projectId, conversationId, false), 5000)
        return
      }
      if (now.title === title) return
      this.store.updateConversation(projectId, conversationId, { title, titleSource: 'auto' })
      this.onProjectsChanged()
    } catch (err) {
      console.warn('세션 제목을 읽지 못함', err)
    }
  }

  /** 직접 이름 붙이기. 세션이 있으면 세션 기록에도 남긴다 (CLI /resume 목록과 같게) */
  async rename(projectId: string, conversationId: string, raw: string): Promise<void> {
    const title = raw.replace(/\s+/g, ' ').trim().slice(0, 80)
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!title || !project || !conv) return
    this.store.updateConversation(projectId, conversationId, { title, titleSource: 'custom' })
    if (conv.sessionId) {
      try {
        await saveSessionTitle(conv.sessionId, cwdOf(project, conv), title)
      } catch (err) {
        console.warn('세션 이름을 저장하지 못함', err)
      }
    }
  }

  private atCapacity(): boolean {
    // 구독 한도를 다 썼으면 풀릴 때까지 아무것도 시작하지 않는다
    if (this.holdUntil && this.holdUntil > Date.now()) return true
    const limit = this.prefs().maxConcurrent
    if (limit <= 0) return false
    let busy = 0
    for (const [id, s] of this.sessions) if (s.isBusy() && !this.quickIds.has(id)) busy++
    return busy >= limit
  }

  /** 자리가 났으면 대기열 앞에서부터 시작한다. 설정을 바꿨을 때도 부른다 */
  drain(): void {
    while (this.waiting.length && !this.atCapacity()) {
      const w = this.waiting.shift()!
      this.sessions.get(w.conversationId)?.send(w.text, false, w.id)
    }
    this.announcePositions()
  }

  private announcePositions(): void {
    const seen = new Set<string>()
    const until = this.holdUntil && this.holdUntil > Date.now() ? this.holdUntil : undefined
    this.waiting.forEach((w, i) => {
      if (seen.has(w.conversationId)) return
      seen.add(w.conversationId)
      this.broadcast({ projectId: w.projectId, conversationId: w.conversationId, event: { kind: 'queue', position: i + 1, until } })
    })
  }

  /** 세션을 끝내고 대기열에서 뺀다. 실행 중이던 자리가 비었을 수 있으니 다음 차례를 시작한다 (끝낸 세션은 status를 내지 않는다) */
  private endSession(conversationId: string): void {
    this.dropWaiting(conversationId)
    this.sessions.get(conversationId)?.dispose()
    this.sessions.delete(conversationId)
    queueMicrotask(() => this.drain())
  }

  private dropWaiting(conversationId: string): boolean {
    const before = this.waiting.length
    this.waiting = this.waiting.filter((w) => w.conversationId !== conversationId)
    return this.waiting.length !== before
  }

  /** 이 앱 실행 중에 한 번이라도 메시지를 보낸 대화인지 */
  hasSession(conversationId: string): boolean {
    return this.sessions.has(conversationId)
  }

  compact(projectId: string, conversationId: string, instructions?: string): void {
    const conv = this.store.getConversation(projectId, conversationId)
    if (!conv) throw new Error(`대화 없음: ${projectId}/${conversationId}`)
    // 앱을 다시 켠 뒤라 세션 객체가 없어도, 저장된 세션 ID로 이어서 컴팩트한다
    this.getOrCreate(projectId, conversationId).compact(instructions)
  }

  private peeking = new Set<string>()
  private models: { at: number; list: ModelOption[] } | null = null

  /** 고를 수 있는 모델 목록 (계정 단위라 10분 캐시) */
  async listModels(projectId: string): Promise<ModelOption[]> {
    if (this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list
    const project = this.store.get(projectId)
    const fetch = (q: Query): Promise<ModelOption[]> =>
      q.supportedModels().then((l) => l.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description, resolvedModel: m.resolvedModel, efforts: m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? undefined) })))
    const live = this.liveQuery()
    const list = live ? await fetch(live) : await withProbe(project?.path ?? process.cwd(), fetch)
    this.models = { at: Date.now(), list }
    return list
  }

  async setModel(projectId: string, conversationId: string, option: ModelOption): Promise<void> {
    const isDefault = option.value === 'default'
    this.store.updateConversation(projectId, conversationId, { modelChoice: isDefault ? undefined : option.value })
    await this.sessions.get(conversationId)?.setModel(isDefault ? undefined : option.value)
    // 화면에는 바로 반영 (실제 모델 ID는 다음 턴 시작 메시지로 다시 맞춰진다)
    const id = option.resolvedModel ?? option.value
    const label = /^claude-/.test(id) ? modelLabel(id) : option.displayName
    this.store.updateConversation(projectId, conversationId, { model: id, modelLabel: label })
    this.broadcast({ projectId, conversationId, event: { kind: 'model', model: id, label } })
  }

  /** 이 대화의 모델이 받는 effort 단계와, 고르지 않았을 때 쓰는 설정값 */
  async getEffort(projectId: string, conversationId: string): Promise<EffortInfo> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    const list = await this.listModels(projectId).catch(() => [] as ModelOption[])
    const choice = conv?.modelChoice ?? 'default'
    const row =
      list.find((m) => m.value === choice) ??
      (conv?.model ? list.find((m) => m.value === conv.model || m.resolvedModel === conv.model) : undefined)
    const levels = row?.efforts ?? EFFORT_LEVELS
    let saved: EffortLevel | null = null
    try {
      const { effective } = await resolveSettings({ cwd: project && conv ? cwdOf(project, conv) : undefined })
      const model = conv?.model?.replace(/\[.*\]$/, '')
      const fromEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL as EffortLevel | undefined
      saved = (model ? effective.modelSettings?.[model]?.effortLevel : undefined) ?? effective.effortLevel ?? (fromEnv && EFFORT_LEVELS.includes(fromEnv) ? fromEnv : null)
    } catch {
      // 설정을 못 읽으면 모델 기본값으로 안내
    }
    return { levels, saved }
  }

  async setEffort(projectId: string, conversationId: string, effort: EffortLevel | null): Promise<void> {
    this.store.updateConversation(projectId, conversationId, { effort: effort ?? undefined })
    try {
      await this.sessions.get(conversationId)?.setEffort(effort)
    } catch (err) {
      this.broadcast({ projectId, conversationId, event: { kind: 'error', message: `effort를 바꾸지 못했어요: ${err instanceof Error ? err.message : String(err)}` } })
    }
  }

  async loadHistory(projectId: string, conversationId: string): Promise<void> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv?.sessionId) return
    try {
      const items = await readHistory(conv.sessionId, cwdOf(project, conv))
      if (items.length) this.broadcast({ projectId, conversationId, event: { kind: 'history', items } })
    } catch (err) {
      console.warn('지난 대화를 읽지 못함', err)
    }
  }

  /**
   * 대화창을 열었을 때 메시지를 보내지 않고 컨텍스트 사용률과 모델을 읽는다.
   * 살아 있는 세션이 있으면 거기서, 없으면 저장된 세션을 이어 연 CLI(또는 새 대화면 빈 CLI)에서 읽고 바로 닫는다
   */
  async peek(projectId: string, conversationId: string): Promise<void> {
    const live = this.sessions.get(conversationId)
    if (live?.query()) return live.refreshContext()
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv || this.peeking.has(conversationId)) return
    this.peeking.add(conversationId)
    try {
      // 고른 모델로 띄워야 그 모델이 보인다 (빠뜨리면 기본 모델로 덮어쓴다)
      const model = conv.modelChoice && conv.modelChoice !== 'default' ? conv.modelChoice : undefined
      const u = await withProbe(cwdOf(project, conv), (q) => q.getContextUsage({ detail: 'summary' }), conv.sessionId, model)
      const emit = (event: AgentEventEnvelope['event']): void => this.broadcast({ projectId, conversationId, event })
      const context = toContext(u)
      this.store.updateConversation(projectId, conversationId, { contextPercent: context.percent, ...(u.model ? { model: u.model, modelLabel: conv.modelLabel ?? modelLabel(u.model) } : {}) })
      emit({ kind: 'context', context })
      if (u.model) emit({ kind: 'model', model: u.model, label: conv.model === u.model && conv.modelLabel ? conv.modelLabel : modelLabel(u.model) })
    } catch (err) {
      console.warn('세션 정보를 미리 읽지 못함', err)
    } finally {
      this.peeking.delete(conversationId)
    }
  }

  /** 살아 있는 아무 세션의 Query (사용량처럼 계정 단위 조회에 쓴다). 없으면 null */
  liveQuery(): Query | null {
    for (const s of this.sessions.values()) {
      const q = s.query()
      if (q) return q
    }
    return null
  }

  /** 슬래시 명령 목록: 이 프로젝트에 살아 있는 세션이 있으면 거기서, 없으면 캐시나 잠깐 띄운 CLI에서 */
  async listCommands(projectId: string): Promise<SlashCommandInfo[]> {
    const project = this.store.get(projectId)
    if (!project) return []
    for (const conv of project.conversations) {
      const list = await this.sessions.get(conv.id)?.commands().catch(() => null)
      if (list) return remember(project.path, list)
    }
    try {
      return await commandsFor(project.path)
    } catch (err) {
      console.warn('슬래시 명령 목록을 가져오지 못함', err)
      return []
    }
  }

  /** 대화를 닫는다: 세션을 끝내고(진행 중이면 중단) 목록에서 뺀다. 디스크의 세션 기록 파일은 남긴다 */
  closeConversation(projectId: string, conversationId: string): string {
    this.endSession(conversationId)
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    const next = this.store.closeConversation(projectId, conversationId)
    // 하위 대화의 작업 공간: 변경이 없을 때만 지운다 (보고서 때문에 남겨 둔 대화는 그대로)
    if (project && conv?.worktree && !this.store.getConversation(projectId, conversationId)) {
      void removeWorktreeIfClean(project.path, conv.worktree.path)
    }
    return next
  }

  /** 세션을 닫고 저장된 세션 ID를 지운다. 다음 메시지는 새 세션으로 시작 (이전 기록 파일은 지우지 않음) */
  clear(projectId: string, conversationId: string): void {
    this.endSession(conversationId)
    this.store.updateConversation(projectId, conversationId, { sessionId: undefined, contextPercent: undefined })
    this.broadcast({ projectId, conversationId, event: { kind: 'cleared' } })
    // 비운 직후에도 컨텍스트가 보이도록 새 세션의 기본 사용량·모델을 바로 읽는다
    void this.peek(projectId, conversationId)
  }

  async interrupt(projectId: string, conversationId: string): Promise<void> {
    // 아직 차례를 기다리던 대화는 대기열에서 빼는 것으로 중단
    if (this.dropWaiting(conversationId)) {
      this.sessions.get(conversationId)?.cancelQueued()
      this.announcePositions()
      return
    }
    await this.sessions.get(conversationId)?.interrupt()
  }

  async stopTask(_projectId: string, conversationId: string, taskId: string): Promise<void> {
    await this.sessions.get(conversationId)?.stopTask(taskId)
  }

  /** 백그라운드 작업의 출력. 작업이 끝났거나 세션이 닫혀도 파일이 남아 있으면 읽는다 */
  async taskOutput(projectId: string, conversationId: string, taskId: string): Promise<TaskOutput | null> {
    const sessionId = this.store.getConversation(projectId, conversationId)?.sessionId
    if (!sessionId) return null
    try {
      return await readTaskOutput(sessionId, taskId)
    } catch (err) {
      console.warn('작업 출력을 읽지 못함', err)
      return null
    }
  }

  async setMode(projectId: string, conversationId: string, mode: AgentMode): Promise<void> {
    const session = this.sessions.get(conversationId)
    // 세션이 있으면 바뀐 결과가 'mode' 이벤트로 와서 저장된다 (아래 emit). 없으면 다음 시작 때 쓰도록 저장만
    if (session) return session.setMode(mode)
    this.store.updateConversation(projectId, conversationId, { mode })
    this.broadcast({ projectId, conversationId, event: { kind: 'mode', mode } })
  }

  respondPermission(conversationId: string, requestId: string, decision: PermissionDecision, extra?: PermissionExtra): void {
    this.sessions.get(conversationId)?.respondPermission(requestId, decision, extra)
  }

  /** 도구 결과 전문. 세션 기록에서 그 tool_use_id의 결과를 찾는다 */
  async toolResult(projectId: string, conversationId: string, toolUseId: string): Promise<string | null> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv?.sessionId) return null
    return fullToolResult(conv.sessionId, cwdOf(project, conv), toolUseId)
  }

  /**
   * 되감기. code: 파일을 그 메시지 시점으로(SDK rewindFiles). chat: 그 메시지 앞까지만 남긴 세션으로 포크해 바꿔 끼운다.
   * 대화를 되감으면 그 메시지의 글을 돌려줘 입력창에 되돌려 놓는다
   */
  async rewind(projectId: string, conversationId: string, uuid: string, scope: RewindScope, dryRun = false): Promise<RewindResult> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv?.sessionId) return { ok: false, message: '되감을 세션이 없어요' }
    const session = this.getOrCreate(projectId, conversationId)
    if (session.isBusy()) return { ok: false, message: '작업이 끝난 뒤에 되감을 수 있어요' }
    const cwd = cwdOf(project, conv)
    let files: string[] | undefined
    if (scope !== 'chat') {
      try {
        const r = await session.rewindFiles(uuid, dryRun)
        if (!r.canRewind) return { ok: false, message: r.error ?? '이 시점으로는 파일을 되돌릴 수 없어요' }
        files = r.filesChanged
      } catch (err) {
        return { ok: false, message: `파일을 되돌리지 못했어요: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    if (dryRun) return { ok: true, message: files?.length ? `${files.length}개 파일이 바뀌어요` : '바뀌는 파일이 없어요', files }
    let text: string | undefined
    if (scope !== 'code') {
      try {
        const messages = await getSessionMessages(conv.sessionId, { dir: cwd, includeSystemMessages: true })
        const main = messages.filter((m) => !m.parent_tool_use_id)
        const at = main.findIndex((m) => m.uuid === uuid)
        if (at < 0) return { ok: false, message: '세션 기록에서 그 메시지를 찾지 못했어요', files }
        const msg = main[at].message as { content?: unknown }
        text = typeof msg?.content === 'string' ? msg.content : undefined
        const before = main[at - 1]
        let next: string | undefined
        if (before) next = (await forkSession(conv.sessionId, { dir: cwd, upToMessageId: before.uuid, title: conv.title })).sessionId
        // 첫 메시지면 남길 대화가 없다: 새 세션으로
        session.switchSession(next)
        this.store.updateConversation(projectId, conversationId, { sessionId: next, contextPercent: undefined })
        const items = next ? await readHistory(next, cwd) : []
        this.broadcast({ projectId, conversationId, event: { kind: 'replace', items } })
        void this.peek(projectId, conversationId)
      } catch (err) {
        return { ok: false, message: `대화를 되감지 못했어요: ${err instanceof Error ? err.message : String(err)}`, files }
      }
    }
    const parts = [scope !== 'chat' ? `파일 ${files?.length ?? 0}개를 되돌렸어요` : '', scope !== 'code' ? '대화를 그 시점으로 되감았어요' : ''].filter(Boolean)
    this.broadcast({ projectId, conversationId, event: { kind: 'task_note', text: `REWIND · ${parts.join(' · ')}` } })
    return { ok: true, message: parts.join(' · '), files, text }
  }

  /** 이 프로젝트 폴더의 지난 세션 (작업 공간 포함, 최근 순). 이미 열린 대화에 붙은 세션은 표시만 */
  async listSessions(projectId: string): Promise<SessionOption[]> {
    const project = this.store.get(projectId)
    if (!project) return []
    const attached = new Map(project.conversations.filter((c) => c.sessionId).map((c) => [c.sessionId!, c.id]))
    const list = await listSessions({ dir: project.path, includeWorktrees: true, limit: 60 })
    return list.map((s) => ({
      sessionId: s.sessionId,
      title: (s.customTitle ?? s.summary ?? s.firstPrompt ?? '').trim() || '(제목 없음)',
      firstPrompt: s.firstPrompt,
      modified: s.lastModified,
      branch: s.gitBranch,
      cwd: (s as { cwd?: string }).cwd,
      conversationId: attached.get(s.sessionId),
    }))
  }

  /** 지난 세션을 이어 연다. 아직 아무것도 보내지 않은 대화면 거기에 붙이고, 아니면 새 탭을 만든다 */
  async attachSession(projectId: string, conversationId: string, sessionId: string, title: string): Promise<string> {
    const project = this.store.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const already = project.conversations.find((c) => c.sessionId === sessionId && !c.closedAt)
    if (already) return already.id
    const conv = this.store.getConversation(projectId, conversationId)
    const fresh = conv && !conv.sessionId && !conv.lastTask && !this.sessions.get(conv.id)?.isBusy()
    const target = fresh ? conv : this.store.addConversation(projectId, {})
    this.sessions.get(target.id)?.switchSession(sessionId)
    this.store.updateConversation(projectId, target.id, { sessionId, title: title.slice(0, 80), titleSource: 'auto', contextPercent: undefined })
    const items = await readHistory(sessionId, cwdOf(project, target)).catch(() => [])
    this.broadcast({ projectId, conversationId: target.id, event: { kind: 'replace', items } })
    void this.peek(projectId, target.id)
    return target.id
  }

  /** 지금 대화를 포크해 새 탭으로. 기록은 복사되고 이후는 따로 간다 */
  async forkConversation(projectId: string, conversationId: string, title?: string): Promise<string> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv) throw new Error(`대화 없음: ${projectId}/${conversationId}`)
    if (!conv.sessionId) throw new Error('아직 대화가 없어 포크할 내용이 없어요')
    const name = title?.trim() || `${conv.title} (fork)`
    const { sessionId } = await forkSession(conv.sessionId, { dir: cwdOf(project, conv), title: name })
    const next = this.store.addConversation(projectId, { sessionId, title: name.slice(0, 80), titleSource: title?.trim() ? 'custom' : 'auto', mode: conv.mode, modelChoice: conv.modelChoice, effort: conv.effort, additionalDirectories: conv.additionalDirectories, tag: conv.tag })
    const items = await readHistory(sessionId, cwdOf(project, next)).catch(() => [])
    this.broadcast({ projectId, conversationId: next.id, event: { kind: 'replace', items } })
    return next.id
  }

  /** 살아 있는 세션의 Query, 없으면 잠깐 띄운 CLI로 fn을 실행한다 */
  private async withQuery<T>(projectId: string, conversationId: string, fn: (q: Query) => Promise<T>): Promise<T> {
    const live = this.sessions.get(conversationId)?.query()
    if (live) return fn(live)
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    return withProbe(project && conv ? cwdOf(project, conv) : (project?.path ?? process.cwd()), fn, conv?.sessionId)
  }

  async mcpStatus(projectId: string, conversationId: string): Promise<McpServerInfo[]> {
    const list = await this.withQuery(projectId, conversationId, (q) => q.mcpServerStatus())
    return list.map((s) => {
      const c = (s.config ?? {}) as { command?: string; args?: string[]; url?: string; type?: string }
      const target = c.url ?? [c.command, ...(c.args ?? [])].filter(Boolean).join(' ')
      return { name: s.name, status: s.status, version: s.serverInfo?.version, error: s.error, target: target || undefined }
    })
  }

  /** 다시 연결·켜고 끄기는 살아 있는 세션에서만 뜻이 있다. 없으면 띄워 둔 세션에서 한다 (다음 메시지가 이어 쓴다) */
  async mcpReconnect(projectId: string, conversationId: string, name: string): Promise<void> {
    await this.getOrCreate(projectId, conversationId).ensureQuery().reconnectMcpServer(name)
  }

  async mcpToggle(projectId: string, conversationId: string, name: string, enabled: boolean): Promise<void> {
    await this.getOrCreate(projectId, conversationId).ensureQuery().toggleMcpServer(name, enabled)
  }

  async listAgents(projectId: string): Promise<AgentOption[]> {
    const project = this.store.get(projectId)
    const first = project ? openConversations(project)[0] : undefined
    const list = await this.withQuery(projectId, first?.id ?? '', (q) => q.supportedAgents())
    return list.map((a) => ({ name: a.name, description: a.description, model: a.model }))
  }

  async setAdditionalDirectories(projectId: string, conversationId: string, dirs: string[]): Promise<void> {
    this.store.updateConversation(projectId, conversationId, { additionalDirectories: dirs.length ? dirs : undefined })
    await this.sessions.get(conversationId)?.setAdditionalDirectories(dirs)
  }

  private account: { at: number; info: AccountStatus } | null = null

  /** 로그인 상태. 계정 단위라 10분 캐시 */
  async accountStatus(refresh = false): Promise<AccountStatus> {
    if (!refresh && this.account && Date.now() - this.account.at < 10 * 60_000) return this.account.info
    const live = this.liveQuery()
    const cwd = this.store.list()[0]?.path ?? process.cwd()
    try {
      const a = live ? await live.accountInfo() : await withProbe(cwd, (q) => q.accountInfo())
      const method = a.apiKeySource ? `API KEY (${a.apiKeySource})` : a.tokenSource ?? (a.email ? 'claude.ai' : undefined)
      const info: AccountStatus = { loggedIn: !!(a.email || a.tokenSource || a.apiKeySource), email: a.email, organization: a.organization, subscription: a.subscriptionType, method }
      this.account = { at: Date.now(), info }
      return info
    } catch (err) {
      return { loggedIn: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async sessionStatus(projectId: string, conversationId: string): Promise<SessionStatus> {
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv) throw new Error(`대화 없음: ${projectId}/${conversationId}`)
    return {
      sessionId: conv.sessionId,
      cwd: cwdOf(project, conv),
      model: conv.modelLabel ?? conv.model,
      mode: conv.mode,
      contextPercent: conv.contextPercent,
      additionalDirectories: conv.additionalDirectories ?? [],
      account: await this.accountStatus(),
    }
  }

  /** 프로젝트를 목록에서 닫기 전: 세션을 모두 끝내고(실행 중이면 중단) 대기열에서 빼고, 변경 없는 작업 공간은 정리한다. 프로젝트 폴더는 건드리지 않는다 */
  disposeProject(projectId: string): void {
    const project = this.store.get(projectId)
    for (const conv of project?.conversations ?? []) {
      this.endSession(conv.id)
      if (project && conv.worktree) void removeWorktreeIfClean(project.path, conv.worktree.path)
    }
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose()
    this.sessions.clear()
    this.spare.dispose()
    if (this.holdTimer) clearTimeout(this.holdTimer)
  }

  private getOrCreate(projectId: string, conversationId: string): AgentSession {
    const existing = this.sessions.get(conversationId)
    if (existing) return existing
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv) throw new Error(`대화 없음: ${projectId}/${conversationId}`)
    const session = new AgentSession({
      cwd: cwdOf(project, conv),
      mode: conv.mode,
      resumeSessionId: conv.sessionId,
      model: conv.modelChoice && conv.modelChoice !== 'default' ? conv.modelChoice : undefined,
      effort: conv.effort,
      additionalDirectories: conv.additionalDirectories,
      takeSpare: () => this.spare.take(),
      tools: projectId === QUICK_PROJECT_ID ? { disallowed: QUICK_DISALLOWED_TOOLS, allowed: QUICK_ALLOWED_TOOLS } : undefined,
      prefs: () => this.prefs(),
      // 질문 창은 사람이 보고 있는 창이라 AWAY를 적용하지 않는다
      away: () => projectId !== QUICK_PROJECT_ID && this.prefs().away,
      budget: () => (projectId === QUICK_PROJECT_ID ? null : this.budgetFor()),
      emit: (event) => {
        // 실행이 끝나 자리가 나면 다음 차례를 시작한다
        if (event.kind === 'status' && event.status !== 'running' && event.status !== 'waiting_approval' && event.status !== 'queued') {
          queueMicrotask(() => this.drain())
        }
        if (event.kind === 'context') this.store.updateConversation(projectId, conversationId, { contextPercent: event.context.percent })
        if (event.kind === 'mode') this.store.updateConversation(projectId, conversationId, { mode: event.mode })
        if (event.kind === 'model') this.store.updateConversation(projectId, conversationId, { model: event.model, modelLabel: event.label })
        if (event.kind === 'result') void this.refreshTitle(projectId, conversationId)
        this.broadcast({ projectId, conversationId, event })
      },
      onSessionId: (sessionId) => this.store.updateConversation(projectId, conversationId, { sessionId }),
      onRateLimit: this.onRateLimit,
    })
    this.sessions.set(conversationId, session)
    if (projectId === QUICK_PROJECT_ID) this.quickIds.add(conversationId)
    return session
  }
}
