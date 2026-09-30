import { Component, type ErrorInfo, type ReactNode } from 'react';

/** 错误页沿用应用支持的界面语言。 */
type RendererCrashLanguage = 'zh-CN' | 'en-US';

/** 窗口错误边界保留子界面、语言与本地诊断回调。 */
interface RendererErrorBoundaryProps {
  children: ReactNode;
  /** 跟随应用语言渲染兜底页；未加载设置前默认中文，避免崩溃页出现空白。 */
  appLanguage?: RendererCrashLanguage;
  onFatalError?: (error: Error, info: ErrorInfo) => void;
}

/** 只记录当前窗口是否进入错误页，不改变后台执行状态。 */
interface RendererErrorBoundaryState {
  hasError: boolean;
}

/** 界面故障只重新加载当前窗口，后台工作继续运行。 */
const rendererCrashCopy: Record<
  RendererCrashLanguage,
  {
    ariaLabel: string;
    status: string;
    title: string;
    description: string;
    reload: string;
  }
> = {
  'zh-CN': {
    ariaLabel: 'Zeus 界面错误',
    status: '详细信息已写入本机运行日志',
    title: '页面无法显示',
    description: '当前窗口发生界面错误。重新加载窗口可尝试恢复，后台工作会继续运行。',
    reload: '重新加载窗口',
  },
  'en-US': {
    ariaLabel: 'Zeus interface error',
    status: 'Details were written to the local runtime log',
    title: 'This page could not be displayed',
    description: 'An interface error occurred in this window. Try reloading it. Background work will continue.',
    reload: 'Reload window',
  },
};

/** 设置未加载时仍提供可操作的中文恢复页。 */
function getRendererCrashCopy(appLanguage: RendererErrorBoundaryProps['appLanguage']) {
  return rendererCrashCopy[appLanguage ?? 'zh-CN'] ?? rendererCrashCopy['zh-CN'];
}

/**
 * Renderer 顶层错误边界：渲染异常时保留可恢复说明，避免整页白屏或把堆栈/secret 暴露到界面。
 */
export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  /** 故障只停留在当前 Renderer，不请求应用退出或宿主重启。 */
  state: RendererErrorBoundaryState = {
    hasError: false,
  };

  /** 捕获渲染异常后显示窗口恢复入口。 */
  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { hasError: true };
  }

  /** 记录异常供本地排查，保持后台进程不受界面错误影响。 */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 错误详情只写入本地开发控制台，不进入 DOM，避免 token、路径或堆栈被用户复制到报告中。
    console.error('Zeus renderer crashed', {
      message: error.message,
      componentStack: info.componentStack,
    });
    this.props.onFatalError?.(error, info);
  }

  /** 通过平台原生窗口操作恢复界面，无需应用级恢复接口。 */
  render(): ReactNode {
    if (this.state.hasError) {
      const copy = getRendererCrashCopy(this.props.appLanguage);
      return (
        <main className="startup-failure-shell" data-theme="system" aria-label={copy.ariaLabel}>
          <section className="startup-failure-content">
            <span className="startup-failure-mark" aria-hidden="true" />
            <h1>{copy.title}</h1>
            <p className="startup-failure-description">{copy.description}</p>
            <p className="startup-failure-log-hint">{copy.status}</p>
            <div className="startup-failure-actions">
              <button className="startup-failure-button is-primary" type="button" onClick={() => window.location.reload()}>
                {copy.reload}
              </button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
