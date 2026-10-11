import { useCallback, useEffect, useRef, useState } from 'react'

// 입력 초안: 탭을 옮기거나 앱을 껐다 켜도 쓰던 글이 남는다. 대화(또는 홈 작업 지시창)마다 하나.
// 이 창에서만 쓰는 편의라 localStorage에 둔다 (projects.json에 쓰면 글자마다 전체 목록이 다시 퍼진다)

const PREFIX = 'wt-draft:'

function load(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? ''
  } catch {
    return ''
  }
}

function save(key: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(PREFIX + key, text)
    else localStorage.removeItem(PREFIX + key)
  } catch {
    // 저장하지 못해도 이번에는 그대로
  }
}

/** key별 초안. key가 바뀌면 그 key의 초안을 불러온다 */
export function useDraft(key: string): [string, React.Dispatch<React.SetStateAction<string>>] {
  const [state, setState] = useState(() => ({ key, text: load(key) }))
  // 렌더 중에 key가 바뀐 것을 알아채 바로 그 초안으로 (이전 대화의 글이 한 번이라도 다른 대화에 저장되지 않게)
  const current = state.key === key ? state : { key, text: load(key) }
  if (current !== state) setState(current)
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => save(current.key, current.text), [current.key, current.text])
  const setText = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (v) =>
      setState((s) => {
        const base = s.key === keyRef.current ? s : { key: keyRef.current, text: load(keyRef.current) }
        return { key: base.key, text: typeof v === 'function' ? v(base.text) : v }
      }),
    [],
  )
  return [current.text, setText]
}

/** 없어진 대화의 초안을 지운다 */
export function pruneDrafts(alive: Set<string>): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX) && !alive.has(k.slice(PREFIX.length))) localStorage.removeItem(k)
    }
  } catch {
    // 못 지워도 된다
  }
}
