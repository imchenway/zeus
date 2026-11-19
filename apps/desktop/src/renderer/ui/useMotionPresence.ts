import { useLayoutEffect, useRef, useState } from 'react';

/** 连续高度过渡在展开和收起时使用的时序。 */
export type HeightMotionTiming = Readonly<{
  /** 展开时长，单位为毫秒。 */
  enterMs: number;
  /** 收起时长，单位为毫秒。 */
  exitMs: number;
  /** 两个方向共用的 CSS 缓动曲线。 */
  easing: string;
}>;

/** 等待元素自身的退出过渡后卸载；重新打开会接管过渡，减少动态效果时立即卸载。 */
export function useMotionPresence<T extends HTMLElement>(open: boolean, animateHeight = false, heightMotionTiming?: HeightMotionTiming) {
  /** 当前动画所属的真实元素，避免等待子内容或循环装饰。 */
  const ref = useRef<T>(null);
  /** 独立测量自然内容，外层高度动画不会反过来触发自身测量。 */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 退出期间保留内容，业务开关仍然立即生效。 */
  const [retained, setRetained] = useState(open);
  /** 高度过渡可被连续开合从当前位置接管。 */
  const revealAnimation = useRef<Animation | null>(null);
  useLayoutEffect(() => () => revealAnimation.current?.cancel(), []);
  useLayoutEffect(() => {
    if (animateHeight) {
      /** 外层始终保留上次高度，异步内容到达后从当前可见高度接续。 */
      const element = ref.current;
      /** 自然内容保持独立排版，同时覆盖 Markdown、图片和嵌套展开。 */
      const content = contentRef.current;
      if (!element || !content) return;
      /** 未指定局部时序时，继续使用共享浮层时序。 */
      const style = getComputedStyle(element);
      /** 当前方向的局部时长，单位为毫秒。 */
      const durationOverride = open ? heightMotionTiming?.enterMs : heightMotionTiming?.exitMs;
      /** 当前方向的实际时长，单位为毫秒。 */
      const duration = durationOverride ?? (Number.parseFloat(style.getPropertyValue(open ? '--zeus-motion-duration-layer-enter' : '--zeus-motion-duration-layer-exit')) || (open ? 160 : 120));
      /** 高度在过渡期间的速度曲线。 */
      const easing = heightMotionTiming?.easing ?? (style.getPropertyValue('--zeus-motion-ease-out').trim() || 'ease-out');
      /** 首次挂载和虚拟列表恢复不重复播放入场。 */
      let targetHeight = Number.parseFloat(element.style.blockSize);
      if (open) setRetained(true);
      /** 内容增减只改变高度，不反复淡入已经显示的正文。 */
      const resize = (measuredHeight?: number): void => {
        /** 完整自然高度就是终点，结束时不会从一屏高度跳到整段高度。 */
        const to = open ? (measuredHeight ?? content.getBoundingClientRect().height) : 0;
        if (to === targetHeight) {
          if (!open && !revealAnimation.current) setRetained(false);
          return;
        }
        /** 无旧高度表示首次挂载，虚拟列表恢复不重复播放入场。 */
        const initial = !Number.isFinite(targetHeight);
        /** 只有正在播放的动画需要读取当前位置，其余情况复用上次真实高度。 */
        const from = initial ? to : revealAnimation.current ? element.getBoundingClientRect().height : targetHeight;
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
          { duration, easing },
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
      // 已保留页面恢复时复用高度，避免每个展开区重新强制排版；真实变化由尺寸观察接管。
      if (!Number.isFinite(targetHeight) || !open) resize();
      /** 观察自然内容而非动画外壳，异步加载也在绘制前接入高度过渡。 */
      const observer = new ResizeObserver((entries) => resize(entries[0]?.borderBoxSize[0]?.blockSize));
      observer.observe(content);
      return () => {
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
  }, [open, animateHeight, heightMotionTiming]);
  return { ref, contentRef, present: open || retained };
}
