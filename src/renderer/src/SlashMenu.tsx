import { useEffect, useState } from 'react'
import type { SlashCommandInfo } from '@shared/types'

/** 앱이 직접 처리하는 명령. SDK 목록에 같은 이름이 있어도 이 설명을 쓴다 */
export const LOCAL: SlashCommandInfo[] = [
  { name: 'compact', description: '지금까지의 대화를 요약해 컨텍스트를 줄여요', argumentHint: '[요약할 때 중점]', builtin: true },
  { name: 'close', description: '이 대화(세션)를 닫아요. 실행 중이면 멈춰요', argumentHint: '', builtin: true },
  { name: 'clear', description: '컨텍스트를 비우고 다음 메시지부터 새 세션으로 시작해요', argumentHint: '', aliases: ['reset', 'new'], builtin: true },
  { name: 'rename', description: '이 탭의 이름을 붙여요', argumentHint: '[이름]', builtin: true },
  { name: 'rewind', description: '파일·대화를 앞선 메시지 시점으로 되돌려요', argumentHint: '', builtin: true },
  { name: 'files', description: '프로젝트의 파일·폴더를 찾고 내용을 읽어요. md는 읽기 모드, html은 미리 보기로', argumentHint: '', builtin: true },
  { name: 'git', description: '브랜치·작업 공간·커밋 기록과 커밋마다 바뀐 내용을 봐요', argumentHint: '', builtin: true },
  { name: 'resume', description: '이 폴더의 지난 세션을 이어 열어요', argumentHint: '', builtin: true },
  { name: 'fork', description: '지금 대화를 복제해 새 탭에서 따로 이어 가요', argumentHint: '[이름]', builtin: true },
  { name: 'export', description: '대화를 마크다운 파일로 저장해요', argumentHint: '', builtin: true },
  { name: 'mcp', description: 'MCP 서버 상태를 보고 다시 연결하거나 켜고 꺼요', argumentHint: '', builtin: true },
  { name: 'agents', description: '쓸 수 있는 하위 에이전트 종류를 봐요', argumentHint: '', builtin: true },
  { name: 'permissions', description: '권한 규칙·추가 폴더·훅을 보고 고쳐요', argumentHint: '', aliases: ['hooks'], builtin: true },
  { name: 'add-dir', description: '작업 폴더 밖의 폴더를 이 대화에서 더 쓸 수 있게 해요', argumentHint: '[폴더]', builtin: true },
  { name: 'memory', description: 'CLAUDE.md와 자동 메모리 파일을 열어요', argumentHint: '', builtin: true },
  { name: 'status', description: '로그인 계정·세션·모델·폴더를 봐요', argumentHint: '', aliases: ['login'], builtin: true },
  { name: 'goal', description: '조건을 걸면 턴이 끝날 때마다 확인하고 못 미치면 계속해요. clear로 풀어요', argumentHint: '[조건 | clear]', builtin: true },
  { name: 'tag', description: '이 대화에 태그를 붙여요. 홈에서 태그로 거를 수 있어요. clear로 떼요', argumentHint: '[태그 | clear]', builtin: true },
]

const cache = new Map<string, SlashCommandInfo[]>()

/** 프로젝트의 명령 목록. 처음 /를 칠 때 한 번 불러오고 이후엔 캐시 */
export function useSlashCommands(projectId: string, active: boolean): { list: SlashCommandInfo[]; loading: boolean } {
  const [list, setList] = useState<SlashCommandInfo[] | null>(cache.get(projectId) ?? null)
  useEffect(() => {
    setList(cache.get(projectId) ?? null)
    if (!active || cache.has(projectId)) return
    let alive = true
    window.api.listCommands(projectId).then((remote) => {
      const local = new Set(LOCAL.map((c) => c.name))
      const merged = [...LOCAL, ...remote.filter((c) => !local.has(c.name))]
      cache.set(projectId, merged)
      if (alive) setList(merged)
    })
    return () => {
      alive = false
    }
  }, [projectId, active])
  return { list: list ?? LOCAL, loading: active && list === null }
}

/** 이름이 앞부분과 맞는 것 > 별칭이 맞는 것 > 이름에 들어 있는 것 > 설명에 들어 있는 것 */
export function rankCommands(list: SlashCommandInfo[], q: string): SlashCommandInfo[] {
  const query = q.toLowerCase()
  if (!query) return list
  const score = (c: SlashCommandInfo): number => {
    const n = c.name.toLowerCase()
    if (n.startsWith(query)) return 0
    if (c.aliases?.some((a) => a.toLowerCase().startsWith(query))) return 1
    if (n.includes(query)) return 2
    if (c.description.toLowerCase().includes(query)) return 3
    return 9
  }
  return list
    .map((c, i) => ({ c, s: score(c), i }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.c)
}

interface Props {
  items: SlashCommandInfo[]
  index: number
  loading: boolean
  onHover: (i: number) => void
  onPick: (c: SlashCommandInfo) => void
  /** 닫히는 중: 나올 때와 같은 길로 들어간다 */
  leaving?: boolean
}

export function SlashMenu({ items, index, loading, onHover, onPick, leaving }: Props): React.JSX.Element {
  return (
    <div className={`slash ${leaving ? 'leaving' : ''}`} role="listbox" aria-label="명령">
      <div className="slash-head">
        <span>COMMANDS {items.length}</span>
      </div>
      {items.length === 0 && <div className="slash-empty">{loading ? '명령을 불러오는 중…' : '맞는 명령이 없어요'}</div>}
      {items.map((c, i) => (
        <button
          key={`${c.name}:${i}`}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`slash-row ${i === index ? 'on' : ''}`}
          // 블록 본문 필수: scrollIntoView()가 Promise를 돌려주면 React 19가 정리 함수로 오인한다
          ref={i === index ? (el) => { el?.scrollIntoView({ block: 'nearest' }) } : undefined}
          onMouseMove={() => i !== index && onHover(i)}
          // 입력창의 포커스를 빼앗지 않는다
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c)}
        >
          <span className="slash-name">
            /{c.name}
            {c.argumentHint && <span className="slash-arg">{c.argumentHint}</span>}
          </span>
          <span className="slash-desc">{c.description}</span>
          {!c.builtin && <span className="slash-tag">USER</span>}
        </button>
      ))}
    </div>
  )
}

/** 입력창의 @ 후보 하나: 파일·폴더(경로) 또는 하위 에이전트(agent-이름) */
export type Mention = { kind: 'file'; path: string } | { kind: 'agent'; name: string; description: string }

/** @ 뒤에 넣을 글 */
export const mentionText = (m: Mention): string => (m.kind === 'file' ? m.path : `agent-${m.name}`)

/** 입력창의 @ 후보. 파일 이름을 굵게, 폴더는 옅게. 에이전트는 AGENT 표시 */
export function FileMenu({ items, index, loading, onHover, onPick, leaving }: {
  items: Mention[]
  index: number
  loading: boolean
  onHover: (i: number) => void
  onPick: (m: Mention) => void
  leaving?: boolean
}): React.JSX.Element {
  return (
    <div className={`slash ${leaving ? 'leaving' : ''}`} role="listbox" aria-label="파일·에이전트">
      <div className="slash-head">
        <span>MENTIONS {items.length >= 50 ? '50+' : items.length}</span>
      </div>
      {items.length === 0 && <div className="slash-empty">{loading ? '찾는 중…' : '맞는 파일·에이전트가 없어요'}</div>}
      {items.map((m, i) => {
        const path = m.kind === 'file' ? m.path : ''
        const dir = path.endsWith('/')
        const cut = (dir ? path.slice(0, -1) : path).lastIndexOf('/')
        return (
          <button
            key={mentionText(m)}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`slash-row file-row ${i === index ? 'on' : ''}`}
            ref={i === index ? (el) => { el?.scrollIntoView({ block: 'nearest' }) } : undefined}
            onMouseMove={() => i !== index && onHover(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(m)}
          >
            {m.kind === 'agent' ? (
              <>
                <span className="slash-name">@agent-{m.name}</span>
                <span className="slash-desc">{m.description}</span>
                <span className="slash-tag">AGENT</span>
              </>
            ) : (
              <>
                <span className="slash-name">@{path.slice(cut + 1)}</span>
                <span className="slash-desc">{cut >= 0 ? path.slice(0, cut + 1) : './'}</span>
                {dir && <span className="slash-tag">DIR</span>}
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
