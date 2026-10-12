import { prewarm, type CanUseTool, type OnElicitation, type OnUserDialog, type Options, type SpareProcess } from '@anthropic-ai/claude-agent-sdk'

/** 세션이 CLI의 물음에 답하는 콜백. 미리 띄운 CLI에는 세션이 생기기 전에 등록해야 하므로 묶어서 다룬다 */
export interface SessionCallbacks {
  canUseTool: CanUseTool
  onElicitation: OnElicitation
  onUserDialog: OnUserDialog
}

/** 가져간 스페어. 세션이 claim하기 전에 bind로 자기 콜백을 연결한다 */
export interface SpareHandle {
  spare: SpareProcess
  bind(cb: SessionCallbacks): void
}

/** 쓰지 않고 이만큼 지나면 끝낸다 (주차 중에도 230~260MB를 잡는다) */
const IDLE_MS = 10 * 60_000

interface Entry {
  spare: SpareProcess
  target: { cb: SessionCallbacks | null }
  timer: ReturnType<typeof setTimeout>
}

/**
 * 새 대화의 첫 메시지가 바로 가도록 CLI 프로세스를 미리 띄워 둔다 (SDK prewarm, 알파 API).
 * 홈·빈 대화에 글을 치기 시작하면 ensure(), 세션이 시작할 때 take()로 가져가 claim한다.
 * 한 번에 하나만 두고, claim이 거절되면(프로젝트 설정의 model·env 등) 세션이 query()로 다시 띄운다
 */
export class SpareKeeper {
  private current: Entry | null = null
  private starting = false

  constructor(private readonly options: (cb: SessionCallbacks) => Options) {}

  /** 없으면 하나 띄운다. 띄우는 중이거나 이미 있으면 아무것도 안 함 */
  ensure(): void {
    if (this.current || this.starting) return
    this.starting = true
    const target: Entry['target'] = { cb: null }
    // 콜백은 prewarm 때 고정되므로, 가져간 세션으로 넘겨 주는 대리 콜백을 등록한다
    const delegate: SessionCallbacks = {
      canUseTool: (name, input, opts) => (target.cb ? target.cb.canUseTool(name, input, opts) : Promise.resolve({ behavior: 'deny', message: '세션이 아직 연결되지 않았어요' })),
      onElicitation: (req, opts) => (target.cb ? target.cb.onElicitation(req, opts) : Promise.resolve({ action: 'cancel' })),
      onUserDialog: (req, opts) => (target.cb ? target.cb.onUserDialog(req, opts) : Promise.resolve({ behavior: 'cancelled' })),
    }
    prewarm({ options: this.options(delegate) })
      .then(
        (spare) => {
          const entry: Entry = { spare, target, timer: setTimeout(() => this.drop(entry), IDLE_MS) }
          this.current = entry
          // 주차 중에 죽으면 비워 둔다 (다음 ensure가 새로 띄운다)
          void spare.exited.then(() => {
            if (this.current !== entry) return
            clearTimeout(entry.timer)
            this.current = null
          })
        },
        (err) => console.warn('CLI를 미리 띄우지 못함', err instanceof Error ? err.message : err),
      )
      .finally(() => {
        this.starting = false
      })
  }

  /** 주차된 스페어가 있는지 (테스트·진단용) */
  has(): boolean {
    return this.current !== null
  }

  /** 띄워 둔 것이 있으면 가져간다 (이후 keeper는 잊는다). 없으면 null */
  take(): SpareHandle | null {
    const entry = this.current
    if (!entry) return null
    clearTimeout(entry.timer)
    this.current = null
    return {
      spare: entry.spare,
      bind: (cb) => {
        entry.target.cb = cb
      },
    }
  }

  private drop(entry: Entry): void {
    if (this.current !== entry) return
    this.current = null
    entry.spare.close()
  }

  dispose(): void {
    if (!this.current) return
    clearTimeout(this.current.timer)
    this.current.spare.close()
    this.current = null
  }
}
