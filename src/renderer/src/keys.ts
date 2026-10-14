// 40% 배열 기준 키 규칙: 숫자 줄·방향키·F키·백틱 없이 알파벳 + 조합키만으로 모든 동작이 되게 한다.
// 숫자와 방향키는 레이어로 누를 수 있으면 보조로 그대로 동작한다.

/** macOS에서는 Alt 키 이름이 Option(⌥)이므로 화면 표기만 바꾼다. 판정은 둘 다 e.altKey */
export const IS_MAC = /Mac/i.test(navigator.platform)
export const ALT_LABEL = IS_MAC ? '⌥' : 'Alt'

/** 프로젝트 1~9에 대응하는 홈 줄 키. Alt+A = 1번, Alt+S = 2번 … Alt+L = 9번. 길이가 `MAX_PROJECTS`(types.ts)와 같아야 한다 */
export const HOME_ROW = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'] as const

/**
 * 물리 키 코드 ('KeyH', 'Digit1' …). 한글 IME와 상관없이 같은 키로 판정하려고 e.code를 쓰되,
 * e.code가 비어 오는 입력(합성 키 입력 등)은 keyCode로 대신 계산한다.
 */
export function physicalCode(e: KeyboardEvent): string {
  if (e.code) return e.code
  const k = e.keyCode
  if (k >= 65 && k <= 90) return `Key${String.fromCharCode(k)}`
  if (k >= 48 && k <= 57) return `Digit${k - 48}`
  if (k === 219) return 'BracketLeft'
  return ''
}

/** Alt+홈 줄 또는 Ctrl+숫자로 고른 프로젝트 순번(0부터). 해당 없으면 null */
export function projectIndexFromKey(e: KeyboardEvent, code: string): number | null {
  if (e.altKey && !e.ctrlKey && !e.shiftKey && code.startsWith('Key')) {
    const i = HOME_ROW.indexOf(code.slice(3) as (typeof HOME_ROW)[number])
    if (i >= 0) return i
  }
  if (e.ctrlKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(code)) return Number(code.slice(5)) - 1
  return null
}

/** Esc */
export function isEscape(e: KeyboardEvent): boolean {
  return e.key === 'Escape'
}

/** 입력창에서 선택한 글자가 없을 때의 Ctrl+C. 터미널처럼 실행 중단으로 쓴다 */
export function isInterruptCopy(e: KeyboardEvent, code: string): boolean {
  if (!(e.ctrlKey && !e.shiftKey && !e.altKey && code === 'KeyC')) return false
  const t = e.target as HTMLTextAreaElement | HTMLInputElement | null
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return t.selectionStart === t.selectionEnd
  return !window.getSelection()?.toString()
}

/** 홈 화면 카드 이동: H J K L (vim) 또는 방향키 */
export function gridMove(e: KeyboardEvent, code: string, cols: number): number | null {
  const byCode: Record<string, number> = { KeyH: -1, KeyL: 1, KeyK: -cols, KeyJ: cols }
  const byKey: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }
  return byCode[code] ?? byKey[e.key] ?? null
}

// ── 키맵 판정 (설정에서 바꾼 단축키) ──

const CODE_TOKEN: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  Backquote: '`', Minus: '-', Equal: '=', Backslash: '\\', Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
}

/** 눌린 물리 키를 키맵 표기로 ('KeyL' → 'L', 'Comma' → ','). 수정 키만 눌렸으면 '' */
export function keyToken(e: KeyboardEvent): string {
  const code = physicalCode(e) || e.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  return CODE_TOKEN[code] ?? ''
}

/** 이벤트를 키맵 표기로 ('Ctrl+Shift+L'). 수정 키만 눌렸으면 null */
export function eventToBinding(e: KeyboardEvent): string | null {
  const key = keyToken(e)
  if (!key) return null
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', key].filter(Boolean).join('+')
}

/** 이벤트가 키 조합과 정확히 같은지 (수정 키도 모두 같아야 한다) */
export function matches(e: KeyboardEvent, binding: string | undefined): boolean {
  if (!binding) return false
  return eventToBinding(e) === binding
}
