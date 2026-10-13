import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ALWAYS_SCOPE_LABEL, ALWAYS_SCOPE_TIP, ELICITATION_TOOL, needsChoice, type PermissionDecision, type PermissionRequest, type Project } from '@shared/types'
import { refocusAfterClick, useRefocus } from './focus'
import { HOME_ROW } from './keys'
import { boxIn, EASE, Odo, Presence, PresenceList, reducedMotion, Roll, useLayoutMotion, usePresenceList } from './motion'
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
  /** 보고서의 TOOLS: 대화를 열면서 도구 목록을 펼친다 */
  onOpenTools: (ref: TaskRef) => void
  onOpenReport: (conversationId: string) => void
  onCloseReport: () => void
  onArchive: (conversationId: string) => void
  onNewTaskFor: (projectIndex: number) => void
  onRespond: (projectId: string, conversationId: string, requestId: string, decision: PermissionDecision) => void
  onAddProject: () => void
  /** 카드에 붙은 세션 태그들과 지금 거르는 태그 (/tag) */
  tags: string[]
  tag: string | null
  onTag: (tag: string | null) => void
  /** AWAY에서 거절한 호출을 모두 승인하고 이어서 하게 한다 */
  onApproveDenied: (ref: TaskRef) => void
}

export function Home(props: Props): React.JSX.Element {
  const { projects, running, reports, selectedId } = props
  const now = useNow(1000)
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutMotion(scrollRef, props.dispatchOrigin)

  const unread = reports.filter((r) => r.task.unread).length
  const waiting = running.filter((r) => r.state.permissions.length > 0).length
  // 카드가 빠질 때 잠시 남아 나간다. 진행 띠가 보고서로(또는 그 반대로) 바뀌는 건 같은 layout id의 변형이라 붙잡지 않는다
  const runningRows = usePresenceList(running, (r) => r.conversationId).filter((x) => !x.leaving || !reports.some((r) => r.conversationId === x.key))
  const reportRows = usePresenceList(reports, (r) => r.conversationId).filter((x) => !x.leaving || !running.some((r) => r.conversationId === x.key))
  const openReport = reports.find((r) => r.conversationId === props.openReportId) ?? null
  // 포커스는 늘 작업 지시창으로: 홈에 오면, 보고서를 닫으면, 덮개를 닫으면 (focus.ts). 카드를 키로 고르려면 Esc로 빠져나온다
  const focusAsk = useCallback((): void => {
    const el = props.inputRef.current
    if (el && document.activeElement !== el && !document.activeElement?.closest('[data-keys-own]')) el.focus({ preventScroll: true })
  }, [props.inputRef])
  useRefocus(focusAsk)
  // 보고서 상세가 열려 있는 동안은 O·E·I 한 키가 먹도록 입력칸을 비워 둔다
  useEffect(() => {
    if (!openReport) requestAnimationFrame(focusAsk)
    else props.inputRef.current?.blur()
  }, [!!openReport, focusAsk]) // eslint-disable-line react-hooks/exhaustive-deps
  const d = new Date(now)

  return (
    <div className="home-wrap" ref={wrapRef} onClick={(e) => refocusAfterClick(e, () => (wrapRef.current?.querySelector('.sheet') ? null : props.inputRef.current))}>
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

        <Presence as="div" show={props.tags.length > 0} className="tagbar" role="radiogroup" aria-label="태그로 거르기">
          <span className="tagbar-k">TAGS</span>
          <button type="button" role="radio" aria-checked={!props.tag} className={!props.tag ? 'on' : ''} onClick={() => props.onTag(null)}>ALL</button>
          <PresenceList items={props.tags} keyOf={(t) => t} as="span" className="tagbar-tags">
            {(t, leaving) => (
              <button type="button" role="radio" aria-checked={props.tag === t} className={`${props.tag === t ? 'on' : ''} ${leaving ? 'leaving' : ''}`} onClick={() => props.onTag(props.tag === t ? null : t)}>
                #{t}
              </button>
            )}
          </PresenceList>
        </Presence>

        <div className="cols">
          <section className="col col-run" aria-label="진행 중">
            <h2 className="col-h">
              RUNNING <span className="disp">{running.length}</span>
            </h2>
            <Presence as="div" show={runningRows.length === 0} className="empty">맡긴 작업이 모두 끝났어요. 위에서 새 작업을 맡겨 보세요.</Presence>
            {runningRows.map(({ item: r, leaving }) => (
              <TaskCard key={r.conversationId} r={r} now={now} selected={r.conversationId === selectedId} leaving={leaving} onSelect={props.onSelect} onOpen={props.onOpenTask} onRespond={props.onRespond} />
            ))}
          </section>

          <section className="col col-rep" aria-label="보고함">
            <h2 className="col-h">
              REPORTS <span className="disp">{reports.length}</span>
            </h2>
            <Presence as="div" show={reportRows.length === 0} className="empty">끝난 작업의 보고서가 여기에 쌓여요.</Presence>
            {reportRows.map(({ item: r, leaving }) => (
              <ReportCard key={r.conversationId} r={r} now={now} selected={r.conversationId === selectedId} hidden={r.conversationId === props.openReportId} leaving={leaving} onOpen={props.onOpenReport} />
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
          onOpenTools={() => props.onOpenTools(openReport)}
          onNewTask={() => props.onNewTaskFor(openReport.projectIndex)}
          onArchive={() => props.onArchive(openReport.conversationId)}
          onApproveDenied={() => props.onApproveDenied(openReport)}
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
          onChange={(e) => {
            // 글을 치기 시작하면 CLI를 미리 띄워 둔다 (작업마다 새 대화라 첫 응답이 기동을 기다리지 않게)
            if (!text && e.target.value) void window.api.prewarm()
            setText(e.target.value)
          }}
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

function TaskCard({ r, now, selected, leaving, onSelect, onOpen, onRespond }: {
  r: TaskRef
  now: number
  selected: boolean
  leaving: boolean
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
      className={`task ${selected ? 'selected' : ''} ${pending ? 'waiting' : ''} ${leaving ? 'leaving' : ''}`}
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
              <Presence show={!!state.goal} className="band-goal" title={state.goal?.condition}>GOAL{(state.goal?.iterations ?? 0) > 0 ? ` · ${state.goal!.iterations}` : ''}</Presence>
              <Presence show={!!r.tag} className="band-tag">#{r.tag}</Presence>
              <Presence show={(task.denied?.length ?? 0) > 0} className="band-denied">AWAY DENIED {task.denied?.length ?? 0}</Presence>
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
            {pending && needsChoice(pending.toolName) && (
              <div className="cf-in">
                <span className="cf-cmd mono">{choiceNote(pending)}</span>
                <button type="button" className="btn-pri sm" onClick={(e) => { e.stopPropagation(); onOpen(r) }}>
                  {pending.toolName === 'ExitPlanMode' ? 'REVIEW PLAN' : 'ANSWER'}
                </button>
              </div>
            )}
            {pending && !needsChoice(pending.toolName) && (
              <div className="cf-in">
                <span className="cf-cmd mono">{pending.title ?? `${pending.toolName} ${summarizeInput(pending.input)}`}</span>
                <button type="button" className="btn-pri sm" onClick={(e) => respond(e, 'allow')}>
                  ALLOW
                </button>
                {!pending.suppressAlwaysAllow && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={(e) => respond(e, 'always')}
                    title={pending.always ? `${pending.always.what} · ${ALWAYS_SCOPE_LABEL[pending.always.scope]} · ${ALWAYS_SCOPE_TIP[pending.always.scope]}` : undefined}
                  >
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

function ReportCard({ r, now, selected, hidden, leaving, onOpen }: {
  r: TaskRef
  now: number
  selected: boolean
  hidden: boolean
  leaving: boolean
  onOpen: (id: string) => void
}): React.JSX.Element {
  const { task, state } = r
  return (
    <button
      type="button"
      className={`rep ${task.unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${leaving ? 'leaving' : ''}`}
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
          {(task.denied?.length ?? 0) > 0 && <span className="chip bad">AWAY DENIED {task.denied!.length}</span>}
          {r.tag && <span className="chip">#{r.tag}</span>}
          {task.files.length > 0 && <span className="chip">FILES {task.files.length}</span>}
          <span className="chip">TOOLS {task.tools}</span>
          {task.durationMs !== undefined && <span className="chip">{mmss(task.durationMs)}</span>}
        </span>
      </span>
    </button>
  )
}

function ReportSheet({ r, wrapRef, scrollRef, closeRef, onClosed, onOpenChat, onOpenTools, onNewTask, onArchive, onApproveDenied }: {
  r: TaskRef
  onOpenTools: () => void
  onApproveDenied: () => void
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
              <div className="kv">
                <span>TOOLS</span>
                <b className="mono">
                  {task.tools}
                  {task.tools > 0 && <button type="button" className="kv-btn" onClick={onOpenTools} title="대화를 열고 부른 도구를 모두 봐요">SHOW</button>}
                </b>
              </div>
              <div className="kv"><span>CHAT</span><b>{r.title}</b></div>
            </div>
          </div>
          {(task.denied?.length ?? 0) > 0 && (
            <div className="sh-denied st">
              <h4>AWAY DENIED {task.denied!.length}</h4>
              <p className="muted">자리를 비운 사이 묻지 않고 거절한 호출이에요. 모두 승인하면 같은 호출은 묻지 않고 실행하고, 멈춘 곳부터 이어서 해요.</p>
              {task.denied!.map((d, i) => (
                <div key={i} className="fl mono" title={JSON.stringify(d.input, null, 2)}>
                  {d.title ?? `${d.toolName} ${summarizeInput(d.input)}`}
                </div>
              ))}
              <button type="button" className="btn-pri" onClick={onApproveDenied}>APPROVE ALL · CONTINUE</button>
            </div>
          )}
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

/** 홈 카드에서 한 키로 답할 수 없는 요청의 안내 (대화창에서 답한다) */
function choiceNote(req: PermissionRequest): string {
  if (req.toolName === 'ExitPlanMode') return '계획을 세웠어요. 대화창에서 승인해요'
  if (req.toolName === ELICITATION_TOOL) return `${req.elicitation?.serverName ?? 'MCP'} 서버가 입력을 기다려요. 대화창에서 답해요`
  if (req.toolName === 'AskUserQuestion') return '물어볼 게 있어요. 대화창에서 답해요'
  return '모델이 답하지 않았어요. 대화창에서 어떻게 할지 골라요'
}
