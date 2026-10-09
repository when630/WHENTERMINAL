import type { AgentEvent, AgentMode, AgentStatus, ContextInfo, PermissionRequest, Project } from '@shared/types'
import { STATUS_PRIORITY } from '@shared/types'

export type TranscriptItem =
  | { type: 'user'; text: string; at: number }
  | { type: 'assistant'; text: string; streaming: boolean; at: number }
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean; at: number }
  | { type: 'notice'; text: string; tone: 'info' | 'error'; at: number }
  | { type: 'divider'; text: string; at: number }

/** 작업 진행 단계. SDK가 단계를 알려주지 않으므로 사용한 도구로 추정한다 (stageForTool) */
export const STAGES = ['계획', '탐색', '수정', '검증', '보고'] as const

/** 한 번의 지시(사용자 메시지)부터 결과까지 = 작업 하나 */
export interface TaskInfo {
  instruction: string
  startedAt: number
  stage: number
  activity: string
  tools: number
  files: string[]
  finishedAt?: number
  durationMs?: number
  costUsd?: number
  summary?: string
  unread: boolean
  archived: boolean
}

export interface ConversationState {
  status: AgentStatus
  mode?: AgentMode
  items: TranscriptItem[]
  permissions: PermissionRequest[]
  updatedAt: number
  task?: TaskInfo
  context?: ContextInfo
  compacting?: boolean
}

export type ConversationMap = Record<string, ConversationState>

export function emptyConversation(): ConversationState {
  return { status: 'idle', items: [], permissions: [], updatedAt: 0 }
}

const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'ToolSearch'])
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const VERIFY_CMD = /\b(test|tests|tsc|typecheck|lint|eslint|vitest|jest|pytest|build|check)\b/i

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

export function stageForTool(name: string, input: unknown): number | null {
  const o = (input ?? {}) as Record<string, unknown>
  if (EXPLORE.has(name)) return 1
  if (EDIT.has(name)) return 2
  if (name === 'Bash' || name === 'PowerShell') return VERIFY_CMD.test(str(o.command)) ? 3 : 1
  return null
}

export function activityForTool(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const file = str(o.file_path) || str(o.notebook_path)
  if (EDIT.has(name)) return `수정 중 · ${baseName(file)}`
  if (name === 'Read') return `읽는 중 · ${baseName(file)}`
  if (name === 'Grep' || name === 'Glob') return `찾는 중 · ${str(o.pattern)}`
  if (name === 'Bash' || name === 'PowerShell') return `실행 중 · ${str(o.command).split('\n')[0]}`
  if (name === 'WebSearch') return `검색 중 · ${str(o.query)}`
  if (name === 'WebFetch') return `웹 페이지 읽는 중`
  if (name === 'TodoWrite') return '할 일 정리 중'
  return `${name} 실행 중`
}

export function applyEvent(prev: ConversationState | undefined, event: AgentEvent): ConversationState {
  const s: ConversationState = prev ? { ...prev, items: [...prev.items], permissions: [...prev.permissions] } : emptyConversation()
  const now = Date.now()
  s.updatedAt = now
  const last = s.items[s.items.length - 1]
  const finalizeStreaming = (): void => {
    if (last?.type === 'assistant' && last.streaming) s.items[s.items.length - 1] = { ...last, streaming: false }
  }
  const task = (patch: Partial<TaskInfo>): void => {
    if (s.task) s.task = { ...s.task, ...patch }
  }

  switch (event.kind) {
    case 'status':
      s.status = event.status
      if (event.status !== 'running' && event.status !== 'waiting_approval') finalizeStreaming()
      if (s.task && (event.status === 'done' || event.status === 'error' || event.status === 'stopped')) {
        task({ finishedAt: now, stage: event.status === 'done' ? STAGES.length : s.task.stage, unread: true })
      }
      break
    case 'mode':
      s.mode = event.mode
      break
    case 'user':
      finalizeStreaming()
      s.items.push({ type: 'user', text: event.text, at: now })
      s.task = { instruction: event.text, startedAt: now, stage: 0, activity: '작업 범위를 정리하는 중', tools: 0, files: [], unread: false, archived: false }
      break
    case 'text_delta':
      if (last?.type === 'assistant' && last.streaming) s.items[s.items.length - 1] = { ...last, text: last.text + event.text }
      else s.items.push({ type: 'assistant', text: event.text, streaming: true, at: now })
      if (s.task && s.task.stage < 1) task({ activity: '생각을 정리하는 중' })
      break
    case 'assistant_text':
      if (last?.type === 'assistant' && last.streaming) s.items[s.items.length - 1] = { type: 'assistant', text: event.text, streaming: false, at: last.at }
      else s.items.push({ type: 'assistant', text: event.text, streaming: false, at: now })
      task({ summary: event.text })
      break
    case 'tool_use': {
      finalizeStreaming()
      s.items.push({ type: 'tool', toolUseId: event.toolUseId, name: event.name, input: event.input, at: now })
      if (s.task) {
        const st = stageForTool(event.name, event.input)
        const file = str((event.input as Record<string, unknown> | null)?.file_path)
        task({
          tools: s.task.tools + 1,
          stage: st === null ? s.task.stage : Math.max(s.task.stage, st),
          activity: activityForTool(event.name, event.input),
          files: EDIT.has(event.name) && file && !s.task.files.includes(file) ? [...s.task.files, file] : s.task.files,
        })
      }
      break
    }
    case 'tool_result': {
      const idx = s.items.findLastIndex((i) => i.type === 'tool' && i.toolUseId === event.toolUseId)
      if (idx >= 0) s.items[idx] = { ...(s.items[idx] as Extract<TranscriptItem, { type: 'tool' }>), result: event.content, isError: event.isError }
      break
    }
    case 'permission_request':
      s.permissions.push(event.request)
      task({ activity: '확인을 기다리는 중' })
      break
    case 'permission_resolved':
      s.permissions = s.permissions.filter((p) => p.requestId !== event.requestId)
      break
    case 'result':
      finalizeStreaming()
      task({ durationMs: event.durationMs, costUsd: event.costUsd, activity: '보고서를 보냈어요' })
      if (event.subtype !== 'success') s.items.push({ type: 'notice', text: `종료: ${event.subtype}`, tone: 'error', at: now })
      break
    case 'error':
      finalizeStreaming()
      s.items.push({ type: 'notice', text: event.message, tone: 'error', at: now })
      break
    case 'context':
      s.context = event.context
      break
    case 'compacting':
      s.compacting = event.on
      break
    case 'compacted': {
      const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))
      const label = event.trigger === 'auto' ? '자동 컴팩트' : '컴팩트'
      s.items.push({ type: 'divider', text: `${label} · ${k(event.preTokens)}${event.postTokens !== undefined ? ` → ${k(event.postTokens)}` : ''} 토큰`, at: now })
      break
    }
    case 'cleared':
      // 화면 기록도 비운다. 보고서(task)는 보고함에 남긴다
      s.items = [{ type: 'divider', text: '컨텍스트를 비웠어요 · 다음 메시지부터 새 세션', at: now }]
      s.permissions = []
      s.status = 'idle'
      s.context = undefined
      s.compacting = false
      break
  }
  return s
}

export const isActive = (st: AgentStatus): boolean => st === 'running' || st === 'waiting_approval' || st === 'queued'

/** 카드 상태 = 하위 대화 중 가장 급한 것 (기획서 5장) */
export function projectStatus(project: Project, convs: ConversationMap): AgentStatus {
  let best: AgentStatus = 'idle'
  for (const c of project.conversations) {
    const st = convs[c.id]?.status ?? 'idle'
    if (STATUS_PRIORITY[st] > STATUS_PRIORITY[best]) best = st
  }
  return best
}

/** 프로젝트를 열 때 보여줄 대화: 가장 급한 대화, 같으면 가장 최근에 움직인 대화 */
export function mostUrgentConversation(project: Project, convs: ConversationMap): string {
  let bestId = project.conversations[0].id
  let bestKey = -1
  for (const c of project.conversations) {
    const s = convs[c.id]
    const key = STATUS_PRIORITY[s?.status ?? 'idle'] * 1e13 + (s?.updatedAt ?? 0)
    if (key > bestKey) {
      bestKey = key
      bestId = c.id
    }
  }
  return bestId
}

export interface TaskRef {
  project: Project
  projectIndex: number
  conversationId: string
  title: string
  state: ConversationState
  task: TaskInfo
}

/** 진행 중 작업(최근 시작 순)과 보고서(최근 완료 순) */
export function collectTasks(projects: Project[], convs: ConversationMap): { running: TaskRef[]; reports: TaskRef[] } {
  const running: TaskRef[] = []
  const reports: TaskRef[] = []
  projects.forEach((project, projectIndex) => {
    for (const c of project.conversations) {
      const state = convs[c.id]
      const task = state?.task
      if (!state || !task) continue
      const ref = { project, projectIndex, conversationId: c.id, title: c.title, state, task }
      if (isActive(state.status)) running.push(ref)
      else if (task.finishedAt && !task.archived) reports.push(ref)
    }
  })
  running.sort((a, b) => b.task.startedAt - a.task.startedAt)
  reports.sort((a, b) => (b.task.finishedAt ?? 0) - (a.task.finishedAt ?? 0))
  return { running, reports }
}

export function firstPendingPermission(project: Project, convs: ConversationMap): { conversationId: string; request: PermissionRequest } | null {
  for (const c of project.conversations) {
    const req = convs[c.id]?.permissions[0]
    if (req) return { conversationId: c.id, request: req }
  }
  return null
}
