import { createElement, Fragment, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'

// 화면 움직임 도구 모음. 효과(빛·입자)는 쓰지 않고, 요소가 자리를 옮기고 모양을 바꾸는 움직임만 다룬다.

export const EASE = 'cubic-bezier(.22, 1, .36, 1)'
export const EASE_IO = 'cubic-bezier(.65, 0, .35, 1)'
export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 스크롤 컨테이너 기준 좌표 (스크롤해도 값이 변하지 않게) */
export function boxIn(el: Element, container: HTMLElement): Box {
  const r = el.getBoundingClientRect()
  const c = container.getBoundingClientRect()
  return { x: r.left - c.left + container.scrollLeft, y: r.top - c.top + container.scrollTop, w: r.width, h: r.height }
}

/**
 * data-layout-id가 붙은 요소의 위치를 렌더마다 기억했다가, 자리가 바뀌면 이전 자리에서 미끄러지게 한다 (FLIP).
 * 같은 id가 다른 모양으로 나타나면 (진행 카드 → 보고서 카드) 이전 크기에서 새 크기로 변형되며 이동한다.
 * dispatchOrigin에 위치를 넣어 두면, 다음에 새로 나타나는 진행 카드는 그 자리(작업 지시창)에서 튀어나온다.
 */
export function useLayoutMotion(container: RefObject<HTMLElement | null>, dispatchOrigin: RefObject<{ box: Box; at: number } | null>): void {
  const boxes = useRef(new Map<string, Box>())
  const kinds = useRef(new Map<string, string>())
  const mounted = useRef(false)

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const reduced = reducedMotion()
    const seen = new Set<string>()
    root.querySelectorAll<HTMLElement>('[data-layout-id]').forEach((el) => {
      const id = el.dataset.layoutId!
      const kind = el.dataset.layoutKind ?? ''
      seen.add(id)
      if (el.getAnimations().some((a) => a.playState === 'running')) return
      const now = boxIn(el, root)
      const prev = boxes.current.get(id)
      const prevKind = kinds.current.get(id)
      boxes.current.set(id, now)
      kinds.current.set(id, kind)
      if (!mounted.current || reduced) return

      let from = prev
      let morph = prev !== undefined && prevKind !== kind
      const origin = dispatchOrigin.current
      if (!prev && kind === 'task' && origin && performance.now() - origin.at < 4000) {
        from = origin.box
        morph = true
        dispatchOrigin.current = null
      }
      if (!from) {
        // 새 보고서는 위에서 떨어지듯 (아래 카드들은 같은 렌더에서 한 칸씩 밀려 내려간다). 나머지는 아래에서 떠오른다
        const enter = kind === 'report' ? 'translateY(-28px)' : 'translateY(8px)'
        el.animate([{ opacity: 0, transform: enter }, { opacity: 1, transform: 'none' }], { duration: kind === 'report' ? 520 : 360, easing: EASE })
        return
      }
      const dx = from.x - now.x
      const dy = from.y - now.y
      const sizeChanged = Math.abs(from.w - now.w) > 2 || Math.abs(from.h - now.h) > 2
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !(morph && sizeChanged)) return
      if (morph) {
        const sx = now.w > 0 ? from.w / now.w : 1
        const sy = now.h > 0 ? from.h / now.h : 1
        el.animate(
          [
            { transformOrigin: 'left top', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
            { transformOrigin: 'left top', transform: 'none' },
          ],
          { duration: 640, easing: EASE },
        )
        el.querySelector('.lx-in')?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: 640, easing: 'ease-out' })
      } else {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 520, easing: EASE })
      }
    })
    // 사라진 id는 잠시 기억해 둔다: 같은 렌더에서 다른 모양으로 다시 나타날 수 있다
    for (const id of boxes.current.keys()) if (!seen.has(id) && boxes.current.size > 200) boxes.current.delete(id)
    mounted.current = true
  })

  useEffect(() => () => {
    boxes.current.clear()
    kinds.current.clear()
  }, [])
}

/**
 * 값이 사라져도 잠시(ms) 마지막 값을 붙잡아 두어 나가는 애니메이션을 보여줄 수 있게 한다.
 * leaving이 true인 동안 요소에 'leaving' 클래스를 붙이면 된다.
 * 값이 사라진 바로 그 렌더부터 leaving이어야 한다: 효과에서 뒤늦게 세우면 요소가 한 번 내려갔다 다시 올라와 깜빡인다
 */
export function usePresence<T>(value: T | null | undefined, ms = 240): { item: T | null; leaving: boolean } {
  const current = value ?? null
  const kept = useRef<T | null>(current)
  if (current !== null) kept.current = current
  // 값이 사라지고 ms가 지나면 true: 붙잡아 둔 값을 놓는다. 값이 다시 생기면 false로
  const [released, setReleased] = useState(false)
  useEffect(() => {
    if (current !== null) {
      setReleased(false)
      return
    }
    if (kept.current === null) return
    const t = setTimeout(() => setReleased(true), reducedMotion() ? 0 : ms)
    return () => clearTimeout(t)
  }, [current, ms])
  const leaving = current === null && !released && kept.current !== null && !reducedMotion()
  return { item: current ?? (leaving ? kept.current : null), leaving }
}

/**
 * 목록용 usePresence: 빠진 항목을 잠시(ms) 원래 자리에 붙잡아 두어 leaving 클래스로 내보낼 수 있게 한다.
 * 같은 키가 다시 들어오면 바로 산다. 줄마다 key로 그리고 leaving이면 'leaving' 클래스를 붙이면 된다
 */
export function usePresenceList<T>(items: T[], keyOf: (item: T) => string, ms = 240, scope = ''): { item: T; key: string; leaving: boolean }[] {
  const gone = useRef(new Map<string, { item: T; index: number; at: number }>())
  const prev = useRef<{ key: string; item: T }[]>([])
  const lastScope = useRef(scope)
  // 다른 대화·프로젝트의 목록으로 바뀐 것이면 빠진 항목을 붙잡지 않는다 (잔상이 새 화면에 남지 않게)
  if (lastScope.current !== scope) {
    lastScope.current = scope
    prev.current = []
    gone.current.clear()
  }
  const [, bump] = useState(0)
  const now = performance.now()
  const live = new Set(items.map(keyOf))
  if (!reducedMotion()) {
    prev.current.forEach((p, index) => {
      if (!live.has(p.key) && !gone.current.has(p.key)) gone.current.set(p.key, { item: p.item, index, at: now })
    })
  }
  for (const [key, g] of gone.current) if (live.has(key) || now - g.at >= ms) gone.current.delete(key)
  prev.current = items.map((item) => ({ key: keyOf(item), item }))
  const out = prev.current.map((p) => ({ item: p.item, key: p.key, leaving: false }))
  // 빠진 항목은 원래 있던 자리에 (앞에서부터 넣어야 자리가 맞는다)
  for (const [key, g] of [...gone.current.entries()].sort((a, b) => a[1].index - b[1].index)) out.splice(Math.min(g.index, out.length), 0, { item: g.item, key, leaving: true })
  // 마지막으로 빠진 항목이 놓일 때 한 번 다시 그린다
  const until = gone.current.size ? Math.max(...[...gone.current.values()].map((g) => g.at)) + ms : 0
  useEffect(() => {
    if (!until) return
    const t = setTimeout(() => bump((n) => n + 1), Math.max(0, until - performance.now()) + 1)
    return () => clearTimeout(t)
  }, [until])
  return out
}

type Tag = 'span' | 'div' | 'section' | 'nav' | 'p' | 'i' | 'ul' | 'ol' | 'li' | 'h2'

/**
 * show가 false가 돼도 잠시 마지막 내용을 'leaving' 클래스로 남기는 감싸개 (usePresence를 요소 하나에 바로).
 * 나가는 동안 className·children은 마지막 모습 그대로, 그 밖의 속성은 지금 값
 */
export function Presence({ show, ms = 240, as = 'span', className = '', scope = '', children, ...rest }: { show: boolean; ms?: number; as?: Tag; className?: string; scope?: string; children?: ReactNode } & HTMLAttributes<HTMLElement>): React.JSX.Element | null {
  const p = usePresence(show ? { children, className, scope } : null, ms)
  // scope(대화 ID 등)가 바뀌어 사라진 것은 잔상 없이 바로 뺀다
  if (!p.item || p.item.scope !== scope) return null
  return createElement(as, { ...rest, className: `${p.item.className}${p.leaving ? ' leaving' : ''}` }, p.item.children)
}

/** 목록 감싸개: 줄이 빠지면 잠시 남겨 leaving으로 그린다. children이 줄 하나를 그린다 (key는 여기서 붙인다) */
export function PresenceList<T>({ items, keyOf, as = 'ul', className, ms, scope, children, ...rest }: { items: T[]; keyOf: (item: T) => string; as?: Tag; className?: string; ms?: number; scope?: string; children: (item: T, leaving: boolean) => ReactNode } & Omit<HTMLAttributes<HTMLElement>, 'children'>): React.JSX.Element {
  const rows = usePresenceList(items, keyOf, ms, scope)
  return createElement(as, { ...rest, className }, rows.map((r) => createElement(Fragment, { key: r.key }, children(r.item, r.leaving))))
}

/** 바뀔 때 위로 굴러가며 교체되는 글자 */
export function Roll({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(text)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || prev.current === text) return
    const oldText = prev.current
    prev.current = text
    if (reducedMotion()) return
    const cur = el.querySelector<HTMLSpanElement>('.roll-cur')
    // 아직 굴러가는 중에 또 바뀌면 글자만 바꾸고 움직임은 이어 간다 (매번 다시 시작하면 더듬는다)
    if (cur?.getAnimations().length) return
    el.querySelectorAll('.roll-old').forEach((o) => o.remove())
    const old = document.createElement('span')
    old.className = 'roll-old'
    old.textContent = oldText
    el.appendChild(old)
    old.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], { duration: 320, easing: EASE, fill: 'forwards' }).onfinish = () => old.remove()
    cur?.animate([{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE })
  }, [text])
  return (
    <span ref={ref} className={`roll ${className ?? ''}`}>
      <span className="roll-cur">{text}</span>
    </span>
  )
}

/**
 * 도는 중 표시. active가 false가 돼도 돌던 바퀴를 마저 채운 뒤에 멈춘다 (중간에 끊으면 원래 각도로 튄다).
 * 돌아가는 요소(animation: spin … infinite)가 ref 안에 있어야 한다
 */
export function useSpin(active: boolean, ref: RefObject<HTMLElement | null>): boolean {
  const [spinning, setSpinning] = useState(active)
  useEffect(() => {
    const el = ref.current
    if (active) {
      setSpinning(true)
      return
    }
    if (!el || reducedMotion()) {
      setSpinning(false)
      return
    }
    const stop = (): void => setSpinning(false)
    el.addEventListener('animationiteration', stop, { once: true })
    // 돌고 있지 않았거나 이벤트가 오지 않으면 그냥 멈춘다
    const t = setTimeout(stop, 1200)
    return () => {
      el.removeEventListener('animationiteration', stop)
      clearTimeout(t)
    }
  }, [active, ref])
  return spinning
}

/** 활동 막대 높이: 살아 있음 / 사람이 봐야 함 / 멈춤 */
export type EqMode = 'live' | 'waiting' | 'idle'
const EQ_LEAD = 'scaleY(0.12)'
const EQ_REST: Record<EqMode, string> = { live: 'scaleY(0.5)', waiting: 'scaleY(0.3)', idle: 'scaleY(0.08)' }
const EQ_LOOP = [{ transform: 'scaleY(0.12)' }, { transform: 'scaleY(0.85)', offset: 0.4 }, { transform: 'scaleY(0.35)', offset: 0.7 }, { transform: 'scaleY(1)' }]

/**
 * 이퀄라이저 막대. CSS 애니메이션은 켜고 끌 때 기준 높이로 튀므로 WAAPI로 지금 높이에서 다음 모습으로 이어 간다.
 * 실행 중에는 막대마다 조금씩 늦게 시작해 물결처럼 움직인다
 */
export function Equalizer({ mode, bars = 12 }: { mode: EqMode; bars?: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const reduced = reducedMotion()
    el.querySelectorAll<HTMLElement>('i').forEach((bar, i) => {
      const from = getComputedStyle(bar).transform
      bar.getAnimations().forEach((a) => a.cancel())
      if (reduced) {
        bar.style.transform = EQ_REST[mode]
        return
      }
      bar.style.transform = ''
      if (mode !== 'live') {
        bar.animate([{ transform: from }, { transform: EQ_REST[mode] }], { duration: 600, delay: i * 18, easing: EASE_IO, fill: 'forwards' })
        return
      }
      const lead = bar.animate([{ transform: from }, { transform: EQ_LEAD }], { duration: 320, easing: EASE_IO, fill: 'forwards' })
      lead.onfinish = () => {
        if (!bar.isConnected || lead.playState === 'idle') return
        lead.cancel()
        bar.animate(EQ_LOOP, { duration: 900, delay: i * 70, iterations: Infinity, direction: 'alternate', easing: EASE_IO, fill: 'backwards' })
      }
    })
  }, [mode])
  return (
    <div className={`sp-eq ${mode}`} ref={ref} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => <i key={i} />)}
    </div>
  )
}

/** 주행 거리계처럼 굴러가는 한 자리 숫자 (10 이상은 그대로 표시) */
export function Odo({ n }: { n: number }): React.JSX.Element {
  if (n > 9) return <span className="odo-plain">{n}</span>
  return (
    <span className="odo" aria-label={String(n)}>
      <span className="odo-col" style={{ transform: `translateY(calc(var(--odo-h, 1.5em) * ${-n}))` }} aria-hidden="true">
        {Array.from({ length: 10 }, (_, d) => (
          <span key={d}>{d}</span>
        ))}
      </span>
    </span>
  )
}
