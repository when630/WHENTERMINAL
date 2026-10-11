import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '@shared/types'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'

// 대화창 아래 터미널 서랍. 대화마다 셸 하나(메인의 node-pty)와 xterm 화면 하나.
// xterm 화면은 탭을 옮겨도 버리지 않고 다시 붙여 스크롤·선택이 그대로 남는다

interface Ui {
  open: boolean
  expanded: boolean
  info?: TerminalInfo
  /** 셸이 끝났으면 종료 코드 */
  exited?: number
  /** 바뀔 때마다 터미널에 포커스 */
  focus: number
}

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  started: boolean
  /** 셸이 첫 출력을 냈는지 (프롬프트가 뜨기 전에 넣은 글자는 사라질 수 있다) */
  ready: Promise<void>
  markReady: () => void
}

const CLOSED: Ui = { open: false, expanded: false, focus: 0 }
let uis: Record<string, Ui> = {}
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function setUi(id: string, patch: Partial<Ui>): void {
  uis = { ...uis, [id]: { ...(uis[id] ?? CLOSED), ...patch } }
  listeners.forEach((l) => l())
}
const getUi = (id: string): Ui => uis[id] ?? CLOSED

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
function themeFromCss(): { theme: Record<string, string>; font: string } {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  const bg = v('--code-bg', '#0a0a0a')
  const fg = v('--code-fg', '#f2f2f2')
  return {
    theme: { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: 'rgba(160,160,160,0.45)' },
    font: v('--mono', 'monospace'),
  }
}

// 메인에서 오는 출력·종료는 한 곳에서 받아 대화별 화면으로 나눈다
let wired = false
function wire(): void {
  if (wired) return
  wired = true
  window.api.onTerminalData(({ conversationId, data }) => {
    const e = entries.get(conversationId)
    if (!e) return
    e.term.write(data)
    e.markReady()
  })
  window.api.onTerminalExit(({ conversationId, code }) => {
    const e = entries.get(conversationId)
    if (e) {
      e.started = false
      e.term.write(`\r\n\x1b[2m[셸이 끝났어요 · 코드 ${code}]\x1b[0m\r\n`)
    }
    if (uis[conversationId]?.open) setUi(conversationId, { exited: code })
  })
  // 테마를 바꾸면 터미널 색도 따라간다
  new MutationObserver(() => {
    const { theme } = themeFromCss()
    entries.forEach((e) => (e.term.options.theme = theme))
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

function entryOf(id: string): Entry {
  wire()
  const found = entries.get(id)
  if (found) return found
  const { theme, font } = themeFromCss()
  const term = new Terminal({ fontFamily: font, fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, theme, allowProposedApi: false })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const el = document.createElement('div')
  el.className = 'term-xterm'
  let markReady = (): void => {}
  const ready = new Promise<void>((r) => (markReady = r))
  const entry: Entry = { term, fit, el, opened: false, started: false, ready, markReady: () => markReady() }
  term.onData((d) => window.api.terminalWrite(id, d))
  term.onResize(({ cols, rows }) => window.api.terminalResize(id, cols, rows))
  // 복사·붙여넣기: 선택이 있을 때 Ctrl+C는 복사 (없으면 셸로 ^C), Ctrl+Shift+C/V
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
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
    return true
  })
  entries.set(id, entry)
  return entry
}

/** 셸을 띄운다 (이미 떠 있으면 그대로). 앱을 새로 고친 뒤라면 지금까지의 출력을 다시 그린다 */
async function start(projectId: string, id: string): Promise<void> {
  const e = entryOf(id)
  if (e.started) return
  e.started = true
  try {
    const info = await window.api.terminalOpen(projectId, id, e.term.cols, e.term.rows)
    if (info.buffer) {
      e.term.write(info.buffer)
      e.markReady()
    }
    setUi(id, { info: { shell: info.shell, cwd: info.cwd, pid: info.pid }, exited: undefined })
  } catch (err) {
    e.started = false
    e.term.write(`\x1b[31m셸을 띄우지 못했어요: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
  }
}

const focused = (): boolean => !!document.activeElement?.closest('[data-terminal]')

/**
 * Ctrl+T: 닫혀 있거나 접혀 있으면 펼치고 터미널로, 펼쳐져 있으면 터미널 ↔ 입력창.
 * 터미널에서 누르면 접고 입력창으로 돌아간다 (돌아갈 곳은 onLeave)
 */
export function toggleTerminal(projectId: string, id: string, onLeave: () => void): void {
  const ui = getUi(id)
  if (!ui.open || !ui.expanded) {
    setUi(id, { open: true, expanded: true, focus: ui.focus + 1 })
    void start(projectId, id)
  } else if (focused()) {
    setUi(id, { expanded: false })
    onLeave()
  } else {
    setUi(id, { focus: ui.focus + 1 })
  }
}

/** 명령을 터미널 입력줄에 넣는다. 실행(Enter)은 사용자가 */
export async function runInTerminal(projectId: string, id: string, command: string): Promise<void> {
  const ui = getUi(id)
  setUi(id, { open: true, expanded: true, focus: ui.focus + 1 })
  const e = entryOf(id)
  await start(projectId, id)
  // 프롬프트가 뜨기 전에 넣으면 사라질 수 있어 첫 출력까지 (길어야 3초) 기다린다
  await Promise.race([e.ready, new Promise((r) => setTimeout(r, 3000))])
  e.term.paste(command.replace(/\r?\n$/, ''))
}

export function TerminalDrawer({ projectId, conversationId, onSend }: { projectId: string; conversationId: string; onSend: (text: string) => void }): React.JSX.Element | null {
  const km = useKeymap()
  const ui = useTerminalUi(conversationId)
  const hostRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(savedHeight)
  const [selection, setSelection] = useState(false)
  // 버튼을 누르는 사이 선택이 풀릴 수 있어 마지막 선택 글자를 따로 둔다
  const picked = useRef('')

  // 화면 붙이기: 펼쳐져 있을 때 이 대화의 xterm을 서랍에 옮겨 단다
  useEffect(() => {
    const host = hostRef.current
    if (!ui.open || !host) return
    const e = entryOf(conversationId)
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
    }
  }, [conversationId, ui.open, ui.expanded])

  useEffect(() => {
    if (ui.open && ui.expanded && ui.focus) requestAnimationFrame(() => entries.get(conversationId)?.term.focus())
  }, [ui.focus, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ui.open) return null

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

  const fold = (): void => setUi(conversationId, { expanded: !ui.expanded, focus: ui.expanded ? ui.focus : ui.focus + 1 })
  const close = (): void => {
    void window.api.terminalClose(conversationId)
    const e = entries.get(conversationId)
    e?.term.dispose()
    entries.delete(conversationId)
    setUi(conversationId, { open: false, expanded: false, info: undefined, exited: undefined })
  }
  const restart = (): void => {
    setUi(conversationId, { exited: undefined, focus: ui.focus + 1 })
    void start(projectId, conversationId)
  }
  const send = (): void => {
    const e = entries.get(conversationId)
    const text = (e?.term.getSelection() || picked.current).replace(/\s+$/, '')
    if (!text) return
    e?.term.clearSelection()
    picked.current = ''
    onSend(text)
  }

  return (
    <section className={`term ${ui.expanded ? 'open' : 'folded'}`} style={ui.expanded ? { height } : undefined} aria-label="터미널">
      {ui.expanded && <div className="term-grip" onPointerDown={startResize} title="끌어서 높이를 바꿔요" aria-hidden="true" />}
      <header className="term-head">
        <button type="button" className="term-title" onClick={fold} title={ui.expanded ? '접어요 (셸은 계속 돌아요)' : '펼쳐요'} aria-expanded={ui.expanded}>
          <span className={`term-sq ${ui.exited === undefined ? '' : 'off'}`} aria-hidden="true" />
          <b>TERMINAL</b>
          {ui.info && <span className="term-shell">{ui.info.shell}</span>}
          {ui.info && <span className="term-cwd mono">{ui.info.cwd}</span>}
          {ui.exited !== undefined && <span className="term-exit">EXITED {ui.exited}</span>}
        </button>
        <div className="term-actions">
          {ui.exited !== undefined && (
            <button type="button" className="term-btn" onClick={restart}>RESTART</button>
          )}
          {/* 누를 때 포커스를 옮기지 않아 선택이 유지된다 */}
          <button type="button" className="term-btn" disabled={!selection} onMouseDown={(ev) => ev.preventDefault()} onClick={send} title="선택한 출력을 입력창에 붙여 Claude에게 물어봐요">
            SEND TO CLAUDE
          </button>
          <button type="button" className="term-btn" onClick={fold} title={ui.expanded ? '접어요 (셸은 계속 돌아요)' : '펼쳐요'}>
            {ui.expanded ? 'FOLD' : 'UNFOLD'} <Keys keys={km.terminal} />
          </button>
          <button type="button" className="term-btn term-x" onClick={close} title="셸을 끝내고 닫아요" aria-label="터미널 닫기">×</button>
        </div>
      </header>
      {/* data-terminal: 여기에 포커스가 있으면 App이 Esc·Ctrl+C 등을 가로채지 않고 셸로 보낸다 */}
      <div className="term-host" ref={hostRef} data-terminal="true" hidden={!ui.expanded} />
    </section>
  )
}
