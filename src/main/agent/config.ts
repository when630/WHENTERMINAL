import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MemoryFile, PermissionRuleSource, PermissionsInfo } from '@shared/types'
import { readJson, writeJson } from '../json-file'

// CLI의 /permissions /hooks /memory가 보여 주는 것들을 설정 파일에서 읽는다.
// 규칙을 바꾸는 건 CLI와 같은 파일(.claude/settings.local.json 등)에 직접 쓴다. SDK의 updateSettings는 허용 키가 좁아 못 쓴다

type Hook = { type?: string; command?: string; prompt?: string }
type HookMatcher = { matcher?: string; hooks?: Hook[] }

/** 지금 폴더에서 적용되는 권한 규칙·추가 폴더·훅 */
export async function permissionsInfo(cwd: string, extraDirs: string[] = []): Promise<PermissionsInfo> {
  const { effective } = await resolveSettings({ cwd })
  const p = effective.permissions ?? {}
  const hooks: PermissionsInfo['hooks'] = []
  for (const [event, matchers] of Object.entries((effective.hooks ?? {}) as Record<string, HookMatcher[] | undefined>)) {
    for (const m of matchers ?? []) {
      const commands = (m.hooks ?? []).map((h) => h.command ?? h.prompt ?? h.type ?? '?')
      if (commands.length) hooks.push({ event, matcher: m.matcher || undefined, commands })
    }
  }
  return {
    allow: p.allow ?? [],
    deny: p.deny ?? [],
    ask: p.ask ?? [],
    defaultMode: p.defaultMode,
    additionalDirectories: [...new Set([...(p.additionalDirectories ?? []), ...extraDirs])],
    hooks,
  }
}

/** 규칙을 쓸 설정 파일 (CLI의 /permissions와 같은 자리) */
function settingsFile(projectPath: string, source: PermissionRuleSource): string {
  if (source === 'user') return join(homedir(), '.claude', 'settings.json')
  return join(projectPath, '.claude', source === 'local' ? 'settings.local.json' : 'settings.json')
}

/** 규칙 하나를 더하거나(on) 뺀다. 다음 세션부터 적용된다 */
export function setPermissionRule(projectPath: string, source: PermissionRuleSource, kind: 'allow' | 'deny' | 'ask', rule: string, on: boolean): void {
  const file = settingsFile(projectPath, source)
  const data = ((readJson(file) as Record<string, unknown> | undefined) ?? {}) as { permissions?: Record<string, unknown> }
  const perms = (data.permissions ??= {})
  const list = new Set(Array.isArray(perms[kind]) ? (perms[kind] as string[]) : [])
  if (on) list.add(rule)
  else list.delete(rule)
  if (list.size) perms[kind] = [...list]
  else delete perms[kind]
  writeJson(file, data)
}

/** CLAUDE.md와 자동 메모리 파일들 (CLI /memory의 목록) */
export function memoryFiles(projectPath: string): MemoryFile[] {
  const home = join(homedir(), '.claude')
  const candidates: { label: string; path: string }[] = [
    { label: 'PROJECT · CLAUDE.md', path: join(projectPath, 'CLAUDE.md') },
    { label: 'PROJECT · .claude/CLAUDE.md', path: join(projectPath, '.claude', 'CLAUDE.md') },
    { label: 'LOCAL · CLAUDE.local.md', path: join(projectPath, 'CLAUDE.local.md') },
    { label: 'USER · ~/.claude/CLAUDE.md', path: join(home, 'CLAUDE.md') },
    { label: 'RULES · .claude/rules', path: join(projectPath, '.claude', 'rules') },
    { label: 'AUTO MEMORY · ~/.claude/projects', path: join(home, 'projects', projectKey(projectPath), 'memory') },
  ]
  return candidates.map(({ label, path }) => {
    const exists = existsSync(path)
    let size: number | undefined
    if (exists) {
      try {
        const st = statSync(path)
        size = st.isFile() ? st.size : undefined
      } catch {
        // 크기는 없어도 된다
      }
    }
    return { label, path, exists, size }
  })
}

/** CLI가 프로젝트 폴더를 ~/.claude/projects 아래 폴더 이름으로 바꾸는 규칙 (영숫자 외는 -) */
function projectKey(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-')
}
