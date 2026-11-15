import { useEffect } from 'react';

/** 当前真实文件选择的单调时钟起点；自动预读不产生点击样本。 */
let selection: { path: string; startedAt: number } | undefined;

/** 只在用户改变审阅文件时开始计时，不把悬停预读算作点击。 */
export function beginGitDiffSelection(path: string): void {
  selection = { path, startedAt: performance.now() };
}

/** 文件列表实际提交后，展示或重新聚焦窗口时报告其首个已绘制帧。 */
export function useGitDeliveryWindowFrame(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let first = 0;
    let second = 0;
    const report = () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      if (document.visibilityState !== 'visible') return;
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => window.zeus?.reportGitDeliveryFrame?.({ kind: 'window' }));
      });
    };
    report();
    const unsubscribe = window.zeus?.onGitDeliveryFrameRequested?.(report);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      unsubscribe?.();
    };
  }, [ready]);
}

/** 差异编辑器挂载并绘制后结束计时，排除仅显示加载提示的帧。 */
export function useGitDiffContentFrame(path: string, ready: boolean): void {
  useEffect(() => {
    const pending = selection;
    if (!ready || !pending || pending.path !== path) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (selection !== pending) return;
        selection = undefined;
        const durationMs = performance.now() - pending.startedAt;
        // Performance Timeline 只保留最近一次选择，历史数值由现有宿主日志接收。
        performance.clearMeasures('zeus.git-diff.click-to-content');
        performance.measure('zeus.git-diff.click-to-content', { start: pending.startedAt, duration: durationMs });
        window.zeus?.reportGitDeliveryFrame?.({ kind: 'diff', durationMs });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [path, ready]);
}
