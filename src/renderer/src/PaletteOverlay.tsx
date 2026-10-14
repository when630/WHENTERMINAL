import { useEffect, useMemo, useRef, useState } from 'react'
import { matches } from './keys'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'

/** 팔레트 한 줄. run은 팔레트가 닫힌 뒤에 App이 부른다 */
export interface PaletteEntry {
  id: string
  group: 'ACTION' | 'COMMAND' | 'TAB' | 'PROJECT' | 'THEME'
  label: string
  note?: string
  /** 찾을 때만 쓰는 말 (화면에는 안 보임) */
  keywords?: string
  /** 프로젝트 표시 글자 (홈 열 A S D …) */
  mark?: string
  /** 같은 일을 하는 단축키. 팔레트는 키를 익히는 곳이라 화면에 단축키를 적지 않는 규칙의 예외 */
  keys?: string
  run: () => void
}

const RECENT_KEY = 'wt-palette-recent'
const RECENT_MAX = 6

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function pushRecent(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)))
  } catch {
    // 기억하지 못해도 팔레트는 그대로 동작한다
  }
}

/** 띄어 쓴 말이 모두 들어간 줄만. 이름이 앞부분과 맞는 것 > 이름에 들어 있는 것 > 설명·찾을 말에 들어 있는 것 */
function rank(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    const recent = readRecent()
    const top = recent.map((id) => entries.find((e) => e.id === id)).filter((e): e is PaletteEntry => !!e)
    return [...top, ...entries.filter((e) => !top.includes(e))]
  }
  const terms = q.split(/\s+/)
  const scored: { e: PaletteEntry; s: number }[] = []
  for (const e of entries) {
    const label = e.label.toLowerCase()
    const hay = `${label} ${e.note ?? ''} ${e.keywords ?? ''} ${e.group}`.toLowerCase()
    if (!terms.every((t) => hay.includes(t))) continue
    scored.push({ e, s: label.startsWith(q) ? 0 : terms.every((t) => label.includes(t)) ? 1 : 2 })
  }
  return scored.sort((a, b) => a.s - b.s).map((x) => x.e)
}

/** 명령 팔레트 (키맵 palette): 키맵 동작·입력창 명령·탭·프로젝트·테마를 이름으로 찾아 실행한다 */
export function PaletteOverlay({ entries, leaving, onRun, onClose }: { entries: PaletteEntry[]; leaving: boolean; onRun: (entry: PaletteEntry) => void; onClose: () => void }): React.JSX.Element {
  const km = useKeymap()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 나가는 중에 다시 열면 같은 화면이 돌아온다: 처음처럼 비우고 찾기 칸으로.
  // 비우기는 그리는 중에 한다 (효과에서 비우면 포커스 직후 친 글자가 남은 글 뒤에 붙는다)
  const [wasLeaving, setWasLeaving] = useState(leaving)
  if (wasLeaving !== leaving) {
    setWasLeaving(leaving)
    if (!leaving) setQuery('')
  }
  useEffect(() => {
    if (!leaving) inputRef.current?.focus()
  }, [leaving])
  const shown = useMemo(() => rank(entries, query), [entries, query])
  const recent = useMemo(() => (query.trim() ? new Set<string>() : new Set(readRecent())), [query])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  // 나가는 동안 찾기 칸이 포커스를 쥐고 있으면 입력창이 포커스를 가져가지 못하고, 그 뒤의 키가 팔레트로 간다
  const release = (): void => inputRef.current?.blur()
  const close = (): void => {
    release()
    onClose()
  }
  const run = (e: PaletteEntry | undefined): void => {
    if (!e) return
    release()
    pushRecent(e.id)
    onRun(e)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    const plainCtrl = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    const step =
      e.key === 'ArrowDown' || (plainCtrl && (e.code === 'KeyJ' || e.code === 'KeyN')) ? 1
      : e.key === 'ArrowUp' || (plainCtrl && (e.code === 'KeyK' || e.code === 'KeyP')) ? -1
      : 0
    if (step) {
      e.preventDefault()
      if (shown.length) setIndex((i) => (i + step + shown.length) % shown.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      run(shown[index])
    } else if (e.key === 'Escape' || matches(e.nativeEvent, km.palette)) {
      e.preventDefault()
      close()
    }
  }

  return (
    <div className={`overlay search palette ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-label="명령 팔레트" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="overlay-sheet search-sheet">
        <header className="search-head">
          <span className="kr" aria-hidden="true">DO</span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="무엇을 할까요"
            aria-label="찾을 명령"
            aria-controls="palette-list"
            autoComplete="off"
            spellCheck={false}
            // 팔레트가 키를 처리한다 (Esc가 실행 중단으로, J·K가 홈 이동으로 가지 않게)
            data-keys-own="true"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="search-count mono">{shown.length}</span>
        </header>
        <ol id="palette-list" className="search-list" ref={listRef} role="listbox" aria-label="명령">
          {shown.length === 0 && <li className="empty">'{query.trim()}'에 맞는 명령이 없어요.</li>}
          {shown.map((e, i) => (
            <li
              key={e.id}
              role="option"
              aria-selected={i === index}
              className={`search-hit pal-row ${i === index ? 'on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(e)}
            >
              <span className="pal-mark" aria-hidden="true">{e.mark ?? ''}</span>
              <b className="pal-label">{e.label}</b>
              {e.note && <span className="pal-note" title={e.note}>{e.note}</span>}
              {recent.has(e.id) && <span className="pal-recent">RECENT</span>}
              {e.keys && <Keys keys={e.keys} className="pal-keys" />}
              <span className="pal-group">{e.group}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
