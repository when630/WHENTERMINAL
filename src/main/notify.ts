import { app, Notification, type BrowserWindow, type Tray } from 'electron'
import type { AgentEventEnvelope } from '@shared/types'
import type { Settings } from '@shared/keymap'
import type { ProjectStore } from './store'

const isMac = process.platform === 'darwin'

/**
 * 자리를 비웠을 때(OPEN-004): 확인 요청·작업 끝남을 OS 알림으로. 누르면 창을 열고 그 대화로 옮긴다.
 * 같은 대화의 알림은 새 것으로 바꾼다 (쌓이지 않게)
 */
export class Notifier {
  private shown = new Map<string, Notification>()

  constructor(
    private readonly store: ProjectStore,
    private readonly getWin: () => BrowserWindow | null,
    private readonly getSettings: () => Settings,
    private readonly open: (projectId: string, conversationId: string) => void,
  ) {}

  handle({ projectId, conversationId, event }: AgentEventEnvelope): void {
    const s = this.getSettings().notify
    const win = this.getWin()
    const focused = !!win && win.isVisible() && win.isFocused()
    if (focused && !s.whenFocused) return
    const project = this.store.get(projectId)
    const conv = this.store.getConversation(projectId, conversationId)
    if (!project || !conv) return

    if (event.kind === 'permission_request' && s.approval) {
      const r = event.request
      this.show(conversationId, `NEEDS YOU · ${project.name}`, r.title ?? `${r.toolName} 실행을 허락해 달라고 해요`, projectId)
      if (isMac && !focused) app.dock?.bounce('informational')
    } else if (event.kind === 'status' && s.done && (event.status === 'done' || event.status === 'error')) {
      const head = event.status === 'done' ? 'DONE' : 'ERROR'
      this.show(conversationId, `${head} · ${project.name}`, conv.title, projectId)
    } else if (event.kind === 'permission_resolved') {
      // 앱에서 이미 응답했으면 남은 확인 알림을 치운다
      this.shown.get(conversationId)?.close()
    }
  }

  private show(conversationId: string, title: string, body: string, projectId: string): void {
    if (!Notification.isSupported()) return
    this.shown.get(conversationId)?.close()
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => this.open(projectId, conversationId))
    n.on('close', () => this.shown.get(conversationId) === n && this.shown.delete(conversationId))
    this.shown.set(conversationId, n)
    n.show()
  }
}

/** Dock 배지(macOS)·작업 표시줄 배지와 트레이 툴팁 */
export function applyBadge(tray: Tray | null, waiting: number, unread: number): void {
  const n = waiting + unread
  app.setBadgeCount(n)
  const parts = [waiting && `NEEDS YOU ${waiting}`, unread && `NEW ${unread}`].filter(Boolean)
  tray?.setToolTip(parts.length ? `WHENTERMINAL · ${parts.join(' · ')}` : 'WHENTERMINAL')
}
