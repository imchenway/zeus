/* global module */

/** @typedef {'pending' | 'ready' | 'failed'} RendererBootstrapState */
/** @typedef {'zeus:renderer-bootstrap-failed' | 'zeus:renderer-runtime-failed'} RendererFailureChannel */

/**
 * 首次 commit 前使用 bootstrap fatal；ready 后的 React 崩溃必须走独立 runtime fatal，不能被静默吞掉。
 *
 * @param {{ send: (channel: 'zeus:renderer-bootstrap-ready' | RendererFailureChannel, message?: string) => void }} options
 * @returns {{
 *   reportReady: () => boolean;
 *   reportFailure: (error: unknown) => RendererFailureChannel | undefined;
 *   getState: () => RendererBootstrapState;
 * }}
 */
function createRendererBootstrapReporter(options) {
  /** @type {RendererBootstrapState} */
  let state = 'pending';

  return {
    reportReady: () => {
      if (state !== 'pending') return false;
      state = 'ready';
      options.send('zeus:renderer-bootstrap-ready');
      return true;
    },
    reportFailure: (error) => {
      if (state === 'failed') return undefined;
      /** @type {RendererFailureChannel} */
      const channel = state === 'ready' ? 'zeus:renderer-runtime-failed' : 'zeus:renderer-bootstrap-failed';
      state = 'failed';
      options.send(channel, formatRendererFatalError(error));
      return channel;
    },
    getState: () => state,
  };
}

/** @param {unknown} error */
function formatRendererFatalError(error) {
  if (error instanceof Error && error.message.trim()) return error.message.split('\n')[0]?.slice(0, 180) ?? 'Renderer failed';
  if (typeof error === 'string' && error.trim()) return error.split('\n')[0]?.slice(0, 180) ?? 'Renderer failed';
  return 'Renderer failed';
}

/**
 * 捕获阶段只把真正的 JS ErrorEvent 视为 runtime fatal；启动阶段额外覆盖 SCRIPT/LINK 入口资源失败。
 * IMG 等业务资源由组件自身降级，不能导致整应用退出。
 *
 * @param {RendererBootstrapState} state
 * @param {{ message?: unknown; error?: unknown; target?: unknown }} event
 */
function shouldReportRendererWindowError(state, event) {
  const hasJavaScriptMessage = typeof event.message === 'string' && event.message.trim().length > 0;
  const hasJavaScriptError = event.error !== undefined && event.error !== null;
  if (hasJavaScriptMessage || hasJavaScriptError) return true;
  const target = event.target;
  const tagName = typeof target === 'object' && target !== null && 'tagName' in target && typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  return state === 'pending' && (tagName === 'SCRIPT' || tagName === 'LINK');
}

module.exports = {
  createRendererBootstrapReporter,
  formatRendererFatalError,
  shouldReportRendererWindowError,
};
