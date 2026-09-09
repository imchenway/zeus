import { useLayoutEffect, useRef, useState } from 'react';

/** 等待元素自身的退出过渡后卸载；重新打开会接管过渡，减少动态效果时立即卸载。 */
export function useMotionPresence<T extends HTMLElement>(open: boolean) {
  /** 当前动画所属的真实元素，避免等待子内容或循环装饰。 */
  const ref = useRef<T>(null);
  /** 退出期间保留内容，业务开关仍然立即生效。 */
  const [retained, setRetained] = useState(open);
  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    /** 读取本次样式变更生成的过渡，不另写一份时长。 */
    const animations = ref.current?.getAnimations() ?? [];
    if (animations.length === 0) {
      setRetained(false);
      return;
    }
    /** 快速重开或离开页面后，旧动画回执不能卸载新内容。 */
    let cancelled = false;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setRetained(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return { ref, present: open || retained };
}
