import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { type PermissionDecision, type Project } from '@shared/types'
import { HOME_ROW } from './keys'
import { boxIn, EASE, Odo, reducedMotion, Roll, useLayoutMotion } from './motion'
import { STAGES, type TaskRef } from './state'
import { elapsed, useNow } from './time'

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
  hotkey: string | null
  inputRef: RefObject<HTMLInputElement | null>
  dispatchOrigin: RefObject<DispatchOrigin | null>
  sheetCloseRef: RefObject<(() => void) | null>
  onDispatchIndex: (i: number) => void
  onDispatch: (text: string) => void
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
            <h1 className="hh-label">작업<br />진행 중</h1>
          </div>
          <div className="hh-cell hh-time">
            <span className="hh-small">
              {d.getMonth() + 1}월 {d.getDate()}일 {'일월화수목금토'[d.getDay()]}요일
            </span>
            <span className="clipwrap">
              <span className="roll-in mid disp">{String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}</span>
            </span>
          </div>
          {/* 확인할 것이 있으면 이 칸이 빨갛게 바뀐다. 없으면 새 보고 수 */}
          <div className={`hh-cell hh-flag ${waiting > 0 ? 'alert' : ''}`}>
            <span className="hh-label">{waiting > 0 ? '확인 필요' : '새 보고'}</span>
            <span className="mid disp"><Odo n={waiting > 0 ? waiting : unread} /></span>
          </div>
        </header>

        <Dispatch {...props} scrollRef={scrollRef} />

        <div className="cols">
          <section className="col col-run" aria-label="진행 중">
            <h2 className="col-h">
              진행 중 <span className="disp">{running.length}</span>
            </h2>
            {running.length === 0 && <div className="empty">맡긴 작업이 모두 끝났어요. 위에서 새 작업을 맡겨 보세요.</div>}
            {running.map((r) => (
              <TaskCard key={r.conversationId} r={r} now={now} selected={r.conversationId === selectedId} onSelect={props.onSelect} onOpen={props.onOpenTask} onRespond={props.onRespond} />
            ))}
          </section>

          <section className="col col-rep" aria-label="보고함">
            <h2 className="col-h">
              보고함 <span className="disp">{reports.length}</span>
            </h2>
            {reports.length === 0 && <div className="empty">끝난 작업의 보고서가 여기에 쌓입니다.</div>}
            {reports.map((r) => (
              <ReportCard key={r.conversationId} r={r} now={now} selected={r.conversationId === selectedId} hidden={r.conversationId === props.openReportId} onOpen={props.onOpenReport} />
            ))}
          </section>
        </div>

        <footer className="hints">
          <span><kbd>Ctrl K</kbd>/<kbd>I</kbd> 작업 지시</span>
          <span><kbd>J</kbd><kbd>K</kbd> 위아래</span>
          <span><kbd>H</kbd><kbd>L</kbd> 진행 중 · 보고함</span>
          <span><kbd>O</kbd> 열기</span>
          <span><kbd>E</kbd> 보관</span>
          <span><kbd>Y</kbd><kbd>A</kbd><kbd>N</kbd> 확인 요청</span>
          {props.hotkey && <span className="hints-r"><kbd>{props.hotkey}</kbd> 어디서든 호출</span>}
        </footer>
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
  const [text, setText] = useState('')
  const p = props.projects[props.dispatchIndex]
  if (props.projects.length === 0) {
    return (
      <div className="ask ask-empty">
        <span>먼저 작업할 프로젝트 폴더를 추가하세요.</span>
        <button type="button" className="btn-pri" onClick={props.onAddProject}>
          프로젝트 추가 <kbd>Ctrl N</kbd>
        </button>
      </div>
    )
  }
  const cycle = (dir: number): void => props.onDispatchIndex((props.dispatchIndex + dir + props.projects.length) % props.projects.length)
  return (
    <form
      className="ask"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t) return
        const input = props.inputRef.current
        const root = props.scrollRef.current
        if (input && root) props.dispatchOrigin.current = { box: boxIn(input.closest('.ask')!, root), at: performance.now() }
        setText('')
        props.onDispatch(t)
      }}
    >
      <div className="ask-row">
        <span className="ask-prompt" aria-hidden="true">&gt;</span>
        <label htmlFor="ask-input" className="sr-only">맡길 작업</label>
        <input
          id="ask-input"
          ref={props.inputRef}
          value={text}
          placeholder="무엇을 맡길까요?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault()
              cycle(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <button type="submit" className="btn-pri" disabled={!text.trim()}>
          맡기기 <kbd>Enter</kbd>
        </button>
      </div>
      <div className="ask-meta">
        <button type="button" className="proj" onClick={() => cycle(1)}>
          <kbd>{HOME_ROW[props.dispatchIndex] ?? ''}</kbd>
          <Roll text={p?.name ?? ''} className="proj-name" />
        </button>
        <span><kbd>Tab</kbd> 프로젝트 바꾸기</span>
        <span>끝나면 보고함으로 보고서가 옵니다</span>
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
              {state.context && <span className="mono">컨텍스트 {state.context.percent}%</span>}
            </div>
            <div className="band-title" title={task.instruction}>{task.instruction}</div>
            <div className="act">
              <Roll text={pending ? '확인을 기다리는 중' : task.activity} className="act-text" />
              <button type="button" className="link" onClick={(e) => { e.stopPropagation(); onOpen(r) }}>대화 보기 <kbd>O</kbd></button>
            </div>
          </div>
          <div className="band-side" aria-label={`진행 단계: ${STAGES[stage]}`}>
            {pending ? <span className="q" aria-hidden="true">?</span> : <span className="stage-word"><Roll text={STAGES[stage]} /></span>}
          </div>
        </div>
        <div className={`cf ${pending ? 'open' : ''}`}>
          <div>
            {pending && (
              <div className="cf-in">
                <span className="cf-cmd mono">{pending.title ?? `${pending.toolName} ${summarizeInput(pending.input)}`}</span>
                <button type="button" className="btn-pri sm" onClick={(e) => respond(e, 'allow')}>
                  허용 {!pending.defaultToNo && <kbd>Y</kbd>}
                </button>
                {!pending.suppressAlwaysAllow && (
                  <button type="button" className="btn sm" onClick={(e) => respond(e, 'always')}>
                    항상 {!pending.defaultToNo && <kbd>A</kbd>}
                  </button>
                )}
                <button type="button" className="btn sm" onClick={(e) => respond(e, 'deny')}>
                  거절 <kbd>N</kbd>
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

const RESULT_LABEL: Record<string, string> = { done: '완료', error: '오류', stopped: '중단' }

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
          {task.files.length > 0 && <span className="chip">파일 {task.files.length}</span>}
          <span className="chip">도구 {task.tools}</span>
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
    scrimRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' })
    const f = fromBox()
    if (!f || reducedMotion()) return
    bgRef.current?.animate(
      [{ transform: `translate(${f.dx}px, ${f.dy}px) scale(${f.sx}, ${f.sy})` }, { transform: 'none' }],
      { duration: 560, easing: EASE },
    )
    inRef.current?.querySelectorAll('.st').forEach((el, i) => {
      el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 200 + i * 55, easing: EASE, fill: 'backwards' })
    })
  }, [])

  const close = (): void => {
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
            {r.project.name} · 보고서
            <span className="mono">
              {task.finishedAt ? new Date(task.finishedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''}
              {task.durationMs !== undefined ? ` · ${mmss(task.durationMs)} 소요` : ''}
            </span>
            <button type="button" className="btn ghost sm sh-x" onClick={close}>닫기 <kbd>Esc</kbd></button>
          </div>
          <h3 className="st">{task.instruction}</h3>
          <div className="sh-sum st">{task.summary ?? (state.status === 'done' ? '보고 내용이 없습니다.' : '작업이 끝나기 전에 멈췄습니다. 대화에서 자세한 내용을 확인하세요.')}</div>
          <div className="sh-grid st">
            <div className="sh-box">
              <h4>변경한 파일 {task.files.length}</h4>
              {task.files.length === 0 && <div className="muted">파일을 바꾸지 않았습니다.</div>}
              {task.files.map((f) => (
                <div key={f} className="fl mono" title={f}>{relPath(f, r.project.path)}</div>
              ))}
            </div>
            <div className="sh-box">
              <h4>작업 기록</h4>
              <div className="kv"><span>결과</span><b>{RESULT_LABEL[state.status] ?? state.status}</b></div>
              <div className="kv"><span>도구 호출</span><b className="mono">{task.tools}회</b></div>
              {task.costUsd !== undefined && <div className="kv"><span>추정 비용</span><b className="mono">${task.costUsd.toFixed(2)}</b></div>}
              <div className="kv"><span>대화</span><b>{r.title}</b></div>
            </div>
          </div>
          <div className="nexts st">
            <button type="button" className="btn-pri" onClick={onOpenChat}>대화 열기 <kbd>O</kbd></button>
            <button type="button" className="btn" onClick={onNewTask}>이 프로젝트에 새 작업 <kbd>I</kbd></button>
            <button type="button" className="btn ghost" onClick={onArchive}>보관 <kbd>E</kbd></button>
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
