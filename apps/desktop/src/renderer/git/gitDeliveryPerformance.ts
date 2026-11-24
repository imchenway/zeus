import { useEffect } from 'react';

/** 当前真实文件选择的单调时钟起点；自动预读不产生点击样本。 */
let selection: { path: string; startedAt: number } | undefined;

/** 只在用户改变审阅文件时开始计时，不把悬停预读算作点击。 */
export function beginGitDiffSelection(path: string): void {
  selection = { path, startedAt: performance.now() };
}

/** 外壳绘制帧用于显示原生窗口，内容绘制帧用于记录数据就绪耗时。 */
export function useGitDeliveryWindowFrame(ready: boolean, kind: 'surface' | 'window' = 'window'): void {
  useEffect(() => {
    if (!ready || document.body.dataset.surface !== 'task-git-delivery') return;
    /** 系统动效偏好由当前 Renderer 提供，主进程与页面使用同一口径。 */
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    /** 两帧之间让 Chromium 有机会提交实际布局。 */
    let first = 0;
    let second = 0;
    /** 重开、聚焦或系统设置改变后重新报告当前帧。 */
    const report = () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      if (document.visibilityState !== 'visible') return;
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => window.zeus?.reportGitDeliveryFrame?.({ kind, reduceMotion: motion.matches }));
      });
    };
    report();
    const unsubscribe = window.zeus?.onGitDeliveryFrameRequested?.(report);
    motion.addEventListener('change', report);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      motion.removeEventListener('change', report);
      unsubscribe?.();
    };
  }, [ready, kind]);
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
