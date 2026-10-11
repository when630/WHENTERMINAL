import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentProgress, SubItem, TaskOutput } from '@shared/types'
import { agentInfo, describeBackground, isAgentTool, relPath, subActivity, summarizeInput, type ConversationState, type ToolItem } from './state'
import { clock, useNow } from './time'
import { Markdown } from './Markdown'

/** 오른쪽 패널에서 고른 것: 백그라운드 작업(셸·모니터·백그라운드 에이전트) 또는 앞에서 도는 하위 에이전트 */
export type DetailTarget = { kind: 'task'; taskId: string } | { kind: 'agent'; toolUseId: string }

interface Props {
  target: DetailTarget
  state: ConversationState
  projectId: string
  conversationId: string
  root: string
  onClose: () => void
  onStopTask: (taskId: string) => Promise<void>
  /** 대화로 돌아가기·멈춤 단축키 (버튼에 표시) */
}

/** 백그라운드 작업·하위 에이전트의 세부 내용. 대화 기록 자리에 대신 펼친다 (작업 공간 CHANGES처럼) */
export function TaskDetail({ target, state, projectId, conversationId, root, onClose, onStopTask }: Props): React.JSX.Element {
  const now = useNow(1000)
  const background = state.background ?? []
  const task = target.kind === 'task' ? background.find((b) => b.id === target.taskId) : undefined
  // 작업이 끝나 목록에서 빠져도 마지막으로 본 모습으로 계속 보여 준다 (대상이 바뀌면 Chat이 key로 새로 붙인다)
  const last = useRef<{ label: string; text: string; command: string; startedAt: number; toolUseId?: string } | null>(null)
  if (task) last.current = { ...describeBackground(task, state.items), startedAt: task.startedAt, toolUseId: task.toolUseId }

  const [stopping, setStopping] = useState(false)

  // 에이전트: 앞에서 도는 Agent 도구 호출, 또는 백그라운드로 띄운 에이전트 작업의 도구 호출
  const agentToolUseId = target.kind === 'agent' ? target.toolUseId : last.current?.label === 'AGENT' ? last.current.toolUseId : undefined
  const agentItem = agentToolUseId ? (state.items.findLast((i) => i.type === 'tool' && i.toolUseId === agentToolUseId) as ToolItem | undefined) : undefined

  if (agentToolUseId) {
    const live = target.kind === 'task' ? !!task : agentItem?.result === undefined
    return (
      <AgentDetail
        toolUseId={agentToolUseId}
        item={agentItem}
        subs={state.subs ?? {}}
        progress={state.progress?.[agentToolUseId]}
        live={live}
        background={target.kind === 'task'}
        startedAt={last.current?.startedAt ?? agentItem?.at}
        now={now}
        root={root}
        onClose={onClose}
        onStop={task ? () => { setStopping(true); void onStopTask(task.id).finally(() => setStopping(false)) } : undefined}
        stopping={stopping}
      />
    )
  }

  const info = last.current
  const taskId = target.kind === 'task' ? target.taskId : ''
  return (
    <section className="wt-panel td" aria-label="백그라운드 작업 세부 내용">
      <header className="wt-head">
        <div className="wt-title">
          <span className="kr">{info?.label ?? 'TASK'}</span>
          <span className={`td-state ${task ? 'live' : ''}`}>{task ? 'RUNNING' : 'ENDED'}</span>
          {info && <span className="mono">{clock(now - info.startedAt)}</span>}
        </div>
        <div className="wt-actions">
          {task && (
            <button type="button" className="btn" disabled={stopping} onClick={() => { setStopping(true); void onStopTask(task.id).finally(() => setStopping(false)) }} title="이 작업만 멈춰요">
              {stopping ? 'STOPPING…' : 'STOP'}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>BACK TO CHAT</button>
        </div>
      </header>
      {info && (
        <div className="td-meta">
          {info.text !== info.command && <div className="td-desc">{info.text}</div>}
          {info.command && <code className="td-cmd">{relPath(info.command, root)}</code>}
        </div>
      )}
      <OutputLog projectId={projectId} conversationId={conversationId} taskId={taskId} live={!!task} />
    </section>
  )
}

/** 셸·모니터의 출력 파일 끝부분. 도는 동안 1초마다 다시 읽고, 맨 아래를 보고 있으면 따라 내려간다 */
function OutputLog({ projectId, conversationId, taskId, live }: { projectId: string; conversationId: string; taskId: string; live: boolean }): React.JSX.Element {
  const [out, setOut] = useState<TaskOutput | null | undefined>(undefined)
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.taskOutput(projectId, conversationId, taskId).then((o) => {
        if (alive) setOut((prev) => (prev && o && prev.path === o.path && prev.size === o.size ? prev : o))
      })
    }
    load()
    // 끝난 뒤에도 한 번 더 읽어 마지막 줄까지 보인다
    if (!live) return () => void (alive = false)
    const t = setInterval(load, 1000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [projectId, conversationId, taskId, live])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [out?.text])

  if (out === undefined) return <div className="empty">출력을 읽는 중…</div>
  if (out === null) return <div className="empty">출력 파일을 찾지 못했어요. 아직 아무것도 쓰지 않았거나 세션의 임시 폴더가 지워졌을 수 있어요.</div>
  return (
    <>
      <pre
        ref={ref}
        className="td-log"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {out.truncated && <span className="td-cut">… 앞부분은 잘랐어요 (전체 {Math.round(out.size / 1024)}KB){'\n'}</span>}
        {out.text || <span className="td-cut">(아직 출력이 없어요)</span>}
      </pre>
      <div className="td-foot mono" title={out.path}>{out.path}</div>
    </>
  )
}

interface AgentProps {
  toolUseId: string
  item?: ToolItem
  subs: Record<string, SubItem[]>
  progress?: AgentProgress
  live: boolean
  background: boolean
  startedAt?: number
  now: number
  root: string
  onClose: () => void
  onStop?: () => void
  stopping: boolean
}

function AgentDetail({ toolUseId, item, subs, progress, live, background, startedAt, now, root, onClose, onStop, stopping }: AgentProps): React.JSX.Element {
  const info = agentInfo(item?.input)
  const list = subs[toolUseId] ?? []
  const tools = progress?.tools ?? list.filter((i) => i.type === 'tool').length
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [list.length])
  const ms = progress?.durationMs ?? (startedAt ? now - startedAt : 0)
  return (
    <section className="wt-panel td" aria-label="하위 에이전트 세부 내용">
      <header className="wt-head">
        <div className="wt-title">
          <span className="kr">AGENT</span>
          {info.type && <span className="td-type">{info.type}</span>}
          <span className={`td-state ${live ? 'live' : ''}`}>{live ? (background ? 'BACKGROUND' : 'RUNNING') : item?.isError ? 'ERROR' : 'DONE'}</span>
        </div>
        <div className="wt-actions">
          {onStop && (
            <button type="button" className="btn" disabled={stopping} onClick={onStop} title="이 에이전트만 멈춰요">
              {stopping ? 'STOPPING…' : 'STOP'}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>BACK TO CHAT</button>
        </div>
      </header>
      <div className="td-meta">
        {info.description && <div className="td-desc">{info.description}</div>}
        <dl className="td-stats">
          <div><dt>TOOLS</dt><dd>{tools}</dd></div>
          <div><dt>TIME</dt><dd>{clock(ms)}</dd></div>
          {progress && <div><dt>TOKENS</dt><dd>{progress.tokens >= 1000 ? `${Math.round(progress.tokens / 1000)}K` : progress.tokens}</dd></div>}
          {live && <div className="td-now"><dt>NOW</dt><dd>{subActivity(list, progress)}</dd></div>}
        </dl>
      </div>
      <div
        className="td-body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {info.prompt && (
          <details className="td-prompt">
            <summary>PROMPT</summary>
            <Markdown text={info.prompt} />
          </details>
        )}
        {list.length === 0 ? (
          <div className="empty">{live ? '하위 에이전트가 시작하는 중이에요…' : '이번 실행에서 받은 활동이 없어요. 앱을 다시 켜기 전에 돌았던 에이전트일 수 있어요.'}</div>
        ) : (
          <SubLog list={list} subs={subs} root={root} />
        )}
        {item?.result !== undefined && !background && (
          <div className="td-result">
            <h5>RESULT</h5>
            <Markdown text={item.result} />
          </div>
        )}
      </div>
    </section>
  )
}

/** 하위 에이전트의 활동 목록. 그 안에서 또 띄운 에이전트는 들여 써서 이어 보인다 */
export function SubLog({ list, subs, root, depth = 0 }: { list: SubItem[]; subs: Record<string, SubItem[]>; root: string; depth?: number }): React.JSX.Element {
  return (
    <ol className="sub-log">
      {list.map((i, idx) =>
        i.type === 'text' ? (
          <li key={idx} className="sub-text">
            <Markdown text={i.text} />
          </li>
        ) : (
          <li key={i.toolUseId} className={`sub-tool ${i.isError ? 'error' : ''}`}>
            <details>
              <summary>
                <span className="sub-name">{i.name}</span>
                <span className="sub-arg">{relPath(summarizeInput(i.input), root)}</span>
                <span className={`sub-st ${i.result === undefined ? 'run' : ''}`}>{i.result === undefined ? 'RUNNING' : i.isError ? 'ERROR' : 'DONE'}</span>
              </summary>
              <pre>{JSON.stringify(i.input, null, 2)}</pre>
              {i.result !== undefined && <pre className="sub-out">{i.result || '(no output)'}</pre>}
            </details>
            {isAgentTool(i.name) && subs[i.toolUseId]?.length && depth < 3 ? <SubLog list={subs[i.toolUseId]} subs={subs} root={root} depth={depth + 1} /> : null}
          </li>
        ),
      )}
    </ol>
  )
}
