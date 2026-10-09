import { useEffect, useState } from 'react'
import type { SlashCommandInfo } from '@shared/types'
import { Keys } from './KeyHint'

/** 앱이 직접 처리하는 명령. SDK 목록에 같은 이름이 있어도 이 설명을 쓴다 */
const LOCAL: SlashCommandInfo[] = [
  { name: 'compact', description: '지금까지의 대화를 요약해 컨텍스트를 줄입니다', argumentHint: '[요약할 때 중점]', builtin: true },
  { name: 'close', description: '이 대화(세션)를 닫습니다. 실행 중이면 멈춥니다', argumentHint: '', builtin: true },
  { name: 'clear', description: '컨텍스트를 비우고 다음 메시지부터 새 세션으로 시작합니다', argumentHint: '', aliases: ['reset', 'new'], builtin: true },
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
}

export function SlashMenu({ items, index, loading, onHover, onPick }: Props): React.JSX.Element {
  return (
    <div className="slash" role="listbox" aria-label="명령">
      <div className="slash-head">
        <span>명령 {items.length}</span>
        <span className="slash-keys">
          <Keys keys="ctrl N" />/<Keys keys="ctrl P" /> 이동 · <Keys keys="tab" /> 채우기 · <Keys keys="enter" /> 실행 · <Keys keys="esc" /> 닫기
        </span>
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
          {!c.builtin && <span className="slash-tag">사용자</span>}
        </button>
      ))}
    </div>
  )
}
