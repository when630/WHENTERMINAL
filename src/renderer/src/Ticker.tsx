import { useEffect, useRef } from 'react'
import { HOME_ROW } from './keys'
import { reducedMotion } from './motion'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'
import { STAGES, type TaskRef } from './state'

interface Props {
  running: TaskRef[]
  reports: TaskRef[]
  hotkey: string | null
}

/** 맨 위 전광판: 모든 프로젝트의 지금 상태가 한 줄로 흐른다. 확인이 필요한 항목만 빨갛게 */
/** 초당 이동 거리(px). 길이가 달라도 읽는 속도가 같게 */
const SPEED = 46

export function Ticker({ running, reports, hotkey }: Props): React.JSX.Element {
  const km = useKeymap()
  const runRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = runRef.current
    if (!el || reducedMotion()) return
    let offset = 0
    let last = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      // 창이 숨어 있다 돌아오면 dt가 커지므로 상한을 둔다
      const dt = Math.min(now - last, 64) / 1000
      last = now
      const half = el.scrollWidth / 2
      if (half > 0) {
        offset = (offset + SPEED * dt) % half
        el.style.transform = `translate3d(${-offset}px, 0, 0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const unread = reports.filter((r) => r.task.unread).length
  const parts: { text: string; alert?: boolean; keys?: string; after?: string }[] = running.map((r) => {
    const name = `■ ${HOME_ROW[r.projectIndex] ?? ''} ${r.project.name.toUpperCase()}`
    if (r.state.permissions.length > 0) return { text: `${name}  NEEDS YOU`, alert: true }
    if (r.state.status === 'queued') return { text: `${name}  QUEUED` }
    return { text: `${name}  ${STAGES[Math.min(r.task.stage, STAGES.length - 1)]} · ${r.task.activity}` }
  })
  if (running.length === 0) parts.push({ text: '■ NO RUNNING TASKS · ', keys: km.dispatch, after: ' NEW TASK' })
  if (unread > 0) parts.push({ text: `■ ${unread} NEW REPORT${unread > 1 ? 'S' : ''}` })
  if (hotkey) parts.push({ text: '■ ', keys: hotkey, after: ' SUMMON' })

  const line = parts.map((p, i) => {
    const body = (
      <>
        {p.text}
        {p.keys && <Keys keys={p.keys} />}
        {p.after}
        {'     '}
      </>
    )
    return p.alert ? <b key={i}>{body}</b> : <span key={i}>{body}</span>
  })
  return (
    <div className="ticker" role="status" aria-label={parts.map((p) => `${p.text}${p.keys ?? ''}${p.after ?? ''}`).join(', ')}>
      <div className="ticker-run" ref={runRef} aria-hidden="true">
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  )
}
