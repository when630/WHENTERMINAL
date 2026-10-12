import { app } from 'electron'
import { join } from 'node:path'
import { ACTIONS, APP_ICONS, DEFAULT_SETTINGS, normalize, THEMES, type Settings } from '@shared/keymap'
import type { TerminalShell } from '@shared/types'
import { readJson, writeJson } from './json-file'

const TERMINAL_SHELLS: TerminalShell[] = ['auto', 'pwsh', 'powershell', 'gitbash', 'cmd', 'wsl', 'zsh', 'bash', 'fish']

/** userData/settings.json. 읽지 못하거나 모르는 값은 기본값으로 */
export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)

  constructor() {
    const saved = readJson(this.file)
    if (saved !== undefined) this.settings = sanitize(saved)
  }

  get(): Settings {
    return structuredClone(this.settings)
  }

  set(next: Settings): Settings {
    this.settings = sanitize(next)
    writeJson(this.file, this.settings)
    return this.get()
  }
}

function sanitize(raw: unknown): Settings {
  const o = (raw ?? {}) as Partial<Settings>
  const theme = THEMES.some((t) => t.id === o.theme) ? o.theme! : DEFAULT_SETTINGS.theme
  const keymap: Settings['keymap'] = {}
  for (const a of ACTIONS) {
    const v = o.keymap?.[a.id]
    // 기본값과 같으면 저장하지 않는다 (기본값이 바뀌면 따라가게)
    if (typeof v === 'string' && normalize(v) && normalize(v) !== normalize(a.default)) keymap[a.id] = normalize(v)
  }
  const n = (o.notify ?? {}) as Partial<Settings['notify']>
  const d = DEFAULT_SETTINGS.notify
  const notify = {
    approval: typeof n.approval === 'boolean' ? n.approval : d.approval,
    done: typeof n.done === 'boolean' ? n.done : d.done,
    terminal: typeof n.terminal === 'boolean' ? n.terminal : d.terminal,
    usage: typeof n.usage === 'boolean' ? n.usage : d.usage,
    whenFocused: typeof n.whenFocused === 'boolean' ? n.whenFocused : d.whenFocused,
  }
  const maxConcurrent = Number.isInteger(o.maxConcurrent) && o.maxConcurrent! >= 0 && o.maxConcurrent! <= 16 ? o.maxConcurrent! : DEFAULT_SETTINGS.maxConcurrent
  const worktree = typeof o.worktree === 'boolean' ? o.worktree : DEFAULT_SETTINGS.worktree
  const openAtLogin = typeof o.openAtLogin === 'boolean' ? o.openAtLogin : DEFAULT_SETTINGS.openAtLogin
  const appIcon = APP_ICONS.some((i) => i.id === o.appIcon) ? o.appIcon! : DEFAULT_SETTINGS.appIcon
  const terminalShell = TERMINAL_SHELLS.includes(o.terminalShell as TerminalShell) ? o.terminalShell! : DEFAULT_SETTINGS.terminalShell
  return { theme, appIcon, notify, maxConcurrent, worktree, openAtLogin, terminalShell, keymap }
}
