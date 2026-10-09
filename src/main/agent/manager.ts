import type { AgentEventEnvelope, AgentMode, PermissionDecision, RateLimitInfo } from '@shared/types'
import type { ProjectStore } from '../store'
import { AgentSession } from './session'

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

  async interrupt(projectId: string, conversationId: string): Promise<void> {
    await this.sessions.get(conversationId)?.interrupt()
  }

  async setMode(projectId: string, conversationId: string, mode: AgentMode): Promise<void> {
    this.store.updateConversation(projectId, conversationId, { mode })
    const session = this.sessions.get(conversationId)
    if (session) await session.setMode(mode)
    else this.broadcast({ projectId, conversationId, event: { kind: 'mode', mode } })
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
      emit: (event) => this.broadcast({ projectId, conversationId, event }),
      onSessionId: (sessionId) => this.store.updateConversation(projectId, conversationId, { sessionId }),
      onRateLimit: this.onRateLimit,
    })
    this.sessions.set(conversationId, session)
    return session
  }
}
