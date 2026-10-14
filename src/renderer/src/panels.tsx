import { useEffect, useRef, useState } from 'react'
import type { DidFailLoadEvent, DidNavigateEvent, WebviewTag } from 'electron'
import { Presence, PresenceList } from './motion'
import type { AgentOption, McpServerInfo, MemoryFile, PermissionRuleSource, PermissionsInfo, RewindScope, SessionOption, SessionStatus } from '@shared/types'
import { ARTIFACT_PARTITION, MODE_LABEL } from '@shared/types'
import { artifactsOf, relPath as relPathOf, summarizeInput as summarizeInputOf, type TranscriptItem } from './state'
import { elapsed, useNow } from './time'
import { GitPanel } from './GitPanel'

// 대화 기록 자리에 펼치는 명령 화면들 (CLI의 /rewind /resume /mcp /agents /permissions /hooks /memory /status).
// 모양은 작업 공간 CHANGES(WorktreePanel)와 같다: 머리줄 + 본문

export type ToolPanel =
  | { kind: 'rewind'; uuid?: string }
  | { kind: 'resume' }
  | { kind: 'mcp' }
  | { kind: 'agents' }
  | { kind: 'permissions' }
  | { kind: 'memory' }
  | { kind: 'status' }
  /** 이번 작업에서 부른 도구 목록. since는 작업 시작 시각 (없으면 전부) */
  | { kind: 'tools'; since?: number }
  /** Artifact 도구로 올린 claude.ai 페이지를 앱 안에서 (상태 패널의 ARTIFACTS 줄) */
  | { kind: 'artifact'; url: string; title: string }
  /** 브랜치·커밋 기록·diff (/git, 키맵 git) */
  | { kind: 'git' }

export const PANEL_TITLE: Record<ToolPanel['kind'], string> = {
  rewind: 'REWIND',
  resume: 'RESUME',
  mcp: 'MCP',
  agents: 'AGENTS',
  permissions: 'PERMISSIONS',
  memory: 'MEMORY',
  status: 'STATUS',
  tools: 'TOOLS',
  artifact: 'ARTIFACT',
  git: 'GIT',
}

interface Props {
  panel: ToolPanel
  projectId: string
  conversationId: string
  items: TranscriptItem[]
  /** 실행 중이면 되감기를 막는다 */
  busy: boolean
  onClose: () => void
  /** 대화를 되감은 뒤: 그 메시지의 글을 입력창에 되돌려 놓는다 */
  onRewound: (text?: string) => void
  onOpenConversation: (conversationId: string) => void
  /** 아래 터미널 입력줄에 명령을 넣는다 (실행은 사용자가) */
  onRunInTerminal: (command: string) => void
  /** 입력창 커서 자리에 글을 넣는다 (@agent-이름 등) */
  onInsert: (text: string) => void
  /** 대화 기록의 그 도구 호출로 가서 펼친다 */
  onJumpToTool: (toolUseId: string) => void
  /** 경로를 줄여 보일 기준 폴더 */
  root: string
}

export function ToolPanelView(props: Props): React.JSX.Element {
  const { panel } = props
  switch (panel.kind) {
    case 'tools':
      return <ToolsPanel {...props} since={panel.since} />
    case 'rewind':
      return <RewindPanel {...props} uuid={panel.uuid} />
    case 'resume':
      return <ResumePanel {...props} />
    case 'mcp':
      return <McpPanel {...props} />
    case 'agents':
      return <AgentsPanel {...props} />
    case 'permissions':
      return <PermissionsPanel {...props} />
    case 'memory':
      return <MemoryPanel {...props} />
    case 'status':
      return <StatusPanel {...props} />
    case 'artifact':
      return <ArtifactPanel {...props} url={panel.url} title={panel.title} />
    case 'git':
      return <GitPanel projectId={props.projectId} conversationId={props.conversationId} refreshKey={`${props.busy}:${props.items.length}`} busy={props.busy} onClose={props.onClose} />
  }
}

function Frame({ title, sub, actions, message, onClose, children }: { title: string; sub?: string; actions?: React.ReactNode; message?: { ok: boolean; text: string } | null; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="wt-panel td" aria-label={title}>
      <header className="wt-head">
        <div className="wt-title">
          <span className="kr">{title}</span>
          {sub && <span className="mono">{sub}</span>}
        </div>
        <div className="wt-actions">
          {actions}
          <button type="button" className="btn ghost" onClick={onClose}>
            BACK TO CHAT
          </button>
        </div>
      </header>
      <Presence as="div" show={!!message} className={`wt-msg ${message?.ok ? 'ok' : 'bad'}`} role="status">{message?.text}</Presence>
      <div className="wt-body">{children}</div>
    </section>
  )
}

type Msg = { ok: boolean; text: string } | null

// ── 아티팩트 (claude.ai 페이지를 webview로) ──
// 로그인은 앱 안에서 한 번(persist:claude 세션에 남는다). 설정 강제·새 창·키 넘기기는 메인 artifact-view.ts

function ArtifactPanel({ url, title, items, onClose }: Props & { url: string; title: string }): React.JSX.Element {
  const ref = useRef<WebviewTag>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState(url)
  // 같은 링크로 다시 올리면 새로 고친다
  const rev = artifactsOf(items).find((a) => a.url === url)?.rev ?? 0
  const firstRev = useRef(rev)
  useEffect(() => {
    if (rev === firstRev.current) return
    firstRev.current = rev
    ref.current?.reload()
  }, [rev])
  useEffect(() => {
    const view = ref.current
    if (!view) return
    const start = (): void => {
      setLoading(true)
      setError(null)
    }
    const stop = (): void => setLoading(false)
    const fail = (e: DidFailLoadEvent): void => {
      // -3(ABORTED)은 다른 페이지로 넘어가며 끊긴 것
      if (e.isMainFrame && e.errorCode !== -3) setError(`${e.errorDescription || 'LOAD FAILED'} (${e.errorCode})`)
    }
    const nav = (e: DidNavigateEvent): void => setAt(e.url)
    view.addEventListener('did-start-loading', start)
    view.addEventListener('did-stop-loading', stop)
    view.addEventListener('did-fail-load', fail)
    view.addEventListener('did-navigate', nav)
    return () => {
      view.removeEventListener('did-start-loading', start)
      view.removeEventListener('did-stop-loading', stop)
      view.removeEventListener('did-fail-load', fail)
      view.removeEventListener('did-navigate', nav)
    }
  }, [])
  // 아티팩트를 벗어났으면(로그인 화면 등) 그 주소를 보인다
  const off = at.split(/[?#]/)[0] !== url
  return (
    <Frame
      title="ARTIFACT"
      sub={off ? `${title} · ${at}` : title}
      message={error ? { ok: false, text: `페이지를 열지 못했어요: ${error}` } : null}
      actions={
        <>
          <button type="button" className="btn ghost" disabled={loading} onClick={() => ref.current?.reload()} title="페이지를 다시 읽어요">
            {loading ? 'LOADING' : 'RELOAD'}
          </button>
          <button type="button" className="btn ghost" onClick={() => window.open(url)} title="기본 브라우저로 열어요">
            OPEN IN BROWSER
          </button>
        </>
      }
      onClose={onClose}
    >
      {/* allowpopups: 구글 로그인 팝업. 어디로 열지는 메인 artifact-view.ts가 거른다 */}
      <webview ref={ref as React.Ref<HTMLWebViewElement>} className="art-view" src={url} partition={ARTIFACT_PARTITION} {...({ allowpopups: 'true' } as object)} />
    </Frame>
  )
}

// ── 도구 목록 (상태 패널·보고서의 TOOLS 수를 누르면) ──

function ToolsPanel({ items, since, root, onClose, onJumpToTool }: Props & { since?: number }): React.JSX.Element {
  const all = items.filter((i): i is Extract<TranscriptItem, { type: 'tool' }> => i.type === 'tool')
  // 되살린 기록은 at이 0이라 시각으로 못 가른다. 이번 작업의 것이 하나도 없으면 전부 보여 준다
  const mine = since ? all.filter((i) => i.at >= since) : all
  const list = mine.length ? mine : all
  const byName = new Map<string, number>()
  for (const t of list) byName.set(t.name, (byName.get(t.name) ?? 0) + 1)
  const counts = [...byName.entries()].sort((a, b) => b[1] - a[1])
  const errors = list.filter((t) => t.isError).length
  const running = list.filter((t) => t.result === undefined).length
  return (
    <Frame title="TOOLS" sub={`${list.length} CALLS${errors ? ` · ${errors} ERRORS` : ''}${running ? ` · ${running} RUNNING` : ''}`} onClose={onClose}>
      {list.length === 0 && <div className="empty">아직 부른 도구가 없어요.</div>}
      {counts.length > 0 && (
        <div className="pn-counts" aria-label="도구별 횟수">
          {counts.map(([name, n]) => (
            <span key={name} className="chip">
              {name} <b>{n}</b>
            </span>
          ))}
        </div>
      )}
      <ul className="pn-list" aria-label="도구 호출">
        {list.map((t, i) => {
          const status = t.result === undefined ? 'RUNNING' : t.isError ? 'ERROR' : 'DONE'
          return (
            <li key={t.toolUseId}>
              <button type="button" className="pn-row" onClick={() => onJumpToTool(t.toolUseId)} title="대화 기록에서 이 호출을 펼쳐요">
                <span className="pn-n">{String(i + 1).padStart(2, '0')}</span>
                <span className="pn-text">
                  <b>{t.name}</b>
                  <span className="pn-sub mono">{relPathOf(summarizeInputOf(t.input), root)}</span>
                </span>
                <span className="pn-tags">
                  <span className={`chip ${status === 'ERROR' ? 'bad' : status === 'DONE' ? '' : 'ok'}`}>{status}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Frame>
  )
}

// ── /rewind ──

const SCOPE_LABEL: Record<RewindScope, string> = { both: 'CODE + CHAT', code: 'CODE ONLY', chat: 'CHAT ONLY' }
const SCOPE_NOTE: Record<RewindScope, string> = {
  both: '파일을 그 시점으로 되돌리고, 대화도 그 메시지 앞까지만 남겨요',
  code: '파일만 되돌려요. 대화는 그대로예요',
  chat: '대화만 그 메시지 앞까지 남겨요. 파일은 그대로예요',
}

function RewindPanel({ projectId, conversationId, items, busy, uuid, onClose, onRewound }: Props & { uuid?: string }): React.JSX.Element {
  const points = items.filter((i): i is Extract<TranscriptItem, { type: 'user' }> => i.type === 'user' && !!i.uuid && !i.pending).reverse()
  const [sel, setSel] = useState<string | undefined>(uuid ?? points[0]?.uuid)
  const [scope, setScope] = useState<RewindScope>('both')
  const [preview, setPreview] = useState<{ uuid: string; files: string[] } | null>(null)
  const [message, setMessage] = useState<Msg>(null)
  const [armed, setArmed] = useState(false)
  const [working, setWorking] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  // 고른 시점이 바뀌면 미리 보기도 다시
  useEffect(() => {
    setPreview(null)
    setArmed(false)
    if (!sel || scope === 'chat') return
    let alive = true
    void window.api.rewind(projectId, conversationId, sel, 'code', true).then((r) => alive && setPreview({ uuid: sel, files: r.ok ? (r.files ?? []) : [] }))
    return () => {
      alive = false
    }
  }, [sel, scope, projectId, conversationId])

  const run = async (): Promise<void> => {
    if (!sel) return
    if (!armed) return setArmed(true)
    setWorking(true)
    const r = await window.api.rewind(projectId, conversationId, sel, scope)
    setWorking(false)
    setArmed(false)
    setMessage({ ok: r.ok, text: r.message })
    if (r.ok) {
      onRewound(scope === 'code' ? undefined : r.text)
      if (scope !== 'code') onClose()
    }
  }

  return (
    <Frame
      title="REWIND"
      sub={points.length ? `${points.length} POINTS` : undefined}
      message={message}
      onClose={onClose}
      actions={
        <button type="button" className={`btn-pri ${armed ? 'armed' : ''}`} disabled={!sel || busy || working} onClick={() => void run()}>
          {working ? 'REWINDING…' : armed ? 'REWIND? 한 번 더' : 'REWIND'}
        </button>
      }
    >
      {busy && <div className="empty">작업이 끝난 뒤에 되감을 수 있어요.</div>}
      {points.length === 0 && !busy && <div className="empty">되감을 지점이 없어요. 메시지를 보낸 뒤부터 기준점이 생겨요.</div>}
      {points.length > 0 && (
        <>
          <div className="pn-scope" role="radiogroup" aria-label="되감기 범위">
            {(['both', 'code', 'chat'] as RewindScope[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scope === s} className={`btn ${scope === s ? 'on' : ''}`} onClick={() => setScope(s)} title={SCOPE_NOTE[s]}>
                {SCOPE_LABEL[s]}
              </button>
            ))}
            <span className="pn-note">{SCOPE_NOTE[scope]}</span>
          </div>
          <ul className="pn-list" aria-label="되감기 지점">
            {points.map((p, i) => (
              <li key={p.uuid} className={sel === p.uuid ? 'sel' : ''}>
                <button type="button" className="pn-row" onClick={() => setSel(p.uuid)} aria-pressed={sel === p.uuid}>
                  <span className="pn-n">{String(points.length - i).padStart(2, '0')}</span>
                  <span className="pn-text">{p.text}</span>
                </button>
              </li>
            ))}
          </ul>
          <Presence as="div" show={scope !== 'chat' && !!preview && preview.uuid === sel} className="pn-preview">
              <h5>FILES · {preview?.files.length ?? 0}</h5>
              {preview?.files.length === 0 && <p className="pn-note">이 시점으로 되돌려도 바뀌는 파일이 없어요.</p>}
              {(preview?.files.length ?? 0) > 0 && (
                <ul className="wt-files">
                  {preview!.files.map((f) => (
                    <li key={f}><span className="mono">{f}</span></li>
                  ))}
                </ul>
              )}
          </Presence>
        </>
      )}
    </Frame>
  )
}

// ── /resume ──

function ResumePanel({ projectId, conversationId, onClose, onOpenConversation }: Props): React.JSX.Element {
  const [list, setList] = useState<SessionOption[] | null>(null)
  const [q, setQ] = useState('')
  const [message, setMessage] = useState<Msg>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const now = useNow(30_000)
  useEffect(() => {
    let alive = true
    window.api.listSessions(projectId).then((l) => alive && setList(l), (err) => alive && setMessage({ ok: false, text: `세션 목록을 읽지 못했어요: ${String(err)}` }))
    return () => {
      alive = false
    }
  }, [projectId])
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (list ?? []).filter((s) => terms.every((t) => `${s.title} ${s.firstPrompt ?? ''} ${s.branch ?? ''}`.toLowerCase().includes(t)))

  const open = async (s: SessionOption): Promise<void> => {
    if (s.conversationId) return onOpenConversation(s.conversationId)
    setOpening(s.sessionId)
    try {
      onOpenConversation(await window.api.attachSession(projectId, conversationId, s.sessionId, s.title))
      onClose()
    } catch (err) {
      setMessage({ ok: false, text: `세션을 열지 못했어요: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setOpening(null)
    }
  }

  return (
    <Frame title="RESUME" sub={list ? `${list.length} SESSIONS` : undefined} message={message} onClose={onClose}>
      <div className="pn-filter">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="제목·첫 메시지·브랜치로 찾기" aria-label="세션 찾기" data-keys-own="true" autoFocus />
      </div>
      {list === null && !message && <div className="empty">지난 세션을 읽는 중…</div>}
      {list && shown.length === 0 && <div className="empty">{list.length ? '맞는 세션이 없어요' : '이 폴더에서 한 세션이 아직 없어요'}</div>}
      <ul className="pn-list" aria-label="지난 세션">
        {shown.map((s) => (
          <li key={s.sessionId}>
            <button type="button" className="pn-row" disabled={opening === s.sessionId} onClick={() => void open(s)} title={s.firstPrompt ?? s.title}>
              <span className="pn-when">{elapsed(s.modified, now)}</span>
              <span className="pn-text">
                <b>{s.title}</b>
                {s.firstPrompt && s.firstPrompt.trim() !== s.title && <span className="pn-sub">{s.firstPrompt}</span>}
              </span>
              <span className="pn-tags">
                {s.branch && <span className="chip">{s.branch}</span>}
                {s.conversationId && <span className="chip ok">OPEN</span>}
                {opening === s.sessionId && <span className="chip">…</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

// ── /mcp ──

const MCP_STATUS: Record<McpServerInfo['status'], { label: string; cls: string }> = {
  connected: { label: 'CONNECTED', cls: 'ok' },
  failed: { label: 'FAILED', cls: 'bad' },
  'needs-auth': { label: 'NEEDS AUTH', cls: 'bad' },
  pending: { label: 'CONNECTING', cls: '' },
  disabled: { label: 'DISABLED', cls: '' },
}

function McpPanel({ projectId, conversationId, onClose, onRunInTerminal }: Props): React.JSX.Element {
  const [list, setList] = useState<McpServerInfo[] | null>(null)
  const [message, setMessage] = useState<Msg>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = (): void => {
    window.api.mcpStatus(projectId, conversationId).then(setList, (err) => setMessage({ ok: false, text: `MCP 상태를 읽지 못했어요: ${err instanceof Error ? err.message : String(err)}` }))
  }
  useEffect(load, [projectId, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name)
    try {
      await fn()
      setMessage(null)
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
      load()
    }
  }
  const needsAuth = list?.some((s) => s.status === 'needs-auth')
  const loginHint = async (): Promise<void> => {
    const base = (await window.api.loginCommand()).replace(/\s+auth login$/, '')
    onRunInTerminal(base)
  }
  return (
    <Frame
      title="MCP"
      sub={list ? `${list.length} SERVERS` : undefined}
      message={message}
      onClose={onClose}
      actions={
        <button type="button" className="btn" onClick={load}>
          REFRESH
        </button>
      }
    >
      {list === null && !message && <div className="empty">서버 상태를 읽는 중…</div>}
      {list && list.length === 0 && <div className="empty">설정된 MCP 서버가 없어요. ~/.claude.json이나 프로젝트의 .mcp.json에 적어요.</div>}
      <ul className="pn-list" aria-label="MCP 서버">
        {list?.map((s) => {
          const st = MCP_STATUS[s.status]
          return (
            <li key={s.name}>
              <div className="pn-row static">
                <span className={`chip ${st.cls}`}>{st.label}</span>
                <span className="pn-text">
                  <b>{s.name}</b>
                  {s.version && <span className="pn-sub mono">v{s.version}</span>}
                  {s.target && <span className="pn-sub mono">{s.target}</span>}
                  {s.error && <span className="pn-sub bad">{s.error}</span>}
                </span>
                <span className="pn-tags">
                  {s.status !== 'disabled' && (
                    <button type="button" className="btn" disabled={busy === s.name} onClick={() => void act(s.name, () => window.api.mcpReconnect(projectId, conversationId, s.name))}>
                      RECONNECT
                    </button>
                  )}
                  <button type="button" className="btn" disabled={busy === s.name} onClick={() => void act(s.name, () => window.api.mcpToggle(projectId, conversationId, s.name, s.status === 'disabled'))}>
                    {s.status === 'disabled' ? 'ENABLE' : 'DISABLE'}
                  </button>
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      {needsAuth && (
        <div className="pn-foot">
          <p>로그인이 필요한 서버가 있어요. OAuth 로그인은 CLI에서만 할 수 있어요. 아래 터미널에서 claude를 띄우고 <code>/mcp</code>를 쳐서 로그인한 뒤 REFRESH를 눌러요.</p>
          <button type="button" className="btn" onClick={() => void loginHint()}>
            OPEN CLAUDE IN TERMINAL
          </button>
        </div>
      )}
    </Frame>
  )
}

// ── /agents ──

function AgentsPanel({ projectId, onClose, onInsert }: Props): React.JSX.Element {
  const [list, setList] = useState<AgentOption[] | null>(null)
  const [message, setMessage] = useState<Msg>(null)
  useEffect(() => {
    let alive = true
    window.api.listAgents(projectId).then((l) => alive && setList(l), (err) => alive && setMessage({ ok: false, text: `에이전트 목록을 읽지 못했어요: ${err instanceof Error ? err.message : String(err)}` }))
    return () => {
      alive = false
    }
  }, [projectId])
  return (
    <Frame title="AGENTS" sub={list ? `${list.length} TYPES` : undefined} message={message} onClose={onClose}>
      {list === null && !message && <div className="empty">에이전트 종류를 읽는 중…</div>}
      <p className="pn-foot">누르면 입력창에 <code>@agent-이름</code>을 넣어요. 새 에이전트는 <code>.claude/agents/</code>에 마크다운 파일로 만들어요.</p>
      <ul className="pn-list" aria-label="에이전트 종류">
        {list?.map((a) => (
          <li key={a.name}>
            <button type="button" className="pn-row" onClick={() => { onInsert(`@agent-${a.name} `); onClose() }}>
              <span className="pn-text">
                <b>{a.name}</b>
                <span className="pn-sub">{a.description}</span>
              </span>
              <span className="pn-tags">{a.model && <span className="chip">{a.model}</span>}</span>
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

// ── /permissions · /hooks · /add-dir ──

const SOURCE_LABEL: Record<PermissionRuleSource, string> = { local: '.claude/settings.local.json', project: '.claude/settings.json', user: '~/.claude/settings.json' }

function PermissionsPanel({ projectId, conversationId, onClose }: Props): React.JSX.Element {
  const [info, setInfo] = useState<PermissionsInfo | null>(null)
  const [message, setMessage] = useState<Msg>(null)
  const [rule, setRule] = useState('')
  const [kind, setKind] = useState<'allow' | 'deny' | 'ask'>('allow')
  const [source, setSource] = useState<PermissionRuleSource>('local')
  const load = (): void => {
    window.api.permissionsInfo(projectId, conversationId).then(setInfo, (err) => setMessage({ ok: false, text: `설정을 읽지 못했어요: ${err instanceof Error ? err.message : String(err)}` }))
  }
  useEffect(load, [projectId, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (): Promise<void> => {
    const r = rule.trim()
    if (!r) return
    await window.api.setPermissionRule(projectId, source, kind, r, true)
    setRule('')
    setMessage({ ok: true, text: `${kind.toUpperCase()} 규칙을 ${SOURCE_LABEL[source]}에 넣었어요. 다음 세션부터 적용돼요` })
    load()
  }
  const remove = async (k: 'allow' | 'deny' | 'ask', r: string): Promise<void> => {
    // 어느 파일에서 왔는지 모르므로 셋 다에서 뺀다 (없는 곳은 그대로)
    for (const s of ['local', 'project', 'user'] as PermissionRuleSource[]) await window.api.setPermissionRule(projectId, s, k, r, false)
    setMessage({ ok: true, text: `${k.toUpperCase()} 규칙을 뺐어요. 다음 세션부터 적용돼요` })
    load()
  }
  const addDir = async (path?: string, rm = false): Promise<void> => {
    await window.api.addDirectory(projectId, conversationId, path, rm)
    load()
  }
  const Rules = ({ k, list }: { k: 'allow' | 'deny' | 'ask'; list: string[] }): React.JSX.Element => (
    <section className="pn-sec">
      <h5>{k.toUpperCase()} · {list.length}</h5>
      {list.length === 0 && <p className="pn-note">없어요</p>}
      <PresenceList items={list} keyOf={(r) => r} className="pn-rules">
        {(r, leaving) => (
          <li className={leaving ? 'leaving' : ''}>
            <code>{r}</code>
            <button type="button" className="pn-x" onClick={() => void remove(k, r)} aria-label={`${r} 규칙 빼기`} title="이 규칙을 빼요">×</button>
          </li>
        )}
      </PresenceList>
    </section>
  )
  return (
    <Frame title="PERMISSIONS" sub={info?.defaultMode ? `DEFAULT MODE ${MODE_LABEL[info.defaultMode as keyof typeof MODE_LABEL] ?? info.defaultMode.toUpperCase()}` : undefined} message={message} onClose={onClose}>
      {!info && !message && <div className="empty">설정을 읽는 중…</div>}
      {info && (
        <>
          <div className="pn-add">
            <select value={kind} onChange={(e) => setKind(e.target.value as 'allow' | 'deny' | 'ask')} aria-label="규칙 종류">
              <option value="allow">ALLOW</option>
              <option value="deny">DENY</option>
              <option value="ask">ASK</option>
            </select>
            <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Bash(npm run *)  Read(./docs/**)  WebFetch(domain:github.com)" aria-label="규칙" data-keys-own="true" onKeyDown={(e) => e.key === 'Enter' && void add()} />
            <select value={source} onChange={(e) => setSource(e.target.value as PermissionRuleSource)} aria-label="저장할 파일">
              <option value="local">LOCAL</option>
              <option value="project">PROJECT</option>
              <option value="user">USER</option>
            </select>
            <button type="button" className="btn-pri" disabled={!rule.trim()} onClick={() => void add()}>ADD</button>
          </div>
          <Rules k="allow" list={info.allow} />
          <Rules k="ask" list={info.ask} />
          <Rules k="deny" list={info.deny} />
          <section className="pn-sec">
            <h5>DIRECTORIES · {info.additionalDirectories.length}</h5>
            <p className="pn-note">작업 폴더 밖에서 더 읽고 쓸 폴더예요 (/add-dir). 이 대화에서 더한 폴더는 바로, 설정 파일의 것은 다음 세션부터 적용돼요.</p>
            <PresenceList items={info.additionalDirectories} keyOf={(d) => d} className="pn-rules">
              {(d, leaving) => (
                <li className={leaving ? 'leaving' : ''}>
                  <code>{d}</code>
                  <button type="button" className="pn-x" onClick={() => void addDir(d, true)} aria-label={`${d} 빼기`} title="이 대화에서 뺀 폴더예요 (설정 파일의 것은 그대로)">×</button>
                </li>
              )}
            </PresenceList>
            <button type="button" className="btn" onClick={() => void addDir()}>ADD FOLDER</button>
          </section>
          <section className="pn-sec">
            <h5>HOOKS · {info.hooks.length}</h5>
            {info.hooks.length === 0 && <p className="pn-note">설정된 훅이 없어요. settings.json의 hooks에 적으면 CLI처럼 그대로 돌아요.</p>}
            <ul className="pn-rules">
              {info.hooks.map((h, i) => (
                <li key={i} className="pn-hook">
                  <span className="chip">{h.event}</span>
                  {h.matcher && <code>{h.matcher}</code>}
                  <span className="pn-sub mono">{h.commands.join(' · ')}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Frame>
  )
}

// ── /memory ──

function MemoryPanel({ projectId, onClose }: Props): React.JSX.Element {
  const [list, setList] = useState<MemoryFile[] | null>(null)
  const [message, setMessage] = useState<Msg>(null)
  const load = (): void => {
    void window.api.memoryFiles(projectId).then(setList)
  }
  useEffect(load, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = async (f: MemoryFile): Promise<void> => {
    const err = await window.api.openPath(f.path, !f.exists)
    setMessage(err ? { ok: false, text: err } : null)
    load()
  }
  return (
    <Frame title="MEMORY" message={message} onClose={onClose}>
      <p className="pn-foot">CLAUDE.md는 세션을 시작할 때 읽어요. 고치면 다음 세션(또는 /clear 뒤)부터 적용돼요.</p>
      <ul className="pn-list" aria-label="메모리 파일">
        {list?.map((f) => (
          <li key={f.path}>
            <button type="button" className="pn-row" onClick={() => void open(f)} title={f.path}>
              <span className={`chip ${f.exists ? 'ok' : ''}`}>{f.exists ? (f.size !== undefined ? `${(f.size / 1024).toFixed(1)}K` : 'DIR') : 'NEW'}</span>
              <span className="pn-text">
                <b>{f.label}</b>
                <span className="pn-sub mono">{f.path}</span>
              </span>
              <span className="pn-tags"><span className="chip">{f.exists ? 'OPEN' : 'CREATE'}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

// ── /status · /login ──

function StatusPanel({ projectId, conversationId, onClose, onRunInTerminal }: Props): React.JSX.Element {
  const [st, setSt] = useState<SessionStatus | null>(null)
  const [message, setMessage] = useState<Msg>(null)
  const load = (refresh = false): void => {
    void window.api.accountStatus(refresh).then(() => window.api.sessionStatus(projectId, conversationId)).then(setSt, (err) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }))
  }
  useEffect(() => load(), [projectId, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps
  const login = async (): Promise<void> => {
    onRunInTerminal(await window.api.loginCommand())
    setMessage({ ok: true, text: '아래 터미널에 로그인 명령을 넣었어요. Enter로 실행하고 브라우저에서 로그인한 뒤 REFRESH를 눌러요' })
  }
  const a = st?.account
  const row = (k: string, v?: React.ReactNode): React.JSX.Element | null => (v ? <div><dt>{k}</dt><dd>{v}</dd></div> : null)
  return (
    <Frame
      title="STATUS"
      message={message}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={() => void login()}>{a?.loggedIn ? 'SWITCH ACCOUNT' : 'LOGIN IN TERMINAL'}</button>
          <button type="button" className="btn" onClick={() => load(true)}>REFRESH</button>
        </>
      }
    >
      {!st && !message && <div className="empty">읽는 중…</div>}
      {st && (
        <>
          <section className="pn-sec">
            <h5>ACCOUNT</h5>
            <dl className="pn-dl">
              {row('STATE', <span className={`chip ${a?.loggedIn ? 'ok' : 'bad'}`}>{a?.loggedIn ? 'LOGGED IN' : 'NOT LOGGED IN'}</span>)}
              {row('EMAIL', a?.email)}
              {row('ORG', a?.organization)}
              {row('PLAN', a?.subscription?.toUpperCase())}
              {row('METHOD', a?.method)}
              {row('ERROR', a?.error)}
            </dl>
            {!a?.loggedIn && <p className="pn-note">구독으로만 인증해요. API 키 환경 변수는 자식 프로세스에 넘기지 않아요.</p>}
          </section>
          <section className="pn-sec">
            <h5>SESSION</h5>
            <dl className="pn-dl">
              {row('ID', <span className="mono">{st.sessionId ?? '(아직 없음)'}</span>)}
              {row('FOLDER', <span className="mono">{st.cwd}</span>)}
              {row('MODEL', st.model)}
              {row('MODE', MODE_LABEL[st.mode])}
              {row('CONTEXT', st.contextPercent !== undefined ? `${st.contextPercent}%` : undefined)}
              {row('DIRS', st.additionalDirectories.length ? <span className="mono">{st.additionalDirectories.join('\n')}</span> : undefined)}
            </dl>
          </section>
        </>
      )}
    </Frame>
  )
}
