import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * JSON 파일을 읽는다. 없으면 undefined.
 * 깨져 있으면 원본을 `<파일>.corrupt-<시각>`으로 남겨 두고 undefined (다음 저장이 덮어써도 되살릴 수 있게)
 */
export function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const keep = `${file}.corrupt-${Date.now()}`
    try {
      copyFileSync(file, keep)
    } catch {
      // 남기지 못해도 시작은 한다
    }
    console.error(`${file} 읽기 실패, ${keep}에 원본을 남기고 기본값으로 시작`, err)
    return undefined
  }
}

/**
 * 임시 파일에 쓰고 디스크에 내린 뒤 바꿔치기한다 (쓰는 중에 꺼져도 반쯤 쓴 파일이 남지 않게).
 * Windows에서 백신·색인기가 잠깐 잡고 있으면 rename이 EPERM/EBUSY로 실패하므로 몇 번 다시 해 본다.
 * 끝내 못 쓰면 로그만 남긴다 (메모리의 값은 그대로라 다음 저장 때 다시 쓴다)
 */
export function writeJson(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, JSON.stringify(data, null, 2), null, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
      }
    }
  } catch (err) {
    console.error(`${file} 저장 실패`, err)
  }
}
