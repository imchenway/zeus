export type RendererBootstrapMonitorOptions<Target extends object> = {
  onFailure: (target: Target, error: unknown) => void;
};

export type RendererBootstrapMonitor<Target extends object> = {
  watch: (target: Target) => void;
  markReady: (target: Target) => boolean;
  fail: (target: Target, error: unknown) => boolean;
  dispose: (target: Target) => void;
  isPending: (target: Target) => boolean;
  isReady: (target: Target) => boolean;
};

type BootstrapStatus = 'pending' | 'ready' | 'failed';

/** 跟踪窗口从创建到 React 首次 commit；只把真实生命周期失败上报一次，不用固定时长误杀慢启动。 */
export function createRendererBootstrapMonitor<Target extends object>(options: RendererBootstrapMonitorOptions<Target>): RendererBootstrapMonitor<Target> {
  const states = new Map<Target, BootstrapStatus>();

  const fail = (target: Target, error: unknown): boolean => {
    if (states.get(target) !== 'pending') return false;
    states.set(target, 'failed');
    options.onFailure(target, error);
    return true;
  };

  const markReady = (target: Target): boolean => {
    if (states.get(target) !== 'pending') return false;
    states.set(target, 'ready');
    return true;
  };

  return {
    watch: (target) => {
      if (!states.has(target)) states.set(target, 'pending');
    },
    markReady,
    fail,
    dispose: (target) => {
      states.delete(target);
    },
    isPending: (target) => states.get(target) === 'pending',
    isReady: (target) => states.get(target) === 'ready',
  };
}
