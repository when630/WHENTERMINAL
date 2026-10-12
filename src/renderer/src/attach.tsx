import { useRef, useState, type RefObject } from 'react'

// 첨부는 경로로: 끌어다 놓기·이미지 붙여넣기·첨부 버튼으로 고른 파일의 경로를 입력칸 커서 자리에 넣는다.
// 에이전트는 경로를 보고 Read로 읽는다 (이미지도 읽을 수 있다).

/** 작업 폴더 안이면 '@상대경로', 밖이면 전체 경로. 띄어쓰기가 있으면 따옴표 */
export function refsFor(paths: string[], root: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  return paths
    .map((raw) => {
      const p = raw.replace(/\\/g, '/')
      const inside = p.toLowerCase().startsWith(r.toLowerCase() + '/')
      const shown = inside ? p.slice(r.length + 1) : raw
      const quoted = /\s/.test(shown) ? `"${shown}"` : shown
      return inside ? `@${quoted}` : quoted
    })
    .join(' ')
}

/** 붙여넣은 파일들 → 경로. 실제 파일(파인더에서 복사)은 그 경로, 스크린샷처럼 경로 없는 이미지는 저장해서 */
async function pathsFromPaste(files: File[]): Promise<string[]> {
  const out = await Promise.all(
    files.map(async (f) => {
      const real = window.api.pathForFile(f)
      if (real) return real
      if (!f.type.startsWith('image/')) return ''
      return window.api.saveImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1] ?? 'png')
    }),
  )
  return out.filter(Boolean)
}

interface Options {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  setValue: (v: string) => void
  /** 이 입력칸의 주인 (대화 ID 등). 붙여넣은 이미지를 저장하는 사이에 바뀌면 넣지 않는다 (다른 대화의 초안을 덮지 않게) */
  scope: string
  /** 경로를 상대 경로로 줄일 기준 폴더 */
  root: string
  onCaret?: (pos: number) => void
}

export function useAttach({ inputRef, setValue, scope, root, onCaret }: Options): {
  dropping: boolean
  dropProps: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
  onPaste: (e: React.ClipboardEvent) => void
  pick: () => void
  insertPaths: (paths: string[]) => void
} {
  const [dropping, setDropping] = useState(false)
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const insertPaths = (paths: string[]): void => {
    if (!paths.length) return
    const el = inputRef.current
    if (!el) return
    // 파일을 고르거나 저장하는 동안 더 친 글이 있을 수 있으므로 렌더 때의 값이 아니라 입력칸의 지금 값에 넣는다
    const value = el.value
    const at = el.selectionStart ?? value.length
    const before = value.slice(0, at)
    const piece = `${before && !/\s$/.test(before) ? ' ' : ''}${refsFor(paths, root)} `
    const pos = at + piece.length
    setValue(before + piece + value.slice(at))
    onCaret?.(pos)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }
  /** 기다리는 일(파일 고르기·이미지 저장) 뒤에 넣는다. 그 사이 다른 대화로 옮겼으면 버린다 */
  const insertLater = (paths: Promise<string[]>): void => {
    const from = scopeRef.current
    void paths.then((list) => scopeRef.current === from && insertPaths(list))
  }

  return {
    dropping,
    insertPaths,
    dropProps: {
      onDragOver: (e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDropping(true)
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
      },
      onDrop: (e) => {
        e.preventDefault()
        setDropping(false)
        insertPaths([...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean))
      },
    },
    // 글자 붙여넣기는 그대로 두고, 파일·이미지가 있을 때만 가로챈다
    onPaste: (e) => {
      const files = [...e.clipboardData.files]
      if (!files.length) return
      e.preventDefault()
      insertLater(pathsFromPaste(files))
    },
    pick: () => insertLater(window.api.pickFiles()),
  }
}

export function AttachButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="attach" onClick={onClick} title="파일 첨부 (끌어다 놓기·이미지 붙여넣기도 돼요)" aria-label="파일 첨부">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden="true">
        <path d="M10.5 4.5 5.2 9.8a1.6 1.6 0 0 0 2.3 2.3l5.6-5.6a3 3 0 0 0-4.3-4.3L3.2 7.8a4.4 4.4 0 0 0 6.2 6.2l4.1-4.1" />
      </svg>
    </button>
  )
}
