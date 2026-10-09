import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { HistoryItem } from '@shared/types'

/** 너무 긴 세션은 끝부분만 되살린다 */
const MAX_ITEMS = 400
const RESULT_LIMIT = 4000

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

/** CLI가 넣는 내부 메시지(로컬 명령 출력, 시스템 알림 등)는 사람이 쓴 글이 아니라 뺀다 */
const INTERNAL = /^\s*<(local-command|command-name|command-message|command-args|system-reminder|local-command-stdout|local-command-caveat)/

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n')
}

/**
 * 세션 기록 파일(JSONL)을 화면 항목으로. 도구 결과는 같은 tool_use_id의 도구 항목에 붙인다.
 * 하위 에이전트(parent_tool_use_id가 있는 것)는 실시간 화면과 같게 뺀다
 */
export async function readHistory(sessionId: string, dir: string): Promise<HistoryItem[]> {
  const messages = await getSessionMessages(sessionId, { dir, includeSystemMessages: true })
  const items: HistoryItem[] = []
  const tools = new Map<string, Extract<HistoryItem, { type: 'tool' }>>()
  for (const m of messages) {
    if (m.parent_tool_use_id) continue
    const msg = (m.message ?? {}) as { content?: unknown; subtype?: string; compact_metadata?: { trigger?: string; pre_tokens?: number } }
    if (m.type === 'system') {
      const raw = m as unknown as { subtype?: string; compact_metadata?: { trigger?: string; pre_tokens?: number } }
      const sub = raw.subtype ?? msg.subtype
      if (sub === 'compact_boundary') items.push({ type: 'divider', text: `${(raw.compact_metadata ?? msg.compact_metadata)?.trigger === 'auto' ? '자동 컴팩트' : '컴팩트'} 이전 대화` })
      continue
    }
    const content = msg.content
    if (m.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim() && !INTERNAL.test(content)) items.push({ type: 'user', text: content })
        continue
      }
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const t = tools.get(b.tool_use_id)
          if (t) {
            t.result = textOf(b.content).slice(0, RESULT_LIMIT)
            t.isError = b.is_error ?? false
          }
        } else if (b.type === 'text' && b.text?.trim() && !INTERNAL.test(b.text)) {
          items.push({ type: 'user', text: b.text })
        }
      }
      continue
    }
    if (m.type === 'assistant') {
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type === 'text' && b.text?.trim()) items.push({ type: 'assistant', text: b.text })
        else if (b.type === 'tool_use' && b.id) {
          const t: Extract<HistoryItem, { type: 'tool' }> = { type: 'tool', toolUseId: b.id, name: b.name ?? '?', input: b.input }
          tools.set(b.id, t)
          items.push(t)
        }
      }
    }
  }
  return items.slice(-MAX_ITEMS)
}
