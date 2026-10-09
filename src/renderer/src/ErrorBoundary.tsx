import { Component, type ReactNode } from 'react'

/** 렌더 오류가 나도 빈 화면 대신 오류 내용과 복구 버튼을 보여준다 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <div className="crash-title">화면에 문제가 생겼어요</div>
        <pre>{error.stack ?? error.message}</pre>
        <button onClick={() => this.setState({ error: null })}>RETRY</button>
      </div>
    )
  }
}
