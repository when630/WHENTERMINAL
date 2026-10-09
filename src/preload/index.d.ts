import type { WhenTerminalApi } from '../shared/types'

declare global {
  interface Window {
    api: WhenTerminalApi
  }
}

export {}
