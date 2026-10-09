import type { AgentEventEnvelope, AgentMode, PermissionDecision, RateLimitInfo, SlashCommandInfo } from '@shared/types'
import type { ProjectStore } from '../store'
import { AgentSession } from './session'
import { commandsFor, remember } from './commands'

/** 대화별 AgentSession을 만들고 보관한다. 동시 실행 제한(OPEN-003)은 여기에 붙일 예정. */
export class AgentManager {
  private sessions = new Map<string, AgentSession>()

  constructor(
    private readonly store: ProjectStore,
    private readonly broadcast: (e: AgentEventEnvelope) => void,
    private readonly onRateLimit: (info: RateLimitInfo) => void,
  ) {}

  send(projectId: string, conversationId: string, text: string): void {
    this.getOrCreate(projectId, conversationId).send(text)
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
    this.sessions.get(conversationId)?.dispose()
    this.sessions.delete(conversationId)
    return this.store.removeConversation(projectId, conversationId)
  }

  /** 세션을 닫고 저장된 세션 ID를 지운다. 다음 메시지는 새 세션으로 시작 (이전 기록 파일은 지우지 않음) */
  clear(projectId: string, conversationId: string): void {
    this.sessions.get(conversationId)?.dispose()
    this.sessions.delete(conversationId)
    this.store.updateConversation(projectId, conversationId, { sessionId: undefined, contextPercent: undefined })
    this.broadcast({ projectId, conversationId, event: { kind: 'cleared' } })
  }

  async interrupt(projectId: string, conversationId: string): Promise<void> {
    await this.sessions.get(conversationId)?.interrupt()
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

  disposeProject(projectId: string): void {
    const project = this.store.get(projectId)
    for (const conv of project?.conversations ?? []) {
      this.sessions.get(conv.id)?.dispose()
      this.sessions.delete(conv.id)
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
      cwd: project.path,
      mode: conv.mode,
      resumeSessionId: conv.sessionId,
      emit: (event) => {
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
