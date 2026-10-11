import { useEffect } from 'react'

// 마우스를 올리면 나오는 설명(title)을 OS 기본 풍선 대신 앱 모양으로 보여준다.
// 요소마다 손대지 않도록 title을 그대로 쓰고, 처음 올릴 때 data-tip으로 옮겨 기본 풍선이 뜨지 않게 한다

const SHOW_DELAY = 450
/** 하나를 본 뒤 이 시간 안에 다른 곳에 올리면 바로 보인다 */
const WARM_MS = 300
const GAP = 7
const EDGE = 8

export function useTooltips(): void {
  useEffect(() => {
    const tip = document.createElement('div')
    tip.className = 'tip'
    tip.setAttribute('role', 'tooltip')
    document.body.appendChild(tip)

    let anchor: HTMLElement | null = null
    let timer = 0
    let hiddenAt = 0
    /** 누른 요소: 마우스가 떠날 때까지 다시 보이지 않는다 (목록을 펼친 버튼 위에 설명이 겹치지 않게) */
    let pressed: HTMLElement | null = null

    const textOf = (el: HTMLElement): string => {
      const title = el.getAttribute('title')
      if (title) {
        // 기본 풍선을 막는다. React는 값이 바뀌지 않으면 title을 다시 쓰지 않는다
        el.dataset.tip = title
        el.removeAttribute('title')
      }
      return el.dataset.tip ?? ''
    }

    const place = (): void => {
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      const below = r.bottom + GAP + h <= window.innerHeight - EDGE
      const top = below ? r.bottom + GAP : r.top - GAP - h
      const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), window.innerWidth - EDGE - w)
      tip.style.left = `${Math.round(left)}px`
      tip.style.top = `${Math.round(top)}px`
      tip.classList.toggle('above', !below)
    }

    const show = (): void => {
      if (!anchor || !anchor.isConnected) return
      const text = anchor.dataset.tip
      if (!text) return
      tip.textContent = text
      place()
      tip.classList.add('show')
    }

    const hide = (): void => {
      clearTimeout(timer)
      timer = 0
      anchor = null
      if (tip.classList.contains('show')) {
        tip.classList.remove('show')
        hiddenAt = performance.now()
      }
    }

    const onOver = (e: MouseEvent): void => {
      const el = (e.target as Element | null)?.closest<HTMLElement>('[title], [data-tip]')
      if (el === anchor) return
      if (pressed && !pressed.contains(el ?? null)) pressed = null
      if (!el || el === pressed || el.getAttribute('aria-expanded') === 'true' || !textOf(el)) {
        hide()
        return
      }
      const warm = tip.classList.contains('show') || performance.now() - hiddenAt < WARM_MS
      hide()
      anchor = el
      if (warm) show()
      else timer = window.setTimeout(show, SHOW_DELAY)
    }
    const onOut = (e: MouseEvent): void => {
      const to = e.relatedTarget as Node | null
      if (anchor && !anchor.contains(to)) hide()
      if (pressed && !pressed.contains(to)) pressed = null
    }
    const onDown = (e: MouseEvent): void => {
      pressed = (e.target as Element | null)?.closest<HTMLElement>('[title], [data-tip]') ?? null
      hide()
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      tip.remove()
    }
  }, [])
}
