import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { cwdOf, openConversations, type HistoryItem, type Project, type SearchHit } from '@shared/types'
import { matchesTerms, searchableText, searchTerms, snippetOf } from '@shared/search'
import { readHistory } from './history'

const MAX_HITS = 150
const MAX_PER_CONVERSATION = 20

/** 세션 ID → 마지막으로 읽은 기록 (기록 파일이 바뀌지 않았으면 다시 읽지 않는다) */
const cache = new Map<string, { modified: number; items: HistoryItem[] }>()

async function load(sessionId: string, dir: string): Promise<{ modified: number; items: HistoryItem[] } | null> {
  try {
    const info = await getSessionInfo(sessionId, { dir })
    if (!info) return null
    const hit = cache.get(sessionId)
    if (hit && hit.modified === info.lastModified) return hit
    const entry = { modified: info.lastModified, items: await readHistory(sessionId, dir) }
    cache.set(sessionId, entry)
    return entry
  } catch {
    return null
  }
}

/**
 * 모든 프로젝트의 열린 대화에서 찾는다. 최근에 움직인 대화부터, 대화 안에서는 오래된 메시지부터.
 * ordinal은 그 대화에서 몇 번째로 맞은 항목인지 (렌더러가 같은 기준으로 세어 그 메시지로 스크롤한다)
 */
export async function searchConversations(projects: Project[], query: string): Promise<SearchHit[]> {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const convs = projects.flatMap((project, projectIndex) =>
    openConversations(project)
      .filter((c) => c.sessionId)
      .map((conv) => ({ project, projectIndex, conv })),
  )
  const loaded = await Promise.all(convs.map(async (x) => ({ ...x, data: await load(x.conv.sessionId!, cwdOf(x.project, x.conv)) })))
  loaded.sort((a, b) => (b.data?.modified ?? 0) - (a.data?.modified ?? 0))
  const hits: SearchHit[] = []
  for (const { project, projectIndex, conv, data } of loaded) {
    if (!data) continue
    let ordinal = 0
    let count = 0
    for (const item of data.items) {
      const t = searchableText(item)
      if (!t || !matchesTerms(t.text, terms)) continue
      if (count < MAX_PER_CONVERSATION) {
        hits.push({
          projectId: project.id,
          projectIndex,
          projectName: project.name,
          conversationId: conv.id,
          title: conv.title,
          role: t.role,
          snippet: snippetOf(t.text, terms),
          ordinal,
          modified: data.modified,
        })
        count++
      }
      ordinal++
    }
    if (hits.length >= MAX_HITS) break
  }
  return hits.slice(0, MAX_HITS)
}
