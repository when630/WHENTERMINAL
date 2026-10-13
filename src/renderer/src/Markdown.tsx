import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 주소 앞에 scheme(http: 등)이 붙어 있는지. 없으면 상대 경로 */
const hasScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(s)

/**
 * 모델 답변용 마크다운. 원시 HTML은 그리지 않는다(react-markdown 기본값) — 앱 API가 노출된 창이라 안전 우선.
 * 링크는 새 창 요청으로 보내고, 메인이 외부 브라우저로 연다 (앱 창 안에서 이동하지 않음).
 * fileUrl(파일 보기): 그 파일의 wt-file 주소. 상대 경로 그림은 그 기준으로 읽고, 상대 경로 링크는 onOpen으로 앱 안에서 연다
 */
export const Markdown = memo(function Markdown({ text, fileUrl, onOpen, remote }: { text: string; fileUrl?: string; onOpen?: (path: string) => void; remote?: Record<string, string> }): React.JSX.Element {
  const local = (href: string): string | null => {
    if (!fileUrl || hasScheme(href) || href.startsWith('#')) return null
    const u = new URL(href, fileUrl)
    return decodeURIComponent(u.pathname).replace(/^\/+/, '')
  }
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const path = href && onOpen ? local(href) : null
            // 문서 안의 #이동은 앱 창이 따라가지 않는다
            if (href?.startsWith('#') && fileUrl) return <a href={href} onClick={(e) => e.preventDefault()}>{children}</a>
            if (path !== null && onOpen) {
              return (
                <a href={href} onClick={(e) => { e.preventDefault(); onOpen(path) }} title={`${path} 열기`}>
                  {children}
                </a>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            )
          },
          img: ({ src, alt }) => {
            const s = typeof src === 'string' ? src : ''
            // 파일 보기의 원격 그림: CSP가 막으므로 메인이 받아 준 data URI로, 아직이면 자리만
            if (fileUrl && /^https?:\/\//i.test(s)) {
              const data = remote?.[s]
              if (data) return <img src={data} alt={alt ?? ''} />
              return <span className="md-remote mono" title={s}>IMAGE · {new URL(s).host}{alt ? ` · ${alt}` : ''}</span>
            }
            return <img src={fileUrl && s && !hasScheme(s) ? new URL(s, fileUrl).toString() : s} alt={alt ?? ''} />
          },
          // 표는 넓으면 가로로 스크롤
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
