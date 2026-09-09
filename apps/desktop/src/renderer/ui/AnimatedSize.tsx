import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** 文本截断和“查看更多”保留原有内容语义，仅在用户切换时平滑改变整体高度。 */
export function AnimatedSize({ changeKey, children }: { changeKey: boolean; children: ReactNode }) {
  /** 动画只作用于这一组内容，不接管内部流式正文。 */
  const ref = useRef<HTMLDivElement>(null);
  /** 记录上一帧的真实高度，快速反向操作从当前可见位置继续。 */
  const previousHeight = useRef<number | null>(null);
  /** 当前高度动画可以被后续点击立即接管。 */
  const animationRef = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    /** 内容自然增长只更新测量，不触发额外入场。 */
    const observer = new ResizeObserver(() => {
      previousHeight.current = element.getBoundingClientRect().height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      animationRef.current?.cancel();
    };
  }, []);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const from = previousHeight.current;
    animationRef.current?.cancel();
    const to = element.getBoundingClientRect().height;
    previousHeight.current = to;
    if (from === null || Math.abs(from - to) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    /** 时长和缓动来自同一品牌动效配置。 */
    const style = getComputedStyle(element);
    const duration = Number.parseFloat(style.getPropertyValue('--zeus-motion-duration-layer-enter')) || 220;
    const easing = style.getPropertyValue('--zeus-motion-ease-out').trim() || 'ease-out';
    const animation = element.animate(
      [
        { height: `${from}px`, overflow: 'clip' },
        { height: `${to}px`, overflow: 'clip' },
      ],
      { duration, easing },
    );
    animationRef.current = animation;
    void animation.finished
      .then(() => {
        if (animationRef.current === animation) animationRef.current = null;
      })
      .catch(() => {
        /* 连续点击接管旧动画属于正常路径。 */
      });
  }, [changeKey]);
  return (
    <div ref={ref} data-zeus-primitive="animated-size" style={{ display: 'flow-root' }}>
      {children}
    </div>
  );
}
