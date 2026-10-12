import { ACTIONS, type ActionId, type ActionScope } from '@shared/keymap'
import { Keys } from './KeyHint'
import { useKeymap } from './settings'

/** 도움말을 연 화면. 그 화면의 묶음을 맨 앞에 둔다 */
export type HelpContext = 'home' | 'chat' | 'settings'

interface Group {
  id: ActionScope | 'terminal' | 'commands'
  title: string
  note: string
  /** 키맵의 동작 (바꾼 키가 그대로 보인다) */
  actions?: ActionId[]
  /** 바꿀 수 없는 키 [키, 설명] */
  fixed?: [string, string][]
}

const label = (id: ActionId): string => ACTIONS.find((a) => a.id === id)?.label ?? id

const GROUPS: Group[] = [
  {
    id: 'anywhere',
    title: 'ANYWHERE',
    note: '어느 화면에서든',
    actions: ['help', 'search', 'goHome', 'dispatch', 'quickAsk', 'openSettings'],
    fixed: [
      ['alt A S D F G H J K L', 'Go to project 1–9'],
      ['ctrl 1…9', 'Go to project (alt.)'],
      ['F11', 'Full screen'],
    ],
  },
  {
    id: 'home',
    title: 'HOME',
    note: '작업 카드와 보고함',
    actions: ['focusAsk', 'down', 'up', 'toRunning', 'toReports', 'open', 'archive', 'newTask', 'addProject'],
    fixed: [
      ['1…9', 'Open project'],
      ['enter', 'Open'],
      ['esc', 'Close report · Clear selection'],
    ],
  },
  {
    id: 'chat',
    title: 'CHAT',
    note: '대화창. 입력 중에도 Ctrl 조합은 동작해요',
    actions: ['newConversation', 'nextConversation', 'prevConversation', 'renameConversation', 'closeConversation', 'closeProject', 'clear', 'compact', 'rewind', 'cycleMode', 'cycleEffort', 'interrupt', 'panelNext', 'panelPrev', 'panelBack', 'stopTask'],
    fixed: [
      ['esc', 'Interrupt'],
      ['ctrl C', 'Interrupt (no text selected)'],
      ['enter', 'Send'],
      ['shift enter', 'New line'],
      ['up', 'Previous prompt (empty input or first line)'],
      ['down', 'Next prompt'],
      ['1…4', 'Pick an option (question box)'],
    ],
  },
  {
    id: 'terminal',
    title: 'TERMINAL',
    note: '대화창 아래 터미널. 포커스가 있으면 Esc·Ctrl+C 같은 키는 셸로 가요',
    actions: ['terminal', 'terminalNew', 'terminalNext', 'terminalPrev', 'terminalClose', 'terminalFind'],
    fixed: [
      ['ctrl shift C', 'Copy (or Ctrl+C with a selection)'],
      ['ctrl shift V', 'Paste'],
      ['ctrl Click', 'Open link · Insert file path'],
      ['enter', 'Find: next result'],
      ['shift enter', 'Find: previous result'],
      ['esc', 'Find: close'],
    ],
  },
  {
    id: 'approval',
    title: 'APPROVAL',
    note: '확인 요청이 왔을 때 (입력창 밖에서)',
    actions: ['allow', 'always', 'deny'],
  },
  {
    id: 'commands',
    title: 'COMMANDS',
    note: '대화창 입력창에 쳐요',
    fixed: [
      ['/compact', 'Summarize to free context'],
      ['/clear', 'Start a new session'],
      ['/close', 'Close this tab'],
      ['/rename', 'Rename this tab'],
      ['/rewind', 'Rewind files / chat to a message'],
      ['/resume', 'Open a past session'],
      ['/fork', 'Copy this chat into a new tab'],
      ['/export', 'Save the chat as Markdown'],
      ['/mcp', 'MCP server status'],
      ['/agents', 'Subagent types'],
      ['/permissions', 'Rules · directories · hooks'],
      ['/add-dir', 'Allow another folder'],
      ['/memory', 'Open CLAUDE.md files'],
      ['/status', 'Account · session · login'],
      ['/', 'All commands and skills'],
      ['@', 'Insert a file, folder or @agent-name'],
    ],
  },
]

const FIRST: Record<HelpContext, Group['id']> = { home: 'home', chat: 'chat', settings: 'anywhere' }

/** 모든 단축키를 화면별로 모아 보여 준다. 지금 화면의 묶음이 맨 앞 */
export function HelpOverlay({ context, hotkey, leaving, onClose }: { context: HelpContext; hotkey: string | null; leaving: boolean; onClose: () => void }): React.JSX.Element {
  const km = useKeymap()
  const first = FIRST[context]
  const groups = [...GROUPS.filter((g) => g.id === first), ...GROUPS.filter((g) => g.id !== first)]
  return (
    <div className={`help ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="help-sheet">
        <header className="help-head">
          <h1 id="help-title" className="kr">KEYS</h1>
          <p>단축키는 설정에서 바꿀 수 있어요. 바꾼 키가 여기에도 그대로 보여요.</p>
          <button type="button" className="btn ghost" onClick={onClose}>
            CLOSE
          </button>
        </header>
        <div className="help-grid">
          {groups.map((g) => (
            <section key={g.id} className={`help-group ${g.id === first ? 'here' : ''}`} aria-label={g.title}>
              <h2>
                {g.title}
                {g.id === first && <span className="help-here">HERE</span>}
              </h2>
              <p className="help-note">{g.note}</p>
              <dl>
                {g.actions?.map((id) => (
                  <div key={id}>
                    <dt><Keys keys={km[id]} /></dt>
                    <dd>{label(id)}</dd>
                  </div>
                ))}
                {g.fixed?.map(([k, text]) => (
                  <div key={k} className="fixed">
                    <dt>{k.startsWith('/') || k === '@' ? <kbd className="mono">{k}</kbd> : <Keys keys={k} />}</dt>
                    <dd>{text}</dd>
                  </div>
                ))}
                {g.id === 'anywhere' && hotkey && (
                  <div className="fixed">
                    <dt><Keys keys={hotkey} /></dt>
                    <dd>{label('summon')} (다른 앱에서도)</dd>
                  </div>
                )}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
