// Agent SDK가 구독 계정 인증으로 동작하는지 1회 호출로 확인한다.
// 실행: npm run smoke
import { query } from '@anthropic-ai/claude-agent-sdk'

// 구독 인증을 강제: API 키 환경변수가 있으면 구독보다 우선하므로 제거한다.
const env = { ...process.env }
delete env.ANTHROPIC_API_KEY
delete env.ANTHROPIC_AUTH_TOKEN

const q = query({
  prompt: 'Reply with exactly one word: pong',
  options: {
    env,
    maxTurns: 1,
    tools: [],
    settingSources: [],
    persistSession: false,
  },
})

let ok = false
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log(`[init] model=${msg.model} apiKeySource=${msg.apiKeySource} cli=${msg.claude_code_version}`)
  } else if (msg.type === 'rate_limit_event') {
    const r = msg.rate_limit_info
    console.log(`[rate] status=${r.status} type=${r.rateLimitType ?? '-'} utilization=${r.utilization ?? '-'}`)
  } else if (msg.type === 'assistant') {
    const text = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    if (text) console.log(`[assistant] ${text}`)
  } else if (msg.type === 'result') {
    ok = msg.subtype === 'success' && !msg.is_error
    console.log(`[result] ${msg.subtype} turns=${msg.num_turns} ${msg.duration_ms}ms`)
  }
}
process.exit(ok ? 0 : 1)
