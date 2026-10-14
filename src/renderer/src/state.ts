import { openConversations, type StoredTask, type AgentEvent, type AgentMode, type AgentProgress, type AgentStatus, type BackgroundTask, type GoalInfo, type HistoryItem, type HookOutcome, type MemoryRecall, type SubItem, type ContextInfo, type PermissionRequest, type Project, type TaskInfo } from '@shared/types'
export type { TaskInfo }
import { STATUS_PRIORITY } from '@shared/types'

export type TranscriptItem =
  /** uuid: 되감기 기준점. queuedId가 있고 pending이면 아직 차례를 기다리는 메시지 (고치거나 뺄 수 있다) */
  | { type: 'user'; text: string; at: number; uuid?: string; queuedId?: string; pending?: boolean }
  | { type: 'assistant'; text: string; streaming: boolean; at: number }
  /** 모델의 생각 (요약본). 접힌 채로 보인다 */
  | { type: 'thinking'; text: string; streaming: boolean; at: number }
  /** truncated: 결과 전문은 세션 기록에 (펼칠 때 읽는다). elapsedS: 도는 동안의 경과 시간 */
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean; truncated?: boolean; elapsedS?: number; at: number }
  | { type: 'notice'; text: string; tone: 'info' | 'warn' | 'error'; mono?: boolean; at: number }
  | { type: 'divider'; text: string; at: number }
  /** 설정의 훅이 도는 것 (살아 있는 세션에서만. 기록 파일에는 남지 않는다) */
  | HookItem
  /** 도구 호출 묶음의 한 줄 요약. 화면에서는 ids의 도구 항목을 이 줄 아래로 접는다 (foldSummaries) */
  | { type: 'summary'; summary: string; ids: string[]; at: number }
  /** 이번 턴에 들어간 기억 (접힌 채로) */
  | { type: 'memory'; recall: MemoryRecall; at: number }

export type HookItem = { type: 'hook'; hookId: string; name: string; event: string; running: boolean; output?: string; outcome?: HookOutcome; exitCode?: number; at: number }

/** 작업 진행 단계. SDK가 단계를 알려주지 않으므로 사용한 도구로 추정한다 (stageForTool) */
export const STAGES = ['PLAN', 'EXPLORE', 'EDIT', 'VERIFY', 'REPORT'] as const


export interface ConversationState {
  status: AgentStatus
  mode?: AgentMode
  items: TranscriptItem[]
  permissions: PermissionRequest[]
  updatedAt: number
  task?: TaskInfo
  /** 다음 작업이 바로 이어져 task가 바뀌었을 때, 저장하기 전에 덮인 앞 작업의 보고서 */
  finishedTask?: StoredTask
  context?: ContextInfo
  compacting?: boolean
  /** 기록 파일에서 되살린 항목 수 (등장 애니메이션을 하지 않을 몫) */
  restored?: number
  model?: { id: string; label: string }
  /** 턴이 끝나도 살아 있는 셸·모니터 등 */
  background?: BackgroundTask[]
  /** 하위 에이전트가 한 일. 키는 그 에이전트를 띄운 Agent 도구 호출 ID (중첩된 에이전트도 같은 표에) */
  subs?: Record<string, SubItem[]>
  /** 작업(하위 에이전트 등)의 진행 수치. 키는 작업을 띄운 도구 호출 ID */
  progress?: Record<string, AgentProgress>
  /** 턴이 끝난 뒤 예측한 다음 지시. 입력창에 흐리게 보이고 Tab으로 받는다. 다음 메시지를 보내면 지운다 */
  suggestion?: string
  /** /goal로 건 목표. null이면 풀렸다 */
  goal?: GoalInfo | null
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
  if (EDIT.has(name)) return `EDIT ${baseName(file)}`
  if (name === 'Read') return `READ ${baseName(file)}`
  if (name === 'Grep' || name === 'Glob') return `SEARCH ${str(o.pattern)}`
  if (name === 'Bash' || name === 'PowerShell') return `RUN ${str(o.command).split('\n')[0]}`
  if (name === 'WebSearch') return `WEB ${str(o.query)}`
  if (name === 'WebFetch') return `FETCH ${str(o.url)}`
  if (name === 'TodoWrite') return 'TODO'
  return name.toUpperCase()
}

/** 하위 에이전트 하나가 기억할 최대 항목 수 (오래된 것부터 버린다) */
const SUB_LIMIT = 300

export const isAgentTool = (name: string): boolean => name === 'Agent' || name === 'Task'

function newTask(instruction: string, now: number): TaskInfo {
  return { instruction, startedAt: now, stage: 0, activity: 'STARTING', tools: 0, files: [], unread: false, archived: false }
}

export function applyEvent(prev: ConversationState | undefined, event: AgentEvent): ConversationState {
  const s: ConversationState = prev ? { ...prev, items: [...prev.items], permissions: [...prev.permissions] } : emptyConversation()
  const now = Date.now()
  s.updatedAt = now
  const last = s.items[s.items.length - 1]
  const finalizeStreaming = (): void => {
    if ((last?.type === 'assistant' || last?.type === 'thinking') && last.streaming) s.items[s.items.length - 1] = { ...last, streaming: false }
  }
  const task = (patch: Partial<TaskInfo>): void => {
    if (s.task) s.task = { ...s.task, ...patch }
  }
  const startTask = (instruction: string): void => {
    if (s.task?.finishedAt) s.finishedTask = { ...s.task, status: s.status }
    s.task = newTask(instruction, now)
  }

  switch (event.kind) {
    case 'status':
      s.status = event.status
      if (event.status !== 'running' && event.status !== 'waiting_approval') finalizeStreaming()
      // 확인 요청에 답하고 전 상태로 돌아간 것: 작업은 그대로
      if (event.quiet) break
      // 끝난 작업에 CLI가 스스로 턴을 열었다 (백그라운드 작업 알림·모니터 등): 같은 작업을 이어 간다.
      // 밀려난 앞 작업(finishedTask)은 이미 저장했으니 지운다. 남기면 도는 동안 그 보고서가 다시 저장된다
      if (event.status === 'running' && s.task?.finishedAt) {
        task({ finishedAt: undefined, stage: Math.min(s.task.stage, STAGES.length - 1), activity: 'RESUMED', unread: false, priorDurationMs: s.task.durationMs })
        s.finishedTask = undefined
      }
      if (s.task && (event.status === 'done' || event.status === 'error' || event.status === 'stopped')) {
        task({ finishedAt: now, stage: event.status === 'done' ? STAGES.length : s.task.stage, unread: true })
      }
      break
    case 'mode':
      s.mode = event.mode
      break
    case 'user':
      finalizeStreaming()
      s.suggestion = undefined
      s.items.push({ type: 'user', text: event.text, at: now, uuid: event.uuid, queuedId: event.queuedId, pending: event.next || undefined })
      // 실행 중에 보낸 메시지는 지금 작업을 덮지 않는다. 차례가 오면 task_start
      if (!event.next) startTask(event.text)
      break
    case 'task_start': {
      s.suggestion = undefined
      startTask(event.text)
      // 기다리던 메시지가 이제 보내졌다: 되감기 기준점을 받고 대기 표시를 뗀다
      const idx = event.queuedId ? s.items.findIndex((i) => i.type === 'user' && i.queuedId === event.queuedId) : -1
      if (idx >= 0) s.items[idx] = { ...(s.items[idx] as Extract<TranscriptItem, { type: 'user' }>), pending: undefined, uuid: event.uuid }
      break
    }
    case 'unqueued':
      s.items = s.items.filter((i) => !(i.type === 'user' && i.queuedId === event.queuedId))
      break
    case 'text_delta':
      if (last?.type === 'assistant' && last.streaming) s.items[s.items.length - 1] = { ...last, text: last.text + event.text }
      else {
        finalizeStreaming()
        s.items.push({ type: 'assistant', text: event.text, streaming: true, at: now })
      }
      if (s.task && s.task.stage < 1) task({ activity: 'WRITING' })
      break
    case 'assistant_text':
      if (last?.type === 'assistant' && last.streaming) s.items[s.items.length - 1] = { type: 'assistant', text: event.text, streaming: false, at: last.at }
      else {
        finalizeStreaming()
        s.items.push({ type: 'assistant', text: event.text, streaming: false, at: now })
      }
      task({ summary: event.text })
      break
    case 'thinking_delta':
      if (last?.type === 'thinking' && last.streaming) s.items[s.items.length - 1] = { ...last, text: last.text + event.text }
      else {
        finalizeStreaming()
        s.items.push({ type: 'thinking', text: event.text, streaming: true, at: now })
      }
      task({ activity: 'THINKING' })
      break
    case 'thinking':
      if (last?.type === 'thinking' && last.streaming) s.items[s.items.length - 1] = { type: 'thinking', text: event.text, streaming: false, at: last.at }
      else {
        finalizeStreaming()
        s.items.push({ type: 'thinking', text: event.text, streaming: false, at: now })
      }
      break
    case 'tool_progress': {
      const idx = s.items.findLastIndex((i) => i.type === 'tool' && i.toolUseId === event.toolUseId)
      if (idx >= 0) s.items[idx] = { ...(s.items[idx] as Extract<TranscriptItem, { type: 'tool' }>), elapsedS: event.elapsedS }
      break
    }
    case 'notice':
      finalizeStreaming()
      s.items.push({ type: 'notice', text: event.text, tone: event.tone, mono: event.mono, at: now })
      break
    case 'retry':
      task({ activity: `RETRY ${event.attempt}/${event.max} · ${Math.round(event.delayMs / 1000)}s` })
      break
    case 'hook': {
      // 같은 훅 실행(hookId)은 한 줄에서 상태만 바뀐다. 시작 없이 끝만 올 수도 있다
      const idx = s.items.findLastIndex((i) => i.type === 'hook' && i.hookId === event.hookId)
      const prev = idx >= 0 ? (s.items[idx] as HookItem) : undefined
      const item: HookItem = {
        type: 'hook',
        hookId: event.hookId,
        name: event.name,
        event: event.event,
        running: event.phase !== 'done',
        output: event.output ?? prev?.output,
        outcome: event.outcome ?? prev?.outcome,
        exitCode: event.exitCode ?? prev?.exitCode,
        at: prev?.at ?? now,
      }
      if (prev) s.items[idx] = item
      else {
        finalizeStreaming()
        s.items.push(item)
      }
      if (event.phase === 'start' && s.task) task({ activity: `HOOK ${event.event}` })
      break
    }
    case 'replace':
      s.items = fromHistory(event.items)
      s.restored = s.items.length
      s.subs = undefined
      s.progress = undefined
      s.permissions = []
      s.context = undefined
      s.compacting = false
      s.suggestion = undefined
      s.goal = undefined
      if (s.status === 'running' || s.status === 'waiting_approval') s.status = 'stopped'
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
      if (idx >= 0) s.items[idx] = { ...(s.items[idx] as Extract<TranscriptItem, { type: 'tool' }>), result: event.content, isError: event.isError, truncated: event.truncated, elapsedS: undefined }
      // 이번 작업에서 남은 도구가 없으면 모델이 결과를 보고 다음 걸음을 고르는 중 (중단된 턴의 도구는 결과가 끝내 오지 않으므로 뺀다)
      const since = s.task?.startedAt ?? 0
      if (!s.items.some((i) => i.type === 'tool' && i.result === undefined && i.at >= since)) task({ activity: 'THINKING' })
      break
    }
    case 'permission_request':
      s.permissions.push(event.request)
      task({ activity: 'WAITING FOR YOU' })
      break
    case 'permission_resolved':
      s.permissions = s.permissions.filter((p) => p.requestId !== event.requestId)
      break
    case 'result':
      finalizeStreaming()
      task({ durationMs: (s.task?.priorDurationMs ?? 0) + event.durationMs, costUsd: event.costUsd, activity: 'REPORTED' })
      if (event.subtype !== 'success') s.items.push({ type: 'notice', text: `종료: ${event.subtype}`, tone: 'error', at: now })
      break
    case 'error':
      finalizeStreaming()
      s.items.push({ type: 'notice', text: event.message, tone: 'error', at: now })
      break
    case 'context':
      s.context = event.context
      break
    case 'queue':
      task({ activity: event.until ? `LIMIT · ${hhmm(event.until)} 재개 · #${event.position}` : `QUEUED #${event.position}` })
      break
    case 'suggestion':
      s.suggestion = event.text ?? undefined
      break
    case 'goal': {
      const prev = s.goal
      s.goal = event.goal
      // 조건을 못 미쳐 다시 도는 것과 목표가 풀린 것은 구분선으로 남긴다
      if (event.goal && prev && event.goal.iterations > prev.iterations) {
        finalizeStreaming()
        s.items.push({ type: 'divider', text: `GOAL NOT MET · ${event.goal.iterations}${event.goal.lastReason ? ` · ${event.goal.lastReason}` : ''}`, at: now })
      } else if (event.goal && (!prev || prev.condition !== event.goal.condition)) {
        finalizeStreaming()
        s.items.push({ type: 'divider', text: `GOAL · ${event.goal.condition}`, at: now })
      } else if (!event.goal && prev) {
        finalizeStreaming()
        s.items.push({ type: 'divider', text: `GOAL MET · ${prev.condition}`, at: now })
      }
      break
    }
    case 'tool_summary':
      finalizeStreaming()
      s.items.push({ type: 'summary', summary: event.summary, ids: event.toolUseIds, at: now })
      break
    case 'memory':
      finalizeStreaming()
      s.items.push({ type: 'memory', recall: event.recall, at: now })
      break
    case 'away_denied': {
      finalizeStreaming()
      const label = event.call.title ?? `${event.call.toolName} ${summarizeInput(event.call.input)}`.trim()
      s.items.push({ type: 'notice', text: `AWAY · DENIED · ${label}`, tone: 'warn', at: now })
      if (s.task) task({ denied: [...(s.task.denied ?? []), event.call] })
      break
    }
    case 'budget':
      finalizeStreaming()
      s.items.push({ type: 'divider', text: `BUDGET · ${Math.round(event.tokens / 1000)}K TOKENS · 구독 한도가 높아 이 세션은 예산 안에서 마무리해요`, at: now })
      break
    case 'history':
      // 이미 이번 실행에서 대화가 시작됐으면 덮지 않는다
      if (s.items.length === 0) {
        s.items = fromHistory(event.items)
        s.restored = s.items.length
      }
      break
    case 'background':
      s.background = event.tasks
      break
    case 'sub': {
      const list = [...(s.subs?.[event.parent] ?? []), event.item]
      s.subs = { ...s.subs, [event.parent]: list.length > SUB_LIMIT ? list.slice(-SUB_LIMIT) : list }
      // 앞에서 기다리는(포그라운드) 에이전트면 작업 줄에 그 에이전트가 하는 일을 보인다
      if (event.item.type === 'tool' && s.items.some((i) => i.type === 'tool' && i.toolUseId === event.parent && i.result === undefined)) {
        task({ activity: `AGENT · ${activityForTool(event.item.name, event.item.input)}` })
      }
      break
    }
    case 'sub_result': {
      const list = s.subs?.[event.parent]
      const idx = list?.findLastIndex((i) => i.type === 'tool' && i.toolUseId === event.toolUseId) ?? -1
      if (list && idx >= 0) {
        const next = [...list]
        next[idx] = { ...(next[idx] as Extract<SubItem, { type: 'tool' }>), result: event.content, isError: event.isError }
        s.subs = { ...s.subs, [event.parent]: next }
      }
      break
    }
    case 'task_progress':
      s.progress = { ...s.progress, [event.toolUseId]: event.progress }
      break
    case 'task_note':
      finalizeStreaming()
      s.items.push({ type: 'divider', text: event.text, at: now })
      break
    case 'model':
      s.model = { id: event.model, label: event.label }
      break
    case 'compacting':
      s.compacting = event.on
      break
    case 'compacted': {
      const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))
      const label = event.trigger === 'auto' ? 'AUTO COMPACT' : 'COMPACT'
      s.items.push({ type: 'divider', text: `${label} · ${k(event.preTokens)}${event.postTokens !== undefined ? ` → ${k(event.postTokens)}` : ''} tokens`, at: now })
      break
    }
    case 'cleared':
      // 화면 기록도 비운다. 보고서(task)는 보고함에 남긴다
      s.items = [{ type: 'divider', text: 'CLEARED · 컨텍스트를 비웠어요. 다음 메시지부터 새 세션이에요', at: now }]
      s.subs = undefined
      s.progress = undefined
      // 되살린 기록도 함께 사라졌으므로, 새 항목이 등장 애니메이션 없이 나오지 않게 한다
      s.restored = undefined
      s.permissions = []
      s.status = 'idle'
      s.context = undefined
      s.compacting = false
      s.suggestion = undefined
      s.goal = undefined
      break
  }
  return s
}

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 화면에 그릴 단위: 항목 하나, 또는 요약 한 줄 아래로 접은 도구 묶음. idx는 items에서의 자리 (키·등장 애니메이션용) */
export type RenderNode =
  | { kind: 'item'; item: TranscriptItem; idx: number }
  | { kind: 'group'; summary: Extract<TranscriptItem, { type: 'summary' }>; idx: number; tools: { item: ToolItem; idx: number }[] }

/**
 * 도구 호출 묶음 요약(summary)이 가리키는 도구 항목을 그 요약 아래로 접는다. 상태는 평평하게 두고 그릴 때만 묶는다
 * (runningAgents·artifactsOf 같은 계산이 그대로 돌게). 요약이 끝내 안 오면 그대로 그린다
 */
export function foldSummaries(items: TranscriptItem[]): RenderNode[] {
  const claimed = new Map<string, number>()
  items.forEach((it, i) => {
    if (it.type === 'summary') for (const id of it.ids) claimed.set(id, i)
  })
  if (claimed.size === 0) return items.map((item, idx) => ({ kind: 'item', item, idx }))
  const out: RenderNode[] = []
  const buffered = new Map<number, { item: ToolItem; idx: number }[]>()
  items.forEach((item, idx) => {
    if (item.type === 'tool') {
      const at = claimed.get(item.toolUseId)
      if (at !== undefined && at > idx) {
        const list = buffered.get(at) ?? []
        list.push({ item, idx })
        buffered.set(at, list)
        return
      }
    }
    if (item.type === 'summary') {
      const tools = buffered.get(idx) ?? []
      buffered.delete(idx)
      if (tools.length) out.push({ kind: 'group', summary: item, idx, tools })
      return
    }
    out.push({ kind: 'item', item, idx })
  })
  // 요약이 없는 채 남은 것 (없어야 하지만) 뒤에 그대로
  for (const list of buffered.values()) for (const t of list) out.push({ kind: 'item', item: t.item, idx: t.idx })
  return out
}

/** 세션 기록 파일에서 되살린 항목을 화면 항목으로 (등장 애니메이션 없이 그리도록 at은 0) */
function fromHistory(items: HistoryItem[]): TranscriptItem[] {
  return items.map((h): TranscriptItem => {
    if (h.type === 'assistant' || h.type === 'thinking') return { ...h, streaming: false, at: 0 }
    return { ...h, at: 0 }
  })
}

/** 백그라운드 작업의 종류 라벨과 보여 줄 설명. 띄운 도구 호출이 화면 기록에 있으면 그 이름·명령을 쓴다 */
export function describeBackground(b: BackgroundTask, items: TranscriptItem[]): { label: string; text: string; command: string } {
  const found = b.toolUseId ? items.findLast((i) => i.type === 'tool' && i.toolUseId === b.toolUseId) : undefined
  const tool = found?.type === 'tool' ? found : undefined
  const o = (tool?.input ?? {}) as Record<string, unknown>
  const command = (str(o.command) || str(o.description) || str(o.prompt)).split('\n')[0]
  return { label: backgroundLabel(b.type, tool?.name), text: b.description || command, command }
}

function backgroundLabel(type: string, tool?: string): string {
  if (tool === 'Bash' || tool === 'PowerShell') return 'SHELL'
  if (tool === 'Monitor') return 'MONITOR'
  if (tool === 'Agent' || tool === 'Task') return 'AGENT'
  const t = type.toLowerCase()
  if (t.includes('monitor')) return 'MONITOR'
  if (t.includes('bash') || t.includes('shell')) return 'SHELL'
  if (t.includes('agent')) return 'AGENT'
  if (t.includes('workflow')) return 'WORKFLOW'
  if (t.includes('mcp')) return 'MCP'
  return t.replace(/^local_/, '').toUpperCase() || 'TASK'
}

export type ToolItem = Extract<TranscriptItem, { type: 'tool' }>

/** 앞에서 기다리는(포그라운드) 하위 에이전트: 결과가 아직 안 온 Agent 도구 호출. 백그라운드 에이전트는 BACKGROUND 쪽에 나온다 */
export function runningAgents(items: TranscriptItem[], background: BackgroundTask[]): ToolItem[] {
  const bg = new Set(background.map((b) => b.toolUseId))
  return items.filter((i): i is ToolItem => i.type === 'tool' && isAgentTool(i.name) && i.result === undefined && !bg.has(i.toolUseId))
}

/** 에이전트를 띄운 도구 입력에서 설명·종류·지시문 */
export function agentInfo(input: unknown): { description: string; type: string; prompt: string } {
  const o = (input ?? {}) as Record<string, unknown>
  return { description: str(o.description), type: str(o.subagent_type), prompt: str(o.prompt) }
}

/** 하위 에이전트가 지금(또는 마지막으로) 하는 일 한 줄 */
export function subActivity(list: SubItem[] | undefined, progress?: AgentProgress): string {
  if (progress?.summary) return progress.summary
  const last = list?.findLast((i) => i.type === 'tool')
  if (last?.type === 'tool') return activityForTool(last.name, last.input)
  return list?.length ? 'WRITING' : 'STARTING'
}

export interface BackgroundRef {
  project: Project
  projectIndex: number
  conversationId: string
  id: string
  label: string
  text: string
}

/** 모든 대화의 살아 있는 백그라운드 작업 (전광판용) */
export function collectBackground(projects: Project[], convs: ConversationMap): BackgroundRef[] {
  const out: BackgroundRef[] = []
  projects.forEach((project, projectIndex) => {
    for (const c of project.conversations) {
      const state = convs[c.id]
      for (const b of state?.background ?? []) {
        const { label, text } = describeBackground(b, state!.items)
        out.push({ project, projectIndex, conversationId: c.id, id: b.id, label, text })
      }
    }
  })
  return out
}

export interface ArtifactLink {
  url: string
  title: string
  /** 이 대화에서 올린 횟수. 다시 올리면 늘어 앱 안 화면을 새로 고친다 */
  rev: number
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/

/** 이 대화에서 Artifact 도구로 올린(또는 고친) 페이지. 같은 링크는 마지막 것 하나만, 최근 것이 위로 */
export function artifactsOf(items: TranscriptItem[]): ArtifactLink[] {
  const byUrl = new Map<string, ArtifactLink>()
  for (const item of items) {
    if (item.type !== 'tool' || item.name !== 'Artifact' || item.isError || !item.result) continue
    const o = (item.input ?? {}) as Record<string, unknown>
    // 올리기(action 없음·publish)와 보여 주기(open)만. list·read 등은 연결된 페이지가 아니다
    const open = o.action === 'open'
    if (o.action !== undefined && o.action !== 'publish' && !open) continue
    // open은 결과에 다른 링크가 섞일 수 있어 입력의 url을 먼저 본다
    const fromInput = typeof o.url === 'string' ? ARTIFACT_URL.exec(o.url)?.[0] : undefined
    const url = open ? (fromInput ?? ARTIFACT_URL.exec(item.result)?.[0]) : (ARTIFACT_URL.exec(item.result)?.[0] ?? fromInput)
    if (!url) continue
    const prev = byUrl.get(url)
    // open은 내용을 바꾸지 않으므로 새로 고치지 않고(rev 그대로) 앞서 올린 제목을 둔다
    const title = (open ? prev?.title : undefined) || str(o.title) || baseName(str(o.file_path)) || url.replace(/^https:\/\/claude\.ai\/(?:code\/)?/, '')
    const rev = (prev?.rev ?? 0) + (open && prev ? 0 : 1)
    byUrl.delete(url)
    byUrl.set(url, { url, title, rev })
  }
  return [...byUrl.values()].reverse()
}

export const isActive =(st: AgentStatus): boolean => st === 'running' || st === 'waiting_approval' || st === 'queued'

/** 카드 상태 = 하위 대화 중 가장 급한 것 (기획서 5장) */
export function projectStatus(project: Project, convs: ConversationMap): AgentStatus {
  let best: AgentStatus = 'idle'
  for (const c of openConversations(project)) {
    const st = convs[c.id]?.status ?? 'idle'
    if (STATUS_PRIORITY[st] > STATUS_PRIORITY[best]) best = st
  }
  return best
}

/** 프로젝트를 열 때 보여줄 대화: 가장 급한 대화, 같으면 가장 최근에 움직인 대화 */
export function mostUrgentConversation(project: Project, convs: ConversationMap): string {
  const open = openConversations(project)
  let bestId = (open[0] ?? project.conversations[0]).id
  let bestKey = -1
  for (const c of open) {
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
  /** 세션 태그 (/tag) */
  tag?: string
  state: ConversationState
  task: TaskInfo
}

/** 홈에서 쉬는 대화 카드를 고를 때의 키 (같은 대화의 보고서 카드와 구분) */
export const IDLE_KEY = 'idle:'

/**
 * 진행 중 작업(최근 시작 순), 쉬는 대화(열린 대화 중 한 번이라도 작업을 끝낸 것, 최근 끝난 순), 보고서(최근 완료 순).
 * 끝난 작업은 쉬는 대화와 보고서 양쪽에 나온다 (진행 띠는 아래 NO RUNNING으로 내려가고, 보고서는 따로 위에서 들어온다)
 */
export function collectTasks(projects: Project[], convs: ConversationMap): { running: TaskRef[]; idle: TaskRef[]; reports: TaskRef[] } {
  const running: TaskRef[] = []
  const idle: TaskRef[] = []
  const reports: TaskRef[] = []
  projects.forEach((project, projectIndex) => {
    for (const c of project.conversations) {
      const state = convs[c.id]
      const task = state?.task
      if (!state || !task) continue
      const ref = (): TaskRef => ({ project, projectIndex, conversationId: c.id, title: c.title, tag: c.tag, state, task })
      if (isActive(state.status)) {
        running.push(ref())
        continue
      }
      if (task.finishedAt && !c.closedAt) idle.push(ref())
      if (task.finishedAt && !task.archived) reports.push(ref())
    }
  })
  running.sort((a, b) => b.task.startedAt - a.task.startedAt)
  idle.sort((a, b) => (b.task.finishedAt ?? 0) - (a.task.finishedAt ?? 0))
  reports.sort((a, b) => (b.task.finishedAt ?? 0) - (a.task.finishedAt ?? 0))
  return { running, idle, reports }
}

export function firstPendingPermission(project: Project, convs: ConversationMap): { conversationId: string; request: PermissionRequest } | null {
  for (const c of openConversations(project)) {
    const req = convs[c.id]?.permissions[0]
    if (req) return { conversationId: c.id, request: req }
  }
  return null
}

/** 프로젝트 폴더 안의 경로는 앞부분을 떼고 보여준다 */
export function relPath(text: string, root: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const t = text.replace(/\\/g, '/')
  return t.toLowerCase().startsWith(r.toLowerCase() + '/') ? t.slice(r.length + 1) : text
}

/** 도구 입력에서 한 줄로 보여 줄 값 (명령·파일·패턴 …) */
export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 120) : ''
}
