import { useEffect, useState } from 'react'

/** 경과 시간 표시용 현재 시각 (주기적으로 갱신) */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function elapsed(from: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - from) / 1000))
  if (sec < 60) return '방금'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  return `${Math.floor(hr / 24)}일 전`
}

/** 경과 시간 '03:07', 한 시간이 넘으면 '1:03:07' */
export function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0')
  const ss = String(sec % 60).padStart(2, '0')
  return sec >= 3600 ? `${Math.floor(sec / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}
