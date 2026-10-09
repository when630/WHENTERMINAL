import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentMode, AgentStatus, ContextInfo, PermissionDecision, RateLimitInfo } from '@shared/types'
import { MessageQueue } from './message-queue'

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  suggestions?: PermissionUpdate[]
  suppressAlwaysAllow: boolean
}

export interface AgentSessionOptions {
  cwd: string
  mode: AgentMode
  /** 이전에 저장한 SDK 세션 ID. 있으면 이어서 시작 */
  resumeSessionId?: string
  emit: (event: AgentEvent) => void
  onSessionId: (sessionId: string) => void
  onRateLimit: (info: RateLimitInfo) => void
}

/** 구독 인증 강제: API 키 환경변수는 구독보다 우선하므로 자식 프로세스에 넘기지 않는다. */
function subscriptionEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

const TOOL_RESULT_PREVIEW_LIMIT = 4000

/** 대화 1개 = SDK 세션 1개. 첫 send에서 query()를 띄우고 이후 입력은 스트리밍으로 이어 붙인다. */
export class AgentSession {
  private q: Query | null = null
  private queue: MessageQueue | null = null
  private pending = new Map<string, PendingPermission>()
  private sessionId?: string
  private status: AgentStatus = 'idle'
  private mode: AgentMode
  /** 사용자가 요청한 컴팩트가 진행 중. 이때 오는 result는 작업 완료가 아니므로 상태를 바꾸지 않는다 */
  private manualCompact = false

  constructor(private readonly opts: AgentSessionOptions) {
    this.mode = opts.mode
    this.sessionId = opts.resumeSessionId
  }

  getStatus(): AgentStatus {
    return this.status
  }

  send(text: string): void {
    if (!this.q) this.start()
    this.opts.emit({ kind: 'user', text })
    this.setStatus('running')
    this.queue!.push(text)
  }

  /** /compact를 같은 세션에 보낸다. 실행 중이면 거절 (끝난 뒤에 해야 요약이 온전하다) */
  compact(instructions?: string): void {
    const refuse = (message: string): void => this.opts.emit({ kind: 'error', message })
    if (this.status === 'running' || this.status === 'waiting_approval') return refuse('작업이 끝난 뒤에 컴팩트할 수 있어요')
    if (!this.q && !this.sessionId) return refuse('아직 대화가 없어 컴팩트할 내용이 없어요')
    if (this.manualCompact) return
    if (!this.q) this.start()
    this.manualCompact = true
    this.opts.emit({ kind: 'compacting', on: true })
    this.queue!.push(instructions?.trim() ? `/compact ${instructions.trim()}` : '/compact')
  }

  async interrupt(): Promise<void> {
    if (!this.q || this.status === 'idle' || this.status === 'done') return
    this.denyAllPending('사용자가 중단함')
    await this.q.interrupt()
    this.setStatus('stopped')
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.mode = mode
    if (this.q) await this.q.setPermissionMode(mode)
    this.opts.emit({ kind: 'mode', mode })
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: '사용자가 거절함' })
    } else {
      const always = decision === 'always' && !p.suppressAlwaysAllow
      p.resolve({ behavior: 'allow', updatedPermissions: always ? p.suggestions : undefined })
    }
    this.opts.emit({ kind: 'permission_resolved', requestId })
    if (this.pending.size === 0 && this.status === 'waiting_approval') this.setStatus('running')
  }

  dispose(): void {
    this.denyAllPending('세션 종료')
    this.queue?.close()
    this.q?.close()
    this.q = null
    this.queue = null
  }

  private start(): void {
    this.queue = new MessageQueue()
    this.q = query({
      prompt: this.queue,
      options: {
        cwd: this.opts.cwd,
        env: subscriptionEnv(),
        permissionMode: this.mode,
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        // CLI와 동일하게 사용자/프로젝트/로컬 설정과 CLAUDE.md를 읽는다
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        resume: this.sessionId,
      },
    })
    void this.consume(this.q)
  }

  private canUseTool: CanUseTool = (toolName, input, options) => {
    const requestId = randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        suggestions: options.suggestions,
        suppressAlwaysAllow: options.suppressAlwaysAllowRule ?? false,
      })
      options.signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) this.opts.emit({ kind: 'permission_resolved', requestId })
      })
      // 상태를 먼저 바꿔야 요청 이벤트 처리 중 즉시 응답이 와도 'running'으로 정상 복귀한다
      this.setStatus('waiting_approval')
      this.opts.emit({
        kind: 'permission_request',
        request: {
          requestId,
          toolName,
          input,
          title: options.title,
          description: options.description ?? options.decisionReason,
          defaultToNo: options.defaultToNo,
          suppressAlwaysAllow: options.suppressAlwaysAllowRule,
        },
      })
    })
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg)
    } catch (err) {
      this.opts.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      this.setStatus('error')
    } finally {
      // 프로세스가 끝났으면 다음 send에서 resume으로 다시 띄운다
      if (this.q === q) {
        this.denyAllPending('세션 종료')
        this.queue?.close()
        this.q = null
        this.queue = null
      }
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id !== this.sessionId) {
          this.sessionId = msg.session_id
          this.opts.onSessionId(msg.session_id)
        } else if (msg.subtype === 'status') {
          // 자동 컴팩트도 이 메시지로 알려온다
          if (msg.status === 'compacting') this.opts.emit({ kind: 'compacting', on: true })
          else if (msg.compact_result) {
            if (msg.compact_result === 'failed') this.opts.emit({ kind: 'error', message: `컴팩트 실패: ${msg.compact_error ?? '알 수 없는 오류'}` })
            this.endCompacting()
          }
        } else if (msg.subtype === 'compact_boundary') {
          const m = msg.compact_metadata
          this.opts.emit({ kind: 'compacted', trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens })
          this.endCompacting()
          void this.refreshContext()
        }
        break
      case 'stream_event':
        if (msg.parent_tool_use_id === null && msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
          this.opts.emit({ kind: 'text_delta', text: msg.event.delta.text })
        }
        break
      case 'assistant':
        if (msg.parent_tool_use_id !== null) break
        for (const block of msg.message.content) {
          if (block.type === 'text') this.opts.emit({ kind: 'assistant_text', text: block.text })
          else if (block.type === 'tool_use') this.opts.emit({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input })
        }
        break
      case 'user': {
        if (msg.parent_tool_use_id !== null || typeof msg.message.content === 'string') break
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue
          const content =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
          this.opts.emit({
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            content: content.slice(0, TOOL_RESULT_PREVIEW_LIMIT),
            isError: block.is_error ?? false,
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
        void this.refreshContext()
        if (this.manualCompact) {
          // /compact의 결과: 작업이 끝난 것이 아니므로 상태·보고서는 그대로 둔다
          if (msg.subtype !== 'success' || msg.is_error) this.opts.emit({ kind: 'error', message: '컴팩트하지 못했어요' })
          this.endCompacting()
          break
        }
        this.opts.emit({ kind: 'result', subtype: msg.subtype, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd })
        if (this.status !== 'stopped') this.setStatus(msg.subtype === 'success' && !msg.is_error ? 'done' : 'error')
        break
    }
  }

  private endCompacting(): void {
    this.manualCompact = false
    this.opts.emit({ kind: 'compacting', on: false })
  }

  /** 마지막 응답의 사용량으로 컨텍스트 사용률을 구한다 ('summary'는 토큰 계산 API를 추가로 부르지 않음) */
  private async refreshContext(): Promise<void> {
    const q = this.q
    if (!q) return
    try {
      const u = await q.getContextUsage({ detail: 'summary' })
      const context: ContextInfo = {
        percent: Math.round(u.percentage),
        tokens: u.totalTokens,
        max: u.maxTokens,
        autoCompactAt: u.isAutoCompactEnabled && u.autoCompactThreshold ? Math.round((u.autoCompactThreshold / u.maxTokens) * 100) : undefined,
      }
      this.opts.emit({ kind: 'context', context })
    } catch (err) {
      console.warn('getContextUsage 실패', err)
    }
  }

  private denyAllPending(message: string): void {
    for (const [requestId, p] of this.pending) {
      p.resolve({ behavior: 'deny', message, interrupt: true })
      this.opts.emit({ kind: 'permission_resolved', requestId })
    }
    this.pending.clear()
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return
    this.status = status
    this.opts.emit({ kind: 'status', status })
  }
}
