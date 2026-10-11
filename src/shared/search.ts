// 대화 검색 (Ctrl+Shift+F). 메인(세션 기록에서 찾기)과 렌더러(찾은 메시지로 스크롤)가 같은 기준을 쓴다:
// 검색 대상 문장과 '몇 번째로 맞은 항목인지'가 양쪽에서 같아야 결과를 누르면 그 메시지로 간다

export type SearchRole = 'user' | 'assistant' | 'tool'

/** 검색 대상이 되는 대화 항목 (HistoryItem·TranscriptItem 모두 이 모양을 가진다) */
interface Searchable {
  type: string
  text?: string
  name?: string
  input?: unknown
}

/** 항목에서 찾을 문장. 내 메시지·답변은 본문, 도구는 이름과 대표 입력(명령·파일·패턴 …). 결과·구분선·알림은 뺀다 */
export function searchableText(item: Searchable): { role: SearchRole; text: string } | null {
  if (item.type === 'user' || item.type === 'assistant') return item.text ? { role: item.type, text: item.text } : null
  if (item.type !== 'tool') return null
  const o = (item.input ?? {}) as Record<string, unknown>
  const v = [o.command, o.file_path, o.path, o.pattern, o.url, o.query, o.description].find((x) => typeof x === 'string') as string | undefined
  return { role: 'tool', text: `${item.name ?? ''} ${v ?? ''}`.trim() }
}

/** 띄어쓰기로 나눈 검색어 (소문자) */
export const searchTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

/** 검색어가 모두 들어 있는지 (대소문자 무시) */
export function matchesTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false
  const lower = text.toLowerCase()
  return terms.every((t) => lower.includes(t))
}

/** 맞은 곳 앞뒤를 잘라 한 줄로 */
export function snippetOf(text: string, terms: string[], before = 36, after = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)))
  const start = Math.max(0, at - before)
  const end = Math.min(flat.length, at + after)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
