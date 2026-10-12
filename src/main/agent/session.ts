import { query, type SlashCommand, type ElicitationRequest, type ElicitationResult, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type UserDialogRequest, type UserDialogResult } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { ELICITATION_TOOL, isAgentMode, REFUSAL_TOOL, type EffortLevel, type AgentEvent, type AgentMode, type AgentStatus, type BackgroundTask, type ContextInfo, type PermissionDecision, type PermissionExtra, type PermissionRequest, type RateLimitInfo } from '@shared/types'
import { MessageQueue } from './message-queue'
import { claudeExecutable } from '../executable'
import { outputPathIn, rememberTaskOutput } from './task-output'
import { taskLine } from './history'
import type { SessionCallbacks, SpareHandle } from './spare'

/** 사람의 답을 기다리는 것: 도구 승인 · MCP 입력 요청 · CLI 대화 상자. 화면에는 모두 승인창으로 */
type Pending =
  | { kind: 'tool'; resolve: (r: PermissionResult) => void; toolName: string; input: Record<string, unknown>; suggestions?: PermissionUpdate[]; suppressAlwaysAllow: boolean }
  | { kind: 'elicit'; resolve: (r: ElicitationResult | null) => void }
  | { kind: 'dialog'; resolve: (r: UserDialogResult | null) => void }

/** 앱이 그릴 수 있는 CLI 대화 상자. 선언하지 않은 종류는 CLI가 대화 상자 없이 처리한다 */
const REFUSAL_DIALOG = 'refusal_fallback_prompt'

/** 훅 출력은 이만큼만 화면으로 */
const HOOK_OUTPUT_LIMIT = 4000

/** 차례를 기다리는 메시지. id로 고치거나 뺀다 */
interface HeldMessage {
  id: string
  text: string
}

export interface AgentSessionOptions {
  cwd: string
  mode: AgentMode
  /** 사용자가 고른 모델. 없으면 설정의 기본 모델 */
  model?: string
  /** 사용자가 고른 effort. 없으면 모델·설정의 기본값 */
  effort?: EffortLevel
  /** 작업 폴더 밖에서 더 쓸 폴더 (/add-dir) */
  additionalDirectories?: string[]
  /** 이전에 저장한 SDK 세션 ID. 있으면 이어서 시작 */
  resumeSessionId?: string
  /** 미리 띄워 둔 CLI가 있으면 가져온다 (새 세션일 때만 쓴다) */
  takeSpare?: () => SpareHandle | null
  emit: (event: AgentEvent) => void
  onSessionId: (sessionId: string) => void
  onRateLimit: (info: RateLimitInfo) => void
}

/** 구독 인증 강제: API 키 환경변수는 구독보다 우선하므로 자식 프로세스에 넘기지 않는다. */
export function subscriptionEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  // SDK로 띄운 CLI는 Artifact 도구가 기본으로 꺼져 있다(sdk_default_off). CLI처럼 켜 둔다. 사용자 설정 enableArtifact: false는 여전히 우선
  env.CLAUDE_CODE_ARTIFACT ??= '1'
  return env
}

/**
 * 세션마다 같은 SDK 옵션. 미리 띄우는 CLI(prewarm)도 이걸로 띄워야 claim할 수 있다 (폴더·모드·모델·effort는 claim 때 넘긴다)
 */
export function baseOptions(cb: SessionCallbacks): Options {
  return {
    env: subscriptionEnv(),
    canUseTool: cb.canUseTool,
    // MCP 서버가 사람에게 묻는 것(폼·브라우저 인증)과 CLI 대화 상자(거절 뒤 다른 모델로 재시도)를 승인창으로 받는다
    onElicitation: cb.onElicitation,
    onUserDialog: cb.onUserDialog,
    supportedDialogKinds: [REFUSAL_DIALOG],
    includePartialMessages: true,
    // 하위 에이전트의 글도 받아 대화창에서 무엇을 하는지 보여 준다 (기본은 도구 호출만)
    forwardSubagentText: true,
    // CLI와 동일하게 사용자/프로젝트/로컬 설정과 CLAUDE.md를 읽는다
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // 파일 되감기(/rewind)의 기준점을 남긴다
    enableFileCheckpointing: true,
    // Esc(interrupt)는 지금 턴만 끊는다. 백그라운드 작업은 stopTask로 하나씩 (선언하지 않으면 CLI가 모두 죽인다)
    perTaskStopAffordance: true,
    // 설정의 훅이 도는 것을 화면에 보인다 (hook_started·hook_progress·hook_response)
    includeHookEvents: true,
    pathToClaudeCodeExecutable: claudeExecutable(),
  }
}

const TOOL_RESULT_PREVIEW_LIMIT = 4000
/** 하위 에이전트의 도구 결과는 수가 많아 더 짧게 */
const SUB_RESULT_PREVIEW_LIMIT = 1500

type ToolResultBlock = { content?: string | { type: string; text?: string }[] }
const resultText = (block: ToolResultBlock): string =>
  typeof block.content === 'string' ? block.content : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')

type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>

/** 훅의 출력: 합친 output이 있으면 그것, 없으면 stdout·stderr. 끝부분만 */
function hookOutput(msg: { output: string; stdout: string; stderr: string }): string | undefined {
  const text = (msg.output || [msg.stdout, msg.stderr].filter(Boolean).join('\n')).replace(/\s+$/, '')
  if (!text) return undefined
  return text.length > HOOK_OUTPUT_LIMIT ? `…${text.slice(-HOOK_OUTPUT_LIMIT)}` : text
}

export function toContext(u: ContextUsage): ContextInfo {
  return {
    percent: Math.round(u.percentage),
    tokens: u.totalTokens,
    max: u.maxTokens,
    autoCompactAt: u.isAutoCompactEnabled && u.autoCompactThreshold ? Math.round((u.autoCompactThreshold / u.maxTokens) * 100) : undefined,
  }
}

/** 'claude-opus-5-5' → 'Opus 5.5', 'claude-sonnet-5[1m]' → 'Sonnet 5 (1M)'. 모르는 형식은 그대로 */
export function modelLabel(id: string): string {
  const long = /\[1m\]$/i.test(id) ? ' (1M)' : ''
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(id.replace(/\[.*\]$/, ''))
  if (!m) return id
  const name = m[1][0].toUpperCase() + m[1].slice(1)
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}${long}`
}

/** 대화 1개 = SDK 세션 1개. 첫 send에서 query()를 띄우고 이후 입력은 스트리밍으로 이어 붙인다. */
export class AgentSession {
  private q: Query | null = null
  private queue: MessageQueue | null = null
  private pending = new Map<string, Pending>()
  /** 미리 띄운 CLI를 claim하고 아직 답을 못 받았다. 거절되면 query()로 다시 띄우고 inflight를 다시 보낸다 */
  private claiming = false
  /** 이번 턴에 보낸 메시지 (claim이 거절되면 새 프로세스로 다시 보낸다) */
  private inflight: { text: string; uuid: string }[] = []
  private sessionId?: string
  private status: AgentStatus = 'idle'
  private mode: AgentMode
  /** 사용자가 요청한 컴팩트가 진행 중. 이때 오는 result는 작업 완료가 아니므로 상태를 바꾸지 않는다 */
  private manualCompact = false
  private model?: string
  /** 백그라운드 작업 id → 띄운 도구 호출 (task_started에서) */
  private taskTools = new Map<string, string>()
  private background: BackgroundTask[] = []
  /**
   * 실행 중에 보낸 메시지. CLI로 바로 넘기면 지금 턴에 섞이거나 Esc 뒤에도 살아남아 돌므로(interrupt의 still_queued),
   * 앱이 들고 있다가 턴이 끝나면 하나씩 보낸다. 메시지 하나 = 작업 하나
   */
  private held: HeldMessage[] = []
  /** ExitPlanMode를 승인한 뒤 바꿀 모드. CLI가 플랜 모드를 빠져나온 직후(status)에 적용한다 */
  private afterPlan: AgentMode | null = null
  private afterPlanTimer: ReturnType<typeof setTimeout> | null = null
  /** 스트리밍 글자 조각을 모아 한 번에 보낸다 (조각마다 IPC·렌더러 전체 갱신을 하지 않게) */
  private delta = ''
  private deltaTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Esc로 끊은 턴의 result가 아직 오지 않았다. 그 사이 새 메시지를 보냈으면 늦게 온 result가 새 작업을 끝내지 않게 걸러 낸다 */
  private interrupted = false

  constructor(private readonly opts: AgentSessionOptions) {
    this.mode = opts.mode
    this.sessionId = opts.resumeSessionId
  }

  getStatus(): AgentStatus {
    return this.status
  }

  /** 모델 바꾸기. 살아 있으면 다음 응답부터, 아니면 다음 시작 때 쓴다 */
  async setModel(value: string | undefined): Promise<void> {
    this.opts.model = value
    if (this.q) await this.q.setModel(value)
  }

  /** effort 바꾸기. 살아 있으면 다음 요청부터(세션 단위 설정), 아니면 다음 시작 때. null이면 모델 기본값으로 */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.opts.effort = effort ?? undefined
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort })
  }

  /** 살아 있는 SDK Query. 프로세스가 끝났으면 null */
  query(): Query | null {
    return this.q
  }

  /** 살아 있는 세션의 슬래시 명령 목록. 세션이 없으면 null */
  async commands(): Promise<SlashCommand[] | null> {
    return this.q ? this.q.supportedCommands() : null
  }

  /** 저장된(또는 이번 실행에서 받은) 세션 ID */
  getSessionId(): string | undefined {
    return this.sessionId
  }

  /** 살아 있는 세션이 없으면 메시지 없이 띄워 둔다 (상태 조회용). 모델은 부르지 않는다 */
  ensureQuery(): Query {
    if (!this.q) this.start()
    return this.q!
  }

  /**
   * echo=false: 대기열에 넣을 때 이미 화면에 보낸 메시지라 다시 보내지 않는다.
   * 실행 중(또는 컴팩트 중)이면 들고 있다가 지금 턴이 끝난 뒤 보낸다
   */
  send(text: string, echo = true, queuedId?: string): void {
    if (this.isBusy() || this.manualCompact) {
      const id = queuedId ?? randomUUID()
      if (echo) this.emit({ kind: 'user', text, next: true, queuedId: id })
      this.held.push({ id, text })
      return
    }
    // 대기열에서 나온 메시지는 이미 화면에 있으니 작업만 지금 시작한다
    const uuid = randomUUID()
    this.emit(echo ? { kind: 'user', text, uuid } : { kind: 'task_start', text, queuedId, uuid })
    this.dispatch(text, uuid)
  }

  /** 자리가 없어 기다리는 메시지: 화면에는 바로 보이고 상태는 대기. 이미 기다리는 중이면 앞 메시지의 작업을 덮지 않는다 */
  enqueue(text: string, queuedId: string): void {
    this.emit({ kind: 'user', text, next: this.status === 'queued', queuedId })
    this.setStatus('queued')
  }

  /** 들고 있던 메시지를 보내지 않는다. 그 글을 돌려준다 (없으면 null) */
  dropHeld(queuedId: string): string | null {
    const i = this.held.findIndex((h) => h.id === queuedId)
    if (i < 0) return null
    const [h] = this.held.splice(i, 1)
    this.emit({ kind: 'unqueued', queuedId })
    return h.text
  }

  private dispatch(text: string, uuid: string): void {
    if (!this.q) this.start()
    this.setStatus('running')
    this.inflight.push({ text, uuid })
    this.queue!.push(text, uuid)
  }

  /** 들고 있던 메시지를 하나 보낸다. 작업은 이때 시작한다 */
  private sendHeld(): void {
    const h = this.held.shift()
    if (!h) return
    const uuid = randomUUID()
    this.emit({ kind: 'task_start', text: h.text, queuedId: h.id, uuid })
    this.dispatch(h.text, uuid)
  }

  /** 프로세스가 떠서 자리를 차지하는 중 (실행 또는 확인 대기) */
  isBusy(): boolean {
    return this.status === 'running' || this.status === 'waiting_approval'
  }

  cancelQueued(): void {
    if (this.status === 'queued') this.setStatus('stopped')
  }

  /** /compact를 같은 세션에 보낸다. 실행 중이면 거절 (끝난 뒤에 해야 요약이 온전하다) */
  compact(instructions?: string): void {
    const refuse = (message: string): void => this.emit({ kind: 'error', message })
    if (this.status === 'running' || this.status === 'waiting_approval' || this.status === 'queued') return refuse('작업이 끝난 뒤에 컴팩트할 수 있어요')
    if (!this.q && !this.sessionId) return refuse('아직 대화가 없어 컴팩트할 내용이 없어요')
    if (this.manualCompact) return
    if (!this.q) this.start()
    this.manualCompact = true
    this.emit({ kind: 'compacting', on: true })
    this.queue!.push(instructions?.trim() ? `/compact ${instructions.trim()}` : '/compact')
  }

  /** Esc: 지금 턴과 차례를 기다리던 메시지를 멈춘다. 백그라운드 셸·모니터는 남는다 (perTaskStopAffordance, stopTask로 하나씩) */
  async interrupt(): Promise<void> {
    const dropped = this.held.splice(0)
    for (const h of dropped) this.emit({ kind: 'unqueued', queuedId: h.id })
    if (dropped.length) this.emit({ kind: 'task_note', text: `CANCELLED · 차례를 기다리던 메시지 ${dropped.length}개를 보내지 않았어요` })
    if (!this.q || (this.status !== 'running' && this.status !== 'waiting_approval')) return
    this.interrupted = true
    // 끊은 메시지는 claim이 거절되더라도 다시 보내지 않는다
    this.inflight = []
    this.denyAllPending('사용자가 중단함')
    // 응답을 기다리는 사이에 끊긴 턴의 result가 먼저 와도 오류로 보이지 않게 먼저 바꾼다
    this.setStatus('stopped')
    try {
      await this.q.interrupt()
    } catch (err) {
      console.warn('interrupt 실패', err)
    }
  }

  /** 백그라운드 작업 하나를 멈춘다. 끝나면 background_tasks_changed로 목록에서 빠진다 */
  async stopTask(taskId: string): Promise<void> {
    if (!this.q) return
    try {
      await this.q.stopTask(taskId)
    } catch (err) {
      this.emit({ kind: 'error', message: `백그라운드 작업을 멈추지 못했어요: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /** 모드를 바꾼다. 계정·모델이 그 모드를 지원하지 않으면(auto 등) 원래 모드를 유지하고 알린다 */
  async setMode(mode: AgentMode): Promise<void> {
    if (this.q) {
      try {
        await this.q.setPermissionMode(mode)
      } catch (err) {
        this.emit({ kind: 'error', message: `${mode} 모드로 바꾸지 못했어요: ${err instanceof Error ? err.message : String(err)}` })
        this.emit({ kind: 'mode', mode: this.mode })
        return
      }
    }
    this.mode = mode
    this.emit({ kind: 'mode', mode })
  }

  respondPermission(requestId: string, decision: PermissionDecision, extra: PermissionExtra = {}): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (p.kind === 'elicit') {
      // MCP 입력 요청: 폼 값은 accept와 함께. 버튼 없이 N으로 닫으면 decline
      const e = extra.elicitation
      p.resolve(e ? { action: e.action, content: e.action === 'accept' ? e.content : undefined } : { action: decision === 'deny' ? 'decline' : 'accept' })
    } else if (p.kind === 'dialog') {
      p.resolve({ behavior: 'completed', result: decision === 'deny' ? 'cancelled' : (extra.dialog ?? 'cancelled') })
    } else if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: extra.message ?? '사용자가 거절함' })
    } else {
      const always = decision === 'always' && !p.suppressAlwaysAllow
      // AskUserQuestion은 답을 입력값에 실어 돌려줘야 모델이 받는다 (질문 원문도 함께)
      const updatedInput = p.toolName === 'AskUserQuestion' && extra.answers ? { questions: p.input.questions, answers: extra.answers } : undefined
      p.resolve({ behavior: 'allow', updatedInput, updatedPermissions: always ? p.suggestions : undefined })
      if (p.toolName === 'ExitPlanMode' && extra.planMode) this.armAfterPlan(extra.planMode)
    }
    this.emit({ kind: 'permission_resolved', requestId })
    if (this.pending.size === 0 && this.status === 'waiting_approval') this.setStatus('running')
  }

  /** 플랜을 승인한 뒤 CLI가 모드를 되돌리면(status) 고른 모드로 바꾼다. 소식이 없으면 잠시 뒤 그냥 바꾼다 */
  private armAfterPlan(mode: AgentMode): void {
    this.afterPlan = mode
    if (this.afterPlanTimer) clearTimeout(this.afterPlanTimer)
    this.afterPlanTimer = setTimeout(() => void this.applyAfterPlan(), 2000)
  }

  private async applyAfterPlan(): Promise<void> {
    const mode = this.afterPlan
    this.afterPlan = null
    if (this.afterPlanTimer) clearTimeout(this.afterPlanTimer)
    this.afterPlanTimer = null
    if (mode && mode !== this.mode) await this.setMode(mode)
  }

  /** 파일을 그 사용자 메시지 시점으로 되돌린다 (enableFileCheckpointing). 세션이 떠 있지 않으면 이어 띄워서 */
  async rewindFiles(uuid: string, dryRun: boolean): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[] }> {
    if (!this.q) this.start()
    return this.q!.rewindFiles(uuid, { dryRun })
  }

  /** 대화를 다른 세션(포크·지난 세션)으로 바꾼다. 지금 프로세스는 끝내고 다음 메시지부터 그 세션을 이어 연다 */
  switchSession(sessionId: string | undefined): void {
    this.denyAllPending('세션 바꿈')
    this.queue?.close()
    this.q?.close()
    this.q = null
    this.queue = null
    this.claiming = false
    this.inflight = []
    this.setBackground([])
    this.sessionId = sessionId
    this.model = undefined
    if (this.status === 'running' || this.status === 'waiting_approval') this.setStatus('stopped')
  }

  /** 추가 폴더를 바꾼다. 살아 있으면 바로, 아니면 다음 시작 때 */
  async setAdditionalDirectories(dirs: string[]): Promise<void> {
    this.opts.additionalDirectories = dirs
    if (this.q) await this.q.applyFlagSettings({ permissions: { additionalDirectories: dirs } })
  }

  dispose(): void {
    this.disposed = true
    this.held = []
    if (this.afterPlanTimer) clearTimeout(this.afterPlanTimer)
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    this.delta = ''
    this.denyAllPending('세션 종료')
    this.queue?.close()
    this.q?.close()
    this.q = null
    this.queue = null
    this.setBackground([])
  }

  private start(): void {
    this.queue = new MessageQueue()
    // 이어 여는 세션은 claim할 수 없다. 새 세션이고 미리 띄운 CLI가 있으면 그걸 쓴다
    const spare = this.sessionId ? null : (this.opts.takeSpare?.() ?? null)
    if (spare) this.startFromSpare(spare)
    else this.startCold()
  }

  private startCold(): void {
    this.q = query({
      prompt: this.queue!,
      options: {
        ...baseOptions(this.callbacks),
        cwd: this.opts.cwd,
        permissionMode: this.mode,
        resume: this.sessionId,
        model: this.opts.model,
        effort: this.opts.effort,
        additionalDirectories: this.additionalDirectories(),
      },
    })
    void this.consume(this.q)
  }

  /**
   * 미리 띄운 CLI에 이 대화를 붙인다. 거절되면(프로젝트 설정의 model·env, 모드 불가 등) 그 프로세스는 스스로 끝나고
   * 보냈던 메시지는 새로 띄운 프로세스로 다시 보낸다. option_not_applied는 모델·effort만 안 먹은 것이라 그대로 간다
   */
  private startFromSpare(h: SpareHandle): void {
    h.bind(this.callbacks)
    const effort = this.opts.effort
    const q = h.spare.claim({
      prompt: this.queue!,
      options: {
        cwd: this.opts.cwd,
        permissionMode: this.mode,
        model: this.opts.model,
        additionalDirectories: this.additionalDirectories(),
        settings: effort ? { effortLevel: effort } : undefined,
      },
    })
    this.q = q
    this.claiming = true
    void this.consume(q)
    h.spare.claimed.then(
      () => {
        if (this.q === q) this.claiming = false
      },
      (err) => {
        if (this.q !== q) return
        this.claiming = false
        const message = err instanceof Error ? err.message : String(err)
        if (message.startsWith('option_not_applied')) {
          console.warn('미리 띄운 CLI가 일부 옵션을 받지 않음', message)
          return
        }
        console.warn('미리 띄운 CLI를 쓰지 못해 새로 띄움', message)
        this.queue?.close()
        q.close()
        const resend = this.inflight.splice(0)
        this.queue = new MessageQueue()
        this.startCold()
        for (const m of resend) this.queue.push(m.text, m.uuid)
      },
    )
  }

  private additionalDirectories(): string[] | undefined {
    return this.opts.additionalDirectories?.length ? this.opts.additionalDirectories : undefined
  }

  /** CLI가 사람에게 묻는 것들. 미리 띄운 CLI에도 같은 묶음을 bind한다 */
  private readonly callbacks: SessionCallbacks = {
    canUseTool: (toolName, input, options) => {
      const requestId = randomUUID()
      return new Promise<PermissionResult>((resolve) => {
        this.pending.set(requestId, { kind: 'tool', resolve, toolName, input, suggestions: options.suggestions, suppressAlwaysAllow: options.suppressAlwaysAllowRule ?? false })
        this.ask(requestId, options.signal, {
          toolName,
          input,
          title: options.title,
          description: options.description ?? options.decisionReason,
          defaultToNo: options.defaultToNo,
          suppressAlwaysAllow: options.suppressAlwaysAllowRule,
          agentId: options.agentID,
        })
      })
    },
    onElicitation: (request: ElicitationRequest, { signal }) => {
      const requestId = randomUUID()
      return new Promise<ElicitationResult | null>((resolve) => {
        this.pending.set(requestId, { kind: 'elicit', resolve })
        this.ask(requestId, signal, {
          toolName: ELICITATION_TOOL,
          input: {},
          title: request.title,
          description: request.description,
          defaultToNo: true,
          suppressAlwaysAllow: true,
          elicitation: {
            serverName: request.serverName,
            message: request.message,
            mode: request.mode ?? 'form',
            url: request.url,
            schema: request.requestedSchema,
            title: request.title,
            description: request.description,
          },
        })
      })
    },
    onUserDialog: (request: UserDialogRequest, { signal }) => {
      // 모르는 종류는 cancelled로 답해야 CLI가 기본 동작을 한다
      if (request.dialogKind !== REFUSAL_DIALOG) return Promise.resolve<UserDialogResult>({ behavior: 'cancelled' })
      const p = request.payload as { originalModel?: string; fallbackModel?: string; apiRefusalCategory?: string | null; guidanceText?: string }
      const requestId = randomUUID()
      return new Promise<UserDialogResult | null>((resolve) => {
        this.pending.set(requestId, { kind: 'dialog', resolve })
        this.ask(requestId, signal, {
          toolName: REFUSAL_TOOL,
          input: {},
          defaultToNo: true,
          suppressAlwaysAllow: true,
          refusal: { originalModel: p.originalModel ?? '', fallbackModel: p.fallbackModel ?? '', category: p.apiRefusalCategory ?? undefined, guidance: p.guidanceText },
        })
      })
    },
  }

  /** 승인창을 띄운다. CLI가 요청을 거두면(signal) 창도 닫는다 */
  private ask(requestId: string, signal: AbortSignal, request: Omit<PermissionRequest, 'requestId'>): void {
    signal.addEventListener('abort', () => {
      if (!this.pending.delete(requestId)) return
      this.emit({ kind: 'permission_resolved', requestId })
      if (this.pending.size === 0 && this.status === 'waiting_approval') this.setStatus('running')
    })
    // 상태를 먼저 바꿔야 요청 이벤트 처리 중 즉시 응답이 와도 'running'으로 정상 복귀한다
    this.setStatus('waiting_approval')
    this.emit({ kind: 'permission_request', request: { requestId, ...request } })
  }

  /** CLI가 화면에만 보이는 안내: 명령 출력·훅 경고·알림. 사람이 봐야 할 것은 warn */
  private notice(text: string, tone: 'info' | 'warn' | 'error' = 'info', mono = false): void {
    const t = text.replace(/\s+$/, '')
    if (t) this.emit({ kind: 'notice', text: t, tone, mono })
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        // 닫거나 비운 세션에서 늦게 온 메시지는 버린다
        if (this.q !== q) break
        try {
          this.handle(msg)
        } catch (err) {
          // 메시지 하나를 처리하다 난 오류(저장 실패 등)로 세션 전체를 끝내지 않는다
          console.error('SDK 메시지 처리 실패', msg.type, err)
        }
      }
    } catch (err) {
      if (this.q !== q) return
      this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      this.setStatus('error')
    } finally {
      // 프로세스가 끝났으면 다음 send에서 resume으로 다시 띄운다
      if (this.q === q && !this.disposed) {
        this.denyAllPending('세션 종료')
        this.queue?.close()
        this.q = null
        this.queue = null
        this.claiming = false
        this.inflight = []
        // 백그라운드 작업은 CLI 프로세스와 함께 끝난다
        this.setBackground([])
        this.interrupted = false
        if (this.manualCompact) this.endCompacting()
        // 결과 없이 끝났으면(프로세스가 죽는 등) 실행 중으로 남지 않게 한다
        if (this.status === 'running' || this.status === 'waiting_approval') {
          this.emit({ kind: 'error', message: '세션이 예기치 않게 끝났어요' })
          this.setStatus('error')
        }
        this.sendHeld()
      }
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id !== this.sessionId) {
            this.sessionId = msg.session_id
            this.opts.onSessionId(msg.session_id)
          }
          if (msg.model && msg.model !== this.model) {
            this.model = msg.model
            this.emit({ kind: 'model', model: msg.model, label: modelLabel(msg.model) })
            void this.lookupModelName(msg.model)
          }
        } else if (msg.subtype === 'status') {
          // 세션 쪽에서 모드가 바뀐 경우 (플랜 모드를 빠져나오는 등) 화면과 저장값을 맞춘다
          if (msg.permissionMode && msg.permissionMode !== this.mode && isAgentMode(msg.permissionMode)) {
            this.mode = msg.permissionMode
            this.emit({ kind: 'mode', mode: msg.permissionMode })
            // 플랜을 승인하며 고른 모드가 있으면 CLI가 되돌린 모드 대신 그 모드로
            if (this.afterPlan && msg.permissionMode !== 'plan') void this.applyAfterPlan()
          }
          // 자동 컴팩트도 이 메시지로 알려온다
          if (msg.status === 'compacting') this.emit({ kind: 'compacting', on: true })
          else if (msg.compact_result) {
            if (msg.compact_result === 'failed') this.emit({ kind: 'error', message: `컴팩트하지 못했어요: ${msg.compact_error ?? '알 수 없는 오류'}` })
            this.endCompacting()
          }
        } else if (msg.subtype === 'compact_boundary') {
          const m = msg.compact_metadata
          this.emit({ kind: 'compacted', trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens })
          this.endCompacting()
          void this.refreshContext()
        } else if (msg.subtype === 'task_started') {
          if (msg.tool_use_id) this.taskTools.set(msg.task_id, msg.tool_use_id)
          // background_tasks_changed가 먼저 왔으면 도구 호출만 채워 넣는다
          if (msg.tool_use_id && this.background.some((t) => t.id === msg.task_id && !t.toolUseId)) {
            this.setBackground(this.background.map((t) => (t.id === msg.task_id ? { ...t, toolUseId: msg.tool_use_id } : t)))
          }
        } else if (msg.subtype === 'task_notification') {
          this.taskTools.delete(msg.task_id)
          if (msg.output_file && this.sessionId) rememberTaskOutput(this.sessionId, msg.output_file)
          // CLI가 모델에게 넣는 <task-notification> 사용자 메시지는 SDK로 오지 않고 이것만 온다. 한 줄 구분선으로 (되살린 기록과 같게)
          if (!msg.skip_transcript) this.emit({ kind: 'task_note', text: taskLine(msg.status, msg.summary) })
        } else if (msg.subtype === 'local_command_output') {
          // /context /usage /cost 같은 로컬 명령의 출력. CLI는 화면에만 보인다
          this.notice(msg.content, 'info', true)
        } else if (msg.subtype === 'informational') {
          // info는 CLI도 transcript 모드에서만 보인다. notice 이상만
          if (msg.level !== 'info') this.notice(msg.content, msg.level === 'warning' ? 'warn' : 'info')
        } else if (msg.subtype === 'notification') {
          this.notice(msg.text, msg.priority === 'high' || msg.priority === 'immediate' ? 'warn' : 'info')
        } else if (msg.subtype === 'api_retry') {
          this.emit({ kind: 'retry', attempt: msg.attempt, max: msg.max_retries, delayMs: msg.retry_delay_ms })
        } else if (msg.subtype === 'permission_denied') {
          // 자동 모드의 분류기·규칙이 거절한 것. 사람이 알아야 다음 지시를 바꿀 수 있다
          this.notice(`DENIED · ${msg.tool_name}${msg.decision_reason ? ` · ${msg.decision_reason}` : ''}`, 'warn')
        } else if (msg.subtype === 'hook_started') {
          this.emit({ kind: 'hook', hookId: msg.hook_id, name: msg.hook_name, event: msg.hook_event, phase: 'start' })
        } else if (msg.subtype === 'hook_progress') {
          this.emit({ kind: 'hook', hookId: msg.hook_id, name: msg.hook_name, event: msg.hook_event, phase: 'progress', output: hookOutput(msg) })
        } else if (msg.subtype === 'hook_response') {
          this.emit({ kind: 'hook', hookId: msg.hook_id, name: msg.hook_name, event: msg.hook_event, phase: 'done', output: hookOutput(msg), outcome: msg.outcome, exitCode: msg.exit_code })
        } else if (msg.subtype === 'task_progress') {
          const toolUseId = msg.tool_use_id ?? this.taskTools.get(msg.task_id)
          if (toolUseId) {
            const u = msg.usage
            this.emit({
              kind: 'task_progress',
              toolUseId,
              progress: { tools: u.tool_uses, tokens: u.total_tokens, durationMs: u.duration_ms, lastTool: msg.last_tool_name, summary: msg.summary },
            })
          }
        } else if (msg.subtype === 'background_tasks_changed') {
          // 전체 목록이 온다 (바꿔치기). 활동이 아닌 감시자(ambient)는 뺀다
          const now = Date.now()
          this.setBackground(
            msg.tasks
              .filter((t) => !t.ambient)
              .map((t) => ({
                id: t.task_id,
                type: t.task_type,
                description: t.description,
                toolUseId: this.taskTools.get(t.task_id),
                startedAt: this.background.find((b) => b.id === t.task_id)?.startedAt ?? now,
              })),
          )
        }
        break
      case 'stream_event':
        if (msg.parent_tool_use_id === null && msg.event.type === 'content_block_delta') {
          if (msg.event.delta.type === 'text_delta') this.emit({ kind: 'text_delta', text: msg.event.delta.text })
          else if (msg.event.delta.type === 'thinking_delta') this.emit({ kind: 'thinking_delta', text: msg.event.delta.thinking })
        }
        break
      case 'tool_progress':
        if (msg.parent_tool_use_id === null && !msg.heartbeat) this.emit({ kind: 'tool_progress', toolUseId: msg.tool_use_id, elapsedS: msg.elapsed_time_seconds })
        break
      case 'auth_status':
        if (msg.error) this.notice(`LOGIN · ${msg.error}`, 'error')
        else if (msg.isAuthenticating) this.notice(['LOGIN', ...msg.output].join(' · '), 'warn')
        break
      case 'assistant':
        if (msg.parent_tool_use_id !== null) {
          const parent = msg.parent_tool_use_id
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) this.emit({ kind: 'sub', parent, item: { type: 'text', text: block.text } })
            else if (block.type === 'tool_use') this.emit({ kind: 'sub', parent, item: { type: 'tool', toolUseId: block.id, name: block.name, input: block.input } })
          }
          break
        }
        for (const block of msg.message.content) {
          if (block.type === 'text') this.emit({ kind: 'assistant_text', text: block.text })
          else if (block.type === 'thinking') this.emit({ kind: 'thinking', text: block.thinking })
          else if (block.type === 'tool_use') this.emit({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input })
        }
        break
      case 'user': {
        if (typeof msg.message.content === 'string') break
        if (msg.parent_tool_use_id !== null) {
          const parent = msg.parent_tool_use_id
          for (const block of msg.message.content) {
            if (block.type !== 'tool_result') continue
            const content = resultText(block)
            this.emit({ kind: 'sub_result', parent, toolUseId: block.tool_use_id, content: content.slice(0, SUB_RESULT_PREVIEW_LIMIT), isError: block.is_error ?? false })
          }
          break
        }
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue
          const content = resultText(block)
          // 백그라운드 셸의 출력 파일 위치를 알아 두면 같은 세션의 모니터 출력도 바로 찾는다
          const out = outputPathIn(content)
          if (out && this.sessionId) rememberTaskOutput(this.sessionId, out)
          this.emit({
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            content: content.slice(0, TOOL_RESULT_PREVIEW_LIMIT),
            isError: block.is_error ?? false,
            truncated: content.length > TOOL_RESULT_PREVIEW_LIMIT,
          })
        }
        break
      }
      case 'rate_limit_event': {
        const r = msg.rate_limit_info
        this.opts.onRateLimit({ status: r.status, rateLimitType: r.rateLimitType, utilization: r.utilization, resetsAt: r.resetsAt })
        break
      }
      case 'result':
        // 미리 띄운 CLI가 claim을 거절하면 보냈던 메시지에 not_claimed 오류 결과가 온다. 새 프로세스로 다시 보내므로 작업 끝으로 치지 않는다
        if (this.claiming && msg.subtype !== 'success' && msg.errors?.some((e) => e.startsWith('not_claimed'))) break
        this.inflight = []
        void this.refreshContext()
        if (this.manualCompact) {
          // /compact의 결과: 작업이 끝난 것이 아니므로 상태·보고서는 그대로 둔다
          if (msg.subtype !== 'success' || msg.is_error) this.emit({ kind: 'error', message: '컴팩트하지 못했어요' })
          this.endCompacting()
          this.sendHeld()
          break
        }
        if (this.interrupted) {
          this.interrupted = false
          // 끊은 턴의 결과. 그 뒤에 새 작업이 시작됐으면 그 작업의 것이 아니므로 버린다
          if (this.status === 'stopped') this.emit({ kind: 'result', subtype: msg.subtype, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd })
          break
        }
        this.emit({ kind: 'result', subtype: msg.subtype, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd })
        if (this.status !== 'stopped') this.setStatus(msg.subtype === 'success' && !msg.is_error ? 'done' : 'error')
        this.sendHeld()
        break
    }
  }

  /** SDK가 아는 표시 이름이 있으면 그것으로 바꾼다 (예: 'Opus 5.5') */
  private async lookupModelName(model: string): Promise<void> {
    try {
      const list = await this.q?.supportedModels()
      const base = model.replace(/\[.*\]$/, '')
      // 별칭 행('default', 'opus' 등)은 '기본값(추천)' 같은 이름이라 모델을 알 수 없다. ID가 정확히 같은 행만 쓴다
      const hit = list?.find((m) => m.value === model || m.value === base)
      if (hit?.displayName && this.model === model) this.emit({ kind: 'model', model, label: hit.displayName })
    } catch {
      // 표시 이름은 없어도 된다
    }
  }

  private endCompacting(): void {
    this.manualCompact = false
    this.emit({ kind: 'compacting', on: false })
  }

  /** 컨텍스트 사용률(과 아직 모르면 모델)을 다시 읽는다 ('summary'는 토큰 계산 API를 추가로 부르지 않음) */
  async refreshContext(): Promise<void> {
    const q = this.q
    if (!q) return
    try {
      const u = await q.getContextUsage({ detail: 'summary' })
      this.emit({ kind: 'context', context: toContext(u) })
      if (u.model && !this.model) {
        this.model = u.model
        this.emit({ kind: 'model', model: u.model, label: modelLabel(u.model) })
      }
    } catch (err) {
      console.warn('getContextUsage 실패', err)
    }
  }

  private denyAllPending(message: string): void {
    for (const [requestId, p] of this.pending) {
      if (p.kind === 'tool') p.resolve({ behavior: 'deny', message, interrupt: true })
      else if (p.kind === 'elicit') p.resolve({ action: 'cancel' })
      else p.resolve({ behavior: 'cancelled' })
      this.emit({ kind: 'permission_resolved', requestId })
    }
    this.pending.clear()
  }

  private setBackground(tasks: BackgroundTask[]): void {
    if (tasks.length === 0 && this.background.length === 0) return
    this.background = tasks
    this.emit({ kind: 'background', tasks })
  }

  private emit(event: AgentEvent): void {
    if (event.kind === 'text_delta' || event.kind === 'thinking_delta') {
      // 종류가 바뀌면(생각 → 글) 모아 둔 것을 먼저 보낸다
      if (this.deltaKind !== event.kind) this.flushDelta()
      this.deltaKind = event.kind
      this.delta += event.text
      this.deltaTimer ??= setTimeout(() => this.flushDelta(), 40)
      return
    }
    // 다른 이벤트보다 앞서 온 글자가 먼저 가야 순서가 맞다
    this.flushDelta()
    this.opts.emit(event)
  }

  private deltaKind: 'text_delta' | 'thinking_delta' = 'text_delta'

  private flushDelta(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = null
    if (!this.delta || this.disposed) return
    const text = this.delta
    this.delta = ''
    this.opts.emit({ kind: this.deltaKind, text })
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit({ kind: 'status', status })
  }
}
