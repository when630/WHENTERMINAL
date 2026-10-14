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
  /** CLI가 다시 연 턴으로 이어 간 작업: 앞 턴들의 걸린 시간 합. result의 시간은 그 턴 것뿐이라 더한다 */
  priorDurationMs?: number
  costUsd?: number
  summary?: string
  unread: boolean
  archived: boolean
  /** 자리 비움(AWAY) 모드라 묻지 않고 거절한 호출. 돌아와서 한 번에 승인하고 이어 갈 수 있다 */
  denied?: DeniedCall[]
}

/** AWAY 모드에서 거절한 도구 호출 하나. 승인·재실행 때 같은 도구·입력이면 묻지 않고 허용한다 */
export interface DeniedCall {
  toolName: string
  title?: string
  input: Record<string, unknown>
  at: number
}

/** /goal로 건 목표 (SDK active_goal). Stop 훅이 조건을 확인하고 못 미치면 iterations를 올린다 */
export interface GoalInfo {
  condition: string
  iterations: number
  setAt: number
  lastReason?: string
}

/** 이번 턴에 들어간 기억 (SDK memory_recall). select는 파일 그대로, synthesize는 요약 문단 */
export interface MemoryRecall {
  mode: 'select' | 'synthesize'
  memories: { path: string; scope: 'personal' | 'team' | 'organization'; content?: string }[]
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
  /** 작업 폴더 밖에서 더 읽고 쓸 수 있는 폴더 (/add-dir) */
  additionalDirectories?: string[]
  /** 세션 태그 (/tag). 홈 카드를 태그로 거른다. SDK tagSession으로 세션 기록에도 남긴다 */
  tag?: string
}

/** 대화가 실제로 작업하는 폴더 */
export const cwdOf = (p: Project, c: Conversation | undefined): string => c?.worktree?.path ?? p.path

/** 탭·목록에 보이는 대화 (닫힌 대화 제외) */
export const openConversations = (p: Project): Conversation[] => p.conversations.filter((c) => !c.closedAt)

/**
 * 프로젝트 없이 묻는 질문 창(Ctrl+Shift+K)의 숨은 프로젝트. userData/quick 빈 폴더에서 세션을 띄우고,
 * 프로젝트 목록·9개 상한·Alt+A~L 순번·동시 실행 제한·미리 띄우기에서 빠진다. 대화는 하나를 이어 쓴다
 */
export const QUICK_PROJECT_ID = 'quick'
/** 질문 창은 읽기와 웹만: 파일 수정·명령 실행·하위 에이전트는 모델에게서 뺀다 */
export const QUICK_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Task']
/** 묻지 않고 쓰는 읽기·웹 도구 */
export const QUICK_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
/** 처음 쓰는 모델·effort (빠르게 답하도록). 창 머리에서 바꿀 수 있다 */
export const QUICK_DEFAULT_MODEL = 'haiku'
export const QUICK_DEFAULT_EFFORT: EffortLevel = 'low'

/** 프로젝트 수 상한. 홈 열의 키(A S D F G H J K L)와 Ctrl+1~9가 9개라 그 안에서만 받는다 (OPEN-007) */
export const MAX_PROJECTS = 9

export interface Project {
  id: string
  name: string
  path: string
  conversations: Conversation[]
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

/** 승인 응답에 덧붙이는 것: AskUserQuestion의 답, 플랜 승인 뒤 바꿀 모드 */
export interface PermissionExtra {
  /** AskUserQuestion: 질문 → 고른 답 (복수 선택은 쉼표로) */
  answers?: Record<string, string>
  /** ExitPlanMode를 승인한 뒤 이 모드로 (편집 자동 허용 등) */
  planMode?: AgentMode
  /** 거절 이유 (계획을 더 다듬어 달라는 등). 모델에게 전달된다 */
  message?: string
  /** MCP 서버의 입력 요청(elicitation)에 대한 답. accept면 content에 폼 값 */
  elicitation?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }
  /** 모델이 답을 거절했을 때의 선택 (CLI refusal_fallback_prompt 대화 상자) */
  dialog?: RefusalChoice
}

/** '항상 허용'의 범위. chat: 이 대화(세션)만 · project: 프로젝트 설정 · user: 사용자 설정(모든 프로젝트) */
export type AlwaysScope = 'chat' | 'project' | 'user'

export interface AlwaysInfo {
  /** 기억하는 것: 'npm view *', 'WebFetch(domain:example.com)', 'ALL EDITS' … */
  what: string
  scope: AlwaysScope
}

export const ALWAYS_SCOPE_LABEL: Record<AlwaysScope, string> = { chat: 'THIS CHAT', project: 'PROJECT', user: 'ALL PROJECTS' }
export const ALWAYS_SCOPE_TIP: Record<AlwaysScope, string> = {
  chat: '이 대화에서만 다시 묻지 않아요. 새 대화나 홈에서 맡긴 다음 작업에서는 다시 물어요',
  project: '이 프로젝트에서는 다시 묻지 않아요. 프로젝트 설정에 저장돼요',
  user: '모든 프로젝트에서 다시 묻지 않아요. 사용자 설정에 저장돼요',
}

/** 거절 대화 상자의 답: 다른 모델로 다시 시도 · 지시를 고쳐 다시 보냄 · 그만 */
export type RefusalChoice = 'retry_fallback' | 'edit_prompt' | 'cancelled'

/** 앱이 만든 승인 요청의 도구 이름. 도구 호출이 아니라 CLI·MCP가 사람에게 묻는 것 */
export const ELICITATION_TOOL = 'McpElicitation'
export const REFUSAL_TOOL = 'RefusalFallback'

/** Y/A/N 한 키로 답할 수 없는 요청 (답을 골라야 한다) */
export const needsChoice = (toolName: string): boolean =>
  toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode' || toolName === ELICITATION_TOOL || toolName === REFUSAL_TOOL

/** MCP 서버가 사람에게 묻는 것 (SDK onElicitation): 폼 값을 받거나 브라우저에서 인증하고 오기 */
export interface ElicitationInfo {
  serverName: string
  message: string
  mode: 'form' | 'url'
  url?: string
  /** form: 받을 값의 JSON Schema (properties·required) */
  schema?: Record<string, unknown>
  title?: string
  description?: string
}

/** 모델이 답을 거절해 CLI가 다른 모델로 다시 시도할지 묻는 것 (SDK onUserDialog의 refusal_fallback_prompt) */
export interface RefusalInfo {
  originalModel: string
  fallbackModel: string
  category?: string
  guidance?: string
}

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
  /** true면 Y 한 키로 승인 불가 (SDK가 요구). 클릭 또는 확인 단계 필요 */
  defaultToNo?: boolean
  /** true면 '항상 허용'(A) 제공 불가. SDK가 금지했거나 CLI가 기억할 규칙을 주지 않은 경우(이어 붙인 명령 등) */
  suppressAlwaysAllow?: boolean
  /** '항상 허용'이 기억하는 것과 범위 (SDK suggestions를 풀어 쓴 것) */
  always?: AlwaysInfo
  /** 하위 에이전트 안에서 온 요청이면 그 에이전트 ID */
  agentId?: string
  /** toolName이 ELICITATION_TOOL일 때 */
  elicitation?: ElicitationInfo
  /** toolName이 REFUSAL_TOOL일 때 */
  refusal?: RefusalInfo
}

/** AskUserQuestion 도구의 질문 하나 (SDK AskUserQuestionInput) */
export interface AskQuestion {
  question: string
  header: string
  options: { label: string; description: string; preview?: string }[]
  multiSelect?: boolean
}

/** 되감기(/rewind) 범위: 파일만, 대화만, 둘 다 */
export type RewindScope = 'code' | 'chat' | 'both'

export interface RewindResult {
  ok: boolean
  message: string
  /** 미리 보기: 되돌리면 바뀌는 파일 */
  files?: string[]
  /** 대화를 되감았을 때 그 메시지의 글 (입력창에 되돌려 놓아 고쳐 보낼 수 있게) */
  text?: string
}

/** /resume 목록의 세션 하나 (SDK SDKSessionInfo) */
export interface SessionOption {
  sessionId: string
  title: string
  firstPrompt?: string
  modified: number
  branch?: string
  cwd?: string
  /** 이미 이 앱의 대화에 붙어 있으면 그 대화 ID */
  conversationId?: string
}

/** MCP 서버 상태 (SDK McpServerStatus) */
export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  version?: string
  error?: string
  /** stdio 명령 또는 http/sse URL */
  target?: string
}

/** 하위 에이전트 종류 (SDK AgentInfo) */
export interface AgentOption {
  name: string
  description: string
  model?: string
}

/** 권한 규칙·훅 (설정 파일에서 읽은 것) */
export interface PermissionsInfo {
  allow: string[]
  deny: string[]
  ask: string[]
  defaultMode?: string
  /** 설정 파일의 additionalDirectories + 이 대화의 /add-dir */
  additionalDirectories: string[]
  /** 훅 이벤트 → 명령 요약 */
  hooks: { event: string; matcher?: string; commands: string[] }[]
}

/** 권한 규칙을 쓸 설정 파일 */
export type PermissionRuleSource = 'local' | 'project' | 'user'

/** CLAUDE.md 등 메모리 파일 */
export interface MemoryFile {
  label: string
  path: string
  exists: boolean
  /** 글자 수 (있을 때) */
  size?: number
}

/** 로그인 상태 (SDK accountInfo) */
export interface AccountStatus {
  loggedIn: boolean
  email?: string
  organization?: string
  subscription?: string
  /** 'claude.ai' | 'apiKey' … */
  method?: string
  error?: string
}

/** /status: 이 대화의 세션 정보 */
export interface SessionStatus {
  sessionId?: string
  cwd: string
  model?: string
  mode: AgentMode
  contextPercent?: number
  additionalDirectories: string[]
  account: AccountStatus
  /** Claude Code CLI 버전 (알 수 있을 때) */
  cliVersion?: string
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

/** git 화면(/git)의 왼쪽 칸: 브랜치·작업 공간·커밋 안 한 변경 수 */
export interface GitOverview {
  /** 저장소 최상위 폴더 */
  root: string
  /** 이 대화 폴더의 지금 브랜치 (분리된 HEAD면 짧은 커밋, 커밋이 하나도 없으면 브랜치 이름) */
  head: string
  detached: boolean
  branches: GitBranchInfo[]
  worktrees: GitWorktreeInfo[]
  /** 이 대화 폴더에서 커밋하지 않은 파일 수 (새 파일 포함) */
  changed: number
}

export interface GitBranchInfo {
  name: string
  /** 이 대화 폴더에서 체크아웃된 브랜치 */
  current: boolean
  sha: string
  /** 마지막 커밋 시각 (ms) */
  date: number
  subject: string
  upstream?: string
  ahead: number
  behind: number
  /** 다른 작업 공간에 체크아웃되어 있으면 그 폴더 */
  worktree?: string
}

export interface GitWorktreeInfo {
  path: string
  /** 분리된 HEAD면 없음 */
  branch?: string
  sha: string
  /** 이 대화 폴더 */
  here: boolean
  /** 저장소의 원래 폴더 (첫 작업 공간) */
  main: boolean
}

export interface GitCommitInfo {
  sha: string
  short: string
  parents: string[]
  author: string
  /** ms */
  date: number
  /** HEAD -> main, origin/main, tag: v1 … */
  refs: string[]
  subject: string
}

/** git 화면 오른쪽 칸에 보일 것: 커밋 하나 또는 작업 공간의 커밋 안 한 변경 */
export type GitDiffTarget = { kind: 'commit'; sha: string } | { kind: 'working'; path?: string }

export interface GitDiff {
  files: { path: string; status: string }[]
  diff: string
  truncated: boolean
  /** 커밋이면 그 정보와 본문 */
  commit?: GitCommitInfo & { body: string; email: string }
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

/** 입력창 `!명령`으로 터미널에서 돌린 명령의 결과. 출력은 세션에 모델 턴 없이 덧붙는다 */
/** 파일 보기(FilesOverlay)로 읽은 파일 하나. url은 wt-file 주소(그림·html 미리 보기·md의 상대 경로 그림) */
export interface FileView {
  /** 프로젝트(대화 폴더) 안의 상대 경로, / 구분 */
  path: string
  url: string
  kind: 'text' | 'markdown' | 'html' | 'image' | 'binary' | 'dir' | 'missing'
  size: number
  /** 글로 읽은 내용 (text·markdown·html). 20MB까지는 전부, 더 크면 offset부터 한 조각 */
  text?: string
  /** 이 조각이 시작하는 바이트 위치 */
  offset?: number
  /** 뒤에 더 있으면 다음 조각의 위치 (MORE) */
  next?: number
}

export interface ShellResult {
  command: string
  output: string
  /** 걸린 시간 */
  ms: number
  /** 출력이 길어 앞부분을 잘랐다 */
  truncated: boolean
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
  /** uuid는 되감기(/rewind)의 기준점 */
  | { type: 'user'; text: string; uuid?: string }
  | { type: 'assistant'; text: string }
  /** 모델의 생각 (요약본) */
  | { type: 'thinking'; text: string }
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; result?: string; isError?: boolean; truncated?: boolean }
  | { type: 'divider'; text: string }
  /** 명령 출력·안내문. mono면 고정폭으로 */
  | { type: 'notice'; text: string; tone: 'info' | 'warn' | 'error'; mono?: boolean }

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
  /** quiet: 확인 요청에 답하고 전 상태로 돌아간 것. 작업이 새로 끝난 게 아니라 보고서·알림을 건드리지 않는다 */
  | { kind: 'status'; status: AgentStatus; quiet?: boolean }
  /** next: 화면에만 보이고 작업은 차례가 오면(task_start) 시작한다. queuedId는 기다리는 동안 고치거나 뺄 때의 손잡이, uuid는 되감기 기준점 */
  | { kind: 'user'; text: string; next?: boolean; queuedId?: string; uuid?: string }
  /** 기다리던 메시지를 실제로 보냈다. 이 메시지의 작업이 지금 시작된다 */
  | { kind: 'task_start'; text: string; queuedId?: string; uuid?: string }
  /** 기다리던 메시지를 보내지 않기로 했다 (고치려고 꺼냈거나 취소) */
  | { kind: 'unqueued'; queuedId: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'assistant_text'; text: string }
  /** 모델의 생각 (요약본). delta는 스트리밍 조각, thinking은 완성본 */
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; truncated?: boolean }
  /** 오래 도는 도구의 경과 시간 */
  | { kind: 'tool_progress'; toolUseId: string; elapsedS: number }
  | { kind: 'permission_request'; request: PermissionRequest }
  | { kind: 'permission_resolved'; requestId: string }
  | { kind: 'mode'; mode: AgentMode }
  | { kind: 'result'; subtype: string; durationMs: number; costUsd?: number }
  | { kind: 'error'; message: string }
  /** 안내문·명령 출력·경고. CLI가 화면에만 보이는 것들 (/context 출력, 훅 경고, 자동 거절 …) */
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error'; mono?: boolean }
  /** API 재시도 중 */
  | { kind: 'retry'; attempt: number; max: number; delayMs: number }
  | { kind: 'context'; context: ContextInfo }
  | { kind: 'compacting'; on: boolean }
  | { kind: 'compacted'; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | { kind: 'cleared' }
  | { kind: 'model'; model: string; label: string }
  | { kind: 'history'; items: HistoryItem[] }
  /** 화면 기록을 통째로 바꾼다 (되감기·세션 이어 열기·포크 뒤) */
  | { kind: 'replace'; items: HistoryItem[] }
  /** 대기열 순번 (1부터). until이 있으면 구독 한도가 풀리는 그 시각까지 기다린다 */
  | { kind: 'queue'; position: number; until?: number }
  /** 다음 지시 예측 (SDK prompt_suggestion). null이면 지운다 */
  | { kind: 'suggestion'; text: string | null }
  /** /goal 목표의 상태. null이면 목표가 풀렸다 */
  | { kind: 'goal'; goal: GoalInfo | null }
  /** 도구 호출 묶음의 한 줄 요약 (SDK tool_use_summary). 화면에서는 그 호출들을 이 줄 아래로 접는다 */
  | { kind: 'tool_summary'; summary: string; toolUseIds: string[] }
  /** 이번 턴에 들어간 기억 */
  | { kind: 'memory'; recall: MemoryRecall }
  /** AWAY 모드라 묻지 않고 거절했다 */
  | { kind: 'away_denied'; call: DeniedCall }
  /** 한도가 높아 이 세션에 토큰 예산을 걸었다 */
  | { kind: 'budget'; tokens: number }
  /** 살아 있는 백그라운드 작업 전체 (바꿔치기) */
  | { kind: 'background'; tasks: BackgroundTask[] }
  /** 하위 에이전트의 글·도구 호출. parent는 그 에이전트를 띄운 Agent 도구 호출 */
  | { kind: 'sub'; parent: string; item: SubItem }
  | { kind: 'sub_result'; parent: string; toolUseId: string; content: string; isError: boolean }
  /** 백그라운드 작업 알림 한 줄 (끝남·멈춤·모니터 이벤트) */
  | { kind: 'task_note'; text: string }
  /** toolUseId는 이 작업을 띄운 도구 호출 */
  | { kind: 'task_progress'; toolUseId: string; progress: AgentProgress }
  /** 설정의 훅(PreToolUse·PostToolUse·Stop …)이 돌기 시작·진행·끝남. output은 지금까지의 출력 */
  | { kind: 'hook'; hookId: string; name: string; event: string; phase: 'start' | 'progress' | 'done'; output?: string; outcome?: HookOutcome; exitCode?: number }

export type HookOutcome = 'success' | 'error' | 'cancelled'

export interface AgentEventEnvelope {
  projectId: string
  conversationId: string
  event: AgentEvent
}

/** 앱 안에서 아티팩트를 볼 때 쓰는 claude.ai 세션 (로그인 쿠키를 앱 창과 따로 저장) */
export const ARTIFACT_PARTITION = 'persist:claude'

/** webview가 가진 포커스에서 눌린 키 (메인이 앱 창으로 넘긴다) */
export interface GuestKey {
  key: string
  code: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export const IPC = {
  getHotkey: 'app:get-hotkey',
  listProjects: 'projects:list',
  addProject: 'projects:add',
  removeProject: 'projects:remove',
  moveProject: 'projects:move',
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
  listDir: 'files:list',
  viewFile: 'files:view',
  fileImages: 'files:images',
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
  gitOverview: 'git:overview',
  gitLog: 'git:log',
  gitDiff: 'git:diff',
  gitCheckout: 'git:checkout',
  gitCommit: 'git:commit',
  loadHistory: 'agent:load-history',
  getSettingsSync: 'settings:get-sync',
  appInfo: 'app:info',
  setSettings: 'settings:set',
  settingsChanged: 'settings:changed',
  openSettings: 'app:open-settings',
  guestKey: 'app:guest-key',
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
  dropQueued: 'agent:drop-queued',
  toolResult: 'agent:tool-result',
  rewind: 'agent:rewind',
  listSessions: 'agent:list-sessions',
  attachSession: 'agent:attach-session',
  forkConversation: 'agent:fork',
  mcpStatus: 'agent:mcp-status',
  mcpReconnect: 'agent:mcp-reconnect',
  mcpToggle: 'agent:mcp-toggle',
  listAgents: 'agent:list-agents',
  permissionsInfo: 'agent:permissions-info',
  setPermissionRule: 'agent:set-permission-rule',
  addDirectory: 'agent:add-directory',
  memoryFiles: 'agent:memory-files',
  openPath: 'app:open-path',
  exportConversation: 'agent:export',
  sessionStatus: 'agent:session-status',
  accountStatus: 'agent:account-status',
  loginCommand: 'agent:login-command',
  prewarm: 'agent:prewarm',
  quickProject: 'quick:project',
  setTag: 'agent:set-tag',
  approveDenied: 'agent:approve-denied',
  command: 'agent:command',
  shellOutput: 'agent:shell-output',
} as const

/** preload가 window.api로 노출하는 API */
export interface WhenTerminalApi {
  /** 실제로 등록된 전역 호출 단축키 (예: 'Ctrl+Space'). 모두 실패하면 null */
  getHotkey(): Promise<string | null>
  listProjects(): Promise<Project[]>
  /** 폴더 선택 대화상자를 띄워 프로젝트 추가. 취소하거나 MAX_PROJECTS를 넘으면 null */
  addProject(): Promise<Project | null>
  /** 새 대화의 첫 메시지를 바로 보낼 수 있게 CLI를 미리 띄워 둔다 (홈·빈 대화에 글을 치기 시작할 때). 이미 있으면 아무것도 안 함 */
  prewarm(): Promise<void>
  /** 질문 창(QUICK_PROJECT_ID)의 숨은 프로젝트. 대화 하나를 이어 쓴다 */
  quickProject(): Promise<Project>
  /** 세션 태그를 붙이거나(null이면) 뗀다. 세션이 있으면 세션 기록에도 남긴다 */
  setTag(projectId: string, conversationId: string, tag: string | null): Promise<void>
  /** AWAY 모드에서 거절한 호출을 한 번에 승인하고 이어서 하라고 보낸다. 같은 도구·입력이 다시 오면 묻지 않고 허용한다 */
  approveDenied(projectId: string, conversationId: string, calls: DeniedCall[]): Promise<void>
  /** CLI 명령(/goal …)을 세션에 보낸다. 작업으로 치지 않아 상태·보고서가 바뀌지 않는다. 실행 중이면 오류 이벤트 */
  command(projectId: string, conversationId: string, text: string): Promise<void>
  /** 입력창 `!명령`으로 터미널에서 돌린 명령의 출력을 보낸다. 화면에는 출력 항목으로 보이고 모델이 이어 답한다 */
  shellOutput(projectId: string, conversationId: string, result: ShellResult): Promise<void>
  removeProject(projectId: string): Promise<void>
  /** 프로젝트를 목록의 to번째(0부터) 자리로 옮긴다 */
  moveProject(projectId: string, to: number): Promise<void>
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
  /** extra: AskUserQuestion의 답, 플랜 승인 뒤 모드, 거절 이유 */
  respondPermission(projectId: string, conversationId: string, requestId: string, decision: PermissionDecision, extra?: PermissionExtra): Promise<void>
  /** 차례를 기다리던 메시지를 보내지 않는다. 그 글을 돌려준다 (고쳐서 다시 보낼 수 있게). 이미 보냈으면 null */
  dropQueued(projectId: string, conversationId: string, queuedId: string): Promise<string | null>
  /** 도구 결과 전문 (화면에는 앞부분만 보내므로). 세션 기록에 없으면 null */
  toolResult(projectId: string, conversationId: string, toolUseId: string): Promise<string | null>
  /** 되감기: 그 사용자 메시지 시점으로 파일·대화를 되돌린다. dryRun이면 바뀔 파일만 알려 준다 */
  rewind(projectId: string, conversationId: string, uuid: string, scope: RewindScope, dryRun?: boolean): Promise<RewindResult>
  /** 이 프로젝트 폴더(작업 공간 포함)의 지난 세션들 (최근 순) */
  listSessions(projectId: string): Promise<SessionOption[]>
  /** 지난 세션을 이어 연다: 빈 대화면 거기에, 아니면 새 탭으로. 옮겨 갈 대화 ID */
  attachSession(projectId: string, conversationId: string, sessionId: string, title: string): Promise<string>
  /** 지금 대화를 포크해 새 탭으로. 새 대화 ID */
  forkConversation(projectId: string, conversationId: string, title?: string): Promise<string>
  mcpStatus(projectId: string, conversationId: string): Promise<McpServerInfo[]>
  mcpReconnect(projectId: string, conversationId: string, name: string): Promise<void>
  mcpToggle(projectId: string, conversationId: string, name: string, enabled: boolean): Promise<void>
  listAgents(projectId: string): Promise<AgentOption[]>
  permissionsInfo(projectId: string, conversationId: string): Promise<PermissionsInfo>
  /** 권한 규칙 추가·삭제. 설정 파일에 쓰며 다음 세션부터 적용 */
  setPermissionRule(projectId: string, source: PermissionRuleSource, kind: 'allow' | 'deny' | 'ask', rule: string, on: boolean): Promise<PermissionsInfo>
  /** /add-dir: 폴더를 고르거나(path 없음) 적은 폴더를 이 대화에 더한다. 비우려면 remove */
  addDirectory(projectId: string, conversationId: string, path?: string, remove?: boolean): Promise<string[]>
  memoryFiles(projectId: string): Promise<MemoryFile[]>
  /** 파일·폴더를 기본 앱(편집기)으로 연다. 없는 파일이면 만들고 연다 */
  openPath(path: string, create?: boolean): Promise<string>
  /** 대화를 마크다운 파일로 저장 (저장 창). 취소면 null */
  exportConversation(projectId: string, conversationId: string): Promise<string | null>
  sessionStatus(projectId: string, conversationId: string): Promise<SessionStatus>
  accountStatus(refresh?: boolean): Promise<AccountStatus>
  /** 터미널에서 로그인할 때 칠 명령 (번들된 CLI 경로 포함) */
  loginCommand(): Promise<string>
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
  /** 폴더 바로 아래 항목 (폴더는 끝에 /, 먼저). dir은 '' 또는 'src/' */
  listDir(projectId: string, conversationId: string, dir: string): Promise<string[]>
  viewFile(projectId: string, conversationId: string, path: string, offset?: number): Promise<FileView>
  /** 파일 보기 md의 원격 그림을 받아 data URI로 (주소 → data URI, 못 받은 것은 빠진다) */
  fileImages(urls: string[]): Promise<Record<string, string>>
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
  /** git 화면: 브랜치·작업 공간 목록. git 저장소가 아니면 null */
  gitOverview(projectId: string, conversationId: string): Promise<GitOverview | null>
  /** git 화면: 커밋 기록 (최근 것부터, 부모 포함). ref가 null이면 모든 브랜치 */
  gitLog(projectId: string, conversationId: string, ref: string | null, skip: number): Promise<GitCommitInfo[]>
  /** git 화면: 커밋 하나 또는 작업 공간의 커밋 안 한 변경 */
  gitDiff(projectId: string, conversationId: string, target: GitDiffTarget): Promise<GitDiff>
  /** git 화면: 대화 폴더를 로컬 브랜치로 옮긴다 */
  gitCheckout(projectId: string, conversationId: string, branch: string): Promise<{ ok: boolean; message: string }>
  /** git 화면: 작업 공간 폴더(path가 없으면 대화 폴더)의 변경을 모두 커밋한다 */
  gitCommit(projectId: string, conversationId: string, path: string | undefined, message: string): Promise<{ ok: boolean; message: string }>
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
  /** 앱 안 아티팩트 화면(webview)에서 누른 앱 단축키 */
  onGuestKey(cb: (key: GuestKey) => void): () => void
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
