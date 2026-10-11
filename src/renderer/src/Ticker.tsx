import { useEffect, useRef } from 'react'
import { HOME_ROW } from './keys'
import { reducedMotion } from './motion'
import { STAGES, type BackgroundRef, type TaskRef } from './state'

interface Props {
  running: TaskRef[]
  reports: TaskRef[]
  /** 턴이 끝나도 도는 셸·모니터 등 */
  background: BackgroundRef[]
}

/** 맨 위 전광판: 모든 프로젝트의 지금 상태가 한 줄로 흐른다. 확인이 필요한 항목만 빨갛게 */
/** 초당 이동 거리(px). 길이가 달라도 읽는 속도가 같게 */
const SPEED = 46

export function Ticker({ running, reports, background }: Props): React.JSX.Element {
  const runRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = runRef.current
    const box = el?.parentElement
    if (!el || !box) return
    // 한 벌이 창 너비보다 짧으면 다음 벌이 화면 가운데서 튀어나오므로, 한 벌의 최소 너비를 창 너비로 맞춘다
    const fit = (): void => el.style.setProperty('--ticker-w', `${box.getBoundingClientRect().width}px`)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    // 처음에는 오른쪽 끝 바깥에서 들어온다
    let offset = -box.clientWidth
    let last = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      // 프레임이 드물게 와도(부하·절전) 속도는 그대로. 창이 숨었다 돌아올 때는 visibilitychange에서 last를 다시 잡는다
      const dt = Math.min(now - last, 250) / 1000
      last = now
      const half = el.scrollWidth / 2
      if (half > 0) {
        offset += SPEED * dt
        if (offset >= half) offset %= half
        el.style.transform = `translate3d(${-offset}px, 0, 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    const start = (): void => {
      cancelAnimationFrame(raf)
      if (reducedMotion()) {
        el.style.transform = ''
        return
      }
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
    const onVisible = (): void => {
      if (!document.hidden) start()
    }
    // 앱이 떠 있는 동안 OS의 애니메이션 효과 설정이 바뀌어도 따라간다
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    start()
    document.addEventListener('visibilitychange', onVisible)
    mq.addEventListener('change', start)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      mq.removeEventListener('change', start)
    }
  }, [])
  const unread = reports.filter((r) => r.task.unread).length
  const parts: { text: string; alert?: boolean }[] = running.map((r) => {
    const name = `■ ${HOME_ROW[r.projectIndex] ?? ''} ${r.project.name.toUpperCase()}`
    if (r.state.permissions.length > 0) return { text: `${name}  NEEDS YOU`, alert: true }
    if (r.state.status === 'queued') return { text: `${name}  QUEUED` }
    return { text: `${name}  ${STAGES[Math.min(r.task.stage, STAGES.length - 1)]} · ${r.task.activity}` }
  })
  for (const b of background) {
    parts.push({ text: `■ ${HOME_ROW[b.projectIndex] ?? ''} ${b.project.name.toUpperCase()}  ${b.label}${b.text ? ` · ${b.text}` : ''}` })
  }
  if (running.length === 0 && background.length === 0) parts.push({ text: '■ NO RUNNING TASKS' })
  if (unread > 0) parts.push({ text: `■ ${unread} NEW REPORT${unread > 1 ? 'S' : ''}` })

  const line = parts.map((p, i) => {
    const body = (
      <>
        {p.text}
        {'     '}
      </>
    )
    return p.alert ? <b key={i}>{body}</b> : <span key={i}>{body}</span>
  })
  return (
    <div className="ticker" role="status" aria-label={parts.map((p) => p.text).join(', ')}>
      <div className="ticker-run" ref={runRef} aria-hidden="true">
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  )
}
