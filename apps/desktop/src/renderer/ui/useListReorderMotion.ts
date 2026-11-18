import { useEffect, useLayoutEffect, useRef } from 'react';

/** 列表项沿自然位置重排；连续更新接续当前位移，首屏及减少动态效果时直接显示结果。 */
export function useListReorderMotion<T extends HTMLElement>(layoutKey: string, observeRowSize = false) {
  /** 测量限于调用方的列表容器。 */
  const ref = useRef<T>(null);
  /** 自然位置不包含动画位移，侧栏滚动也不会改变它。 */
  const positionsRef = useRef(new Map<string, number>());
  /** 每行最多保留一段可被接续的原生动画。 */
  const animationsRef = useRef(new Map<HTMLElement, Animation>());
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) {
      positionsRef.current.clear();
      return;
    }
    /** 先完成全部位置读取，再统一写入动画，避免逐行触发布局。 */
    const positions = new Map<string, number>();
    const moves: { element: HTMLElement; offset: number }[] = [];
    for (const element of list.querySelectorAll<HTMLElement>('[data-list-motion-id]')) {
      const id = element.dataset.listMotionId!;
      const top = element.offsetTop;
      const previousTop = positionsRef.current.get(id);
      /** 旧动画尚未结束时，接住用户此刻看到的位置。 */
      const translation = animationsRef.current.has(element) ? Number.parseFloat(getComputedStyle(element).translate.split(' ')[1] ?? '0') || 0 : 0;
      positions.set(id, top);
      if (previousTop !== undefined && Math.abs(previousTop + translation - top) >= 1) moves.push({ element, offset: previousTop + translation - top });
    }
    for (const animation of animationsRef.current.values()) animation.cancel();
    animationsRef.current.clear();
    positionsRef.current = positions;
    if (moves.length === 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    /** 行位移复用品牌层级动效的时长和缓动，不改变透明度及选中态。 */
    const style = getComputedStyle(list);
    /** CSS 时间统一换算为毫秒，ms 与 s 的同值表达使用相同时长。 */
    const duration = CSSNumericValue.parse(style.getPropertyValue('--zeus-motion-duration-layer-enter') || '220ms').to('ms').value;
    const easing = style.getPropertyValue('--zeus-motion-ease-out').trim() || 'ease-out';
    for (const { element, offset } of moves) {
      const animation = element.animate([{ translate: `0 ${offset}px` }, { translate: '0 0' }], { duration, easing });
      animationsRef.current.set(element, animation);
      /** 动画完成后释放句柄，旧回调不能清除接续的新动画。 */
      animation.onfinish = () => {
        if (animationsRef.current.get(element) === animation) animationsRef.current.delete(element);
      };
    }
  }, [layoutKey]);
  useLayoutEffect(() => {
    if (!observeRowSize || !ref.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    /** 逐行高度过渡会自然移动后续行，更新位置基线以免第二次播放补位。 */
    const rows = ref.current.querySelectorAll<HTMLElement>('[data-list-motion-id]');
    const observer = new ResizeObserver(() => {
      for (const row of rows) positionsRef.current.set(row.dataset.listMotionId!, row.offsetTop);
    });
    for (const row of rows) observer.observe(row, { box: 'border-box' });
    return () => observer.disconnect();
  }, [layoutKey, observeRowSize]);
  useEffect(
    () => () => {
      for (const animation of animationsRef.current.values()) animation.cancel();
    },
    [],
  );
  return ref;
}
