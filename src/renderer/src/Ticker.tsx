import { HOME_ROW } from './keys'
import { STAGES, type TaskRef } from './state'

interface Props {
  running: TaskRef[]
  reports: TaskRef[]
  hotkey: string | null
}

/** 맨 위 전광판: 모든 프로젝트의 지금 상태가 한 줄로 흐른다. 확인이 필요한 항목만 빨갛게 */
export function Ticker({ running, reports, hotkey }: Props): React.JSX.Element {
  const unread = reports.filter((r) => r.task.unread).length
  const parts: { text: string; alert?: boolean }[] = running.map((r) => {
    const name = `■ ${HOME_ROW[r.projectIndex] ?? ''} ${r.project.name.toUpperCase()}`
    if (r.state.permissions.length > 0) return { text: `${name}  확인을 기다려요`, alert: true }
    return { text: `${name}  ${STAGES[Math.min(r.task.stage, STAGES.length - 1)]} 중 · ${r.task.activity}` }
  })
  if (running.length === 0) parts.push({ text: '■ 진행 중인 작업 없음 · CTRL K 로 작업 지시' })
  if (unread > 0) parts.push({ text: `■ 새 보고 ${unread}건` })
  if (hotkey) parts.push({ text: `■ ${hotkey.toUpperCase()} 어디서든 호출` })

  const line = parts.map((p, i) => (p.alert ? <b key={i}>{p.text}     </b> : <span key={i}>{p.text}     </span>))
  return (
    <div className="ticker" role="status" aria-label={parts.map((p) => p.text).join(', ')}>
      <div className="ticker-run" aria-hidden="true">
        <span>{line}</span>
        <span>{line}</span>
      </div>
    </div>
  )
}
