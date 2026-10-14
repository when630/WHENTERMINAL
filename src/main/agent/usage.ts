import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import type { RateLimitInfo, UsageInfo, UsageWindow } from '@shared/types'
import { formatReset, limitLevel, type LimitLevel } from '@shared/usage'
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

/** SDK 응답 → 화면용. 비어 있는 창은 뺀다. prev는 직전 값 (모델별 창이 빠진 응답을 메우는 데) */
export function toUsage(raw: Raw, prev?: UsageInfo | null): UsageInfo {
  const r = raw.rate_limits
  const windows: UsageWindow[] = []
  const add = (id: string, w: RawWindow, label = LABEL[id] ?? id): void => {
    if (w && (w.utilization !== null || w.resets_at !== null)) windows.push({ id, label, percent: pct(w.utilization), resetsAt: toMs(w.resets_at) })
  }
  if (r) {
    add('five_hour', r.five_hour)
    add('seven_day', r.seven_day)
    // 서버가 모델별 주간 창을 목록으로 주면 그것을, 아니면 예전 Opus/Sonnet 칸을 쓴다
    // 캐시에서 답하면 model_scoped가 아예 빠져 온다(빈 배열과 다름). 그때는 직전 값을 그대로 둬 칸이 나왔다 사라지지 않게 한다
    const kept = r.model_scoped === undefined ? (prev?.windows.filter((w) => w.id.startsWith('model:')) ?? []) : []
    if (r.model_scoped && r.model_scoped.length > 0) {
      for (const m of r.model_scoped) add(`model:${m.display_name}`, m, `${m.display_name.toUpperCase()} WEEKLY`)
    } else if (kept.length > 0) {
      const now = Date.now()
      // 그사이 초기화 시각이 지났으면 0%로
      for (const w of kept) windows.push(w.resetsAt !== null && w.resetsAt <= now ? { ...w, percent: 0, resetsAt: null, status: undefined } : w)
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

/**
 * 한도 경고 알림: 창마다 80 → 95 → 100 단계를 처음 넘을 때 한 번씩. 초기화되면(resetsAt이 바뀌면) 다시 센다.
 * 앱을 켰을 때 이미 넘어 있으면 95 이상만 알린다 (켤 때마다 80% 알림이 뜨지 않게)
 */
export class UsageAlerts {
  private seen = new Map<string, { level: LimitLevel; resetsAt: number | null }>()

  check(u: UsageInfo): { id: string; title: string; body: string }[] {
    if (!u.available) return []
    const out: { id: string; title: string; body: string }[] = []
    for (const w of u.windows) {
      const level = limitLevel(w)
      const prev = this.seen.get(w.id)
      const fresh = !prev || prev.resetsAt !== w.resetsAt
      const before = fresh ? 0 : prev.level
      this.seen.set(w.id, { level: Math.max(level, before) as LimitLevel, resetsAt: w.resetsAt })
      if (level <= before || (!prev && level < 95)) continue
      const reset = w.resetsAt ? formatReset(w.resetsAt) : ''
      out.push(
        level === 100
          ? { id: w.id, title: `LIMIT · ${w.label} 한도를 다 썼어요`, body: reset ? `${reset}. 그 전에는 요청이 거절될 수 있어요` : '요청이 거절될 수 있어요' }
          : { id: w.id, title: `LIMIT · ${w.label} ${w.percent ?? level}%`, body: reset || '곧 한도에 닿아요' },
      )
    }
    return out
  }
}

/** 살아 있는 세션이 있으면 거기서, 없으면 CLI만 잠깐 띄워 받는다 (실험적 API) */
export async function fetchUsage(live: Query | null, prev?: UsageInfo | null): Promise<UsageInfo> {
  const call = (q: Query): Promise<Raw> => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  const raw = live ? await call(live) : await withProbe(homedir(), call)
  return toUsage(raw, prev)
}
