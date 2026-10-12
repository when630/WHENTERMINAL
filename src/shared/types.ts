import type { Settings } from './keymap'

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
  idle: 'IDLE',
  queued: 'QUEUED',
  running: 'RUNNING',
  waiting_approval: 'NEEDS YOU',
  done: 'DONE',
  error: 'ERROR',
  stopped: 'STOPPED',
}

/**
 * Shift+Tab 순환 순서: 기본 → 편집 자동 허용 → 자동 → 플랜.
 * auto는 모델 분류기가 도구 실행마다 승인/거절하고, 판단하지 못한 것만 canUseTool로 사용자에게 묻는다
 */
export type AgentMode = 'default' | 'acceptEdits' | 'auto' | 'plan'
export const MODE_CYCLE: AgentMode[] = ['default', 'acceptEdits', 'auto', 'plan']
export const MODE_LABEL: Record<AgentMode, string> = {
  default: 'DEFAULT',
  acceptEdits: 'ACCEPT EDITS',
  auto: 'AUTO',
  plan: 'PLAN',
}
export const isAgentMode = (m: unknown): m is AgentMode => MODE_CYCLE.includes(m as AgentMode)

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

/** 끝난 작업의 보고서. 재시작해도 보고함에 남도록 대화와 함께 저장 */
export interface StoredTask extends TaskInfo {
  status: AgentStatus
}

export interface Conversation {
  id: string
  title: string
  /** 제목의 출처. draft: 첫 메시지를 다듬은 임시 제목, auto: CLI가 만든 세션 제목, custom: 사용자가 붙인 이름(자동으로 바꾸지 않음). 없으면 기본 이름이거나 예전 방식 */
  titleSource?: 'draft' | 'auto' | 'custom'
  /** SDK 세션 ID. 앱 재시작 후 resume에 사용 */
  sessionId?: string
  mode: AgentMode
  /** 마지막으로 확인한 컨텍스트 사용률(0~100). 앱을 다시 켜도 보이도록 저장 */
  contextPercent?: number
  /** 이 세션이 쓰는 모델 ID와 표시 이름. 매 턴 시작 메시지에서 갱신 */
  model?: string
  modelLabel?: string
  /** 마지막으로 끝난 작업의 보고서 */
  lastTask?: StoredTask
  /** 닫았지만 보관하지 않은 보고서가 있어 남겨 둔 대화. 탭·목록에는 안 보인다 */
  closedAt?: number
  /** 사용자가 고른 모델 (SDK ModelInfo.value). 없으면 설정의 기본 모델 */
  modelChoice?: string
  /** 사용자가 고른 effort. 없으면 모델·설정의 기본값 */
  effort?: EffortLevel
  /** 하위 대화의 별도 작업 공간 (git worktree). 있으면 세션이 이 폴더에서 돈다 */
  worktree?: { path: string; branch: string }
}

/** 대화가 실제로 작업하는 폴더 */
export const cwdOf = (p: Project, c: Conversation | undefined): string => c?.worktree?.path ?? p.path

/** 탭·목록에 보이는 대화 (닫힌 대화 제외) */
export const openConversations = (p: Project): Conversation[] => p.conversations.filter((c) => !c.closedAt)

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

/** 컨텍스트 창 사용량. autoCompactAt은 자동 컴팩트가 시작되는 사용률(%) */
export interface ContextInfo {
  percent: number
  tokens: number
  max: number
  autoCompactAt?: number
}

export interface WorktreeChanges {
  branch: string
  target: string
  files: { path: string; status: string }[]
  diff: string
  truncated: boolean
  dirty: boolean
  ahead: number
}

/** 고를 수 있는 모델 (SDK ModelInfo) */
export interface ModelOption {
  value: string
  displayName: string
  description: string
  resolvedModel?: string
  /** 이 모델이 받는 effort 단계 (effort를 안 받으면 없음) */
  efforts?: EffortLevel[]
}

/** 생각·작업에 들이는 노력 (SDK EffortLevel). max는 세션에서만 (설정 파일에 저장되지 않음) */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT_LABEL: Record<EffortLevel, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' }

/** 이 대화의 effort를 고를 때 보여 줄 것 */
export interface EffortInfo {
  /** 지금 모델이 받는 단계. 비어 있으면 effort를 받지 않는 모델 */
  levels: EffortLevel[]
  /** 고르지 않았을 때 쓰는 값 (Claude Code 설정의 effortLevel). 모르면 null = 모델 기본값 */
  saved: EffortLevel | null
}

/** 대화 폴더의 git 브랜치 */
export interface GitBranch {
  /** 브랜치 이름. 분리된 HEAD면 짧은 커밋 */
  name: string
  detached: boolean
  /** 커밋하지 않은 변경(추적 중인 파일)이 있다 */
  dirty: boolean
}

/** 입력창에서 /로 고를 수 있는 명령 (SDK SlashCommand와 같은 모양) */
export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
  builtin?: boolean
}

/** 구독 한도 창 하나 (5시간, 주간, 모델별 주간 …) */
export interface UsageWindow {
  id: string
  label: string
  /** 사용률 0~100. 모르면 null */
  percent: number | null
  /** 초기화 시각 (ms) */
  resetsAt: number | null
  /** 실시간 한도 이벤트로 받은 상태 */
  status?: 'allowed' | 'allowed_warning' | 'rejected'
}

/** 자동 업데이트 상태. checking → latest | available(안내만) | downloading → ready(재시작하면 설치) | error */
export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** 지금 실행 중인 버전 */
  current: string
  /** 릴리즈의 최신 버전 (확인한 뒤에만) */
  latest?: string
  /** Windows 설치판(NSIS)이라 앱이 직접 받아 설치하는지. 아니면 릴리즈 페이지로 안내만 한다 */
  autoInstall: boolean
  /** 받는 중 진행률 0~100 */
  percent?: number
  /** 릴리즈 페이지 */
  url?: string
  error?: string
  /** 마지막으로 확인을 마친 시각 (ms) */
  checkedAt?: number
}

export interface UsageInfo {
  /** 'pro' | 'max' | 'team' … API 키면 null */
  plan: string | null
  /** 구독 한도가 적용되지 않으면 false (API 키 등) */
  available: boolean
  windows: UsageWindow[]
  fetchedAt: number
  error?: string
}

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  rateLimitType?: string
  utilization?: number
  resetsAt?: number
}

/** 대화창 아래 터미널의 셸. auto는 Windows면 pwsh(없으면 PowerShell), macOS면 $SHELL */
export type TerminalShell = 'auto' | 'pwsh' | 'powershell' | 'gitbash' | 'cmd' | 'wsl' | 'zsh' | 'bash' | 'fish'

/** 이 컴퓨터에서 고를 수 있는 셸 (설치된 것만, auto가 맨 앞) */
export interface TerminalShellOption {
  id: TerminalShell
  /** 라벨 (PWSH, GIT BASH …) */
  label: string
  /** 실제로 띄우는 셸 (auto를 풀어 쓴 것) */
  kind: TerminalShell
  /** 실행 파일 (auto면 지금 고르는 셸의 설명) */
  note: string
}

/** 떠 있는 터미널 */
export interface TerminalInfo {
  /** 표시 이름 (pwsh, Git Bash, zsh …) */
  shell: string
  /** 실제로 띄운 셸 (auto를 풀어 쓴 것) */
  kind: TerminalShell
  cwd: string
  pid: number
}

/** 대화 검색 결과 하나 (Ctrl+Shift+F) */
export interface SearchHit {
  projectId: string
  projectIndex: number
  projectName: string
  conversationId: string
  title: string
  role: 'user' | 'assistant' | 'tool'
  snippet: string
  /** 그 대화에서 몇 번째로 맞은 항목인지 (0부터). 열 때 그 메시지로 스크롤한다 */
  ordinal: number
  /** 세션 기록을 마지막으로 바꾼 시각 (ms) */
  modified: number
}

/** 세션 기록 파일에서 되살린 대화 항목 (앱을 다시 켠 뒤 보여주기용) */
export type HistoryItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { type: 'divider'; text: string }

/** 턴이 끝나도 살아 있는 백그라운드 작업 (셸·모니터·하위 에이전트 등). SDK background_tasks_changed에서 */
export interface BackgroundTask {
  id: string
  /** SDK task_type 그대로 (local_bash, local_agent …) */
  type: string
  description: string
  /** 이 작업을 띄운 도구 호출. 화면 기록의 도구 이름·명령을 찾는 데 쓴다 */
  toolUseId?: string
  startedAt: number
}

/** 하위 에이전트(Agent 도구) 안에서 일어난 일 하나 */
export type SubItem =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean }

/** 하위 에이전트의 진행 수치 (SDK task_progress) */
export interface AgentProgress {
  tools: number
  tokens: number
  durationMs: number
  lastTool?: string
  summary?: string
}

/** 백그라운드 셸·모니터의 출력 파일 끝부분 */
export interface TaskOutput {
  path: string
  text: string
  /** 앞부분을 잘라 냈는지 */
  truncated: boolean
  size: number
}

/** 메인 → 렌더러 이벤트 (대화 단위) */
export type AgentEvent =
  | { kind: 'status'; status: AgentStatus }
  /** next: 화면에만 보이고 작업은 차례가 오면(task_start) 시작한다 */
  | { kind: 'user'; text: string; next?: boolean }
  /** 기다리던 메시지를 실제로 보냈다. 이 메시지의 작업이 지금 시작된다 */
  | { kind: 'task_start'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'permission_request'; request: PermissionRequest }
  | { kind: 'permission_resolved'; requestId: string }
  | { kind: 'mode'; mode: AgentMode }
  | { kind: 'result'; subtype: string; durationMs: number; costUsd?: number }
  | { kind: 'error'; message: string }
  | { kind: 'context'; context: ContextInfo }
  | { kind: 'compacting'; on: boolean }
  | { kind: 'compacted'; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | { kind: 'cleared' }
  | { kind: 'model'; model: string; label: string }
  | { kind: 'history'; items: HistoryItem[] }
  /** 대기열 순번 (1부터) */
  | { kind: 'queue'; position: number }
  /** 살아 있는 백그라운드 작업 전체 (바꿔치기) */
  | { kind: 'background'; tasks: BackgroundTask[] }
  /** 하위 에이전트의 글·도구 호출. parent는 그 에이전트를 띄운 Agent 도구 호출 */
  | { kind: 'sub'; parent: string; item: SubItem }
  | { kind: 'sub_result'; parent: string; toolUseId: string; content: string; isError: boolean }
  /** 백그라운드 작업 알림 한 줄 (끝남·멈춤·모니터 이벤트) */
  | { kind: 'task_note'; text: string }
  /** toolUseId는 이 작업을 띄운 도구 호출 */
  | { kind: 'task_progress'; toolUseId: string; progress: AgentProgress }

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
  closeConversation: 'conversations:close',
  renameConversation: 'conversations:rename',
  reopenConversation: 'conversations:reopen',
  saveTask: 'conversations:save-task',
  startTask: 'tasks:start',
  send: 'agent:send',
  interrupt: 'agent:interrupt',
  stopTask: 'agent:stop-task',
  taskOutput: 'agent:task-output',
  setMode: 'agent:set-mode',
  respondPermission: 'agent:respond-permission',
  compact: 'agent:compact',
  clear: 'agent:clear',
  listCommands: 'agent:list-commands',
  peek: 'agent:peek',
  searchFiles: 'files:search',
  saveImage: 'files:save-image',
  worktreeChanges: 'worktree:changes',
  worktreeMerge: 'worktree:merge',
  worktreeDiscard: 'worktree:discard',
  pickFiles: 'files:pick',
  listModels: 'agent:list-models',
  setModel: 'agent:set-model',
  getEffort: 'agent:get-effort',
  setEffort: 'agent:set-effort',
  gitBranch: 'git:branch',
  loadHistory: 'agent:load-history',
  getSettingsSync: 'settings:get-sync',
  appInfo: 'app:info',
  setSettings: 'settings:set',
  settingsChanged: 'settings:changed',
  openSettings: 'app:open-settings',
  navigate: 'app:navigate',
  setBadge: 'app:set-badge',
  // 메인 → 렌더러
  event: 'agent:event',
  projectsChanged: 'projects:changed',
  rateLimit: 'usage:rate-limit',
  getUsage: 'usage:get',
  usage: 'usage:changed',
  searchConversations: 'conversations:search',
  terminalOpen: 'terminal:open',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalShells: 'terminal:shells',
  terminalNotify: 'terminal:notify',
  // 메인 → 렌더러
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  getUpdate: 'update:get',
  checkUpdate: 'update:check',
  applyUpdate: 'update:apply',
  updateChanged: 'update:changed',
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
  /** 대화(세션)를 닫는다. 실행 중이면 중단한다. 마지막 대화였다면 빈 대화를 새로 만든다. 남은 대화 중 옮겨 갈 ID를 돌려준다 */
  closeConversation(projectId: string, conversationId: string): Promise<string>
  /** 대화 이름을 직접 붙인다. 이후 자동 제목으로 바꾸지 않는다 */
  renameConversation(projectId: string, conversationId: string, title: string): Promise<void>
  /** 닫힌 대화를 다시 탭으로 */
  reopenConversation(projectId: string, conversationId: string): Promise<void>
  /** 끝난 작업의 보고서(읽음·보관 포함)를 저장. 닫힌 대화의 보고서를 보관하면 대화도 지운다 */
  saveTask(projectId: string, conversationId: string, task: StoredTask): Promise<void>
  /** 홈의 작업 지시창: 쓰지 않은 대화가 있으면 재사용하고 없으면 새로 만들어 작업을 보낸다. 대화 ID 반환 */
  /** continueId가 있으면 그 대화에 이어서, 없으면 새 대화(또는 아직 안 쓴 대화)로 */
  startTask(projectId: string, text: string, continueId?: string): Promise<string>
  send(projectId: string, conversationId: string, text: string): Promise<void>
  interrupt(projectId: string, conversationId: string): Promise<void>
  /** 백그라운드 작업(셸·모니터 등) 하나만 멈춘다. 대화의 실행은 그대로 */
  stopTask(projectId: string, conversationId: string, taskId: string): Promise<void>
  /** 백그라운드 셸·모니터가 쓴 출력의 끝부분. 파일을 찾지 못하면 null */
  taskOutput(projectId: string, conversationId: string, taskId: string): Promise<TaskOutput | null>
  setMode(projectId: string, conversationId: string, mode: AgentMode): Promise<void>
  respondPermission(projectId: string, conversationId: string, requestId: string, decision: PermissionDecision): Promise<void>
  /** 대화 내용을 요약해 컨텍스트를 줄인다. instructions는 요약할 때 중점을 둘 내용 */
  compact(projectId: string, conversationId: string, instructions?: string): Promise<void>
  /** 컨텍스트를 비우고 다음 메시지부터 새 세션으로 시작한다 */
  clear(projectId: string, conversationId: string): Promise<void>
  /** 이 프로젝트에서 쓸 수 있는 슬래시 명령 (사용자·프로젝트 명령과 스킬 포함) */
  listCommands(projectId: string): Promise<SlashCommandInfo[]>
  /** 메시지 없이 이 대화의 컨텍스트 사용률·모델을 읽어 'context'·'model' 이벤트로 보낸다 */
  peek(projectId: string, conversationId: string): Promise<void>
  /** 입력창의 @ 자동완성: 이 대화의 작업 폴더에서 파일 찾기 (상대 경로) */
  searchFiles(projectId: string, conversationId: string, query: string): Promise<string[]>
  /** 끌어다 놓은 파일의 실제 경로 (sandbox라 File.path가 없어 preload의 webUtils로) */
  pathForFile(file: File): string
  /** 붙여넣은 이미지(스크린샷)를 userData/attachments에 저장하고 경로를 돌려준다 */
  saveImage(data: Uint8Array, ext: string): Promise<string>
  /** 작업 공간(worktree) 대화의 변경 요약과 diff */
  worktreeChanges(projectId: string, conversationId: string): Promise<WorktreeChanges | null>
  /** 커밋 안 한 변경을 커밋하고 프로젝트의 현재 브랜치에 합친다 */
  worktreeMerge(projectId: string, conversationId: string): Promise<{ ok: boolean; message: string }>
  /** 작업 공간과 브랜치를 지우고 대화를 닫는다. 옮겨 갈 대화 ID */
  worktreeDiscard(projectId: string, conversationId: string): Promise<string>
  /** 파일 선택 창. 고른 파일들의 경로 (취소면 빈 배열) */
  pickFiles(): Promise<string[]>
  listModels(projectId: string): Promise<ModelOption[]>
  /** 이 대화의 모델을 바꾼다. 실행 중이면 다음 응답부터, 아니면 다음 시작부터 */
  setModel(projectId: string, conversationId: string, option: ModelOption): Promise<void>
  getEffort(projectId: string, conversationId: string): Promise<EffortInfo>
  /** 이 대화의 effort를 바꾼다. null이면 기본값으로. 실행 중이면 다음 요청부터 */
  setEffort(projectId: string, conversationId: string, effort: EffortLevel | null): Promise<void>
  /** 대화 폴더의 지금 브랜치. git 저장소가 아니면 null */
  gitBranch(projectId: string, conversationId: string): Promise<GitBranch | null>
  /** 저장된 세션의 지난 대화를 읽어 'history' 이벤트로 보낸다 (화면 기록이 비어 있을 때) */
  loadHistory(projectId: string, conversationId: string): Promise<void>
  /** 첫 화면을 그리기 전에 테마를 적용하려고 동기로 읽는다 */
  initialSettings: Settings
  /** 패키징 여부·버전·플랫폼 (자동 실행처럼 패키징한 앱에서만 되는 기능 안내용) */
  appInfo: { packaged: boolean; version: string; platform: string }
  /** 설정 저장. 전역 호출 키를 등록하지 못하면 error에 이유가 오고 그 키는 저장되지 않는다 */
  setSettings(settings: Settings): Promise<{ settings: Settings; error?: string }>
  onSettingsChanged(cb: (s: Settings) => void): () => void
  /** macOS 메뉴의 '설정…'(⌘,) */
  onOpenSettings(cb: () => void): () => void
  /** 알림을 눌렀을 때 그 대화로 */
  /** terminal이 있으면 그 터미널(termId)을 펼친다 */
  onNavigate(cb: (to: { projectId: string; conversationId: string; terminal?: string }) => void): () => void
  /** Dock 배지·트레이 툴팁: 확인 대기 수와 새 보고 수 */
  setBadge(waiting: number, unread: number): void
  onEvent(cb: (e: AgentEventEnvelope) => void): () => void
  onProjectsChanged(cb: (projects: Project[]) => void): () => void
  onRateLimit(cb: (info: RateLimitInfo) => void): () => void
  /** 구독 한도 (5시간·주간·모델별). refresh면 캐시를 무시하고 새로 받는다 */
  getUsage(refresh?: boolean): Promise<UsageInfo | null>
  onUsage(cb: (u: UsageInfo) => void): () => void
  /** 모든 프로젝트의 열린 대화 내용에서 찾는다 (세션 기록 기준) */
  searchConversations(query: string): Promise<SearchHit[]>
  /** 터미널 하나(termId, 대화마다 여러 개): 살아 있으면 그대로(지금까지의 출력과 함께), 없으면 대화 폴더에서 새로 띄운다.
   *  shell을 주면 그 셸로 띄우고 다음 터미널의 기본값(설정 terminalShell)으로도 저장한다 */
  terminalOpen(projectId: string, conversationId: string, termId: string, cols: number, rows: number, shell?: TerminalShell): Promise<TerminalInfo & { buffer: string }>
  /** 이 컴퓨터에서 고를 수 있는 셸 */
  terminalShells(): Promise<TerminalShellOption[]>
  terminalWrite(termId: string, data: string): void
  terminalResize(termId: string, cols: number, rows: number): void
  /** 셸을 끝낸다 */
  terminalClose(termId: string): Promise<void>
  onTerminalData(cb: (e: { termId: string; data: string }) => void): () => void
  onTerminalExit(cb: (e: { termId: string; code: number }) => void): () => void
  /** 터미널에서 오래 돈 명령이 끝났을 때 OS 알림 (창을 보고 있지 않을 때) */
  notifyTerminal(projectId: string, conversationId: string, termId: string, title: string, body: string): void
  getUpdate(): Promise<UpdateState>
  /** 지금 릴리즈를 확인한다 (받는 중·받아 둔 상태면 그대로 돌려준다) */
  checkUpdate(): Promise<UpdateState>
  /** 받아 둔 업데이트가 있으면 재시작해 설치, 아니면 릴리즈 페이지를 연다 */
  applyUpdate(): void
  onUpdate(cb: (state: UpdateState) => void): () => void
}
