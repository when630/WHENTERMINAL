import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 모델 답변용 마크다운. 원시 HTML은 그리지 않는다(react-markdown 기본값) — 앱 API가 노출된 창이라 안전 우선.
 * 링크는 새 창 요청으로 보내고, 메인이 외부 브라우저로 연다 (앱 창 안에서 이동하지 않음)
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
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
