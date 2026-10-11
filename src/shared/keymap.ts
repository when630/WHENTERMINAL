// 단축키 맵: 동작 ID → 키 조합. 메인(전역 호출 키)과 렌더러(앱 안 단축키)가 함께 쓴다.
// 키 조합 문자열: 'Ctrl+Shift+L', 'Alt+Shift+Space', 'J', 'Ctrl+,' 처럼 수정 키 + 키 하나를 +로 잇는다.
// 글자·숫자·기호 키는 물리 키(e.code) 기준이라 한글 입력 상태에서도 같은 키로 동작한다.

export type ActionId =
  | 'summon' | 'goHome' | 'dispatch' | 'openSettings' | 'fullscreen'
  | 'addProject' | 'focusAsk' | 'down' | 'up' | 'toRunning' | 'toReports' | 'open' | 'archive' | 'newTask'
  | 'allow' | 'always' | 'deny'
  | 'nextConversation' | 'prevConversation' | 'closeConversation' | 'closeProject' | 'clear' | 'compact' | 'cycleMode' | 'interrupt'
  | 'panelNext' | 'panelPrev' | 'panelBack' | 'stopTask'

export type ActionScope = 'system' | 'anywhere' | 'home' | 'chat' | 'approval'

export interface ActionDef {
  id: ActionId
  label: string
  scope: ActionScope
  default: string
}

export const SCOPE_LABEL: Record<ActionScope, string> = {
  system: 'SYSTEM',
  anywhere: 'ANYWHERE',
  home: 'HOME',
  chat: 'CHAT',
  approval: 'APPROVAL',
}

export const ACTIONS: ActionDef[] = [
  { id: 'summon', label: 'Summon app', scope: 'system', default: 'Ctrl+Shift+Space' },
  { id: 'goHome', label: 'Go home', scope: 'anywhere', default: 'Ctrl+H' },
  { id: 'dispatch', label: 'New task', scope: 'anywhere', default: 'Ctrl+K' },
  { id: 'openSettings', label: 'Settings', scope: 'anywhere', default: 'Ctrl+,' },
  { id: 'fullscreen', label: 'Full screen (alt. to F11)', scope: 'anywhere', default: 'Ctrl+Shift+F' },
  { id: 'addProject', label: 'Add project', scope: 'home', default: 'Ctrl+N' },
  { id: 'focusAsk', label: 'Focus task input', scope: 'home', default: 'I' },
  { id: 'down', label: 'Next item', scope: 'home', default: 'J' },
  { id: 'up', label: 'Previous item', scope: 'home', default: 'K' },
  { id: 'toRunning', label: 'Jump to running', scope: 'home', default: 'H' },
  { id: 'toReports', label: 'Jump to reports', scope: 'home', default: 'L' },
  { id: 'open', label: 'Open', scope: 'home', default: 'O' },
  { id: 'archive', label: 'Archive report', scope: 'home', default: 'E' },
  { id: 'newTask', label: 'Follow-up task', scope: 'home', default: 'I' },
  { id: 'allow', label: 'Allow', scope: 'approval', default: 'Y' },
  { id: 'always', label: 'Always allow', scope: 'approval', default: 'A' },
  { id: 'deny', label: 'Deny', scope: 'approval', default: 'N' },
  { id: 'nextConversation', label: 'Next tab', scope: 'chat', default: 'Ctrl+Tab' },
  { id: 'prevConversation', label: 'Previous tab', scope: 'chat', default: 'Ctrl+Shift+Tab' },
  { id: 'closeConversation', label: 'Close tab (twice)', scope: 'chat', default: 'Ctrl+W' },
  { id: 'clear', label: 'Clear (twice)', scope: 'chat', default: 'Ctrl+L' },
  { id: 'compact', label: 'Compact', scope: 'chat', default: 'Ctrl+Shift+L' },
  { id: 'closeProject', label: 'Close project (twice)', scope: 'chat', default: 'Ctrl+Shift+W' },
  { id: 'cycleMode', label: 'Cycle mode', scope: 'chat', default: 'Shift+Tab' },
  { id: 'interrupt', label: 'Interrupt (alt. to Esc)', scope: 'chat', default: 'Ctrl+[' },
  // 오른쪽 패널의 하위 에이전트·백그라운드 작업 세부 내용
  { id: 'panelNext', label: 'Next agent / task details', scope: 'chat', default: 'Ctrl+J' },
  { id: 'panelPrev', label: 'Previous agent / task details', scope: 'chat', default: 'Ctrl+Shift+J' },
  { id: 'panelBack', label: 'Back to chat', scope: 'chat', default: 'Ctrl+B' },
  { id: 'stopTask', label: 'Stop shown task', scope: 'chat', default: 'Ctrl+Shift+X' },
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
  { id: 'poster', name: 'POSTER', note: '흰 종이와 검정, 대비가 가장 강함', colors: ['#ffffff', '#0a0a0a', '#ff2a12'] },
  { id: 'paper', name: 'PAPER', note: '누런 미색과 먹색, 눈부심이 적음', colors: ['#f4efe6', '#2e2a25', '#c4553a'] },
  { id: 'sage', name: 'SAGE', note: '옅은 초록빛 회색, 차분함', colors: ['#e8ece4', '#273029', '#b6533c'] },
  { id: 'sumi', name: 'SUMI', note: '따뜻한 어두운 회색, 밤에 편함', colors: ['#1f1e1c', '#d8d2c6', '#e07a5f'], dark: true },
  { id: 'night', name: 'NIGHT', note: '푸른 어두운 회색, 차가운 톤', colors: ['#1a1e24', '#c5cdd6', '#e5806b'], dark: true },
]

export interface NotifySettings {
  /** 확인 요청이 오면 */
  approval: boolean
  /** 작업이 끝나면 (오류·중단 포함) */
  done: boolean
  /** 창을 보고 있을 때도 알림 */
  whenFocused: boolean
}

export type AppIconId = 'wordmark' | 'prompt' | 'keycap' | 'bands' | 'question' | 'slots'

/** 앱 아이콘 (resources/icons/<id>.png, 원본은 build/icons/<id>.svg → npm run icons) */
export const APP_ICONS: { id: AppIconId; name: string; note: string }[] = [
  { id: 'wordmark', name: 'WT_', note: '사이드바 로고와 같은 모양' },
  { id: 'prompt', name: 'PROMPT', note: '작은 크기에서 가장 또렷함' },
  { id: 'keycap', name: 'KEYCAP', note: '키보드 중심 앱' },
  { id: 'bands', name: 'BANDS', note: '홈 화면의 프로젝트 띠' },
  { id: 'question', name: 'QUESTION', note: 'Dock에서 가장 눈에 띔' },
  { id: 'slots', name: 'SLOTS', note: 'A~L 프로젝트 자리' },
]

export interface Settings {
  theme: ThemeId
  appIcon: AppIconId
  notify: NotifySettings
  /** 동시에 실행할 대화 수 (OPEN-003). 0이면 제한 없음. 넘치면 대기열에서 차례를 기다린다 */
  maxConcurrent: number
  /** 탭의 +로 만든 하위 대화를 git worktree에서 실행 (OPEN-002). git 저장소가 아니면 플랜 모드로 시작 */
  worktree: boolean
  /** 로그인할 때 자동 실행 (창은 숨긴 채 트레이에). 패키징한 앱에서만 동작 */
  openAtLogin: boolean
  /** 기본값과 다른 키만 저장 */
  keymap: Partial<Keymap>
}

export const DEFAULT_SETTINGS: Settings = { theme: 'poster', appIcon: 'prompt', maxConcurrent: 3, worktree: true, openAtLogin: false, notify: { approval: true, done: true, whenFocused: false }, keymap: {} }

export function effectiveKeymap(settings: Settings): Keymap {
  return { ...DEFAULT_KEYMAP, ...settings.keymap }
}
