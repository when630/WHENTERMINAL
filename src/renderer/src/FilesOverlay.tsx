import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileView } from '@shared/types'
import { CodeView } from './CodeView'
import { matches } from './keys'
import { Markdown } from './Markdown'
import { useKeymap } from './settings'

const KIND_LABEL: Record<FileView['kind'], string> = {
  text: 'TEXT',
  markdown: 'MARKDOWN',
  html: 'HTML',
  image: 'IMAGE',
  binary: 'BINARY',
  dir: 'FOLDER',
  missing: 'MISSING',
}

/** 이보다 큰 md·html은 읽기 모드로 그리면 무거워 원문으로만 연다 */
const READ_LIMIT = 2 * 1024 * 1024

const isDir = (p: string): boolean => p.endsWith('/')
const nameOf = (p: string): string => {
  const base = isDir(p) ? p.slice(0, -1) : p
  return base.slice(base.lastIndexOf('/') + 1) + (isDir(p) ? '/' : '')
}
const parentOf = (p: string): string => {
  const base = isDir(p) ? p.slice(0, -1) : p
  const i = base.lastIndexOf('/')
  return i < 0 ? '' : base.slice(0, i + 1)
}

function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** md 안의 원격 그림 주소 (인라인 ![](http…)와 그림이 쓰는 참조 정의 [x]: http…). 그림이 아닌 것은 메인이 뺀다 */
function remoteImages(md: string): string[] {
  const urls = new Set<string>()
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?/gi)) urls.add(m[1])
  const refs = new Set([...md.matchAll(/!\[[^\]]*\]\[([^\]]*)\]/g)].map((m) => m[1].toLowerCase()))
  if (refs.size) {
    for (const m of md.matchAll(/^\s*\[([^\]]+)\]:\s*<?(https?:\/\/\S+?)>?(?:\s|$)/gim)) if (refs.has(m[1].toLowerCase())) urls.add(m[2])
  }
  return [...urls]
}

interface Props {
  projectId: string
  conversationId: string
  /** 프로젝트(대화) 폴더 이름. 경로 줄의 맨 앞 */
  rootName: string
  root: string
  leaving: boolean
  onClose: () => void
  /** 고른 파일·폴더의 상대 경로를 입력창에 넣는다 (@경로) */
  onInsert: (path: string) => void
}

/**
 * 프로젝트의 파일 찾기·읽기 (키맵 files, /files). 비어 있으면 폴더를 한 단계씩 둘러보고, 치면 프로젝트 전체에서 이름으로 찾는다.
 * 고른 파일은 오른쪽에 바로 보인다: md는 읽기 모드, html은 격리된 미리 보기(wt-file, 스크립트만 허용한 sandbox), 그림,
 * 나머지는 CodeMirror 원문(문법 색·찾기, 20MB 넘으면 MORE로 이어 읽기)
 */
export function FilesOverlay({ projectId, conversationId, rootName, root, leaving, onClose, onInsert }: Props): React.JSX.Element {
  const km = useKeymap()
  const [dir, setDir] = useState('')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<{ key: string; items: string[] } | null>(null)
  const [index, setIndex] = useState(0)
  const [view, setView] = useState<FileView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 원격 그림: 누른 문서에만 메인이 받아 준다 (경로별)
  const [remote, setRemote] = useState<{ path: string; map: Record<string, string> } | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  // 링크로 연 파일은 목록 선택과 상관없이 보인다
  const [opened, setOpened] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const q = query.trim()
  const listKey = q ? `q:${q}` : `d:${dir}`

  useEffect(() => {
    let alive = true
    const t = setTimeout(
      () => {
        const p = q ? window.api.searchFiles(projectId, conversationId, q) : window.api.listDir(projectId, conversationId, dir)
        void p.then((items) => {
          if (!alive) return
          setList({ key: listKey, items })
          setIndex(0)
        })
      },
      q ? 120 : 0,
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [listKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = list?.key === listKey ? list.items : []
  const loading = list?.key !== listKey
  const selected = items[index]
  const target = opened ?? (selected && !isDir(selected) ? selected : null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, listKey])

  // 고른 파일을 읽는다 (목록을 빠르게 넘길 때는 멈춘 뒤에)
  useEffect(() => {
    if (!target) {
      setView(null)
      setError(null)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void window.api.viewFile(projectId, conversationId, target).then(
        (v) => {
          if (!alive) return
          setView(v)
          setError(null)
          bodyRef.current?.scrollTo({ top: 0 })
        },
        (err) => alive && setError(err instanceof Error ? err.message : String(err)),
      )
    }, 90)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [target, projectId, conversationId])

  const enter = (path: string): void => {
    setOpened(null)
    if (isDir(path)) {
      setDir(path)
      setQuery('')
    } else onInsert(path)
  }
  const up = (): void => {
    setOpened(null)
    setDir(parentOf(dir))
  }
  const openLinked = (path: string): void => {
    setOpened(path)
    inputRef.current?.focus()
  }

  const shown = view && view.path === target ? view : null
  const doc = shown?.kind === 'markdown' || shown?.kind === 'html'
  // 읽기 모드는 한 번에 다 읽은 작은 문서만
  const canRead = doc && shown.size <= READ_LIMIT && shown.next === undefined
  const reading = canRead && !source
  const showSource = !!shown && (shown.kind === 'text' || (doc && !reading))
  const images = useMemo(() => (shown?.kind === 'markdown' && reading ? remoteImages(shown.text ?? '') : []), [shown, reading])
  const remoteMap = remote && shown && remote.path === shown.path ? remote.map : null
  const failed = remoteMap ? images.filter((u) => !remoteMap[u]).length : 0

  /** 큰 파일: 다음 조각을 읽어 뒤에 붙인다 */
  const more = (): void => {
    if (!shown || shown.next === undefined || loadingMore) return
    const at = shown
    setLoadingMore(true)
    void window.api.viewFile(projectId, conversationId, at.path, at.next).then(
      (v) => {
        setLoadingMore(false)
        setView((cur) => (cur && cur.path === at.path ? { ...cur, text: (cur.text ?? '') + (v.text ?? ''), next: v.next } : cur))
      },
      (err) => {
        setLoadingMore(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const loadRemote = (): void => {
    if (!shown || remoteLoading) return
    const path = shown.path
    setRemoteLoading(true)
    void window.api.fileImages(images).then(
      (map) => {
        setRemoteLoading(false)
        setRemote({ path, map })
      },
      () => setRemoteLoading(false),
    )
  }

  /** 미리 보기 스크롤 (원문은 CodeMirror 안쪽이 스크롤된다) */
  const scrollPreview = (step: 1 | -1): void => {
    const el = bodyRef.current?.querySelector<HTMLElement>('.cm-scroller') ?? bodyRef.current
    if (el) el.scrollBy({ top: step * el.clientHeight * 0.5, behavior: 'smooth' })
  }

  const onKey = (e: React.KeyboardEvent): void => {
    // 덮개가 키를 처리한다: App의 전역 키(Esc 중단 등)로 가지 않게
    e.stopPropagation()
    // 원문(CodeMirror)이 먼저 처리한 키(찾기 칸의 Esc 등)는 건드리지 않는다
    if (e.defaultPrevented) return
    if (e.key === 'Escape' || matches(e.nativeEvent, km.files)) {
      e.preventDefault()
      onClose()
      return
    }
    // 원문 칸 안에서는 글 고르기·찾기 키를 그대로 둔다
    if (e.target !== inputRef.current) return
    const plainCtrl = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    const step = e.key === 'ArrowDown' || (plainCtrl && (e.code === 'KeyJ' || e.code === 'KeyN')) ? 1 : e.key === 'ArrowUp' || (plainCtrl && e.code === 'KeyK') ? -1 : 0
    if (step) {
      e.preventDefault()
      setOpened(null)
      if (items.length) setIndex((i) => (i + step + items.length) % items.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (selected) enter(selected)
    } else if (e.key === 'Backspace' && !query && dir) {
      e.preventDefault()
      up()
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && canRead) {
      e.preventDefault()
      setSource((v) => !v)
    } else if (plainCtrl && (e.code === 'KeyD' || e.code === 'KeyU')) {
      e.preventDefault()
      scrollPreview(e.code === 'KeyD' ? 1 : -1)
    }
  }

  const crumbs = dir ? dir.slice(0, -1).split('/') : []

  return (
    <div className={`overlay files ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-label="파일 찾기" onClick={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKey}>
      {/* 미리 보기를 눌러도 포커스가 이 안에 머물러 App이 키를 가져가지 않게 (data-keys-own) */}
      <div
        className="overlay-sheet files-sheet"
        tabIndex={-1}
        data-keys-own="true"
        onClick={(e) => {
          // 버튼을 눌러도 포커스는 찾기 칸으로 (버튼에 남으면 Esc가 App의 실행 중단으로 간다). 글을 고르는 중·원문 칸 안이면 그대로
          const el = e.target as HTMLElement
          if (el === inputRef.current || el.closest('.cm-editor') || window.getSelection()?.toString()) return
          requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
        }}
      >
        <header className="search-head files-head">
          <span className="kr" aria-hidden="true">FILES</span>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="파일·폴더 이름으로 찾기"
            aria-label="찾을 파일 이름"
            aria-controls="files-list"
            autoComplete="off"
            spellCheck={false}
            data-keys-own="true"
            autoFocus
            onChange={(e) => {
              setOpened(null)
              setQuery(e.target.value)
            }}
          />
          <span className="search-count mono">{loading ? '…' : `${items.length}${q && items.length >= 50 ? '+' : ''}`}</span>
        </header>
        <nav className="files-crumbs mono" aria-label="지금 폴더">
          {q ? (
            <span className="muted">{rootName} 전체에서 찾는 중</span>
          ) : (
            <>
              <button type="button" className="crumb" onClick={() => { setOpened(null); setDir('') }} title={root}>{rootName}</button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  <span className="crumb-sep">/</span>
                  <button type="button" className="crumb" onClick={() => { setOpened(null); setDir(`${crumbs.slice(0, i + 1).join('/')}/`) }}>{c}</button>
                </span>
              ))}
            </>
          )}
        </nav>
        <div className="files-main">
          <ol id="files-list" className="search-list files-list" ref={listRef} role="listbox" aria-label="파일 목록">
            {!q && dir && (
              <li className="files-row up" onClick={up} title="위 폴더로 가요">
                <span className="files-name mono">../</span>
              </li>
            )}
            {!loading && items.length === 0 && <li className="empty">{q ? `'${q}'가 들어간 파일이 없어요.` : '빈 폴더예요.'}</li>}
            {items.map((p, i) => (
              <li
                key={p}
                role="option"
                aria-selected={i === index}
                className={`files-row ${i === index ? 'on' : ''} ${isDir(p) ? 'dir' : ''}`}
                onMouseEnter={() => {
                  setOpened(null)
                  setIndex(i)
                }}
                onClick={() => (isDir(p) ? enter(p) : setIndex(i))}
                onDoubleClick={() => !isDir(p) && onInsert(p)}
              >
                <span className="files-name mono">{nameOf(p)}</span>
                {q && parentOf(p) && <span className="files-dir mono">{parentOf(p)}</span>}
              </li>
            ))}
          </ol>
          <section className="files-view" aria-label="미리 보기">
            {target && (
              <header className="fv-head">
                <span className="fv-path mono" title={target}>{target}</span>
                {shown && (
                  <span className="fv-meta mono">
                    {KIND_LABEL[shown.kind]}
                    {shown.kind !== 'missing' && shown.kind !== 'dir' ? ` · ${shown.next !== undefined ? `${sizeLabel(shown.next)} / ` : ''}${sizeLabel(shown.size)}` : ''}
                  </span>
                )}
                {shown?.next !== undefined && (
                  <button type="button" className="btn ghost sm" disabled={loadingMore} onClick={more} title="다음 부분을 이어서 읽어요">
                    {loadingMore ? '…' : 'MORE'}
                  </button>
                )}
                {canRead && (
                  <button type="button" className="btn ghost sm" aria-pressed={source} onClick={() => setSource((v) => !v)} title={source ? '읽기 모드로 봐요' : '원문을 봐요'}>
                    {source ? 'READ' : 'SOURCE'}
                  </button>
                )}
                <button type="button" className="btn ghost sm" onClick={() => onInsert(target)} title="입력창에 @경로로 넣어요">@ INSERT</button>
                <button type="button" className="btn ghost sm" onClick={() => void window.api.openPath(`${root}/${target}`)} title="기본 앱으로 열어요">OPEN</button>
              </header>
            )}
            {images.length > 0 && (
              <div className="fv-bar" role="status">
                <span>
                  {remoteMap
                    ? failed
                      ? `외부 그림 ${images.length - failed}개를 불러왔어요 · ${failed}개는 그림이 아니거나 받지 못했어요`
                      : `외부 그림 ${images.length}개를 불러왔어요`
                    : `외부 그림 ${images.length}개를 막아 두었어요 · 누르면 앱이 받아 와서 보여요`}
                </span>
                {!remoteMap && (
                  <button type="button" className="btn ghost sm" disabled={remoteLoading} onClick={loadRemote} title="이 문서의 외부 그림만 받아 와요">
                    {remoteLoading ? '…' : 'LOAD REMOTE IMAGES'}
                  </button>
                )}
              </div>
            )}
            {doc && !canRead && <div className="fv-bar muted" role="status">문서가 2MB를 넘어 읽기 모드 대신 원문으로 보여요.</div>}
            <div className={`fv-body ${showSource ? 'code' : ''}`} ref={bodyRef}>
              {!target && <div className="fv-empty">{selected && isDir(selected) ? '폴더예요. 들어가면 안의 파일이 보여요.' : '파일을 고르면 여기에 보여요. md는 읽기 모드로, html은 미리 보기로 보여요.'}</div>}
              {target && error && <div className="fv-empty error">{error}</div>}
              {target && !error && !shown && <div className="fv-empty">불러오는 중…</div>}
              {shown && (
                <>
                  {shown.kind === 'markdown' && reading && (
                    <div className="fv-read">
                      <Markdown text={shown.text ?? ''} fileUrl={shown.url} onOpen={openLinked} remote={remoteMap ?? undefined} />
                    </div>
                  )}
                  {/* 스크립트만 허용: 다른 출처로 격리돼 앱 창·API에 닿지 않고, 위 창을 옮기거나 새 창을 띄우지 못한다 */}
                  {shown.kind === 'html' && reading && <iframe key={shown.url} className="fv-frame" src={shown.url} sandbox="allow-scripts" title={`${target} 미리 보기`} />}
                  {shown.kind === 'image' && (
                    <div className="fv-image">
                      <img src={shown.url} alt={target ?? ''} />
                    </div>
                  )}
                  {showSource && <CodeView path={shown.path} text={shown.text ?? ''} />}
                  {shown.kind === 'binary' && <div className="fv-empty">글자로 볼 수 없는 파일이에요. OPEN으로 기본 앱에서 열 수 있어요.</div>}
                  {shown.kind === 'missing' && <div className="fv-empty error">파일을 찾을 수 없어요.</div>}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
