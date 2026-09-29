import { useLayoutEffect, useRef, useState } from 'react';

/** 等待元素自身的退出过渡后卸载；重新打开会接管过渡，减少动态效果时立即卸载。 */
export function useMotionPresence<T extends HTMLElement>(open: boolean, revealWithinViewport = false) {
  /** 当前动画所属的真实元素，避免等待子内容或循环装饰。 */
  const ref = useRef<T>(null);
  /** 退出期间保留内容，业务开关仍然立即生效。 */
  const [retained, setRetained] = useState(open);
  /** 高度过渡可被连续开合从当前位置接管。 */
  const revealAnimation = useRef<Animation | null>(null);
  /** 初始挂载保持原有状态，不因虚拟列表重新挂载而播放入场。 */
  const previousOpen = useRef(open);
  useLayoutEffect(() => () => revealAnimation.current?.cancel(), []);
  useLayoutEffect(() => {
    if (revealWithinViewport) {
      /** 布局提交后测量自然内容，关闭期间子节点仍由 retained 保留。 */
      const element = ref.current;
      if (!element || previousOpen.current === open) return;
      previousOpen.current = open;
      /** 有滚动容器时只展开入口下方的可见部分，屏外内容无需高速扫过。 */
      let bottom = window.innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) bottom = Math.min(bottom, parent.getBoundingClientRect().bottom);
      }
      /** ponytail: 高度动画最多覆盖一屏；结束后恢复自然高度，跨屏编排有需要再扩展。 */
      const visibleHeight = Math.max(1, bottom - element.getBoundingClientRect().top);
      /** 快速反向保留当前高度和透明度，避免重置后闪回起点。 */
      const from = revealAnimation.current ? element.getBoundingClientRect().height : open ? 0 : Math.min(element.scrollHeight, visibleHeight);
      /** 只做很轻的透明度变化，内容主要通过向下展开逐步显露。 */
      const opacity = revealAnimation.current ? getComputedStyle(element).opacity : open ? 0.6 : 1;
      revealAnimation.current?.cancel();
      revealAnimation.current = null;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setRetained(open);
        return;
      }
      if (open) setRetained(true);
      /** 开合只动画可见高度；自然高度始终由原有样式和内容决定。 */
      const animation = element.animate(
        [
          { blockSize: `${from}px`, opacity, overflow: 'clip' },
          { blockSize: `${open ? Math.min(element.scrollHeight, visibleHeight) : 0}px`, opacity: open ? 1 : 0.6, overflow: 'clip' },
        ],
        { duration: open ? 280 : 220, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' },
      );
      revealAnimation.current = animation;
      void animation.finished
        .then(() => {
          if (revealAnimation.current !== animation) return;
          revealAnimation.current = null;
          if (!open) setRetained(false);
        })
        .catch(() => {
          /* 连续开合或卸载取消旧动画属于正常路径。 */
        });
      return;
    }
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
  }, [open, revealWithinViewport]);
  return { ref, present: open || retained };
}
