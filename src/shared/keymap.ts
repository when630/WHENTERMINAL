// 단축키 맵: 동작 ID → 키 조합. 메인(전역 호출 키)과 렌더러(앱 안 단축키)가 함께 쓴다.
// 키 조합 문자열: 'Ctrl+Shift+L', 'Alt+Shift+Space', 'J', 'Ctrl+,' 처럼 수정 키 + 키 하나를 +로 잇는다.
// 글자·숫자·기호 키는 물리 키(e.code) 기준이라 한글 입력 상태에서도 같은 키로 동작한다.

export type ActionId =
  | 'summon' | 'goHome' | 'dispatch' | 'openSettings'
  | 'addProject' | 'focusAsk' | 'down' | 'up' | 'toRunning' | 'toReports' | 'open' | 'archive' | 'newTask'
  | 'allow' | 'always' | 'deny'
  | 'nextConversation' | 'prevConversation' | 'closeConversation' | 'clear' | 'compact' | 'cycleMode' | 'interrupt'

export type ActionScope = 'system' | 'anywhere' | 'home' | 'chat' | 'approval'

export interface ActionDef {
  id: ActionId
  label: string
  scope: ActionScope
  default: string
}

export const SCOPE_LABEL: Record<ActionScope, string> = {
  system: '시스템 전역',
  anywhere: '앱 어디서나',
  home: '홈',
  chat: '대화창',
  approval: '확인 요청 (홈·대화창)',
}

export const ACTIONS: ActionDef[] = [
  { id: 'summon', label: '어디서든 앱 호출', scope: 'system', default: 'Ctrl+Shift+Space' },
  { id: 'goHome', label: '홈으로', scope: 'anywhere', default: 'Ctrl+H' },
  { id: 'dispatch', label: '작업 지시', scope: 'anywhere', default: 'Ctrl+K' },
  { id: 'openSettings', label: '설정 열기', scope: 'anywhere', default: 'Ctrl+,' },
  { id: 'addProject', label: '프로젝트 추가', scope: 'home', default: 'Ctrl+N' },
  { id: 'focusAsk', label: '작업 지시창으로', scope: 'home', default: 'I' },
  { id: 'down', label: '아래 항목', scope: 'home', default: 'J' },
  { id: 'up', label: '위 항목', scope: 'home', default: 'K' },
  { id: 'toRunning', label: '진행 중 첫 항목', scope: 'home', default: 'H' },
  { id: 'toReports', label: '보고함 첫 항목', scope: 'home', default: 'L' },
  { id: 'open', label: '열기', scope: 'home', default: 'O' },
  { id: 'archive', label: '보고서 보관', scope: 'home', default: 'E' },
  { id: 'newTask', label: '보고서에서 새 작업', scope: 'home', default: 'I' },
  { id: 'allow', label: '허용', scope: 'approval', default: 'Y' },
  { id: 'always', label: '항상 허용', scope: 'approval', default: 'A' },
  { id: 'deny', label: '거절', scope: 'approval', default: 'N' },
  { id: 'nextConversation', label: '다음 하위 대화', scope: 'chat', default: 'Ctrl+Tab' },
  { id: 'prevConversation', label: '이전 하위 대화', scope: 'chat', default: 'Ctrl+Shift+Tab' },
  { id: 'closeConversation', label: '대화 닫기 (두 번)', scope: 'chat', default: 'Ctrl+W' },
  { id: 'clear', label: '컨텍스트 비우기 (두 번)', scope: 'chat', default: 'Ctrl+L' },
  { id: 'compact', label: '컴팩트', scope: 'chat', default: 'Ctrl+Shift+L' },
  { id: 'cycleMode', label: '권한 모드 바꾸기', scope: 'chat', default: 'Shift+Tab' },
  { id: 'interrupt', label: '실행 중단 (Esc 외 보조 키)', scope: 'chat', default: 'Ctrl+[' },
]

export type Keymap = Record<ActionId, string>

export const DEFAULT_KEYMAP = Object.fromEntries(ACTIONS.map((a) => [a.id, a.default])) as Keymap

/** 동시에 쓰일 수 있는 범위끼리만 충돌을 따진다 (홈 키와 대화창 키는 겹쳐도 된다) */
const OVERLAP: Record<ActionScope, ActionScope[]> = {
  system: ['system', 'anywhere', 'home', 'chat', 'approval'],
  anywhere: ['system', 'anywhere', 'home', 'chat', 'approval'],
  home: ['system', 'anywhere', 'home', 'approval'],
  chat: ['system', 'anywhere', 'chat', 'approval'],
  approval: ['system', 'anywhere', 'home', 'chat', 'approval'],
}

/** 같은 키를 쓰는 다른 동작들. 보고서 상세의 newTask와 홈의 focusAsk(I)는 화면이 달라 함께 써도 된다 */
export function conflictsOf(keymap: Keymap, id: ActionId): ActionId[] {
  const me = ACTIONS.find((a) => a.id === id)!
  const key = normalize(keymap[id])
  if (!key) return []
  const allowed = new Set<string>(['focusAsk:newTask', 'newTask:focusAsk'])
  return ACTIONS.filter((a) => a.id !== id && OVERLAP[me.scope].includes(a.scope) && normalize(keymap[a.id]) === key && !allowed.has(`${id}:${a.id}`)).map((a) => a.id)
}

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

/** 'shift+ctrl+l' → 'Ctrl+Shift+L' */
export function normalize(binding: string | undefined): string {
  if (!binding) return ''
  const parts = binding.split('+').map((p) => p.trim())
  // 'Ctrl++'처럼 키가 '+'인 경우는 지원하지 않는다 (Equal로 표기)
  const mods = new Set<string>()
  let key = ''
  for (const raw of parts) {
    const p = raw.toLowerCase()
    if (p === 'ctrl' || p === 'control') mods.add('Ctrl')
    else if (p === 'alt' || p === 'option' || p === 'opt') mods.add('Alt')
    else if (p === 'shift') mods.add('Shift')
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') mods.add('Meta')
    else if (raw) key = raw.length === 1 ? raw.toUpperCase() : raw[0].toUpperCase() + raw.slice(1)
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].filter(Boolean).join('+')
}

/** Electron 전역 단축키 형식으로 ('Ctrl+Shift+Space' → 'Control+Shift+Space') */
export function toAccelerator(binding: string): string {
  return normalize(binding)
    .split('+')
    .map((p) => (p === 'Ctrl' ? 'Control' : p === 'Meta' ? 'Super' : p === 'Esc' ? 'Escape' : p))
    .join('+')
}

export type ThemeId = 'poster' | 'paper' | 'sage' | 'sumi' | 'night'

export const THEMES: { id: ThemeId; name: string; note: string; colors: [string, string, string]; dark?: boolean }[] = [
  { id: 'poster', name: '포스터', note: '흰 종이와 검정, 대비가 가장 강함', colors: ['#ffffff', '#0a0a0a', '#ff2a12'] },
  { id: 'paper', name: '종이', note: '누런 미색과 먹색, 눈부심이 적음', colors: ['#f4efe6', '#2e2a25', '#c4553a'] },
  { id: 'sage', name: '세이지', note: '옅은 초록빛 회색, 차분함', colors: ['#e8ece4', '#273029', '#b6533c'] },
  { id: 'sumi', name: '먹', note: '따뜻한 어두운 회색, 밤에 편함', colors: ['#1f1e1c', '#d8d2c6', '#e07a5f'], dark: true },
  { id: 'night', name: '밤', note: '푸른 어두운 회색, 차가운 톤', colors: ['#1a1e24', '#c5cdd6', '#e5806b'], dark: true },
]

export interface Settings {
  theme: ThemeId
  /** 기본값과 다른 키만 저장 */
  keymap: Partial<Keymap>
}

export const DEFAULT_SETTINGS: Settings = { theme: 'poster', keymap: {} }

export function effectiveKeymap(settings: Settings): Keymap {
  return { ...DEFAULT_KEYMAP, ...settings.keymap }
}
