import { useState } from 'react'
import { ACTIONS, APP_ICONS, conflictsOf, DEFAULT_KEYMAP, effectiveKeymap, SCOPE_LABEL, THEMES, type ActionDef, type ActionId, type ActionScope, type Settings, type ThemeId } from '@shared/keymap'
import { Keys } from './KeyHint'
import { ALT_LABEL, eventToBinding } from './keys'

interface Props {
  settings: Settings
  /** 지금 실제로 등록된 전역 호출 키 (사용자가 정하지 않았을 때 플랫폼 기본값이 다를 수 있다) */
  activeHotkey: string | null
  onClose: () => void
  onSaved: (settings: Settings, activeHotkey?: string | null) => void
}

const SCOPES: ActionScope[] = ['system', 'anywhere', 'home', 'chat', 'approval']

/** 바꿀 수 없는 키: 다른 기능이 쓰거나 비상용이라 고정 */
const FIXED: { keys: string; label: string }[] = [
  { keys: 'esc', label: 'Interrupt · close · cancel' },
  { keys: 'F11', label: 'Full screen' },
  { keys: `${ALT_LABEL} A S D F G H J K L`, label: 'Go to project 1–9' },
  { keys: 'ctrl 1…9', label: 'Go to project 1–9 (alt.)' },
  { keys: 'ctrl C', label: 'Interrupt (when nothing is selected)' },
  { keys: '↑ ↓ ← →', label: 'Move on home (alt.)' },
]

// resources/icons/*.png를 번들에 넣어 미리보기로 쓴다 (실제 Dock 아이콘은 메인이 같은 파일로 바꾼다)
const ICON_SRC = import.meta.glob('../../../resources/icons/*.png', { eager: true, import: 'default' }) as Record<string, string>
const iconSrc = (id: string): string => ICON_SRC[`../../../resources/icons/${id}.png`] ?? ''

const NOTIFY: { id: keyof Settings['notify']; label: string; note: string }[] = [
  { id: 'approval', label: 'Approval requests', note: '알림을 누르면 그 대화로 가요. macOS는 Dock 아이콘도 한 번 튀어요' },
  { id: 'done', label: 'Task finished', note: '완료와 오류 모두 알려요' },
  { id: 'whenFocused', label: 'Even when focused', note: '끄면 다른 창에 있을 때만 알려요' },
]

/** 새 키를 받아도 되는지. 안 되면 이유 */
function validate(a: ActionDef, binding: string): string | null {
  const hasMod = /(^|\+)(Ctrl|Alt|Meta)\+/.test(binding)
  if ((a.scope === 'system' || a.scope === 'anywhere' || a.scope === 'chat') && !hasMod && binding !== 'Shift+Tab') {
    return 'Ctrl·Alt·Meta 중 하나와 함께 눌러 주세요. 글자 키만 쓰면 입력하는 중에 실행돼요'
  }
  if (binding === 'Esc' || binding === 'Ctrl+C' || /^Alt\+[ASDFGHJKL]$/.test(binding) || /^Ctrl\+[1-9]$/.test(binding)) {
    return '고정된 키라 쓸 수 없어요'
  }
  if (a.scope === 'system' && /Tab$/.test(binding)) return '전역 호출 키로 Tab은 쓸 수 없어요'
  return null
}

export function SettingsScreen({ settings, activeHotkey, onClose, onSaved }: Props): React.JSX.Element {
  const [recording, setRecording] = useState<ActionId | null>(null)
  const [message, setMessage] = useState<{ id: ActionId; text: string } | null>(null)
  const km = effectiveKeymap(settings)
  const changed = Object.keys(settings.keymap).length > 0

  const [saveError, setSaveError] = useState<string | null>(null)
  const save = async (next: Settings, forId?: ActionId): Promise<void> => {
    try {
      const res = await window.api.setSettings(next)
      const hk = forId === 'summon' ? await window.api.getHotkey() : undefined
      onSaved(res.settings, hk)
      setSaveError(null)
      if (res.error && forId) setMessage({ id: forId, text: res.error })
    } catch (err) {
      setSaveError(`설정을 저장하지 못했어요: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const setBinding = (id: ActionId, binding: string): void => {
    const keymap = { ...settings.keymap }
    if (binding === DEFAULT_KEYMAP[id]) delete keymap[id]
    else keymap[id] = binding
    setMessage(null)
    void save({ ...settings, keymap }, id)
  }

  const onRecordKey = (a: ActionDef, e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    if (e.key === 'Escape' && plain) return setRecording(null)
    if ((e.key === 'Backspace' || e.key === 'Delete') && plain) {
      setRecording(null)
      return setBinding(a.id, a.default)
    }
    const binding = eventToBinding(e.nativeEvent)
    if (!binding) return // 수정 키만 누른 상태: 계속 기다린다
    const why = validate(a, binding)
    if (why) return setMessage({ id: a.id, text: `${binding.replace(/\+/g, ' + ')} · ${why}` })
    setRecording(null)
    setBinding(a.id, binding)
  }

  return (
    <div className="screen settings">
      <header className="topbar">
        <div className="tb-proj">
          <span className="tb-key settings-title">SETTINGS</span>
          <span className="tb-name">
            <b>WHENTERMINAL v{window.api.appInfo.version}</b>
            <span>바꾸면 바로 적용되고 저장돼요</span>
          </span>
        </div>
        <div className="tb-right">
          <button type="button" className="tb-btn" onClick={onClose}>
            CLOSE <Keys keys="esc" />
          </button>
        </div>
      </header>

      <main className="settings-body">
        {saveError && <div className="msg notice error" role="alert">{saveError}</div>}
        <section className="set-sec" aria-labelledby="set-theme">
          <h2 id="set-theme" className="col-h">THEME</h2>
          <div className="themes" role="radiogroup" aria-label="색 테마">
            {THEMES.map((t) => {
              const on = settings.theme === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`theme ${on ? 'on' : ''}`}
                  onClick={() => !on && void save({ ...settings, theme: t.id as ThemeId })}
                >
                  <span className="theme-swatch" style={{ background: t.colors[0], color: t.colors[1] }} aria-hidden="true">
                    <span className="sw-key" style={{ color: t.colors[1] }}>A</span>
                    <span className="sw-lines">
                      <i style={{ background: t.colors[1] }} />
                      <i style={{ background: t.colors[1], opacity: 0.5 }} />
                      <i style={{ background: t.colors[2], width: '45%' }} />
                    </span>
                    <span className="sw-band" style={{ background: t.colors[2] }} />
                  </span>
                  <span className="theme-name">
                    {t.name}
                    {on && <span className="theme-on">IN USE</span>}
                  </span>
                  <span className="theme-note">{t.note}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="set-sec" aria-labelledby="set-icon">
          <h2 id="set-icon" className="col-h">APP ICON</h2>
          <div className="icons" role="radiogroup" aria-label="앱 아이콘">
            {APP_ICONS.map((ic, k) => {
              const on = settings.appIcon === ic.id
              return (
                <button key={ic.id} type="button" role="radio" aria-checked={on} className={`icon-pick ${on ? 'on' : ''}`} onClick={() => !on && void save({ ...settings, appIcon: ic.id })}>
                  <img src={iconSrc(ic.id)} alt="" width={96} height={96} />
                  <span className="theme-name">
                    <span className="nowrap">
                      <span className="disp">0{k + 1}</span> {ic.name}
                    </span>
                    {on && <span className="theme-on">IN USE</span>}
                  </span>
                  <span className="theme-note">{ic.note}</span>
                </button>
              )
            })}
          </div>
          <p className="set-help">{window.api.appInfo.platform === 'darwin' ? '고르면 Dock 아이콘이 바로 바뀌어요.' : '고르면 창 아이콘이 바로 바뀌어요.'} 설치 파일의 아이콘은 02 PROMPT예요.</p>
        </section>

        <section className="set-sec" aria-labelledby="set-run">
          <h2 id="set-run" className="col-h">RUN</h2>
          <div className="krow">
            <span className="krow-label">
              Max concurrent
              <span className="krow-note">넘치면 대기로 두고 자리가 나는 순서대로 시작해요. 확인을 기다리는 대화도 한 자리를 써요</span>
            </span>
            <span className="seg" role="radiogroup" aria-label="동시 실행 수">
              {[1, 2, 3, 4, 6, 0].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={settings.maxConcurrent === n}
                  className={settings.maxConcurrent === n ? 'on' : ''}
                  onClick={() => void save({ ...settings, maxConcurrent: n })}
                >
                  {n === 0 ? '∞' : n}
                </button>
              ))}
            </span>
            <span className="krow-side" />
          </div>
        </section>

        <section className="set-sec set-sec-cont" aria-label="하위 대화 작업 공간">
          <div className="krow">
            <span className="krow-label">
              Worktree for new tabs
              <span className="krow-note">탭의 +로 만든 대화를 git worktree(새 브랜치 wt/…)에서 실행해 파일 충돌을 막아요. git 저장소가 아니면 플랜 모드로 시작해요</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.worktree}
              aria-label="하위 대화는 따로 작업"
              className={`switch ${settings.worktree ? 'on' : ''}`}
              onClick={() => void save({ ...settings, worktree: !settings.worktree })}
            >
              <i />
              <span>{settings.worktree ? 'ON' : 'OFF'}</span>
            </button>
            <span className="krow-side" />
          </div>
        </section>

        <section className="set-sec set-sec-cont" aria-label="자동 실행">
          <div className="krow">
            <span className="krow-label">
              Open at login
              <span className="krow-note">
                {window.api.appInfo.packaged ? '창은 숨긴 채 트레이에서 시작해요' : '패키징한 앱에서만 동작해요 (지금은 개발 실행)'}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.openAtLogin}
              aria-label="로그인할 때 자동 실행"
              className={`switch ${settings.openAtLogin ? 'on' : ''}`}
              onClick={() => void save({ ...settings, openAtLogin: !settings.openAtLogin })}
            >
              <i />
              <span>{settings.openAtLogin ? 'ON' : 'OFF'}</span>
            </button>
            <span className="krow-side" />
          </div>
        </section>

        <section className="set-sec" aria-labelledby="set-notify">
          <h2 id="set-notify" className="col-h">NOTIFICATIONS</h2>
          {NOTIFY.map((n) => {
            const on = settings.notify[n.id]
            return (
              <div key={n.id} className="krow">
                <span className="krow-label">
                  {n.label}
                  <span className="krow-note">{n.note}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={n.label}
                  className={`switch ${on ? 'on' : ''}`}
                  onClick={() => void save({ ...settings, notify: { ...settings.notify, [n.id]: !on } })}
                >
                  <i />
                  <span>{on ? 'ON' : 'OFF'}</span>
                </button>
                <span className="krow-side" />
              </div>
            )
          })}
        </section>

        <section className="set-sec" aria-labelledby="set-keys">
          <h2 id="set-keys" className="col-h">
            SHORTCUTS
            {changed && (
              <button type="button" className="btn sm set-reset" onClick={() => void save({ ...settings, keymap: {} }, 'summon')}>
                RESET ALL
              </button>
            )}
          </h2>
          <p className="set-help">
            키 칸을 누른 뒤 새 조합을 눌러 주세요. <Keys keys="esc" /> 취소, <Keys keys="Backspace" /> 기본값으로 되돌리기.
          </p>
          {SCOPES.map((scope) => (
            <div key={scope} className="kgroup">
              <h3 className="kgroup-h">{SCOPE_LABEL[scope]}</h3>
              {ACTIONS.filter((a) => a.scope === scope).map((a) => {
                const conflicts = conflictsOf(km, a.id)
                const rec = recording === a.id
                const custom = settings.keymap[a.id] !== undefined
                // 전역 호출 키는 사용자가 정하지 않았으면 실제 등록된 키를 보여준다 (플랫폼마다 다름)
                const shown = a.id === 'summon' && !custom && activeHotkey ? activeHotkey : km[a.id]
                return (
                  <div key={a.id} className={`krow ${conflicts.length ? 'conflict' : ''} ${rec ? 'rec' : ''}`}>
                    <span className="krow-label">{a.label}</span>
                    <button
                      type="button"
                      className="kbind"
                      data-keys-own={rec ? 'true' : undefined}
                      aria-label={`${a.label} 단축키 ${shown}. 눌러서 바꾸기`}
                      onClick={() => {
                        setMessage(null)
                        setRecording(rec ? null : a.id)
                      }}
                      onKeyDown={(e) => rec && onRecordKey(a, e)}
                      onBlur={() => rec && setRecording(null)}
                    >
                      {rec ? <span className="kbind-wait">PRESS KEYS…</span> : <Keys keys={shown} />}
                    </button>
                    <span className="krow-side">
                      {custom && !rec && (
                        <button type="button" className="link" onClick={() => setBinding(a.id, a.default)}>
                          DEFAULT <Keys keys={a.default} />
                        </button>
                      )}
                    </span>
                    {conflicts.length > 0 && (
                      <span className="krow-msg">
                        CONFLICT: {conflicts.map((c) => ACTIONS.find((x) => x.id === c)!.label).join(', ')}
                      </span>
                    )}
                    {message?.id === a.id && <span className="krow-msg">{message.text}</span>}
                  </div>
                )
              })}
            </div>
          ))}
          <div className="kgroup">
            <h3 className="kgroup-h">FIXED</h3>
            {FIXED.map((f) => (
              <div key={f.label} className="krow fixed">
                <span className="krow-label">{f.label}</span>
                <span className="kbind static">
                  <Keys keys={f.keys} />
                </span>
                <span className="krow-side" />
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
