import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { type PermissionDecision, type Project } from '@shared/types'
import { HOME_ROW } from './keys'
import { boxIn, EASE, Odo, reducedMotion, Roll, useLayoutMotion } from './motion'
import { STAGES, type TaskRef } from './state'
import { elapsed, useNow } from './time'
import { Markdown } from './Markdown'
import { AttachButton, useAttach } from './attach'
import { useDraft } from './drafts'

export interface DispatchOrigin {
  box: { x: number; y: number; w: number; h: number }
  at: number
}

interface Props {
  projects: Project[]
  running: TaskRef[]
  reports: TaskRef[]
  selectedId: string | null
  openReportId: string | null
  dispatchIndex: number
  inputRef: RefObject<HTMLInputElement | null>
  dispatchOrigin: RefObject<DispatchOrigin | null>
  sheetCloseRef: RefObject<(() => void) | null>
  onDispatchIndex: (i: number) => void
  onDispatch: (text: string, continueId?: string) => void
  /** '이어서'로 보낼 대화 (이 프로젝트에서 가장 최근에 쓴 대화). 없으면 새 대화만 */
  continueTarget: { id: string; title: string } | null
  onSelect: (conversationId: string) => void
  onOpenTask: (ref: TaskRef) => void
  onOpenReport: (conversationId: string) => void
  onCloseReport: () => void
  onArchive: (conversationId: string) => void
  onNewTaskFor: (projectIndex: number) => void
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) => void
  onAddProject: () => void
}

export function Home(props: Props): React.JSX.Element {
  const { projects, running, reports, selectedId } = props
  const now = useNow(1000)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutMotion(scrollRef, props.dispatchOrigin)

  const unread = reports.filter((r) => r.task.unread).length
  const waiting = running.filter((r) => r.state.permissions.length > 0).length
  const openReport = reports.find((r) => r.conversationId === props.openReportId) ?? null
  const d = new Date(now)

  return (
    <div className="home-wrap" ref={wrapRef}>
      <div className="home" ref={scrollRef}>
        <header className="home-head">
          <div className="hh-cell hh-run">
            <span className="big disp"><Odo n={running.length} /></span>
            <h1 className="hh-label">TASKS<br />RUNNING</h1>
          </div>
          <div className="hh-cell hh-time">
            <span className="hh-small">
              {d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}
            </span>
            <span className="clipwrap">
              <span className="roll-in mid disp">{String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}</span>
            </span>
          </div>
          {/* 확인할 것이 있으면 이 칸이 빨갛게 바뀐다. 없으면 새 보고 수 */}
          <div className={`hh-cell hh-flag ${waiting > 0 ? 'alert' : ''}`}>
            <span className="hh-label">{waiting > 0 ? 'NEEDS YOU' : 'NEW REPORTS'}</span>
            <span className="mid disp"><Odo n={waiting > 0 ? waiting : unread} /></span>
          </div>
        </header>

        <Dispatch {...props} scrollRef={scrollRef} />

        <div className="cols">
          <section className="col col-run" aria-label="진행 중">
            <h2 className="col-h">
              RUNNING <span className="disp">{running.length}</span>
            </h2>
            {running.length === 0 && <div className="empty">맡긴 작업이 모두 끝났어요. 위에서 새 작업을 맡겨 보세요.</div>}
            {running.map((r) => (
              <TaskCard key={r.conversationId} r={r} now={now} selected={r.conversationId === selectedId} onSelect={props.onSelect} onOpen={props.onOpenTask} onRespond={props.onRespond} />
            ))}
          </section>

          <section className="col col-rep" aria-label="보고함">
            <h2 className="col-h">
              REPORTS <span className="disp">{reports.length}</span>
            </h2>
            {reports.length === 0 && <div className="empty">끝난 작업의 보고서가 여기에 쌓여요.</div>}
            {reports.map((r) => (
              <ReportCard key={r.conversationId} r={r} now={now} selected={r.conversationId === selectedId} hidden={r.conversationId === props.openReportId} onOpen={props.onOpenReport} />
            ))}
          </section>
        </div>

      </div>

      {openReport && (
        <ReportSheet
          key={openReport.conversationId}
          r={openReport}
          wrapRef={wrapRef}
          scrollRef={scrollRef}
          closeRef={props.sheetCloseRef}
          onClosed={props.onCloseReport}
          onOpenChat={() => props.onOpenTask(openReport)}
          onNewTask={() => props.onNewTaskFor(openReport.projectIndex)}
          onArchive={() => props.onArchive(openReport.conversationId)}
        />
      )}
    </div>
  )
}

function Dispatch(props: Props & { scrollRef: RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const p = props.projects[props.dispatchIndex]
  // 쓰던 작업 지시는 프로젝트마다 남는다
  const [text, setText] = useDraft(`home:${p?.id ?? ''}`)
  const target = props.continueTarget
  const altEnter = useRef(false)
  const attach = useAttach({ inputRef: props.inputRef, setValue: setText, scope: `home:${p?.id ?? ''}`, root: p?.path ?? '' })
  if (props.projects.length === 0) {
    return (
      <div className="ask ask-empty">
        <span>먼저 작업할 프로젝트 폴더를 추가해 주세요.</span>
        <button type="button" className="btn-pri" onClick={props.onAddProject}>
          ADD PROJECT
        </button>
      </div>
    )
  }
  const cycle = (dir: number): void => props.onDispatchIndex((props.dispatchIndex + dir + props.projects.length) % props.projects.length)
  return (
    <form
      className={`ask ${attach.dropping ? 'dropping' : ''}`}
      {...attach.dropProps}
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault()
        // Alt+Enter는 전환 상태와 상관없이 '이어서'. 표시는 이번 제출에서만 쓰고 바로 지운다
        const viaAlt = altEnter.current
        altEnter.current = false
        const t = text.trim()
        if (!t) return
        const asContinue = viaAlt && target
        const input = props.inputRef.current
        const root = props.scrollRef.current
        if (input && root && !asContinue) props.dispatchOrigin.current = { box: boxIn(input.closest('.ask')!, root), at: performance.now() }
        setText('')
        props.onDispatch(t, asContinue ? target.id : undefined)
      }}
    >
      <div className="ask-row">
        <span className="ask-prompt" aria-hidden="true">&gt;</span>
        <AttachButton onClick={attach.pick} />
        <label htmlFor="ask-input" className="sr-only">맡길 작업</label>
        <input
          id="ask-input"
          ref={props.inputRef}
          value={text}
          placeholder="무엇을 맡길까요?"
          onChange={(e) => setText(e.target.value)}
          onPaste={attach.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault()
              cycle(e.shiftKey ? -1 : 1)
            }
            // Alt+Enter: 입력창은 Alt+Enter로 폼을 제출하지 않으므로(macOS) 직접 제출한다
            if (e.key === 'Enter' && e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              altEnter.current = true
              e.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <button type="submit" className="btn-pri" disabled={!text.trim()}>
          SEND
        </button>
      </div>
      <div className="ask-meta">
        <button type="button" className="proj" onClick={() => cycle(1)}>
          <kbd>{HOME_ROW[props.dispatchIndex] ?? ''}</kbd>
          <Roll text={p?.name ?? ''} className="proj-name" />
        </button>
      </div>
    </form>
  )
}

function TaskCard({ r, now, selected, onSelect, onOpen, onRespond }: {
  r: TaskRef
  now: number
  selected: boolean
  onSelect: (id: string) => void
  onOpen: (r: TaskRef) => void
  onRespond: Props['onRespond']
}): React.JSX.Element {
  const { task, state } = r
  const pending = state.permissions[0]
  const stage = Math.min(task.stage, STAGES.length - 1)
  const progress = Math.min(1, (stage + 0.6) / STAGES.length)
  const respond = (e: React.MouseEvent, decision: PermissionDecision): void => {
    e.stopPropagation()
    if (pending) onRespond(r.project.id, r.conversationId, pending.requestId, decision)
  }
  return (
    <article
      className={`task ${selected ? 'selected' : ''} ${pending ? 'waiting' : ''}`}
      data-layout-id={r.conversationId}
      data-layout-kind="task"
      onClick={() => onSelect(r.conversationId)}
      onDoubleClick={() => onOpen(r)}
    >
      <div className="lx-in">
        <div className="band-row">
          <span className="band-key" aria-hidden="true">{HOME_ROW[r.projectIndex] ?? ''}</span>
          <div className="band-main">
            <div className="band-meta">
              <span>{r.project.name}</span>
              <span className="mono">{mmss(now - task.startedAt)}</span>
              {state.context && <span className="mono">CONTEXT {state.context.percent}%</span>}
            </div>
            <div className="band-title" title={task.instruction}>{task.instruction}</div>
            <div className="act">
              <Roll text={pending ? 'WAITING FOR YOU' : task.activity} className="act-text" />
            </div>
          </div>
          <div className="band-side" aria-label={`진행 단계: ${STAGES[stage]}`}>
            {pending ? <span className="q" aria-hidden="true">?</span> : <span className="stage-word"><Roll text={state.status === 'queued' ? 'QUEUED' : STAGES[stage]} /></span>}
          </div>
        </div>
        <div className={`cf ${pending ? 'open' : ''}`}>
          <div>
            {pending && (
              <div className="cf-in">
                <span className="cf-cmd mono">{pending.title ?? `${pending.toolName} ${summarizeInput(pending.input)}`}</span>
                <button type="button" className="btn-pri sm" onClick={(e) => respond(e, 'allow')}>
                  ALLOW
                </button>
                {!pending.suppressAlwaysAllow && (
                  <button type="button" className="btn sm" onClick={(e) => respond(e, 'always')}>
                    ALWAYS
                  </button>
                )}
                <button type="button" className="btn sm" onClick={(e) => respond(e, 'deny')}>
                  DENY
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="band-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </article>
  )
}

const RESULT_LABEL: Record<string, string> = { done: 'DONE', error: 'ERROR', stopped: 'STOPPED' }

function ReportCard({ r, now, selected, hidden, onOpen }: {
  r: TaskRef
  now: number
  selected: boolean
  hidden: boolean
  onOpen: (id: string) => void
}): React.JSX.Element {
  const { task, state } = r
  return (
    <button
      type="button"
      className={`rep ${task.unread ? 'unread' : ''} ${selected ? 'selected' : ''}`}
      style={hidden ? { visibility: 'hidden' } : undefined}
      data-layout-id={r.conversationId}
      data-layout-kind="report"
      onClick={() => onOpen(r.conversationId)}
    >
      <span className="lx-in">
        <span className="rep-h">
          <span className="nd" />
          <span className="rep-key">{HOME_ROW[r.projectIndex] ?? ''}</span>
          {r.project.name}
          <span className="rep-ago mono">{task.finishedAt ? elapsed(task.finishedAt, now) : ''}</span>
        </span>
        <span className="rep-tt">{task.instruction}</span>
        {task.summary && <span className="rep-sum">{plain(task.summary)}</span>}
        <span className="chips">
          <span className={`chip ${state.status === 'done' ? 'ok' : 'bad'}`}>{RESULT_LABEL[state.status] ?? state.status}</span>
          {task.files.length > 0 && <span className="chip">FILES {task.files.length}</span>}
          <span className="chip">TOOLS {task.tools}</span>
          {task.durationMs !== undefined && <span className="chip">{mmss(task.durationMs)}</span>}
        </span>
      </span>
    </button>
  )
}

function ReportSheet({ r, wrapRef, scrollRef, closeRef, onClosed, onOpenChat, onNewTask, onArchive }: {
  r: TaskRef
  wrapRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  closeRef: RefObject<(() => void) | null>
  onClosed: () => void
  onOpenChat: () => void
  onNewTask: () => void
  onArchive: () => void
}): React.JSX.Element {
  const sheetRef = useRef<HTMLElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const { task, state } = r

  // 보고서 카드 자리 ↔ 상세 화면 사이를 변형하며 열고 닫는다
  const fromBox = (): { dx: number; dy: number; sx: number; sy: number } | null => {
    const wrap = wrapRef.current
    const sheet = sheetRef.current
    const card = scrollRef.current?.querySelector(`[data-layout-id="${r.conversationId}"][data-layout-kind="report"]`)
    if (!wrap || !sheet || !card) return null
    const c = boxIn(card, wrap)
    const s = boxIn(sheet, wrap)
    return { dx: c.x - s.x, dy: c.y - s.y, sx: c.w / s.w, sy: c.h / s.h }
  }
  useLayoutEffect(() => {
    const reduced = reducedMotion()
    if (!reduced) scrimRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' })
    const f = fromBox()
    if (!f || reduced) return
    bgRef.current?.animate(
      [{ transform: `translate(${f.dx}px, ${f.dy}px) scale(${f.sx}, ${f.sy})` }, { transform: 'none' }],
      { duration: 560, easing: EASE },
    )
    inRef.current?.querySelectorAll('.st').forEach((el, i) => {
      el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 200 + i * 55, easing: EASE, fill: 'backwards' })
    })
  }, [])

  const closing = useRef(false)
  const close = (): void => {
    // Esc와 클릭이 겹쳐도 한 번만 닫는다
    if (closing.current) return
    closing.current = true
    const f = fromBox()
    if (!f || reducedMotion()) return onClosed()
    scrimRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' })
    inRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' })
    const a = bgRef.current?.animate(
      [{ transform: 'none' }, { transform: `translate(${f.dx}px, ${f.dy}px) scale(${f.sx}, ${f.sy})` }],
      { duration: 420, easing: EASE, fill: 'forwards' },
    )
    if (a) a.onfinish = onClosed
    else onClosed()
  }
  closeRef.current = close

  return (
    <>
      <div className="scrim" ref={scrimRef} onClick={close} />
      <section className="sheet" ref={sheetRef} aria-label="보고서">
        <div className="sheet-bg" ref={bgRef} />
        <div className="sheet-in" ref={inRef}>
          <div className="sh-top st">
            <kbd>{HOME_ROW[r.projectIndex] ?? ''}</kbd>
            {r.project.name} · REPORT
            <span className="mono">
              {task.finishedAt ? new Date(task.finishedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}
              {task.durationMs !== undefined ? ` · ${mmss(task.durationMs)}` : ''}
            </span>
            <button type="button" className="btn ghost sm sh-x" onClick={close}>CLOSE</button>
          </div>
          <h3 className="st">{task.instruction}</h3>
          <div className="sh-sum st">{task.summary ? <Markdown text={task.summary} /> : state.status === 'done' ? '보고 내용이 없어요.' : '끝내지 못하고 멈췄어요. 대화에서 이유를 볼 수 있어요.'}</div>
          <div className="sh-grid st">
            <div className="sh-box">
              <h4>FILES CHANGED {task.files.length}</h4>
              {task.files.length === 0 && <div className="muted">바꾼 파일이 없어요.</div>}
              {task.files.map((f) => (
                <div key={f} className="fl mono" title={f}>{relPath(f, r.project.path)}</div>
              ))}
            </div>
            <div className="sh-box">
              <h4>LOG</h4>
              <div className="kv"><span>RESULT</span><b>{RESULT_LABEL[state.status] ?? state.status}</b></div>
              <div className="kv"><span>TOOLS</span><b className="mono">{task.tools}</b></div>
              {task.costUsd !== undefined && <div className="kv"><span>EST. COST</span><b className="mono">${task.costUsd.toFixed(2)}</b></div>}
              <div className="kv"><span>CHAT</span><b>{r.title}</b></div>
            </div>
          </div>
          <div className="nexts st">
            <button type="button" className="btn-pri" onClick={onOpenChat}>OPEN CHAT</button>
            <button type="button" className="btn" onClick={onNewTask}>FOLLOW-UP</button>
            <button type="button" className="btn ghost" onClick={onArchive}>ARCHIVE</button>
          </div>
        </div>
      </section>
    </>
  )
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

function plain(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim()
}

function relPath(file: string, root: string): string {
  const f = file.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : f
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url
  return typeof v === 'string' ? v.split('\n')[0].slice(0, 120) : ''
}
