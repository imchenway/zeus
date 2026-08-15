import { Component, type ErrorInfo, type ReactNode } from 'react';

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
    refresh: string;
  }
> = {
  'zh-CN': {
    ariaLabel: 'Zeus 界面错误边界',
    status: '界面已安全暂停',
    title: 'Zeus 遇到界面错误',
    description: '请刷新窗口或重新打开 Zeus。当前页面不会展示错误堆栈、token 或终端输出，避免泄露本机敏感信息。',
    refresh: '刷新窗口',
  },
  'en-US': {
    ariaLabel: 'Zeus interface error boundary',
    status: 'The interface is safely paused',
    title: 'Zeus interface error',
    description: 'Refresh this window or reopen Zeus. This page does not show stack traces, tokens, or terminal output, so local sensitive data stays hidden.',
    refresh: 'Refresh window',
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
      // 真实错误由应用级弹窗承载；这里仅保留稳定底面，避免再次渲染故障组件。
      return <main className="renderer-crash-shell" data-theme="system" aria-label={copy.ariaLabel} />;
    }
    return this.props.children;
  }
}
