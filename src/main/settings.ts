import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIONS, DEFAULT_SETTINGS, normalize, THEMES, type Settings } from '@shared/keymap'

/** userData/settings.json. 읽지 못하거나 모르는 값은 기본값으로 */
export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)

  constructor() {
    if (!existsSync(this.file)) return
    try {
      this.settings = sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      console.error('settings.json 읽기 실패, 기본값으로 시작', err)
    }
  }

  get(): Settings {
    return structuredClone(this.settings)
  }

  set(next: Settings): Settings {
    this.settings = sanitize(next)
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8')
    renameSync(tmp, this.file)
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
    whenFocused: typeof n.whenFocused === 'boolean' ? n.whenFocused : d.whenFocused,
  }
  const maxConcurrent = Number.isInteger(o.maxConcurrent) && o.maxConcurrent! >= 0 && o.maxConcurrent! <= 16 ? o.maxConcurrent! : DEFAULT_SETTINGS.maxConcurrent
  return { theme, notify, maxConcurrent, keymap }
}
