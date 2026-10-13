import { expect, test } from './fixtures'

// 전역 호출 키로 끄기·Alt+F4는 창을 트레이로 숨긴다(hideWindow). 숨기기만 하면 Windows에서 포커스를 가진 창이 없어지므로
// 바로 뒤에 있던 창(원래 쓰던 창)으로 포커스가 돌아가는지 본다. 앱 밖의 창 대신 같은 앱의 다른 창으로 흉내 낸다
test('창을 숨기면 원래 쓰던 창으로 포커스가 돌아간다', async ({ app }) => {
  test.skip(process.platform === 'darwin', 'macOS는 app.hide()로 앱째 숨겨 같은 앱의 창으로는 확인할 수 없다')
  const r = await app.evaluate(async ({ BrowserWindow }) => {
    const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
    const main = BrowserWindow.getAllWindows()[0]
    const other = new BrowserWindow({ width: 300, height: 200, show: true })
    await other.loadURL('data:text/html,<p>other</p>')
    other.focus()
    await sleep(300)
    main.show()
    main.focus()
    await sleep(400)
    const before = main.isFocused()
    // Alt+F4와 같은 길 (close → 트레이로 숨김)
    main.close()
    await sleep(500)
    const res = { before, mainVisible: main.isVisible(), otherFocused: other.isFocused() }
    other.destroy()
    return res
  })
  expect(r.before).toBe(true)
  expect(r.mainVisible).toBe(false)
  expect(r.otherFocused).toBe(true)
})
