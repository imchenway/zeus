import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RendererErrorBoundaryProps {
  children: ReactNode;
  /** 测试专用初始错误；生产渲染错误由 React 生命周期捕获。 */
  initialError?: Error;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
}

/**
 * Renderer 顶层错误边界：渲染异常时保留可恢复说明，避免整页白屏或把堆栈/secret 暴露到界面。
 */
export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = {
    hasError: Boolean(this.props.initialError),
  };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 错误详情只写入本地开发控制台，不进入 DOM，避免 token、路径或堆栈被用户复制到报告中。
    console.error('Zeus renderer crashed', {
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="zeus-shell theme-system" data-theme="system" aria-label="Zeus 界面错误边界">
          <section className="workspace">
            <article className="empty-state data-panel" role="alert">
              <div className="empty-glyph" aria-hidden="true" />
              <h1>Zeus 遇到界面错误</h1>
              <p>请刷新窗口或重新打开 Zeus。当前页面不会展示错误堆栈、token 或终端输出，避免泄露本机敏感信息。</p>
              <button type="button" onClick={() => globalThis.location?.reload()}>
                刷新窗口
              </button>
            </article>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
