import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import type { RateLimitInfo, UsageInfo, UsageWindow } from '@shared/types'
import { withProbe } from './commands'

type Raw = Awaited<ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>
type RawWindow = { utilization: number | null; resets_at: string | null } | null | undefined

const LABEL: Record<string, string> = {
  five_hour: '5H',
  seven_day: 'WEEKLY',
  seven_day_opus: 'OPUS WEEKLY',
  seven_day_sonnet: 'SONNET WEEKLY',
  seven_day_oauth_apps: 'APPS WEEKLY',
  seven_day_overage_included: 'WEEKLY + EXTRA',
}

const toMs = (iso: string | null): number | null => (iso ? Date.parse(iso) || null : null)
const pct = (u: number | null): number | null => (u === null || u === undefined ? null : Math.round(u))

/** SDK 응답 → 화면용. 비어 있는 창은 뺀다 */
export function toUsage(raw: Raw): UsageInfo {
  const r = raw.rate_limits
  const windows: UsageWindow[] = []
  const add = (id: string, w: RawWindow, label = LABEL[id] ?? id): void => {
    if (w && (w.utilization !== null || w.resets_at !== null)) windows.push({ id, label, percent: pct(w.utilization), resetsAt: toMs(w.resets_at) })
  }
  if (r) {
    add('five_hour', r.five_hour)
    add('seven_day', r.seven_day)
    // 서버가 모델별 주간 창을 목록으로 주면 그것을, 아니면 예전 Opus/Sonnet 칸을 쓴다
    if (r.model_scoped && r.model_scoped.length > 0) {
      for (const m of r.model_scoped) add(`model:${m.display_name}`, m, `${m.display_name.toUpperCase()} WEEKLY`)
    } else {
      add('seven_day_opus', r.seven_day_opus)
      add('seven_day_sonnet', r.seven_day_sonnet)
    }
    add('seven_day_oauth_apps', r.seven_day_oauth_apps)
  }
  return { plan: raw.subscription_type, available: raw.rate_limits_available, windows, fetchedAt: Date.now() }
}

/** 실시간 한도 이벤트를 캐시에 반영 (해당 창의 사용률·상태만 바꾼다) */
export function mergeRateLimit(u: UsageInfo | null, info: RateLimitInfo): UsageInfo | null {
  if (!u || !info.rateLimitType) return u
  const id = info.rateLimitType
  const windows = u.windows.map((w) =>
    w.id === id
      ? {
          ...w,
          // SDK 값은 0~1 비율
          percent: info.utilization !== undefined ? Math.round(info.utilization * 100) : w.percent,
          resetsAt: info.resetsAt ? (info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000) : w.resetsAt,
          status: info.status,
        }
      : w,
  )
  return { ...u, windows }
}

/** 살아 있는 세션이 있으면 거기서, 없으면 CLI만 잠깐 띄워 받는다 (실험적 API) */
export async function fetchUsage(live: Query | null): Promise<UsageInfo> {
  const call = (q: Query): Promise<Raw> => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  const raw = live ? await call(live) : await withProbe(homedir(), call)
  return toUsage(raw)
}
