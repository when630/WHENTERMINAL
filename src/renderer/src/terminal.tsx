import { cloneElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_KEYMAP, type Keymap } from '@shared/keymap'
import type { TerminalInfo, TerminalShell, TerminalShellOption } from '@shared/types'
import { matches } from './keys'
import { EASE, reducedMotion, usePresence } from './motion'
import { ListHead } from './ModelPicker'
import { useKeymap } from './settings'

// 대화창 아래 터미널 서랍. 대화마다 터미널 탭 여러 개, 탭마다 셸 하나(메인의 node-pty, termId로 구분)와 xterm 화면 하나.
// xterm 화면은 탭을 옮겨도 버리지 않고 다시 붙여 스크롤·선택이 그대로 남는다

/** 탭 하나의 상태 */
interface Tab {
  info?: TerminalInfo
  /** 셸이 끝났으면 종료 코드 */
  exited?: number
  /** 오래 돈 명령이 끝났는데 아직 보지 않았다 */
  done?: boolean
}

/** 대화 하나의 서랍 상태 */
interface Ui {
  open: boolean
  expanded: boolean
  /** 탭 순서 (termId) */
  order: string[]
  tabs: Record<string, Tab>
  active?: string
  /** 다음 탭 번호 */
  seq: number
  /** 바뀔 때마다 지금 탭의 터미널에 포커스 */
  focus: number
  /** 찾기 줄이 열려 있으면 바뀔 때마다 찾기 칸에 포커스 */
  find: number
  finding: boolean
}

interface Entry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  el: HTMLDivElement
  projectId: string
  conversationId: string
  opened: boolean
  started: boolean
  /** 셸이 첫 출력을 냈는지 (프롬프트가 뜨기 전에 넣은 글자는 사라질 수 있다) */
  ready: Promise<void>
  markReady: () => void
  /** Enter로 시작한 명령 (끝남 감지용) */
  cmd?: { text: string; at: number }
  /** 지난 Enter 뒤로 친 글자 (화면에 아직 안 찍혔을 때 명령 이름 대신) */
  typed: string
  quiet?: ReturnType<typeof setTimeout>
}

const CLOSED: Ui = { open: false, expanded: false, order: [], tabs: {}, seq: 1, focus: 0, find: 0, finding: false }
let uis: Record<string, Ui> = {}
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
// 키 처리(xterm 안)는 React 밖이라 지금 키 맵을 여기에 둔다
let keymap: Keymap = DEFAULT_KEYMAP
/** 지금 화면에 붙어 있는 서랍의 대화 */
let shownConversation: string | null = null
/** 경로 링크를 눌렀을 때 입력창에 넣는 곳 (대화별, 서랍이 등록한다) */
const pathSinks = new Map<string, (path: string) => void>()

function setUi(id: string, patch: Partial<Ui> | ((ui: Ui) => Partial<Ui>)): void {
  const cur = uis[id] ?? CLOSED
  uis = { ...uis, [id]: { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) } }
  listeners.forEach((l) => l())
}
const getUi = (id: string): Ui => uis[id] ?? CLOSED
const setTab = (id: string, termId: string, patch: Partial<Tab>): void =>
  setUi(id, (ui) => (ui.tabs[termId] ? { tabs: { ...ui.tabs, [termId]: { ...ui.tabs[termId], ...patch } } } : {}))

function useTerminalUi(id: string): Ui {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => getUi(id),
  )
}

const HEIGHT_KEY = 'wt-terminal-height'
function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY))
    return n >= 120 ? n : 280
  } catch {
    return 280
  }
}

/** 앱 테마의 코드 색·글꼴을 그대로 쓴다 */
function themeFromCss(): { theme: Record<string, string>; font: string; fg: string } {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  const bg = v('--code-bg', '#0a0a0a')
  const fg = v('--code-fg', '#f2f2f2')
  return {
    theme: { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: 'rgba(160,160,160,0.45)' },
    font: v('--mono', 'monospace'),
    fg,
  }
}

/** 찾기 강조색 (#RRGGBB만 받는다). 빨강은 사람이 봐야 할 것에만 쓰므로 회색 단계로 */
function searchOptions(incremental = false): ISearchOptions {
  const hex = (c: string): string => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#f2f2f2')
  return {
    incremental,
    decorations: { matchBackground: '#4a4a4a', matchOverviewRuler: '#8a8a8a', activeMatchBackground: '#8a8a8a', activeMatchBorder: hex(themeFromCss().fg), activeMatchColorOverviewRuler: hex(themeFromCss().fg) },
  }
}

// 메인에서 오는 출력·종료는 한 곳에서 받아 터미널별 화면으로 나눈다
let wired = false
function wire(): void {
  if (wired) return
  wired = true
  window.api.onTerminalData(({ termId, data }) => {
    const e = entries.get(termId)
    if (!e) return
    e.term.write(data)
    e.markReady()
    if (e.cmd) watchQuiet(termId, e)
  })
  window.api.onTerminalExit(({ termId, code }) => {
    const e = entries.get(termId)
    if (!e) return
    e.started = false
    e.cmd = undefined
    e.term.write(`\r\n\x1b[2m[셸이 끝났어요 · 코드 ${code}]\x1b[0m\r\n`)
    setTab(e.conversationId, termId, { exited: code })
  })
  // 테마를 바꾸면 터미널 색도 따라간다
  new MutationObserver(() => {
    const { theme } = themeFromCss()
    entries.forEach((e) => (e.term.options.theme = theme))
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

// ── 오래 돈 명령이 끝나면 알림 ─────────────────────────────
// 셸 통합 없이: Enter로 명령을 시작하고, 출력이 잠잠해졌을 때 커서 줄이 프롬프트처럼 보이면 끝난 것으로 본다.
// 서버처럼 계속 도는 명령은 프롬프트로 돌아오지 않으니 알리지 않는다

const LONG_MS = 10_000
// e2e 테스트는 window.__termLongMs로 줄여 기다리는 시간을 아낀다
const longMs = (): number => (window as { __termLongMs?: number }).__termLongMs ?? LONG_MS
const QUIET_MS = 800
/** 줄 끝이 프롬프트 기호 (PS C:\x> · C:\x> · user@host:~$ · % · ❯ …) */
const PROMPT_END = /[>$#%❯➜λ»]$/
/** 프롬프트 뒤의 명령 글자 */
const AFTER_PROMPT = /^(?:PS [^>]*>|[A-Za-z]:\\[^>]*>|.*?[$#%❯➜λ»])\s?(.*)$/

function cursorLine(term: Terminal): string {
  const buf = term.buffer.active
  return buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? ''
}

function onInput(e: Entry, d: string): void {
  const enter = d.indexOf('\r')
  if (enter < 0) {
    if (d === '\x7f' || d === '\b') e.typed = e.typed.slice(0, -1)
    else if (!d.startsWith('\x1b')) e.typed += d.replace(/[\x00-\x1f]/g, '')
    return
  }
  const typed = (e.typed + d.slice(0, enter)).trim()
  e.typed = ''
  // 전체 화면 프로그램(vim·less …) 안의 Enter는 명령이 아니다
  if (e.term.buffer.active.type !== 'normal') return
  // 화면의 프롬프트 뒤 글자가 정확하다 (방향키·기록으로 고친 것까지). 아직 안 찍혔으면 친 글자로
  const text = AFTER_PROMPT.exec(cursorLine(e.term))?.[1]?.trim() || typed
  e.cmd = text ? { text, at: Date.now() } : undefined
}

function watchQuiet(termId: string, e: Entry): void {
  if (e.quiet) clearTimeout(e.quiet)
  e.quiet = setTimeout(() => {
    e.quiet = undefined
    const cmd = e.cmd
    if (!cmd || e.term.buffer.active.type !== 'normal' || !PROMPT_END.test(cursorLine(e.term).trimEnd())) return
    e.cmd = undefined
    const ms = Date.now() - cmd.at - QUIET_MS
    if (ms >= longMs()) commandDone(termId, e, cmd.text, ms)
  }, QUIET_MS)
}

const duration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}

function looking(conversationId: string, termId: string): boolean {
  const ui = getUi(conversationId)
  return document.hasFocus() && shownConversation === conversationId && ui.open && ui.expanded && ui.active === termId
}

function commandDone(termId: string, e: Entry, text: string, ms: number): void {
  if (looking(e.conversationId, termId)) return
  setTab(e.conversationId, termId, { done: true })
  const n = getUi(e.conversationId).order.indexOf(termId) + 1
  window.api.notifyTerminal(e.projectId, e.conversationId, termId, `COMMAND DONE · TERMINAL ${String(n).padStart(2, '0')}`, `${text.slice(0, 120)} · ${duration(ms)}`)
}

// ── 링크 ─────────────────────────────────────────────────
// URL과 파일 경로는 Ctrl(macOS는 Cmd)+클릭. 그냥 누르면 터미널을 누르는 것과 같다 (실수로 열리지 않게)

/** 경로처럼 보이는 것: 드라이브·./·../·/로 시작하거나 폴더 구분이 있고, 확장자가 있다. :줄(:칸)이 붙을 수 있다 */
const PATH_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/]|[\w@.-]+[\\/])[\w@.\-\\/]*\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?/g
const withMod = (ev: MouseEvent): boolean => ev.ctrlKey || ev.metaKey

function pathLinks(e: Entry, y: number): ILink[] {
  const line = e.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
  const links: ILink[] = []
  for (const m of line.matchAll(PATH_RE)) {
    const text = m[0]
    // URL 안의 경로는 URL 링크가 맡는다
    if (/[a-z]+:\/\/\S*$/i.test(line.slice(0, m.index))) continue
    links.push({
      text,
      range: { start: { x: m.index + 1, y }, end: { x: m.index + text.length, y } },
      decorations: { underline: true, pointerCursor: true },
      activate: (ev) => {
        if (withMod(ev)) pathSinks.get(e.conversationId)?.(text)
      },
      hover: () => (e.el.title = 'Ctrl+클릭하면 입력창에 경로를 넣어요'),
      leave: () => (e.el.title = ''),
    })
  }
  return links
}

/** 터미널 출력의 경로 → 입력창에 넣을 글자. 대화 폴더 안이면 @상대경로, 줄 번호는 뒤에 (L12) */
export function pathForComposer(raw: string, root: string): string {
  const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(raw)!
  let path = m[1]
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const p = norm(path)
  const isWin = /^[A-Za-z]:/.test(r)
  const under = isWin ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`)
  if (under) path = p.slice(r.length + 1)
  else if (/^\.[\\/]/.test(path)) path = norm(path.slice(2))
  const absolute = /^([A-Za-z]:[\\/]|\/)/.test(path)
  return `${absolute ? path : `@${norm(path)}`}${m[2] ? ` (L${m[2]})` : ''} `
}

// ── 터미널 화면 ───────────────────────────────────────────

/** 첫 출력을 다시 기다린다 (새 셸을 띄울 때) */
function armReady(e: Entry): void {
  e.ready = new Promise<void>((r) => (e.markReady = r))
}

function entryOf(projectId: string, conversationId: string, termId: string): Entry {
  wire()
  const found = entries.get(termId)
  if (found) return found
  const { theme, font } = themeFromCss()
  // allowProposedApi: 찾기 결과 강조(decorations)에 필요
  const term = new Terminal({ fontFamily: font, fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme, allowProposedApi: true })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((ev, uri) => withMod(ev) && window.open(uri)))
  const el = document.createElement('div')
  el.className = 'term-xterm'
  const entry: Entry = { term, fit, search, el, projectId, conversationId, opened: false, started: false, ready: Promise.resolve(), markReady: () => {}, typed: '' }
  armReady(entry)
  term.registerLinkProvider({ provideLinks: (y, cb) => cb(pathLinks(entry, y)) })
  term.onData((d) => {
    onInput(entry, d)
    window.api.terminalWrite(termId, d)
  })
  term.onResize(({ cols, rows }) => window.api.terminalResize(termId, cols, rows))
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    // 복사·붙여넣기: 선택이 있을 때 Ctrl+C는 복사 (없으면 셸로 ^C), Ctrl+Shift+C/V
    const copy = (e.ctrlKey && e.shiftKey && e.code === 'KeyC') || (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && term.hasSelection())
    if (copy) {
      void navigator.clipboard.writeText(term.getSelection()).catch(() => {})
      term.clearSelection()
      return false
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {})
      return false
    }
    if (matches(e, keymap.terminalFind)) {
      e.preventDefault()
      openFind(conversationId)
      return false
    }
    return true
  })
  entries.set(termId, entry)
  return entry
}

function disposeEntry(termId: string): void {
  const e = entries.get(termId)
  if (!e) return
  if (e.quiet) clearTimeout(e.quiet)
  e.term.dispose()
  entries.delete(termId)
}

/** 셸을 띄운다 (이미 떠 있으면 그대로). 앱을 새로 고친 뒤라면 지금까지의 출력을 다시 그린다 */
async function start(projectId: string, conversationId: string, termId: string, shell?: TerminalShell): Promise<void> {
  const e = entryOf(projectId, conversationId, termId)
  if (e.started) return
  e.started = true
  try {
    const info = await window.api.terminalOpen(projectId, conversationId, termId, e.term.cols, e.term.rows, shell)
    if (info.buffer) {
      e.term.write(info.buffer)
      e.markReady()
    }
    setTab(conversationId, termId, { info: { shell: info.shell, kind: info.kind, cwd: info.cwd, pid: info.pid }, exited: undefined })
  } catch (err) {
    e.started = false
    e.term.write(`\x1b[31m셸을 띄우지 못했어요: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
  }
}

/** 새 탭을 만들어 지금 탭으로 */
function addTab(projectId: string, conversationId: string, shell?: TerminalShell): string {
  const ui = getUi(conversationId)
  const termId = `${conversationId}#${ui.seq}`
  setUi(conversationId, (u) => ({ open: true, expanded: true, order: [...u.order, termId], tabs: { ...u.tabs, [termId]: {} }, active: termId, seq: u.seq + 1, focus: u.focus + 1 }))
  void start(projectId, conversationId, termId, shell)
  return termId
}

/** 지금 탭 (없으면 만든다) */
function activeTab(projectId: string, conversationId: string): string {
  const ui = getUi(conversationId)
  return ui.active && ui.tabs[ui.active] ? ui.active : addTab(projectId, conversationId)
}

/** 탭을 닫는다 (셸을 끝낸다). 마지막 탭이면 서랍도 닫는다. refocus면 남은 탭의 터미널로 포커스를 옮긴다 */
function closeTab(conversationId: string, termId: string, refocus = true): void {
  void window.api.terminalClose(termId)
  disposeEntry(termId)
  setUi(conversationId, (ui) => {
    const at = ui.order.indexOf(termId)
    const order = ui.order.filter((t) => t !== termId)
    const tabs = { ...ui.tabs }
    delete tabs[termId]
    if (order.length === 0) return { ...CLOSED, seq: ui.seq }
    const active = ui.active === termId ? order[Math.min(at, order.length - 1)] : ui.active
    return { order, tabs, active, focus: refocus ? ui.focus + 1 : ui.focus }
  })
}

/** 다른 셸로 바꾼다: 지금 셸을 끝내고 화면을 비운 뒤 새로 띄운다. 고른 셸은 다음 터미널의 기본값도 된다 */
function switchShell(projectId: string, conversationId: string, termId: string, shell: TerminalShell): void {
  const e = entryOf(projectId, conversationId, termId)
  e.term.reset()
  e.started = false
  e.cmd = undefined
  armReady(e)
  setTab(conversationId, termId, { exited: undefined })
  setUi(conversationId, (ui) => ({ focus: ui.focus + 1 }))
  void start(projectId, conversationId, termId, shell)
}

function openFind(conversationId: string): void {
  setUi(conversationId, (ui) => ({ finding: true, find: ui.find + 1 }))
}

let shellList: Promise<TerminalShellOption[]> | null = null
const shells = (): Promise<TerminalShellOption[]> => (shellList ??= window.api.terminalShells())

/** 셸 칸: 누르면 이 컴퓨터에 있는 셸이 펼쳐진다. 위아래·Ctrl+N/P(J/K)로 이동, Enter로 고르기, Esc로 닫기 */
function ShellPicker({ info, onPick }: { info?: TerminalInfo; onPick: (shell: TerminalShell | null) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const shown = usePresence(open ? true : null, 220)
  const [list, setList] = useState<TerminalShellOption[] | null>(null)
  const [index, setIndex] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    void shells().then((l) => {
      setList(l)
      setIndex(Math.max(0, l.findIndex((o) => o.id === info?.kind)))
    })
    const close = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (o: TerminalShellOption): void => {
    setOpen(false)
    // 지금과 같은 셸이면 그대로 둔다
    onPick(info && o.kind === info.kind ? null : o.id)
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
    <div className="term-pick" ref={boxRef}>
      <button type="button" className={`term-shell ${open ? 'open' : ''}`} title="셸을 바꿔요 (지금 셸은 끝나요)" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {info?.shell ?? '…'}
        <span className="model-caret" aria-hidden="true">▾</span>
      </button>
      {shown.item && (
        <div className={`model-list term-shells ${shown.leaving ? 'leaving' : ''}`} role="listbox" aria-label="셸 고르기" tabIndex={-1} data-keys-own="true" onKeyDown={onKey} ref={(el) => { if (el && !shown.leaving) el.focus() }}>
          <ListHead label="SHELL" count={list?.length} />
          {!list && <div className="slash-empty">셸을 찾는 중…</div>}
          {list?.map((o, i) => {
            const on = o.id !== 'auto' && o.id === info?.kind
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`model-row ${i === index ? 'hi' : ''} ${on ? 'on' : ''}`}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => pick(o)}
              >
                <span className="model-name">
                  {o.label}
                  {on && <span className="model-now">IN USE</span>}
                </span>
                <span className="model-desc mono" title={o.note}>{o.note}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 찾기 줄: Enter 다음, Shift+Enter 이전, Esc 닫고 터미널로 */
function FindBar({ entry, focusKey, leaving, onClose }: { entry: Entry; focusKey: number; leaving: boolean; onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusKey])
  useEffect(() => {
    const d = entry.search.onDidChangeResults(({ resultIndex, resultCount }) => setResult({ index: resultIndex, count: resultCount }))
    return () => {
      d.dispose()
      entry.search.clearDecorations()
    }
  }, [entry])

  const find = (dir: 1 | -1, incremental = false): void => {
    if (!q) return
    if (dir === 1) entry.search.findNext(q, searchOptions(incremental))
    else entry.search.findPrevious(q, searchOptions())
  }
  useEffect(() => {
    if (q) entry.search.findNext(q, searchOptions(true))
    else {
      entry.search.clearDecorations()
      setResult(null)
    }
  }, [q, entry])

  const close = (): void => {
    onClose()
    requestAnimationFrame(() => entry.term.focus())
  }

  return (
    <div className={`term-find ${leaving ? 'leaving' : ''}`} role="search">
      <input
        ref={inputRef}
        className="term-find-q mono"
        aria-label="터미널에서 찾기"
        placeholder="FIND"
        value={q}
        // 이 칸이 키를 처리한다 (Esc가 실행 중단으로 가지 않게)
        data-keys-own="true"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            find(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      />
      <span className="term-find-n">{q && result ? (result.count ? `${result.index + 1}/${result.count}` : 'NONE') : ''}</span>
      <button type="button" className="term-btn" onClick={() => find(-1)} disabled={!q} aria-label="이전 결과" title="이전 (Shift+Enter)">↑</button>
      <button type="button" className="term-btn" onClick={() => find(1)} disabled={!q} aria-label="다음 결과" title="다음 (Enter)">↓</button>
      <button type="button" className="term-btn term-x" onClick={close} aria-label="찾기 닫기" title="닫기 (Esc)">×</button>
    </div>
  )
}

const focused = (): boolean => !!document.activeElement?.closest('[data-terminal]')

/**
 * Ctrl+T: 닫혀 있거나 접혀 있으면 펼치고 터미널로, 펼쳐져 있으면 터미널 ↔ 입력창.
 * 터미널에서 누르면 접고 입력창으로 돌아간다 (돌아갈 곳은 onLeave)
 */
export function toggleTerminal(projectId: string, conversationId: string, onLeave: () => void): void {
  const ui = getUi(conversationId)
  if (!ui.open || !ui.expanded) {
    const termId = activeTab(projectId, conversationId)
    setUi(conversationId, (u) => ({ open: true, expanded: true, focus: u.focus + 1 }))
    void start(projectId, conversationId, termId)
  } else if (focused()) {
    setUi(conversationId, { expanded: false })
    onLeave()
  } else {
    setUi(conversationId, (u) => ({ focus: u.focus + 1 }))
  }
}

/** 지금 터미널 탭을 닫는다 (서랍의 ×와 같다). 터미널에서 닫았는데 남은 탭이 없으면 입력창으로 (onLeave) */
export function closeTerminal(conversationId: string, onLeave: () => void): void {
  const ui = getUi(conversationId)
  if (!ui.open || !ui.active) return
  const wasFocused = focused()
  closeTab(conversationId, ui.active, wasFocused)
  if (wasFocused && !getUi(conversationId).open) onLeave()
}

/** 새 터미널 탭 (서랍이 닫혀 있으면 열면서) */
export function newTerminal(projectId: string, conversationId: string): void {
  addTab(projectId, conversationId)
}

/** 터미널 탭을 차례로 옮긴다. 탭이 하나뿐이면 그 터미널로 */
export function stepTerminal(projectId: string, conversationId: string, dir: 1 | -1): void {
  const ui = getUi(conversationId)
  if (ui.order.length === 0) return toggleTerminal(projectId, conversationId, () => {})
  const at = ui.active ? ui.order.indexOf(ui.active) : 0
  const active = ui.order[(at + dir + ui.order.length) % ui.order.length]
  setUi(conversationId, (u) => ({ open: true, expanded: true, active, focus: u.focus + 1 }))
}

/** 알림을 눌렀을 때: 그 터미널을 펼친다 */
export function showTerminal(conversationId: string, termId: string): void {
  if (!getUi(conversationId).tabs[termId]) return
  setUi(conversationId, (u) => ({ open: true, expanded: true, active: termId, focus: u.focus + 1 }))
}

/** 명령을 지금 터미널의 입력줄에 넣는다. 실행(Enter)은 사용자가 */
export async function runInTerminal(projectId: string, conversationId: string, command: string): Promise<void> {
  const termId = activeTab(projectId, conversationId)
  setUi(conversationId, (u) => ({ open: true, expanded: true, focus: u.focus + 1 }))
  const e = entryOf(projectId, conversationId, termId)
  await start(projectId, conversationId, termId)
  // 프롬프트가 뜨기 전에 넣으면 사라질 수 있어 첫 출력까지 (길어야 3초) 기다린다
  await Promise.race([e.ready, new Promise((r) => setTimeout(r, 3000))])
  e.term.paste(command.replace(/\r?\n$/, ''))
}

interface DrawerProps {
  projectId: string
  conversationId: string
  /** 선택한 출력 → 입력창 (코드 블록) */
  onSend: (text: string) => void
  /** Ctrl+클릭한 경로 → 입력창 */
  onPath: (path: string) => void
}

export function TerminalDrawer({ projectId, conversationId, onSend, onPath }: DrawerProps): React.JSX.Element | null {
  const km = useKeymap()
  const ui = useTerminalUi(conversationId)
  const finding = usePresence(ui.finding ? true : null, 220)
  const hostRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [height, setHeight] = useState(savedHeight)
  const [selection, setSelection] = useState(false)
  // 버튼을 누르는 사이 선택이 풀릴 수 있어 마지막 선택 글자를 따로 둔다
  const picked = useRef('')
  const active = ui.active
  const tab = active ? ui.tabs[active] : undefined

  useEffect(() => {
    keymap = km
  }, [km])
  useEffect(() => {
    pathSinks.set(conversationId, onPath)
    return () => {
      if (pathSinks.get(conversationId) === onPath) pathSinks.delete(conversationId)
    }
  }, [conversationId, onPath])

  // 화면 붙이기: 펼쳐져 있을 때 지금 탭의 xterm을 서랍에 옮겨 단다
  useEffect(() => {
    const host = hostRef.current
    if (!ui.open || !host || !active) return
    shownConversation = conversationId
    const e = entryOf(projectId, conversationId, active)
    if (e.el.parentElement !== host) host.appendChild(e.el)
    if (!e.opened) {
      e.term.open(e.el)
      e.opened = true
    }
    const sel = e.term.onSelectionChange(() => {
      const text = e.term.getSelection()
      if (text.trim()) picked.current = text
      setSelection(e.term.hasSelection() && !!text.trim())
    })
    setSelection(e.term.hasSelection())
    const fit = (): void => {
      if (!ui.expanded || host.clientHeight < 20) return
      try {
        e.fit.fit()
      } catch {
        // 보이지 않는 동안
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    return () => {
      ro.disconnect()
      sel.dispose()
      if (e.el.parentElement === host) host.removeChild(e.el)
      if (shownConversation === conversationId) shownConversation = null
    }
  }, [conversationId, ui.open, ui.expanded, active]) // eslint-disable-line react-hooks/exhaustive-deps

  // 펼쳐서 본 탭은 '끝남' 표시를 지운다
  useEffect(() => {
    if (ui.open && ui.expanded && active && tab?.done) setTab(conversationId, active, { done: false })
  }, [ui.open, ui.expanded, active, tab?.done, conversationId])

  useEffect(() => {
    if (ui.open && ui.expanded && ui.focus && active) requestAnimationFrame(() => entries.get(active)?.term.focus())
  }, [ui.focus, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 열고 닫고 접는 움직임. 접히는 동안(folding)은 펼친 모습 그대로 높이만 줄이고, 닫히는 동안(leaving)은 마지막 화면을 붙잡아 둔다
  const isOpen = ui.open && !!active
  const [seen, setSeen] = useState({ conv: conversationId, open: isOpen, expanded: ui.expanded })
  const [folding, setFolding] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const lastView = useRef<ReactElement<{ className: string }> | null>(null)
  if (seen.conv !== conversationId || seen.open !== isOpen || seen.expanded !== ui.expanded) {
    // 대화를 옮겨서 바뀐 것은 움직이지 않는다
    const same = seen.conv === conversationId && !reducedMotion()
    setSeen({ conv: conversationId, open: isOpen, expanded: ui.expanded })
    setLeaving(same && seen.open && !isOpen && lastView.current !== null)
    setFolding(same && isOpen && seen.open && seen.expanded && !ui.expanded)
  }
  const look = ui.expanded || folding
  const phase = leaving ? 'leaving' : !isOpen ? 'closed' : folding ? 'folding' : look ? 'open' : 'folded'
  useDrawerMotion(sectionRef, conversationId, phase, () => setFolding(false), () => setLeaving(false))

  if (!isOpen) return leaving && lastView.current ? cloneElement(lastView.current, { className: `${lastView.current.props.className} leaving` }) : null

  const startResize = (ev: React.PointerEvent): void => {
    ev.preventDefault()
    const startY = ev.clientY
    const startH = height
    let next = startH
    const move = (e: PointerEvent): void => {
      next = Math.round(Math.min(Math.max(startH + (startY - e.clientY), 120), window.innerHeight * 0.75))
      setHeight(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(HEIGHT_KEY, String(next))
      } catch {
        // 저장하지 못해도 이번에는 그대로
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const fold = (): void => setUi(conversationId, (u) => ({ expanded: !u.expanded, focus: u.expanded ? u.focus : u.focus + 1 }))
  const restart = (): void => {
    setTab(conversationId, active, { exited: undefined })
    setUi(conversationId, (u) => ({ focus: u.focus + 1 }))
    void start(projectId, conversationId, active)
  }
  const send = (): void => {
    const e = entries.get(active)
    const text = (e?.term.getSelection() || picked.current).replace(/\s+$/, '')
    if (!text) return
    e?.term.clearSelection()
    picked.current = ''
    onSend(text)
  }
  const select = (termId: string): void => setUi(conversationId, (u) => ({ active: termId, expanded: true, focus: u.focus + 1 }))
  const entry = entries.get(active)
  const anyDone = ui.order.some((t) => ui.tabs[t]?.done)

  const view = (
    <section ref={sectionRef} className={`term ${look ? 'open' : 'folded'}`} style={look ? { height } : undefined} aria-label="터미널">
      {look && <div className="term-grip" onPointerDown={startResize} title="끌어서 높이를 바꿔요" aria-hidden="true" />}
      <header className="term-head">
        <button type="button" className="term-title" onClick={fold} title={ui.expanded ? '접어요 (셸은 계속 돌아요)' : '펼쳐요'} aria-expanded={ui.expanded}>
          <span className={`term-sq ${tab?.exited === undefined ? '' : 'off'}`} aria-hidden="true" />
          <b>TERMINAL</b>
          {!ui.expanded && anyDone && <span className="term-done">DONE</span>}
        </button>
        {ui.order.length > 1 && (
          <nav className="term-tabs" aria-label="터미널 탭">
            {ui.order.map((t, i) => {
              const s = ui.tabs[t]
              return (
                <button
                  key={t}
                  type="button"
                  className={`term-tab ${t === active ? 'on' : ''} ${s?.exited !== undefined ? 'off' : ''}`}
                  aria-current={t === active}
                  onClick={() => select(t)}
                  title={`${s?.info?.shell ?? ''}${s?.done ? ' · 명령이 끝났어요' : ''}`}
                >
                  {String(i + 1).padStart(2, '0')} <span>{s?.info?.shell ?? '…'}</span>
                  {s?.done && <i className="term-tab-done" aria-label="명령이 끝났어요" />}
                </button>
              )
            })}
          </nav>
        )}
        <button type="button" className="term-add" onClick={() => newTerminal(projectId, conversationId)} title="새 터미널" aria-label="새 터미널">+</button>
        <ShellPicker info={tab?.info} onPick={(shell) => (shell ? switchShell(projectId, conversationId, active, shell) : entries.get(active)?.term.focus())} />
        {/* 빈 곳을 눌러도 접고 펼친다 (버튼은 위의 TERMINAL) */}
        <div className="term-fill" onClick={fold} aria-hidden="true">
          {tab?.info && <span className="term-cwd mono">{tab.info.cwd}</span>}
          {tab?.exited !== undefined && <span className="term-exit">EXITED {tab.exited}</span>}
        </div>
        <div className="term-actions">
          {tab?.exited !== undefined && (
            <button type="button" className="term-btn" onClick={restart}>RESTART</button>
          )}
          {ui.expanded && (
            <button type="button" className={`term-btn ${ui.finding ? 'armed' : ''}`} onClick={() => openFind(conversationId)} title="출력에서 찾아요">
              FIND
            </button>
          )}
          {/* 누를 때 포커스를 옮기지 않아 선택이 유지된다 */}
          <button type="button" className="term-btn" disabled={!selection} onMouseDown={(ev) => ev.preventDefault()} onClick={send} title="선택한 출력을 입력창에 붙여 Claude에게 물어봐요">
            SEND TO CLAUDE
          </button>
          <button type="button" className="term-btn" onClick={fold} title={ui.expanded ? '접어요 (셸은 계속 돌아요)' : '펼쳐요'}>
            {ui.expanded ? 'FOLD' : 'UNFOLD'}
          </button>
          <button type="button" className="term-btn term-x" onClick={() => closeTab(conversationId, active)} title={ui.order.length > 1 ? '이 터미널의 셸을 끝내고 닫아요' : '셸을 끝내고 닫아요'} aria-label="터미널 닫기">×</button>
        </div>
      </header>
      <div className="term-body" hidden={!look}>
        {finding.item && entry && <FindBar key={active} entry={entry} focusKey={ui.find} leaving={finding.leaving} onClose={() => setUi(conversationId, { finding: false })} />}
        {/* data-terminal: 여기에 포커스가 있으면 App이 Esc·Ctrl+C 등을 가로채지 않고 셸로 보낸다 */}
        <div className="term-host" ref={hostRef} data-terminal="true" />
      </div>
    </section>
  )
  lastView.current = view
  return view
}

type Phase = 'closed' | 'open' | 'folded' | 'folding' | 'leaving'

/**
 * 서랍 높이를 이전 모습에서 새 모습으로 움직인다 (한 번씩만, 끌어서 바꾼 높이는 움직이지 않음).
 * 움직이는 동안 본문 높이를 고정해 xterm이 프레임마다 다시 맞추지(fit) 않게 하고, 바깥 틀이 잘라 보인다
 */
function useDrawerMotion(ref: React.RefObject<HTMLElement | null>, conversationId: string, phase: Phase, onFolded: () => void, onLeft: () => void): void {
  const last = useRef<{ conv: string; phase: Phase; h: number } | null>(null)
  const anim = useRef<Animation | null>(null)
  const stop = (): void => {
    anim.current?.cancel()
    anim.current = null
    const el = ref.current
    el?.classList.remove('moving')
    const body = el?.querySelector<HTMLElement>('.term-body')
    if (body) {
      body.style.flex = ''
      body.style.height = ''
    }
  }
  useLayoutEffect(() => {
    const el = ref.current
    const before = last.current
    const height = (): number => el?.getBoundingClientRect().height ?? 0
    last.current = { conv: conversationId, phase, h: height() }
    if (before?.phase === phase && before.conv === conversationId) return
    if (!el || !before || before.conv !== conversationId || (before.phase === 'closed' && phase !== 'open' && phase !== 'folded') || reducedMotion()) {
      stop()
      return
    }
    // 움직이던 중이면 지금 보이는 높이에서 이어 간다
    const from = before.phase === 'closed' ? 0 : anim.current ? height() : before.h
    stop()
    const head = el.querySelector<HTMLElement>('.term-head')
    const body = el.querySelector<HTMLElement>('.term-body')
    const border = parseFloat(getComputedStyle(el).borderTopWidth) || 0
    const natural = height()
    const to = phase === 'folding' ? border + (head?.clientHeight ?? 0) : phase === 'leaving' ? 0 : natural
    const done = phase === 'folding' ? onFolded : phase === 'leaving' ? onLeft : undefined
    if (Math.abs(from - to) < 2) {
      done?.()
      return
    }
    if (body && !body.hidden) {
      const bodyHeight = body.getBoundingClientRect().height
      body.style.flex = '0 0 auto'
      body.style.height = `${bodyHeight}px`
      if (phase === 'open') body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 60, easing: EASE, fill: 'backwards' })
    }
    el.classList.add('moving')
    const growing = to > from
    // 접히고 닫히는 끝 모습은 다음 렌더가 이어받을 때까지 붙잡아 둔다 (한 프레임 튐 방지)
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: growing ? 320 : phase === 'leaving' ? 200 : 240,
      easing: growing ? EASE : 'cubic-bezier(0.65, 0, 0.35, 1)',
      fill: done ? 'forwards' : 'none',
    })
    anim.current = a
    a.onfinish = () => {
      if (anim.current !== a) return
      if (done) return done()
      stop()
      // 다음 움직임의 출발 높이
      if (last.current) last.current.h = height()
    }
  })
  useEffect(() => () => anim.current?.cancel(), [])
}
