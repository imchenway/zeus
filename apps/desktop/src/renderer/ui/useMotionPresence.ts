import { useLayoutEffect, useRef, useState } from 'react';

/** 等待元素自身的退出过渡后卸载；重新打开会接管过渡，减少动态效果时立即卸载。 */
export function useMotionPresence<T extends HTMLElement>(open: boolean, animateHeight = false) {
  /** 当前动画所属的真实元素，避免等待子内容或循环装饰。 */
  const ref = useRef<T>(null);
  /** 独立测量自然内容，外层高度动画不会反过来触发自身测量。 */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 退出期间保留内容，业务开关仍然立即生效。 */
  const [retained, setRetained] = useState(open);
  /** 高度过渡可被连续开合从当前位置接管。 */
  const revealAnimation = useRef<Animation | null>(null);
  /** React 提交也立即核对高度，后台视图不依赖被暂停的尺寸观察回调。 */
  const resizeContent = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => revealAnimation.current?.cancel(), []);
  useLayoutEffect(() => {
    if (animateHeight) {
      /** 外层始终保留上次高度，异步内容到达后从当前可见高度接续。 */
      const element = ref.current;
      /** 自然内容保持独立排版，同时覆盖 Markdown、图片和嵌套展开。 */
      const content = contentRef.current;
      if (!element || !content) return;
      /** 首次挂载和虚拟列表恢复不重复播放入场。 */
      let targetHeight = Number.parseFloat(element.style.blockSize);
      if (open) setRetained(true);
      /** 内容增减只改变高度，不反复淡入已经显示的正文。 */
      const resize = (): void => {
        /** 完整自然高度就是终点，结束时不会从一屏高度跳到整段高度。 */
        const to = open ? content.getBoundingClientRect().height : 0;
        if (to === targetHeight) {
          if (!open && !revealAnimation.current) setRetained(false);
          return;
        }
        /** 快速反向或迟到内容都从动画当前位置继续。 */
        const from = element.getBoundingClientRect().height;
        /** 无旧高度表示首次挂载，虚拟列表恢复不重复播放入场。 */
        const initial = !Number.isFinite(targetHeight);
        targetHeight = to;
        revealAnimation.current?.cancel();
        revealAnimation.current = null;
        element.style.blockSize = `${to}px`;
        if (initial || Math.abs(from - to) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
          if (!open) setRetained(false);
          return;
        }
        /** 开合与异步补载共用同一条可中断的高度过渡。 */
        const animation = element.animate(
          [
            { blockSize: `${from}px`, opacity: 1, overflow: 'clip' },
            { blockSize: `${to}px`, opacity: 1, overflow: 'clip' },
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
      };
      resizeContent.current = resize;
      resize();
      /** 观察自然内容而非动画外壳，异步加载也在绘制前接入高度过渡。 */
      const observer = new ResizeObserver(resize);
      observer.observe(content);
      return () => {
        resizeContent.current = null;
        observer.disconnect();
      };
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
  }, [open, animateHeight]);
  useLayoutEffect(() => resizeContent.current?.());
  return { ref, contentRef, present: open || retained };
}
