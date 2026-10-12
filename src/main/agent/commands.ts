import { query, type Query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { SlashCommandInfo } from '@shared/types'
import { MessageQueue } from './message-queue'
import { subscriptionEnv } from './session'
import { claudeExecutable } from '../executable'

const TTL_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 20_000

/** 프로젝트 폴더별 명령 목록 캐시. 프로젝트·사용자 명령과 스킬은 폴더마다 다르다 */
const cache = new Map<string, { at: number; list: SlashCommandInfo[] }>()
const inflight = new Map<string, Promise<SlashCommandInfo[]>>()

export function toInfo(list: SlashCommand[]): SlashCommandInfo[] {
  return list.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases, builtin: c.builtin }))
}

export function remember(cwd: string, list: SlashCommand[]): SlashCommandInfo[] {
  const info = toInfo(list)
  cache.set(cwd, { at: Date.now(), list: info })
  return info
}

/**
 * 살아 있는 세션이 없을 때: 메시지를 보내지 않은 채 CLI만 띄워 초기화 응답에서 명령 목록을 받고 바로 닫는다.
 * 모델을 부르지 않으므로 구독 사용량은 쓰지 않는다.
 */
export function commandsFor(cwd: string): Promise<SlashCommandInfo[]> {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.list)
  const running = inflight.get(cwd)
  if (running) return running
  const p = probe(cwd).finally(() => inflight.delete(cwd))
  inflight.set(cwd, p)
  return p
}

async function probe(cwd: string): Promise<SlashCommandInfo[]> {
  return remember(cwd, await withProbe(cwd, (q) => q.supportedCommands()))
}

/**
 * 메시지를 보내지 않은 채 CLI만 띄워 fn을 실행하고 바로 닫는다. 초기화·조회만 하므로 모델을 부르지 않는다.
 * 살아 있는 세션이 없을 때 명령 목록·사용량을 받는 데 쓴다
 */
export async function withProbe<T>(cwd: string, fn: (q: Query) => Promise<T>, resume?: string, model?: string): Promise<T> {
  const queue = new MessageQueue()
  const q = query({
    prompt: queue,
    // model: 대화에서 고른 모델 (없으면 설정의 기본 모델). 컨텍스트 크기·표시 모델이 그 모델 기준이 된다
    options: { cwd, resume, model, pathToClaudeCodeExecutable: claudeExecutable(), env: subscriptionEnv(), settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' } },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(q),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('CLI 응답 없음')), PROBE_TIMEOUT_MS))),
    ])
  } finally {
    clearTimeout(timer)
    queue.close()
    q.close()
  }
}
