import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cwdOf, IPC, MAX_PROJECTS, type Conversation, type ModelOption, type StoredTask, type UsageInfo, type AgentEventEnvelope, type AgentMode, type PermissionDecision, type PermissionExtra, type PermissionRuleSource, type RateLimitInfo, type RewindScope, type TerminalShell, type EffortLevel } from '@shared/types'
import { newConversationId, ProjectStore } from './store'
import { memoryFiles, permissionsInfo, setPermissionRule } from './agent/config'
import { exportMarkdown } from './agent/history'
import { loginCommand } from './executable'
import { branchOf, createWorktree, discardWorktree, isGitRepo, mergeWorktree, worktreeChanges } from './worktree'
import { searchFiles } from './files'
import { SettingsStore } from './settings'
import { applyBadge, Notifier } from './notify'
import { effectiveKeymap, THEMES, toAccelerator, type Settings } from '@shared/keymap'
import { AgentManager } from './agent/manager'
import { searchConversations } from './agent/search'
import { availableShells, TerminalManager } from './terminal'
import { fetchUsage, mergeRateLimit, UsageAlerts } from './agent/usage'
import { Updater } from './updater'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const isMac = process.platform === 'darwin'
// 앞에서부터 등록을 시도. Ctrl+Space는 한글 IME 등이 선점하고 있으면 실패한다 (OPEN-005)
// Windows PC에서는 Control+Space / Control+Alt+Space / Alt+Space가 다른 앱에 선점되어 있음 (2026-10-09 확인)
// macOS는 Control+Space(입력 소스 전환)를 가로채도 등록이 성공해 버리므로 아예 후보에서 뺀다.
// Control+Option+Space는 '다음 입력 소스', Cmd+Space는 Spotlight 기본값
const GLOBAL_HOTKEYS = isMac ? ['Control+Shift+Space', 'Alt+Shift+Space'] : ['Control+Space', 'Control+Shift+Space']
let activeHotkey: string | null = null
let settingsStore: SettingsStore

/**
 * 전역 호출 키 등록. 사용자가 정한 키가 있으면 그 키만 시도하고, 실패하면 이전 키를 되살린 뒤 이유를 돌려준다.
 * 정하지 않았으면 플랫폼별 후보를 앞에서부터 시도한다
 */
function registerSummon(settings: Settings): string | undefined {
  const custom = settings.keymap.summon
  const previous = activeHotkey
  if (activeHotkey) globalShortcut.unregister(activeHotkey)
  activeHotkey = null
  if (custom) {
    const acc = toAccelerator(custom)
    try {
      if (globalShortcut.register(acc, toggleWindow)) {
        activeHotkey = acc
        return undefined
      }
    } catch {
      // 형식이 잘못된 키
    }
    if (previous && globalShortcut.register(previous, toggleWindow)) activeHotkey = previous
    return `${custom} 키를 등록하지 못했어요. 다른 앱이나 시스템이 쓰고 있을 수 있어요`
  }
  activeHotkey = GLOBAL_HOTKEYS.find((key) => globalShortcut.register(key, toggleWindow)) ?? null
  if (activeHotkey !== GLOBAL_HOTKEYS[0]) console.warn(`global hotkey ${GLOBAL_HOTKEYS[0]} unavailable; using ${activeHotkey ?? 'none'}`)
  return undefined
}

/** 로그인할 때 자동 실행. 개발 실행에서는 Electron 실행 파일이 등록되므로 패키징한 앱에서만 건드린다 */
function applyLoginItem(s: Settings): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: s.openAtLogin, args: ['--hidden'] })
}

/** 로그인 자동 실행으로 켜졌으면 창 없이 트레이에만 */
const startHidden = (): boolean => process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin === true)

/** 앱 아이콘 파일: 개발 실행은 저장소의 resources/icons, 패키징한 앱은 Resources/icons (extraResources) */
function iconFile(id: Settings['appIcon']): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons', `${id}.png`) : join(app.getAppPath(), 'resources', 'icons', `${id}.png`)
}

/** Dock(macOS)·창과 트레이(Windows/Linux) 아이콘을 바로 바꾼다 */
function applyAppIcon(s: Settings): void {
  const img = nativeImage.createFromPath(iconFile(s.appIcon))
  if (img.isEmpty()) return
  if (isMac) app.dock?.setIcon(img)
  else {
    win?.setIcon(img)
    tray?.setImage(makeTrayIcon(s))
  }
}

const themeBackground = (s: Settings): string => THEMES.find((t) => t.id === s.theme)?.colors[0] ?? '#ffffff'


let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap)
}

function bootstrap(): void {
  const store = new ProjectStore()
  settingsStore = new SettingsStore()
  ipcMain.on(IPC.getSettingsSync, (e) => {
    e.returnValue = settingsStore.get()
  })
  ipcMain.on(IPC.appInfo, (e) => {
    e.returnValue = { packaged: app.isPackaged, version: app.getVersion(), platform: process.platform }
  })
  applyLoginItem(settingsStore.get())
  ipcMain.handle(IPC.setSettings, (_e, next: Settings) => {
    const before = settingsStore.get()
    let saved = settingsStore.set(next)
    let error: string | undefined
    if (effectiveKeymap(saved).summon !== effectiveKeymap(before).summon) {
      error = registerSummon(saved)
      // 등록에 실패한 호출 키는 저장하지 않는다
      if (error) saved = settingsStore.set({ ...saved, keymap: { ...saved.keymap, summon: before.keymap.summon } })
    }
    win?.setBackgroundColor(themeBackground(saved))
    if (saved.openAtLogin !== before.openAtLogin) applyLoginItem(saved)
    if (saved.appIcon !== before.appIcon) applyAppIcon(saved)
    // 동시 실행 수를 늘렸으면 기다리던 대화를 바로 시작
    manager.drain()
    send(IPC.settingsChanged, saved)
    return { settings: saved, error }
  })
  const send = (channel: string, payload: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  // 구독 한도: 앱 시작·작업 완료·5분마다 새로 받고, 작업 중 오는 한도 이벤트는 바로 반영한다
  let usage: UsageInfo | null = null
  let usageInflight: Promise<UsageInfo | null> | null = null
  let usageTimer: ReturnType<typeof setTimeout> | null = null
  const USAGE_STALE_MS = 5 * 60_000
  const usageAlerts = new UsageAlerts()
  const alertUsage = (u: UsageInfo | null): void => {
    if (u) for (const a of usageAlerts.check(u)) notifier.usage(a.id, a.title, a.body)
  }
  const refreshUsage = (): Promise<UsageInfo | null> => {
    usageInflight ??= fetchUsage(manager.liveQuery())
      .then((u) => (usage = u))
      .catch((err: unknown) => {
        console.warn('사용량을 가져오지 못함', err)
        if (usage) usage = { ...usage, error: '최신 사용량을 가져오지 못했어요' }
        return usage
      })
      .finally(() => {
        usageInflight = null
        if (usage) send(IPC.usage, usage)
        alertUsage(usage)
      })
    return usageInflight
  }
  const refreshUsageSoon = (): void => {
    if (usageTimer) clearTimeout(usageTimer)
    usageTimer = setTimeout(() => void refreshUsage(), 2500)
  }

  const notifier = new Notifier(store, () => win, () => settingsStore.get(), (projectId, conversationId, terminal) => {
    showWindow()
    if (projectId) send(IPC.navigate, { projectId, conversationId, terminal })
  })
  ipcMain.on(IPC.terminalNotify, (_e, projectId: string, conversationId: string, termId: string, title: string, body: string) => notifier.terminalDone(projectId, conversationId, termId, title, body))
  ipcMain.on(IPC.setBadge, (_e, waiting: number, unread: number) => applyBadge(tray, waiting, unread))
  ipcMain.handle(IPC.searchConversations, (_e, query: string) => searchConversations(store.list(), query))
  // 대화창 아래 터미널 (대화마다 하나, 폴더는 cwdOf: 작업 공간이면 그 폴더)
  const terminals = new TerminalManager(
    (termId, data) => send(IPC.terminalData, { termId, data }),
    (termId, code) => send(IPC.terminalExit, { termId, code }),
    () => settingsStore.get().terminalShell,
  )
  ipcMain.handle(IPC.terminalOpen, (_e, projectId: string, conversationId: string, termId: string, cols: number, rows: number, shell?: TerminalShell) => {
    const project = store.get(projectId)
    const conv = store.getConversation(projectId, conversationId)
    if (!project || !conv) throw new Error(`대화 없음: ${projectId}/${conversationId}`)
    // 터미널에서 고른 셸은 다음 터미널의 기본값으로도 남긴다
    if (shell && shell !== settingsStore.get().terminalShell) send(IPC.settingsChanged, settingsStore.set({ ...settingsStore.get(), terminalShell: shell }))
    return terminals.open(termId, conversationId, cwdOf(project, conv), cols, rows, shell)
  })
  ipcMain.handle(IPC.terminalShells, () => availableShells())
  ipcMain.on(IPC.terminalWrite, (_e, termId: string, data: string) => terminals.write(termId, data))
  ipcMain.on(IPC.terminalResize, (_e, termId: string, cols: number, rows: number) => terminals.resize(termId, cols, rows))
  ipcMain.handle(IPC.terminalClose, (_e, termId: string) => terminals.close(termId))
  const updater = new Updater(
    (state) => send(IPC.updateChanged, state),
    () => (quitting = true),
  )
  ipcMain.handle(IPC.getUpdate, () => updater.get())
  ipcMain.handle(IPC.checkUpdate, () => updater.check())
  ipcMain.on(IPC.applyUpdate, () => updater.apply())

  const manager = new AgentManager(
    store,
    (e: AgentEventEnvelope) => {
      send(IPC.event, e)
      notifier.handle(e)
      if (e.event.kind === 'result') refreshUsageSoon()
    },
    (info: RateLimitInfo) => {
      send(IPC.rateLimit, info)
      usage = mergeRateLimit(usage, info)
      if (usage) send(IPC.usage, usage)
      alertUsage(usage)
    },
    () => settingsStore.get().maxConcurrent,
    // 제목이 바뀌면 (임시 제목·자동 제목) 탭·사이드바를 다시 그린다
    () => projectsChanged(),
  )
  ipcMain.handle(IPC.getUsage, (_e, refresh?: boolean) =>
    refresh || !usage || Date.now() - usage.fetchedAt > USAGE_STALE_MS ? refreshUsage() : usage,
  )
  setInterval(() => void refreshUsage(), USAGE_STALE_MS)
  const projectsChanged = (): void => send(IPC.projectsChanged, store.list())

  ipcMain.handle(IPC.getHotkey, () => activeHotkey?.replace('Control', 'Ctrl') ?? null)
  ipcMain.handle(IPC.listProjects, () => store.list())
  ipcMain.handle(IPC.addProject, async () => {
    // 홈 열의 키가 9개라 그 이상은 받지 않는다 (렌더러가 먼저 안내한다)
    if (store.list().length >= MAX_PROJECTS) return null
    const res = await dialog.showOpenDialog(win!, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const project = store.addProject(res.filePaths[0])
    projectsChanged()
    return project
  })
  ipcMain.handle(IPC.removeProject, (_e, projectId: string) => {
    for (const c of store.get(projectId)?.conversations ?? []) terminals.closeConversation(c.id)
    manager.disposeProject(projectId)
    store.removeProject(projectId)
    projectsChanged()
  })
  // 탭의 +: 하위 대화. 설정이 켜져 있으면 git worktree에서, git이 아니면 플랜 모드로 시작
  ipcMain.handle(IPC.addConversation, async (_e, projectId: string) => {
    const project = store.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    const extra: Partial<Conversation> = {}
    const id = newConversationId()
    if (settingsStore.get().worktree) {
      if (await isGitRepo(project.path)) {
        try {
          extra.worktree = await createWorktree(project.path, join(app.getPath('userData'), 'worktrees'), id)
        } catch (err) {
          console.warn('worktree를 만들지 못해 프로젝트 폴더에서 실행', err)
        }
      } else {
        extra.mode = 'plan'
      }
    }
    const conv = store.addConversation(projectId, extra, id)
    projectsChanged()
    return conv
  })
  ipcMain.handle(IPC.closeConversation, (_e, projectId: string, conversationId: string) => {
    // 셸이 작업 공간 폴더를 잡고 있으면 정리하지 못하므로 먼저 끝낸다
    terminals.closeConversation(conversationId)
    const next = manager.closeConversation(projectId, conversationId)
    projectsChanged()
    return next
  })
  ipcMain.handle(IPC.reopenConversation, (_e, projectId: string, conversationId: string) => {
    store.reopenConversation(projectId, conversationId)
    projectsChanged()
  })
  ipcMain.handle(IPC.saveTask, (_e, projectId: string, conversationId: string, task: StoredTask) => {
    if (store.saveTask(projectId, conversationId, task)) projectsChanged()
  })
  ipcMain.handle(IPC.startTask, (_e, projectId: string, text: string, continueId?: string) => {
    const existing = continueId ? store.getConversation(projectId, continueId) : undefined
    if (existing && !existing.closedAt) {
      manager.send(projectId, existing.id, text)
      return existing.id
    }
    const conv = store.conversationForTask(projectId, text, (c) => !manager.hasSession(c.id))
    projectsChanged()
    manager.send(projectId, conv.id, text)
    return conv.id
  })
  ipcMain.handle(IPC.send,(_e, projectId: string, conversationId: string, text: string) =>
    manager.send(projectId, conversationId, text),
  )
  ipcMain.handle(IPC.interrupt, (_e, projectId: string, conversationId: string) => manager.interrupt(projectId, conversationId))
  ipcMain.handle(IPC.stopTask, (_e, projectId: string, conversationId: string, taskId: string) => manager.stopTask(projectId, conversationId, taskId))
  ipcMain.handle(IPC.renameConversation, async (_e, projectId: string, conversationId: string, title: string) => {
    await manager.rename(projectId, conversationId, title)
    projectsChanged()
  })
  ipcMain.handle(IPC.taskOutput, (_e, projectId: string, conversationId: string, taskId: string) => manager.taskOutput(projectId, conversationId, taskId))
  ipcMain.handle(IPC.setMode, async (_e, projectId: string, conversationId: string, mode: AgentMode) => {
    await manager.setMode(projectId, conversationId, mode)
    projectsChanged()
  })
  ipcMain.handle(IPC.compact, (_e, projectId: string, conversationId: string, instructions?: string) =>
    manager.compact(projectId, conversationId, instructions),
  )
  ipcMain.handle(IPC.listCommands, (_e, projectId: string) => manager.listCommands(projectId))
  ipcMain.handle(IPC.loadHistory, (_e, projectId: string, conversationId: string) => manager.loadHistory(projectId, conversationId))
  ipcMain.handle(IPC.listModels, (_e, projectId: string) => manager.listModels(projectId))
  ipcMain.handle(IPC.setModel, (_e, projectId: string, conversationId: string, option: ModelOption) => manager.setModel(projectId, conversationId, option))
  ipcMain.handle(IPC.getEffort, (_e, projectId: string, conversationId: string) => manager.getEffort(projectId, conversationId))
  ipcMain.handle(IPC.setEffort, async (_e, projectId: string, conversationId: string, effort: EffortLevel | null) => {
    await manager.setEffort(projectId, conversationId, effort)
    projectsChanged()
  })
  ipcMain.handle(IPC.gitBranch, (_e, projectId: string, conversationId: string) => {
    const project = store.get(projectId)
    const conv = store.getConversation(projectId, conversationId)
    return project && conv ? branchOf(cwdOf(project, conv)) : null
  })
  // 스크린샷 붙여넣기: 붙여넣은 이미지를 userData/attachments에 저장하고 그 경로를 입력창에 넣는다 (에이전트가 Read로 본다)
  ipcMain.handle(IPC.saveImage, (_e, data: Uint8Array, ext: string) => {
    const dir = join(app.getPath('userData'), 'attachments')
    mkdirSync(dir, { recursive: true })
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const safeExt = /^(png|jpe?g|gif|webp)$/i.test(ext) ? ext.toLowerCase() : 'png'
    const file = join(dir, `screenshot-${stamp}-${Math.random().toString(36).slice(2, 6)}.${safeExt}`)
    writeFileSync(file, Buffer.from(data))
    return file
  })
  const worktreeOf = (projectId: string, conversationId: string) => {
    const project = store.get(projectId)
    const conv = store.getConversation(projectId, conversationId)
    return project && conv?.worktree ? { project, conv, wt: conv.worktree } : null
  }
  ipcMain.handle(IPC.worktreeChanges, async (_e, projectId: string, conversationId: string) => {
    const t = worktreeOf(projectId, conversationId)
    if (!t) return null
    try {
      return await worktreeChanges(t.project.path, t.wt)
    } catch (err) {
      // 버리는 중이라 폴더가 없어졌으면 작업 공간이 없는 것으로 (그 밖의 오류는 그대로 알린다)
      if (!existsSync(t.wt.path) || !existsSync(join(t.wt.path, '.git'))) return null
      throw err
    }
  })
  ipcMain.handle(IPC.worktreeMerge, async (_e, projectId: string, conversationId: string) => {
    const t = worktreeOf(projectId, conversationId)
    if (!t) return { ok: false, message: '작업 공간이 없는 대화예요' }
    return mergeWorktree(t.project.path, t.wt, t.conv.title)
  })
  ipcMain.handle(IPC.worktreeDiscard, async (_e, projectId: string, conversationId: string) => {
    const t = worktreeOf(projectId, conversationId)
    // 대화를 먼저 닫아 세션·셸을 끝낸 뒤 작업 공간을 지운다 (보고서 때문에 남는 대화도 작업 공간은 없앤다)
    terminals.closeConversation(conversationId)
    const next = manager.closeConversation(projectId, conversationId)
    if (t) {
      await discardWorktree(t.project.path, t.wt)
      store.updateConversation(projectId, conversationId, { worktree: undefined })
    }
    projectsChanged()
    return next
  })
  ipcMain.handle(IPC.pickFiles, async () => {
    const res = await dialog.showOpenDialog(win!, { title: '첨부할 파일', properties: ['openFile', 'multiSelections'] })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle(IPC.searchFiles, (_e, projectId: string, conversationId: string, q: string) => {
    const project = store.get(projectId)
    return project ? searchFiles(cwdOf(project, store.getConversation(projectId, conversationId)), q) : []
  })
  ipcMain.handle(IPC.peek, (_e, projectId: string, conversationId: string) => manager.peek(projectId, conversationId))
  ipcMain.handle(IPC.clear, (_e, projectId: string, conversationId: string) => {
    manager.clear(projectId, conversationId)
    // 저장된 세션 ID·컨텍스트 값이 지워졌으니 화면 목록도 갱신 (이전 값이 잠깐 보이지 않게)
    projectsChanged()
  })
  ipcMain.handle(
    IPC.respondPermission,
    (_e, _projectId: string, conversationId: string, requestId: string, decision: PermissionDecision, extra?: PermissionExtra) =>
      manager.respondPermission(conversationId, requestId, decision, extra),
  )
  ipcMain.handle(IPC.dropQueued, (_e, projectId: string, conversationId: string, queuedId: string) => manager.dropQueued(projectId, conversationId, queuedId))
  ipcMain.handle(IPC.toolResult, (_e, projectId: string, conversationId: string, toolUseId: string) => manager.toolResult(projectId, conversationId, toolUseId))
  ipcMain.handle(IPC.rewind, async (_e, projectId: string, conversationId: string, uuid: string, scope: RewindScope, dryRun?: boolean) => {
    const r = await manager.rewind(projectId, conversationId, uuid, scope, dryRun)
    if (!dryRun && r.ok) projectsChanged()
    return r
  })
  ipcMain.handle(IPC.listSessions, (_e, projectId: string) => manager.listSessions(projectId))
  ipcMain.handle(IPC.attachSession, async (_e, projectId: string, conversationId: string, sessionId: string, title: string) => {
    const id = await manager.attachSession(projectId, conversationId, sessionId, title)
    projectsChanged()
    return id
  })
  ipcMain.handle(IPC.forkConversation, async (_e, projectId: string, conversationId: string, title?: string) => {
    const id = await manager.forkConversation(projectId, conversationId, title)
    projectsChanged()
    return id
  })
  ipcMain.handle(IPC.mcpStatus, (_e, projectId: string, conversationId: string) => manager.mcpStatus(projectId, conversationId))
  ipcMain.handle(IPC.mcpReconnect, (_e, projectId: string, conversationId: string, name: string) => manager.mcpReconnect(projectId, conversationId, name))
  ipcMain.handle(IPC.mcpToggle, (_e, projectId: string, conversationId: string, name: string, enabled: boolean) => manager.mcpToggle(projectId, conversationId, name, enabled))
  ipcMain.handle(IPC.listAgents, (_e, projectId: string) => manager.listAgents(projectId))
  ipcMain.handle(IPC.permissionsInfo, (_e, projectId: string, conversationId: string) => {
    const project = store.get(projectId)
    const conv = store.getConversation(projectId, conversationId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    return permissionsInfo(cwdOf(project, conv), conv?.additionalDirectories)
  })
  ipcMain.handle(IPC.setPermissionRule, (_e, projectId: string, source: PermissionRuleSource, kind: 'allow' | 'deny' | 'ask', rule: string, on: boolean) => {
    const project = store.get(projectId)
    if (!project) throw new Error(`프로젝트 없음: ${projectId}`)
    setPermissionRule(project.path, source, kind, rule.trim(), on)
    return permissionsInfo(project.path)
  })
  ipcMain.handle(IPC.addDirectory, async (_e, projectId: string, conversationId: string, path?: string, remove?: boolean) => {
    const conv = store.getConversation(projectId, conversationId)
    if (!conv) throw new Error(`대화 없음: ${projectId}/${conversationId}`)
    let dirs = conv.additionalDirectories ?? []
    if (remove && path) dirs = dirs.filter((d) => d !== path)
    else {
      let add = path?.trim()
      if (!add) {
        const res = await dialog.showOpenDialog(win!, { title: '더 쓸 폴더', properties: ['openDirectory'] })
        add = res.canceled ? undefined : res.filePaths[0]
      }
      if (add && !dirs.includes(add)) dirs = [...dirs, add]
    }
    await manager.setAdditionalDirectories(projectId, conversationId, dirs)
    projectsChanged()
    return dirs
  })
  ipcMain.handle(IPC.memoryFiles, (_e, projectId: string) => {
    const project = store.get(projectId)
    return project ? memoryFiles(project.path) : []
  })
  ipcMain.handle(IPC.openPath, async (_e, path: string, create?: boolean) => {
    if (create && !existsSync(path)) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '')
    }
    return shell.openPath(path)
  })
  ipcMain.handle(IPC.exportConversation, async (_e, projectId: string, conversationId: string) => {
    const project = store.get(projectId)
    const conv = store.getConversation(projectId, conversationId)
    if (!project || !conv?.sessionId) return null
    const safe = conv.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'conversation'
    const res = await dialog.showSaveDialog(win!, { title: '대화 내보내기', defaultPath: join(project.path, `${safe}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, await exportMarkdown(conv.sessionId, cwdOf(project, conv), conv.title), 'utf8')
    return res.filePath
  })
  ipcMain.handle(IPC.sessionStatus, (_e, projectId: string, conversationId: string) => manager.sessionStatus(projectId, conversationId))
  ipcMain.handle(IPC.accountStatus, (_e, refresh?: boolean) => manager.accountStatus(refresh))
  ipcMain.handle(IPC.loginCommand, () => loginCommand())
  ipcMain.handle(IPC.prewarm, () => manager.prewarm())

  // Windows: 기본 메뉴의 Alt 니모닉(Alt+F 파일, Alt+H 도움말 …)이 Alt+홈 줄 프로젝트 이동과 겹치므로 메뉴를 없앤다.
  // 메뉴가 없어도 입력창의 복사·붙여넣기는 그대로 동작한다.
  // macOS: 메뉴 막대는 창과 별개라 니모닉이 없고, Edit 메뉴가 없으면 Cmd+C/V/A/Z가 동작하지 않으므로 최소 메뉴를 둔다.
  // 메뉴 단축키는 모두 Cmd 기반이라 앱의 Ctrl/Alt 단축키와 겹치지 않는다
  Menu.setApplicationMenu(isMac ? buildMacMenu() : null)
  createWindow()
  createTray()
  updater.start()

  registerSummon(settingsStore.get())
  applyAppIcon(settingsStore.get())

  app.on('before-quit', () => {
    quitting = true
    updater.stop()
    manager.disposeAll()
    terminals.closeAll()
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  // 상주형: 창을 닫아도 트레이에 남는다
  app.on('window-all-closed', () => {})
  // macOS: Dock 아이콘을 누르면 숨긴 창을 다시 연다
  app.on('activate', showWindow)
}

/** macOS 메뉴 막대. Cmd+W는 창 닫기(=숨기기), Cmd+Q는 종료 */
function buildMacMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => win?.webContents.send(IPC.openSettings) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
  if (process.env.ELECTRON_RENDERER_URL) {
    template.splice(2, 0, { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] })
  }
  return Menu.buildFromTemplate(template)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'WHENTERMINAL',
    backgroundColor: themeBackground(settingsStore.get()),
    icon: iconFile(settingsStore.get().appIcon),
    autoHideMenuBar: true,
    // Windows: 제목 표시줄·창 버튼 없는 창. 끌기는 사이드바 로고(-webkit-app-region), 크기 조절은 가장자리, 닫기는 Alt+F4(트레이로)
    frame: isMac,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  win.once('ready-to-show', () => {
    if (!startHidden()) win?.show()
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  // 답변 속 링크: 앱 창 안에서 이동하지 않고 http(s)만 외부 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL() && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) e.preventDefault()
  })
  // 전체화면은 F11 고정 (Ctrl+Shift+F는 대화 검색)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.control && !input.alt && !input.shift && !input.meta) {
      toggleFullscreen()
      e.preventDefault()
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer gone]', details.reason))
  if (process.env.ELECTRON_RENDERER_URL) {
    // 개발 중에는 렌더러 콘솔 경고/오류를 터미널로 넘겨 본다
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
    })
    // 기본 메뉴를 없앴으므로 개발용 단축키만 직접 붙인다 (F키 없는 40% 배열 기준)
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !input.control || !input.shift) return
      if (input.code === 'KeyI') { win?.webContents.toggleDevTools(); e.preventDefault() }
      if (input.code === 'KeyR') { win?.webContents.reload(); e.preventDefault() }
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function toggleFullscreen(): void {
  if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen())
}

function createTray(): void {
  tray = new Tray(makeTrayIcon(settingsStore.get()))
  tray.setToolTip('WHENTERMINAL')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('click', showWindow)
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

const TRAY_PROMPT = new Set(['4,4', '5,5', '6,6', '7,7', '6,8', '5,9', '4,10', '5,4', '6,5', '7,6', '8,7', '7,8', '6,9', '5,10'])
const isPromptPixel = (x: number, y: number): boolean => TRAY_PROMPT.has(`${x},${y}`) || (y === 11 && x >= 9 && x <= 12)

/**
 * 트레이 아이콘. Windows/Linux는 설정에서 고른 앱 아이콘을 16px(+고DPI 배율)로 줄여 쓴다.
 * macOS 메뉴 막대는 흑백 템플릿 이미지가 관례라 따로 그린다
 */
function makeTrayIcon(s: Settings): Electron.NativeImage {
  if (isMac) return makeMacTrayIcon()
  const src = nativeImage.createFromPath(iconFile(s.appIcon))
  if (src.isEmpty()) return makeFallbackTrayIcon()
  const img = nativeImage.createEmpty()
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const px = Math.round(16 * scaleFactor)
    img.addRepresentation({ scaleFactor, buffer: src.resize({ width: px, height: px, quality: 'best' }).toPNG() })
  }
  return img
}

/** 아이콘 파일을 못 읽었을 때: 16x16을 코드로 그린다. 둥근 사각형 + 프롬프트 기호 '>' */
function makeFallbackTrayIcon(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const corner = (x === 0 || x === size - 1) && (y === 0 || y === size - 1)
      if (corner) continue
      const fg = isPromptPixel(x, y)
      // BGRA
      buf[i] = fg ? 0xff : 0xe0
      buf[i + 1] = fg ? 0xff : 0x8a
      buf[i + 2] = fg ? 0xff : 0x3b
      buf[i + 3] = 0xff
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/**
 * macOS 메뉴 막대용 템플릿 이미지: 검정 + 투명만 쓰면 OS가 밝은/어두운 메뉴 막대에 맞춰 색을 입힌다.
 * Retina에서 흐리지 않게 16pt를 2배(32px)로 그리고, 프롬프트 기호 '>_'만 남긴다
 */
function makeMacTrayIcon(): Electron.NativeImage {
  const scale = 2
  const size = 16 * scale
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isPromptPixel(Math.floor(x / scale), Math.floor(y / scale))) continue
      buf[(y * size + x) * 4 + 3] = 0xff // BGRA: 검정 + 불투명
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: scale })
  img.setTemplateImage(true)
  return img
}
