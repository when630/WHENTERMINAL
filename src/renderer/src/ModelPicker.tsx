import { useEffect, useRef, useState } from 'react'
import type { ModelOption, UsageInfo } from '@shared/types'

interface Props {
  projectId: string
  conversationId: string
  current?: { id: string; label: string }
  /** 이 대화에서 고른 모델 값. 없으면 기본값을 쓰는 중 */
  choice?: string
  usage: UsageInfo | null
}

/** 모델 계열 이름 ('Fable 5.1' → 'fable', 'claude-opus-5-5' → 'opus') */
const family = (s: string): string => s.toLowerCase().replace(/^claude-/, '').split(/[\s-]/)[0]

/**
 * 모델 칸: 누르면 고를 수 있는 모델이 펼쳐진다. 주간 한도를 다 쓴 계열에는 표시를 붙인다.
 * 위아래·Ctrl+N/P로 이동, Enter로 고르기, Esc로 닫기
 */
export function ModelPicker({ projectId, conversationId, current, choice, usage }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
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
      {open && (
        <div className="model-list" role="listbox" aria-label="모델 고르기" tabIndex={-1} data-keys-own="true" onKeyDown={onKey} ref={(el) => { el?.focus() }}>
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
