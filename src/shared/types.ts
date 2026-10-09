// 메인 ↔ 렌더러가 공유하는 타입과 IPC 채널. 기획서 v0.1 5~6장 기준.

/** 대화 상태 (기획서 6장). 카드 상태는 하위 대화 중 STATUS_PRIORITY가 가장 높은 것. */
export type AgentStatus = 'idle' | 'queued' | 'running' | 'waiting_approval' | 'done' | 'error' | 'stopped'

/** 카드 상태 우선순위: 승인 대기 > 오류 > 실행 중 > 대기 > 중단 > 완료 > 유휴 */
export const STATUS_PRIORITY: Record<AgentStatus, number> = {
  waiting_approval: 6,
  error: 5,
  running: 4,
  queued: 3,
  stopped: 2,
  done: 1,
  idle: 0,
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '유휴',
  queued: '대기',
  running: '실행 중',
  waiting_approval: '승인 대기',
  done: '완료',
  error: '오류',
  stopped: '중단',
}

/** Shift+Tab 순환 순서: 기본 → 편집 자동 허용 → 플랜 */
export type AgentMode = 'default' | 'acceptEdits' | 'plan'
export const MODE_CYCLE: AgentMode[] = ['default', 'acceptEdits', 'plan']
export const MODE_LABEL: Record<AgentMode, string> = {
  default: '기본',
  acceptEdits: '편집 자동 허용',
  plan: '플랜',
}

export interface Conversation {
  id: string
  title: string
  /** SDK 세션 ID. 앱 재시작 후 resume에 사용 */
  sessionId?: string
  mode: AgentMode
}

export interface Project {
  id: string
  name: string
  path: string
  conversations: Conversation[]
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
  /** true면 Y 한 키로 승인 불가 (SDK가 요구). 클릭 또는 확인 단계 필요 */
  defaultToNo?: boolean
  /** true면 '항상 허용'(A) 제공 불가 */
  suppressAlwaysAllow?: boolean
}

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string
  utilization?: number
  resetsAt?: number
}

/** 메인 → 렌더러 이벤트 (대화 단위) */
export type AgentEvent =
  | { kind: 'status'; status: AgentStatus }
  | { kind: 'user'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'permission_request'; request: PermissionRequest }
  | { kind: 'permission_resolved'; requestId: string }
  | { kind: 'mode'; mode: AgentMode }
  | { kind: 'result'; subtype: string; durationMs: number; costUsd?: number }
  | { kind: 'error'; message: string }

export interface AgentEventEnvelope {
  projectId: string
  conversationId: string
  event: AgentEvent
}

export const IPC = {
  getHotkey: 'app:get-hotkey',
  listProjects: 'projects:list',
  addProject: 'projects:add',
  removeProject: 'projects:remove',
  addConversation: 'conversations:add',
  startTask: 'tasks:start',
  send: 'agent:send',
  interrupt: 'agent:interrupt',
  setMode: 'agent:set-mode',
  respondPermission: 'agent:respond-permission',
  // 메인 → 렌더러
  event: 'agent:event',
  projectsChanged: 'projects:changed',
  rateLimit: 'usage:rate-limit',
} as const

/** preload가 window.api로 노출하는 API */
export interface WhenTerminalApi {
  /** 실제로 등록된 전역 호출 단축키 (예: 'Ctrl+Space'). 모두 실패하면 null */
  getHotkey(): Promise<string | null>
  listProjects(): Promise<Project[]>
  /** 폴더 선택 대화상자를 띄워 프로젝트 추가. 취소 시 null */
  addProject(): Promise<Project | null>
  removeProject(projectId: string): Promise<void>
  addConversation(projectId: string): Promise<Conversation>
  /** 홈의 작업 지시창: 쓰지 않은 대화가 있으면 재사용하고 없으면 새로 만들어 작업을 보낸다. 대화 ID 반환 */
  startTask(projectId: string, text: string): Promise<string>
  send(projectId: string, conversationId: string, text: string): Promise<void>
  interrupt(projectId: string, conversationId: string): Promise<void>
  setMode(projectId: string, conversationId: string, mode: AgentMode): Promise<void>
  respondPermission(projectId: string, conversationId: string, requestId: string, decision: PermissionDecision): Promise<void>
  onEvent(cb: (e: AgentEventEnvelope) => void): () => void
  onProjectsChanged(cb: (projects: Project[]) => void): () => void
  onRateLimit(cb: (info: RateLimitInfo) => void): () => void
}
