import {Component, type ErrorInfo, type ReactNode} from 'react';

type RendererCrashLanguage = 'zh-CN' | 'en-US';

interface RendererErrorBoundaryProps {
  children: ReactNode;
  /** 跟随应用语言渲染兜底页；未加载设置前默认中文，避免崩溃页出现空白。 */
  appLanguage?: RendererCrashLanguage;
  onFatalError?: (error: Error, info: ErrorInfo) => void;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
}

const rendererCrashCopy: Record<
  RendererCrashLanguage,
  {
    ariaLabel: string;
    status: string;
    title: string;
    description: string;
      restart: string;
      exit: string;
  }
> = {
  'zh-CN': {
    ariaLabel: 'Zeus 界面错误边界',
      status: '详细信息已写入本机运行日志',
      title: '启动失败',
      description: 'Zeus 现在无法使用。重新启动会停止遗留工作，并重新启动全部相关进程。',
      restart: '重新启动',
      exit: '退出',
  },
  'en-US': {
    ariaLabel: 'Zeus interface error boundary',
      status: 'Details were written to the local runtime log',
      title: 'Startup failed',
      description: 'Zeus cannot be used right now. Restarting stops remaining work and restarts all related processes.',
      restart: 'Restart',
      exit: 'Exit',
  },
};

function getRendererCrashCopy(appLanguage: RendererErrorBoundaryProps['appLanguage']) {
  return rendererCrashCopy[appLanguage ?? 'zh-CN'] ?? rendererCrashCopy['zh-CN'];
}

/**
 * Renderer 顶层错误边界：渲染异常时保留可恢复说明，避免整页白屏或把堆栈/secret 暴露到界面。
 */
export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = {
    hasError: false,
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
    this.props.onFatalError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const copy = getRendererCrashCopy(this.props.appLanguage);
        return (
            <main className="startup-failure-shell" data-theme="system" aria-label={copy.ariaLabel}>
                <section className="startup-failure-content">
            <span className="startup-failure-mark" aria-hidden="true">
              Z
            </span>
                    <h1>{copy.title}</h1>
                    <p className="startup-failure-description">{copy.description}</p>
                    <p className="startup-failure-log-hint">{copy.status}</p>
                    <div className="startup-failure-actions">
                        <button className="startup-failure-button is-primary" type="button"
                                onClick={() => void window.zeus?.restartAfterStartupFailure?.()}>
                            {copy.restart}
                        </button>
                        <button className="startup-failure-button" type="button"
                                onClick={() => void window.zeus?.exitAfterStartupFailure?.()}>
                            {copy.exit}
                        </button>
                    </div>
                </section>
            </main>
        );
    }
    return this.props.children;
  }
}
