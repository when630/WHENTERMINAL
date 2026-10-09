// 단축키 표시: 수정 키·특수 키는 아이콘, 글자 키는 글자 그대로. 화면 읽기 프로그램에는 전체 이름을 읽어 준다.

type IconKey = 'ctrl' | 'shift' | 'alt' | 'enter' | 'esc' | 'tab' | 'space'

const NAMES: Record<IconKey, string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  enter: 'Enter',
  esc: 'Esc',
  tab: 'Tab',
  space: 'Space',
}

const ALIASES: Record<string, IconKey> = {
  ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl',
  shift: 'shift', '⇧': 'shift',
  alt: 'alt', option: 'alt', opt: 'alt', '⌥': 'alt',
  enter: 'enter', return: 'enter', '↵': 'enter',
  esc: 'esc', escape: 'esc',
  tab: 'tab',
  space: 'space',
}

/** 16×16, 선 굵기 1.8, 모서리 없는 선. G안의 굵은 선에 맞춤 */
const ICONS: Record<IconKey, React.JSX.Element> = {
  ctrl: <path d="M3.5 10.5 8 5.5l4.5 5" />,
  shift: <path d="M8 2.5 13.5 8.5H10.5V13.5H5.5V8.5H2.5Z" strokeLinejoin="miter" />,
  alt: <path d="M2 4.5h3.5l5 7H14M10 4.5h4" />,
  enter: <path d="M13 3v6.5H3.5M6.5 6.5l-3 3 3 3" />,
  esc: <path d="M3 3h4.2M3 3v4.2M3 3l5.2 5.2M6.6 2.7a5.6 5.6 0 1 1-3.9 3.9" />,
  tab: <path d="M2 8h10M9 5l3 3-3 3M14 4v8" />,
  space: <path d="M2.5 7v4h11V7" />,
}

function Icon({ k }: { k: IconKey }): React.JSX.Element {
  return (
    <svg className="key-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden="true">
      {ICONS[k]}
    </svg>
  )
}

/**
 * keys: 'ctrl shift l', 'Ctrl+Shift+Space', 'alt a' 처럼 공백이나 +로 구분.
 * 'A S D…'처럼 여러 글자를 나열하려면 그대로 넘기면 된다 (아이콘이 아닌 토큰은 글자로 표시)
 */
export function Keys({ keys, className }: { keys: string; className?: string }): React.JSX.Element {
  const tokens = keys.split(/[\s+]+/).filter(Boolean)
  const label = tokens.map((t) => NAMES[ALIASES[t.toLowerCase()]] ?? t).join('+')
  return (
    <kbd className={`keys ${className ?? ''}`} aria-label={label} title={label}>
      {tokens.map((t, i) => {
        const icon = ALIASES[t.toLowerCase()]
        return icon ? <Icon key={i} k={icon} /> : <span key={i} className="key-ch">{t}</span>
      })}
    </kbd>
  )
}
