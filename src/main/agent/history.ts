import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { HistoryItem } from '@shared/types'

/** 너무 긴 세션은 끝부분만 되살린다 */
const MAX_ITEMS = 400
const RESULT_LIMIT = 4000

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

/** CLI가 넣는 내부 메시지(로컬 명령 출력, 시스템 알림 등)는 사람이 쓴 글이 아니라 뺀다 */
const INTERNAL = /^\s*<(local-command|command-name|command-message|command-args|system-reminder|local-command-stdout|local-command-caveat)/

const TASK_STATUS: Record<string, string> = { completed: 'TASK DONE', killed: 'TASK STOPPED', stopped: 'TASK STOPPED', failed: 'TASK FAILED' }

/**
 * 백그라운드 작업 알림(<task-notification>…)을 한 줄로. CLI가 모델에게 알리려고 사용자 메시지 자리에 넣는 것이라
 * 사람이 쓴 글처럼 보이면 안 된다. 알림이 아니면 null
 */
export function taskNote(text: string): string | null {
  if (!/^\s*<task-notification>/.test(text)) return null
  const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()
  return taskLine(tag('status'), tag('summary'), tag('event'))
}

/**
 * 입력창 `!명령`으로 돌린 명령의 기록(<bash-input>…<bash-stdout>…). 사람이 쓴 글이 아니라 출력 항목으로 되살린다.
 * 아니면 null
 */
export function shellNote(text: string): { command: string; output: string } | null {
  if (!/^\s*<bash-input>/.test(text)) return null
  const tag = (name: string): string => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1] ?? ''
  return { command: tag('bash-input').trim(), output: [tag('bash-stdout'), tag('bash-stderr')].filter((s) => s.trim()).join('\n').replace(/\s+$/, '') }
}

/** 작업 알림 한 줄: 'TASK DONE · 요약 · 이벤트' */
export const taskLine = (status?: string, summary?: string, event?: string): string =>
  [(status && TASK_STATUS[status]) || 'TASK', summary, event].filter(Boolean).join(' · ')

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
      if (sub === 'compact_boundary') items.push({ type: 'divider', text: `${(raw.compact_metadata ?? msg.compact_metadata)?.trigger === 'auto' ? 'AUTO COMPACT' : 'COMPACT'} · 이전 대화` })
      continue
    }
    const content = msg.content
    if (m.type === 'user') {
      if (typeof content === 'string') {
        const note = taskNote(content)
        const shell = shellNote(content)
        if (note) items.push({ type: 'divider', text: note })
        else if (shell) items.push({ type: 'notice', text: `! ${shell.command}\n${shell.output || '(출력 없음)'}`, tone: 'info', mono: true })
        else if (content.trim() && !INTERNAL.test(content)) items.push({ type: 'user', text: content, uuid: m.uuid })
        continue
      }
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const t = tools.get(b.tool_use_id)
          if (t) {
            const full = textOf(b.content)
            t.result = full.slice(0, RESULT_LIMIT)
            t.isError = b.is_error ?? false
            if (full.length > RESULT_LIMIT) t.truncated = true
          }
        } else if (b.type === 'text' && b.text?.trim() && !INTERNAL.test(b.text)) {
          const note = taskNote(b.text)
          const shell = shellNote(b.text)
          items.push(note ? { type: 'divider', text: note } : shell ? { type: 'notice', text: `! ${shell.command}\n${shell.output || '(출력 없음)'}`, tone: 'info', mono: true } : { type: 'user', text: b.text, uuid: m.uuid })
        }
      }
      continue
    }
    if (m.type === 'assistant') {
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type === 'text' && b.text?.trim()) items.push({ type: 'assistant', text: b.text })
        else if (b.type === 'thinking' && b.thinking?.trim()) items.push({ type: 'thinking', text: b.thinking })
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

/** 도구 결과 전문 (화면에는 앞부분만 보내므로 펼칠 때 읽는다). 없으면 null */
export async function fullToolResult(sessionId: string, dir: string, toolUseId: string): Promise<string | null> {
  const messages = await getSessionMessages(sessionId, { dir })
  for (const m of messages) {
    if (m.type !== 'user') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Block[]) {
      if (b.type === 'tool_result' && b.tool_use_id === toolUseId) return textOf(b.content)
    }
  }
  return null
}

/** 세션 기록을 마크다운으로 (/export) */
export async function exportMarkdown(sessionId: string, dir: string, title: string): Promise<string> {
  const messages = await getSessionMessages(sessionId, { dir, includeSystemMessages: true })
  const out: string[] = [`# ${title}`, '', `세션 ${sessionId}`, '']
  const results = new Map<string, string>()
  for (const m of messages) {
    if (m.type !== 'user' || m.parent_tool_use_id) continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Block[]) if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, textOf(b.content))
  }
  for (const m of messages) {
    if (m.parent_tool_use_id) continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (m.type === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Block[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : ''
      const shell = shellNote(text)
      if (shell) out.push(`## SHELL · ${shell.command}`, '', '```', shell.output, '```', '')
      else if (text.trim() && !INTERNAL.test(text) && !taskNote(text)) out.push('## YOU', '', text.trim(), '')
    } else if (m.type === 'assistant') {
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type === 'text' && b.text?.trim()) out.push('## CLAUDE', '', b.text.trim(), '')
        else if (b.type === 'tool_use' && b.id) {
          const r = results.get(b.id)
          out.push(`### TOOL · ${b.name ?? '?'}`, '', '```json', JSON.stringify(b.input, null, 2), '```', '')
          if (r !== undefined) out.push('```', r.length > 8000 ? `${r.slice(0, 8000)}\n… (${r.length - 8000}자 생략)` : r, '```', '')
        }
      }
    }
  }
  return out.join('\n')
}
