import { Fragment, useEffect, useRef, useState } from 'react'
import type { SearchHit } from '@shared/types'
import { searchTerms } from '@shared/search'
import { HOME_ROW, matches } from './keys'
import { useKeymap } from './settings'

const ROLE: Record<SearchHit['role'], string> = { user: 'YOU', assistant: 'CLAUDE', tool: 'TOOL' }

/** 검색어를 굵게 (대소문자 무시) */
function Highlight({ text, terms }: { text: string; terms: string[] }): React.JSX.Element {
  if (terms.length === 0) return <>{text}</>
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  )
}

/** 모든 프로젝트의 대화 내용에서 찾는다 (Ctrl+Shift+F). 고르면 그 대화의 그 메시지로 */
export function SearchOverlay({ leaving, onOpen, onClose }: { leaving: boolean; onOpen: (hit: SearchHit, query: string) => void; onClose: () => void }): React.JSX.Element {
  const km = useKeymap()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ q: string; hits: SearchHit[] } | null>(null)
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)
  const q = query.trim()

  useEffect(() => {
    if (!q) return setResult(null)
    let alive = true
    const t = setTimeout(() => {
      void window.api.searchConversations(q).then((hits) => {
        if (!alive) return
        setResult({ q, hits })
        setIndex(0)
      })
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])

  const hits = result?.q === q ? result.hits : []
  const loading = !!q && result?.q !== q
  const terms = searchTerms(q)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKey = (e: React.KeyboardEvent): void => {
    const plainCtrl = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    const step =
      e.key === 'ArrowDown' || (plainCtrl && (e.code === 'KeyJ' || e.code === 'KeyN')) ? 1
      : e.key === 'ArrowUp' || (plainCtrl && (e.code === 'KeyK' || e.code === 'KeyP')) ? -1
      : 0
    if (step) {
      e.preventDefault()
      if (hits.length) setIndex((i) => (i + step + hits.length) % hits.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (hits[index]) onOpen(hits[index], q)
    } else if (e.key === 'Escape' || matches(e.nativeEvent, km.search)) {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className={`overlay search ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-label="대화 검색" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet search-sheet">
        <header className="search-head">
          <span className="kr" aria-hidden="true">FIND</span>
          <input
            id="search-input"
            className="search-input"
            value={query}
            placeholder="모든 대화에서 찾기"
            aria-label="찾을 말"
            aria-controls="search-results"
            autoComplete="off"
            spellCheck={false}
            // 검색창이 키를 처리한다 (Esc가 실행 중단으로, J·K가 홈 이동으로 가지 않게)
            data-keys-own="true"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="search-count mono">{loading ? '…' : q ? `${hits.length}${hits.length >= 150 ? '+' : ''}` : ''}</span>
        </header>
        <ol id="search-results" className="search-list" ref={listRef} role="listbox" aria-label="검색 결과">
          {!q && <li className="empty">열어 둔 모든 대화의 내 메시지, 답변, 도구 호출에서 찾아요. 띄어 쓴 말이 모두 들어간 것만 보여요.</li>}
          {q && !loading && hits.length === 0 && <li className="empty">'{q}'가 들어간 메시지가 없어요.</li>}
          {hits.map((h, i) => (
            <li
              key={`${h.conversationId}:${h.ordinal}`}
              role="option"
              aria-selected={i === index}
              className={`search-hit ${i === index ? 'on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onOpen(h, q)}
            >
              <span className="search-meta">
                <span className="search-key" aria-hidden="true">{HOME_ROW[h.projectIndex] ?? ''}</span>
                <b>{h.projectName}</b>
                <span className="search-title">{h.title}</span>
                <span className={`search-role role-${h.role}`}>{ROLE[h.role]}</span>
              </span>
              <span className="search-snippet">
                <Highlight text={h.snippet} terms={terms} />
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
