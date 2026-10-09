// AgentSession 통합 테스트: 권한 요청 → 허용 → 파일 생성 → 완료 흐름을 실제 SDK로 확인.
// 실행: npm run test:session  (구독 사용량을 약간 씀)
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@shared/types'
import { AgentSession } from '../src/main/agent/session'

const cwd = mkdtempSync(join(tmpdir(), 'whenterminal-test-'))
const events: AgentEvent[] = []

const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 120_000)
  const session = new AgentSession({
    cwd,
    mode: 'default',
    emit: (e) => {
      events.push(e)
      if (e.kind === 'permission_request') {
        console.log(`[permission] ${e.request.toolName} title=${e.request.title ?? '-'} → allow`)
        session.respondPermission(e.request.requestId, 'allow')
      } else if (e.kind === 'status') {
        console.log(`[status] ${e.status}`)
        if (e.status === 'done' || e.status === 'error') {
          clearTimeout(timer)
          session.dispose()
          resolve()
        }
      } else if (e.kind === 'tool_use') {
        console.log(`[tool_use] ${e.name}`)
      }
    },
    onSessionId: (id) => console.log(`[session] ${id}`),
    onRateLimit: (r) => console.log(`[rate] ${r.status} ${r.rateLimitType} ${r.utilization}`),
  })
  session.send('Use the Write tool to create a file named hello.txt containing exactly: hi. Do nothing else and reply "ok".')
})

try {
  await done
  const file = join(cwd, 'hello.txt')
  const checks = {
    permissionRequested: events.some((e) => e.kind === 'permission_request'),
    textStreamed: events.some((e) => e.kind === 'text_delta'),
    fileCreated: existsSync(file) && readFileSync(file, 'utf8').trim() === 'hi',
    finishedOk: events.some((e) => e.kind === 'status' && e.status === 'done'),
    // 허용 직후 waiting_approval → running으로 돌아와야 한다
    resumedAfterApproval: events.some(
      (e, i) => e.kind === 'status' && e.status === 'running' && events.slice(0, i).some((p) => p.kind === 'permission_request'),
    ),
  }
  console.log(checks)
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
} finally {
  // close()는 CLI 프로세스를 비동기로 종료하므로 잠시 기다렸다가 best-effort로 정리
  await new Promise((r) => setTimeout(r, 2000))
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (err) {
    console.warn(`임시 폴더 정리 실패 (무시): ${cwd}`, err instanceof Error ? err.message : err)
  }
}
