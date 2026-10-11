import { test, expect } from './fixtures'

test('전광판은 오른쪽 끝에서 들어오고, 한 벌이 창보다 짧아도 다음 벌이 가운데서 튀어나오지 않는다', async ({ win }) => {
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  const measure = (): Promise<{ box: number; boxLeft: number; first: number; widths: number[] }> =>
    win.evaluate(() => {
      const box = document.querySelector('.ticker')!.getBoundingClientRect()
      const spans = [...document.querySelectorAll('.ticker-run > span')].map((s) => s.getBoundingClientRect())
      return { box: box.width, boxLeft: box.left, first: spans[0].left - box.left, widths: spans.map((r) => r.width) }
    })

  const a = await measure()
  // 기본 문구(NO RUNNING TASKS …)는 창보다 짧지만 한 벌이 창 너비 이상이라 다음 벌은 늘 오른쪽 끝 바깥에서 시작한다
  for (const w of a.widths) expect(w).toBeGreaterThanOrEqual(a.box - 0.5)
  // 시작 직후에는 아직 오른쪽 절반쯤에 있다
  expect(a.first).toBeGreaterThan(a.box / 2)

  await win.waitForTimeout(1000)
  const b = await measure()
  expect(b.first).toBeLessThan(a.first)
})
