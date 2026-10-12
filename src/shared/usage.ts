import type { UsageInfo, UsageWindow } from './types'

// 구독 한도 경고: 사이드바·입력창 위 경고 줄·OS 알림이 같은 기준을 쓴다

/** 경고 단계. 0 = 괜찮음, 80·95 = 거의 다 씀, 100 = 다 씀(거절될 수 있음) */
export type LimitLevel = 0 | 80 | 95 | 100

export function limitLevel(w: UsageWindow): LimitLevel {
  const p = w.percent ?? 0
  if (w.status === 'rejected' || p >= 100) return 100
  if (p >= 95) return 95
  if (p >= 80 || w.status === 'allowed_warning') return 80
  return 0
}

/** 다 썼어도 서버가 허용한다고 알려 왔다 (추가 사용량 등). 이때는 새 작업을 보류하지 않는다 */
export const limitAllowed = (w: UsageWindow): boolean => w.status === 'allowed' || w.status === 'allowed_warning'

/** 모델 계열 이름 ('Fable 5.1' → 'fable', 'claude-opus-5-5' → 'opus') */
export const modelFamily = (s: string): string => s.toLowerCase().replace(/^claude-/, '').split(/[\s-]/)[0]

/** 모델별 주간 창인지 (그 계열의 모델에만 걸린다) */
const isModelWindow = (w: UsageWindow): boolean => w.id.startsWith('model:') || w.id === 'seven_day_opus' || w.id === 'seven_day_sonnet'

/**
 * 이 모델로 보낼 때 걸리는 창 중 가장 위험한 것. 5시간·주간은 모두에게, 모델별 주간은 그 계열에만.
 * 경고할 것이 없으면 null
 */
export function worstLimit(usage: UsageInfo | null, model?: string): { window: UsageWindow; level: LimitLevel } | null {
  if (!usage?.available) return null
  const f = model ? modelFamily(model) : null
  let worst: { window: UsageWindow; level: LimitLevel } | null = null
  for (const w of usage.windows) {
    if (w.id === 'seven_day_oauth_apps') continue
    if (isModelWindow(w) && (!f || modelFamily(w.label) !== f)) continue
    const level = limitLevel(w)
    if (level && (!worst || level > worst.level || (level === worst.level && (w.percent ?? 0) > (worst.window.percent ?? 0)))) worst = { window: w, level }
  }
  return worst
}

/** 하루 안이면 '17:40 초기화 · 2시간 뒤', 그 뒤면 '10/14(화) 09:00 초기화' */
export function formatReset(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const left = ms - now
  if (left < 24 * 3600_000) {
    // 분으로 먼저 반올림해야 '1시간 60분'이 나오지 않는다
    const total = Math.max(0, Math.round(left / 60_000))
    const h = Math.floor(total / 60)
    return `${hm} 초기화 · ${h > 0 ? `${h}시간 ` : ''}${total % 60}분 뒤`
  }
  return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]}) ${hm} 초기화`
}
