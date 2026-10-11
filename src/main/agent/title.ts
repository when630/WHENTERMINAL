import { getSessionInfo, renameSession } from '@anthropic-ai/claude-agent-sdk'

// 대화(탭) 제목. 출처는 Conversation.titleSource
// - draft: 첫 메시지를 규칙으로 다듬은 임시 제목 (보내자마자)
// - auto: CLI가 세션마다 만드는 제목 (ai-title). 응답이 끝날 때마다 읽어 바꾼다. 모델을 따로 부르지 않는다
// - custom: 사용자가 붙인 이름. 자동으로 덮어쓰지 않는다

const MAX = 32

/** 앞에 붙는 군더더기 */
const LEAD = /^(?:혹시|저기|그럼|그리고|일단|음+|아+|그+|자)[\s,.]+/
/** 끝에 붙는 부탁 어미: '추가해줘' → '추가', '확인해 주세요' → '확인'. '올려줘'처럼 '해'가 없으면 동사가 잘려 그대로 둔다 */
const TAIL = /\s*(?:해\s*(?:줘|봐|주세요|줄래|주라|줄\s*수\s*있어)|부탁(?:해|드려요)?)\s*[.!?~…]*$/

/** 기본 이름 ('대화 3')인지 */
export const isDefaultTitle = (title: string): boolean => /^대화 \d+$/.test(title)

/** 첫 메시지를 탭에 맞게 다듬는다. 요약은 하지 않는다 (자동 제목이 오기 전까지만 쓴다) */
export function draftTitle(text: string): string {
  const t = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ') // 코드 블록
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/]\S*\.(?:png|jpe?g|gif|webp|bmp)\b/gi, ' ') // 붙여넣은 이미지 경로
    .replace(/@(\S+)/g, (_, p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p) // @경로 → 파일 이름
  const first = t.split('\n').map((l) => l.replace(/\s+/g, ' ').replace(/\s좀(?=\s)/g, '').trim()).find(Boolean) ?? ''
  // 첫 문장만 ('… 알려줘. 도구는 쓰지 마.' → '… 알려줘')
  const sentence = first.split(/(?<=[.!?。])\s+/)[0]
  const trimEnd = (s: string): string => s.replace(/[\s.,!?~…]+$/, '')
  const line = trimEnd(sentence.replace(LEAD, '').replace(TAIL, ''))
  if (!line) return text.trim().slice(0, MAX) || '새 대화'
  if (line.length <= MAX) return line
  // 단어 경계에서 자른다 (너무 앞이면 그냥 자른다)
  const cut = line.slice(0, MAX)
  const space = cut.lastIndexOf(' ')
  return `${trimEnd(space > MAX * 0.5 ? cut.slice(0, space) : cut)}…`
}

/** CLI가 만든 세션 제목. 아직 없으면(첫 메시지를 그대로 돌려주면) undefined */
export async function sessionTitle(sessionId: string, dir: string): Promise<string | undefined> {
  const info = await getSessionInfo(sessionId, { dir })
  const title = info?.summary?.trim()
  if (!title || title === info?.firstPrompt?.trim()) return undefined
  return title.length > 80 ? `${title.slice(0, 80)}…` : title
}

/** 직접 붙인 이름을 세션 기록에도 남긴다 (CLI의 /resume 목록에도 같은 이름) */
export async function saveSessionTitle(sessionId: string, dir: string, title: string): Promise<void> {
  await renameSession(sessionId, title, { dir })
}
