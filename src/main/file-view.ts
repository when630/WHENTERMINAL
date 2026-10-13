import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import type { FileView } from '@shared/types'

/**
 * 파일 보기(FilesOverlay)가 쓰는 주소: wt-file://<폴더 키>/<상대 경로>.
 * 렌더러의 CSP는 file:을 막으므로, 이 주소로 열어 준 폴더 안의 파일만 내준다 (html 미리 보기·그림·md의 상대 경로 그림)
 */
export const FILE_SCHEME = 'wt-file'

/** 이만큼까지는 한 번에 읽는다. 더 크면 CHUNK씩 나눠 읽는다 (보기는 CodeMirror라 화면에 보이는 부분만 그린다) */
const FULL_LIMIT = 20 * 1024 * 1024
const CHUNK = 4 * 1024 * 1024
/** 원격 그림 한 장의 크기 상한과 한 문서에서 받는 개수 */
const IMAGE_LIMIT = 10 * 1024 * 1024
const MAX_IMAGES = 60
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'])
const MARKDOWN = new Set(['.md', '.markdown', '.mdx'])
const HTML = new Set(['.html', '.htm'])

const roots = new Map<string, string>()

/** 폴더 하나에 주소 키를 붙인다. 같은 폴더는 늘 같은 키 */
function rootKey(dir: string): string {
  const full = resolve(dir)
  const key = createHash('sha1').update(process.platform === 'win32' ? full.toLowerCase() : full).digest('hex').slice(0, 16)
  roots.set(key, full)
  return key
}

/** 폴더 밖으로 나가는 경로(../, 절대 경로)는 null */
function inside(root: string, rel: string): string | null {
  const full = resolve(root, rel)
  const r = relative(root, full)
  return r.startsWith('..') || isAbsolute(r) ? null : full
}

const urlOf = (key: string, rel: string): string => `${FILE_SCHEME}://${key}/${rel.split('/').map(encodeURIComponent).join('/')}`

/** 앱이 준비되기 전에 불러야 한다 (fetch·스트리밍·상대 경로가 되는 표준 주소로) */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}

export function handleFileScheme(): void {
  protocol.handle(FILE_SCHEME, async (req) => {
    const u = new URL(req.url)
    const root = roots.get(u.hostname)
    if (!root) return new Response('not found', { status: 404 })
    const full = inside(root, decodeURIComponent(u.pathname).replace(/^\/+/, ''))
    if (!full) return new Response('forbidden', { status: 403 })
    try {
      return await net.fetch(pathToFileURL(full).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

/**
 * 파일 하나를 보기용으로 읽는다. 글은 20MB까지 한 번에, 더 크면 offset부터 4MB씩(줄 끝에서 자른다, 다음 위치는 next).
 * 그림·html은 wt-file 주소도 같이
 */
export async function viewFile(cwd: string, rel: string, offset = 0): Promise<FileView> {
  const key = rootKey(cwd)
  const path = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const base = { path, url: urlOf(key, path) }
  const full = inside(cwd, path)
  if (!full) return { ...base, kind: 'missing', size: 0 }
  let size: number
  try {
    const s = await stat(full)
    if (s.isDirectory()) return { ...base, kind: 'dir', size: 0 }
    size = s.size
  } catch {
    return { ...base, kind: 'missing', size: 0 }
  }
  const ext = extname(path).toLowerCase()
  if (IMAGE.has(ext)) return { ...base, kind: 'image', size }
  const fh = await open(full, 'r')
  try {
    const want = offset === 0 && size <= FULL_LIMIT ? size : Math.min(CHUNK, Math.max(0, size - offset))
    const buf = Buffer.alloc(want)
    const { bytesRead } = await fh.read(buf, 0, want, offset)
    let chunk = buf.subarray(0, bytesRead)
    // 앞부분에 NUL이 있으면 글이 아니다
    if (offset === 0 && chunk.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary', size }
    let next: number | undefined
    if (offset + chunk.length < size) {
      // 글자(UTF-8)가 중간에 잘리지 않게 마지막 줄 끝에서 자른다
      const nl = chunk.lastIndexOf(0x0a)
      if (nl > chunk.length / 2) chunk = chunk.subarray(0, nl + 1)
      next = offset + chunk.length
    }
    const kind = MARKDOWN.has(ext) ? 'markdown' : HTML.has(ext) ? 'html' : 'text'
    return { ...base, kind, size, text: chunk.toString('utf8'), offset, next }
  } finally {
    await fh.close()
  }
}

/**
 * 파일 보기에서 사용자가 누른 문서의 원격 그림(http·https)을 메인이 받아 data URI로 돌려준다.
 * 렌더러의 CSP는 외부 그림을 막아 둔다(모델 답의 그림 주소로 대화가 새는 것을 막으려고). 그림이 아니거나 너무 크면 뺀다
 */
export async function fetchRemoteImages(urls: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const list = [...new Set(urls)].filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_IMAGES)
  await Promise.all(
    list.map(async (url) => {
      try {
        const res = await net.fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (!res.ok || !type.startsWith('image/')) return
        const len = Number(res.headers.get('content-length') ?? 0)
        if (len > IMAGE_LIMIT) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > IMAGE_LIMIT) return
        out[url] = `data:${type};base64,${buf.toString('base64')}`
      } catch {
        // 못 받은 그림은 자리 표시로 남는다
      }
    }),
  )
  return out
}
