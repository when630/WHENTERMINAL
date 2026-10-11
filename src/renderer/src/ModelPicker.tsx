import { useEffect, useRef, useState } from 'react'
import { EFFORT_LABEL, type EffortInfo, type EffortLevel, type ModelOption, type UsageInfo } from '@shared/types'
import { modelFamily as family } from '@shared/usage'
import { Keys } from './KeyHint'
import { usePresence } from './motion'

/** 펼친 목록의 머리줄: 이름·개수와 키 안내 */
export function ListHead({ label, count }: { label: string; count?: number }): React.JSX.Element {
  return (
    <div className="model-head">
      <span>{label}{count !== undefined ? ` ${count}` : ''}</span>
      <span className="slash-keys">
        <Keys keys="ctrl N" />/<Keys keys="ctrl P" /> MOVE · <Keys keys="enter" /> PICK · <Keys keys="esc" /> CLOSE
      </span>
    </div>
  )
}

interface Props {
  projectId: string
  conversationId: string
  current?: { id: string; label: string }
  /** 이 대화에서 고른 모델 값. 없으면 기본값을 쓰는 중 */
  choice?: string
  usage: UsageInfo | null
}

/**
 * 모델 칸: 누르면 고를 수 있는 모델이 펼쳐진다. 주간 한도를 다 쓴 계열에는 표시를 붙인다.
 * 위아래·Ctrl+N/P로 이동, Enter로 고르기, Esc로 닫기
 */
export function ModelPicker({ projectId, conversationId, current, choice, usage }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const panel = usePresence(open ? true : null, 220)
  const [list, setList] = useState<ModelOption[] | null>(null)
  const [index, setIndex] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    void window.api.listModels(projectId).then((l) => {
      setList(l)
      const at = l.findIndex((m) => m.value === (choice ?? 'default'))
      setIndex(Math.max(0, at))
    })
    const close = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open, projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const limitOf = (m: ModelOption): number | null => {
    const f = family(m.resolvedModel ?? m.displayName)
    const w = usage?.windows.find((x) => (x.id.startsWith('model:') || x.id.startsWith('seven_day_')) && family(x.label) === f)
    return w?.percent ?? null
  }

  const pick = (m: ModelOption): void => {
    setOpen(false)
    void window.api.setModel(projectId, conversationId, m)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (!list?.length) return
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    const step = e.key === 'ArrowDown' || (ctrl && (e.code === 'KeyN' || e.code === 'KeyJ')) ? 1 : e.key === 'ArrowUp' || (ctrl && (e.code === 'KeyP' || e.code === 'KeyK')) ? -1 : 0
    if (step) setIndex((i) => (i + step + list.length) % list.length)
    else if (e.key === 'Enter') pick(list[index])
    else if (e.key === 'Escape') setOpen(false)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="model-pick" ref={boxRef}>
      <button type="button" className={`meta ${open ? 'open' : ''}`} title={current?.id ?? '첫 응답 뒤에 보여요'} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="meta-k">MODEL</span>
        <span className="meta-v model-v">{current?.label ?? '–'}</span>
        <span className="model-caret" aria-hidden="true">▾</span>
      </button>
      {panel.item && (
        <div className={`model-list ${panel.leaving ? 'leaving' : ''}`} role="listbox" aria-label="모델 고르기" tabIndex={-1} data-keys-own="true" onKeyDown={onKey} ref={(el) => { if (el && !panel.leaving) el.focus() }}>
          <ListHead label="MODEL" count={list?.length} />
          {!list && <div className="slash-empty">모델 목록을 불러오는 중…</div>}
          {list?.map((m, i) => {
            const pct = limitOf(m)
            // 기본값은 다른 모델을 가리키므로, 고른 값으로만 '사용 중'을 판단한다
            const on = m.value === (choice ?? 'default')
            return (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={on}
                className={`model-row ${i === index ? 'hi' : ''} ${on ? 'on' : ''}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => pick(m)}
              >
                <span className="model-name">
                  {m.value === 'default' ? 'Default' : m.displayName}
                  {on && <span className="model-now">IN USE</span>}
                  {pct !== null && pct >= 80 && <span className={`model-limit ${pct >= 100 ? 'full' : ''}`}>LIMIT {pct}%</span>}
                </span>
                <span className="model-desc">{m.value === 'default' ? `설정을 따라요 · ${m.displayName}` : m.description}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface EffortProps {
  /** 이 대화에서 고른 값. 없으면 기본값 */
  choice?: EffortLevel
  info: EffortInfo | null
  onPick: (effort: EffortLevel | null) => void
}

/** 기본값 행에 붙일 설명 */
const effortDefault = (info: EffortInfo | null): string => (info?.saved ? `설정을 따라요 · ${EFFORT_LABEL[info.saved]}` : '모델 기본값을 따라요')

/**
 * effort 칸: 누르면 지금 모델이 받는 단계가 펼쳐진다. 위아래·Ctrl+N/P로 이동, Enter로 고르기, Esc로 닫기.
 * 고르지 않았으면 설정(effortLevel)이나 모델 기본값을 쓴다
 */
export function EffortPicker({ choice, info, onPick }: EffortProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const panel = usePresence(open ? true : null, 220)
  const [index, setIndex] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const rows: (EffortLevel | null)[] = [null, ...(info?.levels ?? [])]
  const none = info !== null && info.levels.length === 0

  useEffect(() => {
    if (!open) return
    setIndex(Math.max(0, rows.indexOf(choice ?? null)))
    const close = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (e: EffortLevel | null): void => {
    setOpen(false)
    onPick(e)
  }
  const onKey = (e: React.KeyboardEvent): void => {
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    const step = e.key === 'ArrowDown' || (ctrl && (e.code === 'KeyN' || e.code === 'KeyJ')) ? 1 : e.key === 'ArrowUp' || (ctrl && (e.code === 'KeyP' || e.code === 'KeyK')) ? -1 : 0
    if (step) setIndex((i) => (i + step + rows.length) % rows.length)
    else if (e.key === 'Enter') pick(rows[index])
    else if (e.key === 'Escape') setOpen(false)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const shown = choice ? EFFORT_LABEL[choice] : info?.saved ? EFFORT_LABEL[info.saved] : 'DEFAULT'
  return (
    <div className="model-pick" ref={boxRef}>
      <button
        type="button"
        className={`meta ${open ? 'open' : ''} ${choice ? '' : 'meta-default'}`}
        title={none ? '이 모델은 effort를 받지 않아요' : choice ? '이 대화에서 고른 effort예요' : effortDefault(info)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={none}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="meta-k">EFFORT</span>
        <span className="meta-v effort-v">{none ? '–' : shown}</span>
        <span className="model-caret" aria-hidden="true">▾</span>
      </button>
      {panel.item && (
        <div className={`model-list effort-list ${panel.leaving ? 'leaving' : ''}`} role="listbox" aria-label="effort 고르기" tabIndex={-1} data-keys-own="true" onKeyDown={onKey} ref={(el) => { if (el && !panel.leaving) el.focus() }}>
          <ListHead label="EFFORT" count={rows.length} />
          {rows.map((r, i) => {
            const on = (choice ?? null) === r
            return (
              <button
                key={r ?? 'default'}
                type="button"
                role="option"
                aria-selected={on}
                className={`model-row ${i === index ? 'hi' : ''} ${on ? 'on' : ''}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => pick(r)}
              >
                <span className="model-name">
                  {r ? EFFORT_LABEL[r] : 'Default'}
                  {on && <span className="model-now">IN USE</span>}
                </span>
                <span className="model-desc">{r ? EFFORT_NOTE[r] : effortDefault(info)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const EFFORT_NOTE: Record<EffortLevel, string> = {
  low: '가장 빠르고 적게 써요. 간단한 질문·수정',
  medium: '속도와 깊이의 균형',
  high: '깊이 생각해요',
  xhigh: '더 깊이. 어려운 문제',
  max: '가장 깊이. 이 세션에만 적용돼요 (설정에 저장되지 않음)',
}
