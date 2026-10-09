import { createContext, useContext } from 'react'
import { DEFAULT_KEYMAP, type Keymap, type ThemeId } from '@shared/keymap'

/** 지금 쓰는 단축키 맵. 화면의 단축키 표시는 모두 여기서 읽는다 */
export const KeymapContext = createContext<Keymap>(DEFAULT_KEYMAP)
export const useKeymap = (): Keymap => useContext(KeymapContext)

/** 테마 적용. 처음에는 즉시, 바꿀 때는 잠깐 전환 클래스를 붙여 색이 부드럽게 넘어가게 */
export function applyTheme(theme: ThemeId, animate: boolean): void {
  const root = document.documentElement
  if (animate) {
    root.classList.add('theme-switching')
    setTimeout(() => root.classList.remove('theme-switching'), 450)
  }
  if (theme === 'poster') delete root.dataset.theme
  else root.dataset.theme = theme
}
