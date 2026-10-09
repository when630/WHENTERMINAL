import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

// 화면 움직임 도구 모음. 효과(빛·입자)는 쓰지 않고, 요소가 자리를 옮기고 모양을 바꾸는 움직임만 다룬다.

export const EASE = 'cubic-bezier(.22, 1, .36, 1)'
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
        el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: EASE })
        return
      }
      const dx = from.x - now.x
      const dy = from.y - now.y
      const sizeChanged = Math.abs(from.w - now.w) > 2 || Math.abs(from.h - now.h) > 2
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !(morph && sizeChanged)) return
      if (morph) {
        el.animate(
          [
            { transformOrigin: 'left top', transform: `translate(${dx}px, ${dy}px) scale(${from.w / now.w}, ${from.h / now.h})` },
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

/** 주행 거리계처럼 굴러가는 한 자리 숫자 (10 이상은 그대로 표시) */
export function Odo({ n }: { n: number }): React.JSX.Element {
  if (n > 9) return <span className="odo-plain">{n}</span>
  return (
    <span className="odo" aria-label={String(n)}>
      <span className="odo-col" style={{ transform: `translateY(${-1.5 * n}em)` }} aria-hidden="true">
        {Array.from({ length: 10 }, (_, d) => (
          <span key={d}>{d}</span>
        ))}
      </span>
    </span>
  )
}
