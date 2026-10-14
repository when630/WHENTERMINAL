import { useEffect } from 'react'

// 포커스는 늘 글 입력칸으로: 화면을 옮기든, 버튼을 누르든, 패널·덮개를 닫든 끝나면 입력칸(대화창 입력창·홈 작업 지시창)으로 돌아온다.
// 예외: 다른 입력칸·터미널·펼친 목록(data-keys-own)처럼 스스로 키를 받는 곳, 글을 긁어 고르는 중

const EVENT = 'wt:refocus'

/** 덮개(도움말·검색)를 닫은 뒤처럼 지금 화면의 입력칸이 포커스를 다시 가져가게 한다 */
export function requestRefocus(): void {
  window.dispatchEvent(new Event(EVENT))
}

/**
 * 지금 화면의 입력칸이 requestRefocus에 응답한다. 포커스를 혼자 갖는 덮개(`data-focus-owner`, 질문 창)가 떠 있으면
 * 그 덮개(owner)만 응답한다. 덮개를 닫을 때는 leaving이 붙은 뒤에 요청해야 아래 화면이 받는다
 */
export function useRefocus(focus: () => void, owner = false): void {
  useEffect(() => {
    const on = (): void => {
      if (!owner && document.querySelector('[data-focus-owner]:not(.leaving)')) return
      focus()
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [focus, owner])
}

/** 포커스가 가 있어도 되는 곳 (여기면 입력칸으로 끌어오지 않는다) */
const OWN = 'input, textarea, select, [contenteditable="true"], [data-terminal], [data-keys-own], [role="listbox"]'

/**
 * 누른 뒤 입력칸으로 돌아가도 되는지: 다른 입력칸·터미널·목록이 아니고, 글을 고르는 중이 아닐 때.
 * input은 누른 처리가 끝난 뒤에 고른다 (보고서 상세가 열렸으면 null을 돌려주는 식)
 */
export function refocusAfterClick(e: React.MouseEvent, input: () => HTMLElement | null | undefined): void {
  const target = e.target as HTMLElement | null
  if (!target || target.closest(OWN)) return
  // 누른 쪽의 처리(목록 열기·상세 열기 등)가 끝난 뒤에 본다
  requestAnimationFrame(() => {
    const el = input()
    if (!el || window.getSelection()?.toString()) return
    const active = document.activeElement as HTMLElement | null
    if (active && active !== document.body && active.closest(OWN)) return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
  })
}

/**
 * 확인 요청이 왔을 때 입력칸을 그대로 둘지: 포커스가 있고 치던 글이 있거나 방금(1.5초 안) 쳤으면.
 * 이때 입력칸을 비우면 치던 글자가 Y/A/N으로 먹는다. 비우지 않은 입력칸은 Tab으로 빠져나와 답한다
 */
export function stillTyping(el: HTMLTextAreaElement | null | undefined, lastTyped: number): boolean {
  return !!el && document.activeElement === el && (!!el.value.trim() || Date.now() - lastTyped < 1500)
}
