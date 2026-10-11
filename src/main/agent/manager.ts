import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { cwdOf, type ModelOption, type AgentEventEnvelope, type TaskOutput, AgentMode, PermissionDecision, RateLimitInfo, SlashCommandInfo } from '@shared/types'
import type { ProjectStore } from '../store'
import { AgentSession } from './session'
import { commandsFor, remember, withProbe } from './commands'
import { modelLabel, toContext } from './session'
import { readHistory } from './history'
import { readTaskOutput } from './task-output'
import { removeWorktreeIfClean } from '../worktree'

/** 대화별 AgentSession을 만들고 보관한다. 동시 실행 제한(OPEN-003)은 여기에 붙일 예정. */
export class AgentManager {
  private sessions = new Map<string, AgentSession>()

  /** 자리가 나길 기다리는 메시지 (OPEN-003). 들어온 순서대로 시작한다 */
  private waiting: { projectId: string; conversationId: string; text: string }[] = []

  constructor(
    private readonly store: ProjectStore,
    private readonly broadcast: (e: AgentEventEnvelope) => void,
    private readonly onRateLimit: (info: RateLimitInfo) => void,
    /** 동시 실행 수. 0이면 제한 없음 */
    private readonly maxConcurrent: () => number = () => 0,
  ) {}

  send(projectId: string, conversationId: string, text: string): void {
    const session = this.getOrCreate(projectId, conversationId)
    // 이미 실행 중인 대화에 이어 보내는 건 자리를 더 쓰지 않는다
    if (session.isBusy()) return session.send(text)
    const alreadyWaiting = this.waiting.some((w) => w.conversationId === conversationId)
    if (alreadyWaiting || this.atCapacity()) {
      this.waiting.push({ projectId, conversationId, text })
      session.enqueue(text)
      this.announcePositions()
      return
    }
    session.send(text)
  }

  private atCapacity(): boolean {
    const limit = this.maxConcurrent()
    if (limit <= 0) return false
    let busy = 0
    for (const s of this.sessions.values()) if (s.isBusy()) busy++
    return busy >= limit
  }

  /** 자리가 났으면 대기열 앞에서부터 시작한다. 설정을 바꿨을 때도 부른다 */
  drain(): void {
    while (this.waiting.length && !this.atCapacity()) {
      const w = this.waiting.shift()!
      this.sessions.get(w.conversationId)?.send(w.text, false)
    }
    this.announcePositions()
  }

  private announcePositions(): void {
    const seen = new Set<string>()
    this.waiting.forEach((w, i) => {
      if (seen.has(w.conversationId)) return
      seen.add(w.conversationId)
      this.broadcast({ projectId: w.projectId, conversationId: w.conversationId, event: { kind: 'queue', position: i + 1 } })
    })
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
      q.supportedModels().then((l) => l.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description, resolvedModel: m.resolvedModel })))
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
      const u = await withProbe(cwdOf(project, conv), (q) => q.getContextUsage({ detail: 'summary' }), conv.sessionId)
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
    this.dropWaiting(conversationId)
    this.sessions.get(conversationId)?.dispose()
    this.sessions.delete(conversationId)
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
    this.dropWaiting(conversationId)
    this.sessions.get(conversationId)?.dispose()
    this.sessions.delete(conversationId)
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

  respondPermission(conversationId: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(conversationId)?.respondPermission(requestId, decision)
  }

  /** 프로젝트를 목록에서 닫기 전: 세션을 모두 끝내고(실행 중이면 중단) 대기열에서 빼고, 변경 없는 작업 공간은 정리한다. 프로젝트 폴더는 건드리지 않는다 */
  disposeProject(projectId: string): void {
    const project = this.store.get(projectId)
    for (const conv of project?.conversations ?? []) {
      this.dropWaiting(conv.id)
      this.sessions.get(conv.id)?.dispose()
      this.sessions.delete(conv.id)
      if (project && conv.worktree) void removeWorktreeIfClean(project.path, conv.worktree.path)
    }
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose()
    this.sessions.clear()
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
      emit: (event) => {
        // 실행이 끝나 자리가 나면 다음 차례를 시작한다
        if (event.kind === 'status' && event.status !== 'running' && event.status !== 'waiting_approval' && event.status !== 'queued') {
          queueMicrotask(() => this.drain())
        }
        if (event.kind === 'context') this.store.updateConversation(projectId, conversationId, { contextPercent: event.context.percent })
        if (event.kind === 'mode') this.store.updateConversation(projectId, conversationId, { mode: event.mode })
        if (event.kind === 'model') this.store.updateConversation(projectId, conversationId, { model: event.model, modelLabel: event.label })
        this.broadcast({ projectId, conversationId, event })
      },
      onSessionId: (sessionId) => this.store.updateConversation(projectId, conversationId, { sessionId }),
      onRateLimit: this.onRateLimit,
    })
    this.sessions.set(conversationId, session)
    return session
  }
}
