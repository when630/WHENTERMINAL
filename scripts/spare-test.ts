// CLI 미리 띄우기(prewarm) 통합 테스트: ① 스페어를 claim해 첫 메시지가 답을 받는지 ② 프로젝트 설정에 model이 있어 claim이 거절되면
// query()로 다시 띄워 같은 메시지가 답을 받는지. 실행: npm run test:spare (짧은 모델 호출 2번)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/types'
import { AgentSession, baseOptions } from '../src/main/agent/session'
import { SpareKeeper } from '../src/main/agent/spare'

const PROMPT = 'Reply with exactly the word ok and nothing else. Do not use any tools.'

async function run(label: string, cwd: string, keeper: SpareKeeper): Promise<{ ok: boolean; tookSpare: boolean; ms: number }> {
  keeper.ensure()
  // 주차될 때까지 기다린다 (ensure는 비동기)
  const t0 = Date.now()
  while (!keeper.has() && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 200))
  console.log(`[${label}] spare ${keeper.has() ? 'parked' : 'missing'} after ${Date.now() - t0}ms`)
  let tookSpare = false
  const events: AgentEvent[] = []
  const started = Date.now()
  const result = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 120_000)
    const session = new AgentSession({
      cwd,
      mode: 'default',
      prefs: () => ({ promptSuggestions: false }),
      away: () => false,
      budget: () => null,
      takeSpare: () => {
        const h = keeper.take()
        tookSpare = !!h
        return h
      },
      emit: (e) => {
        events.push(e)
        if (e.kind === 'status') console.log(`[${label}] status ${e.status}`)
        if (e.kind === 'error') console.log(`[${label}] error ${e.message}`)
        if (e.kind === 'permission_request') session.respondPermission(e.request.requestId, 'deny')
        if (e.kind === 'status' && (e.status === 'done' || e.status === 'error')) {
          clearTimeout(timer)
          session.dispose()
          resolve(e.status === 'done')
        }
      },
      onSessionId: (id) => console.log(`[${label}] session ${id}`),
      onRateLimit: () => {},
    })
    session.send(PROMPT)
  })
  const text = events.filter((e) => e.kind === 'assistant_text').map((e) => (e as { text: string }).text).join('')
  console.log(`[${label}] reply: ${JSON.stringify(text.trim().slice(0, 40))} in ${Date.now() - started}ms`)
  return { ok: result && /\bok\b/i.test(text), tookSpare, ms: Date.now() - started }
}

const warmDir = mkdtempSync(join(tmpdir(), 'wt-spare-warm-'))
const coldDir = mkdtempSync(join(tmpdir(), 'wt-spare-cold-'))
// 프로젝트 설정에 model이 있으면 CLI가 claim을 거절한다 → 폴백 경로
mkdirSync(join(coldDir, '.claude'))
writeFileSync(join(coldDir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }))

const keeper = new SpareKeeper((cb) => baseOptions(cb, { promptSuggestions: false }))
try {
  const warm = await run('warm', warmDir, keeper)
  const cold = await run('fallback', coldDir, keeper)
  const checks = {
    warmTookSpare: warm.tookSpare,
    warmReplied: warm.ok,
    fallbackTookSpare: cold.tookSpare,
    fallbackReplied: cold.ok,
  }
  console.log(checks)
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
} finally {
  keeper.dispose()
  await new Promise((r) => setTimeout(r, 2000))
  for (const d of [warmDir, coldDir]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch (err) {
      console.warn(`임시 폴더 정리 실패 (무시): ${d}`, err instanceof Error ? err.message : err)
    }
  }
}
