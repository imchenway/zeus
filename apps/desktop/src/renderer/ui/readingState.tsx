import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

/** 阅读状态只在当前窗口保存，不持有正文、编辑器或 DOM。 */
const readingStates = new Map<string, Map<string, { current: unknown }>>();
/** 嵌套文件和侧栏会话分别拥有阅读状态，避免同一路径串用位置。 */
const ReadingScope = createContext<string | null>(null);

/** 切换内容时重建视图，重新打开时复用该内容的小型阅读记录。 */
export function ReadingStateScope(props: { id: string; children: ReactNode }) {
  /** 父级身份隔离主会话、侧栏会话和文件版本。 */
  const parent = useContext(ReadingScope);
  /** 结构化身份避免路径分隔符造成碰撞。 */
  const scope = JSON.stringify([parent, props.id]);
  return (
    <ReadingScope.Provider key={scope} value={scope}>
      {props.children}
    </ReadingScope.Provider>
  );
}

/** 返回可在卸载前写入的阅读记录；未提供作用域的入口保持原有生命周期。 */
export function useReadingSnapshot<T>(key: string): { current: T | undefined } {
  /** 当前内容的独立缓存身份。 */
  const scope = useContext(ReadingScope);
  return useMemo(() => {
    if (!scope) return { current: undefined };
    /** 同一内容的各项记录共享作用域，但不共享值。 */
    const entries = readingStates.get(scope) ?? new Map<string, { current: unknown }>();
    readingStates.set(scope, entries);
    /** 记录仅保存调用方明确提供的位置或展示选项。 */
    const entry = entries.get(key) ?? { current: undefined };
    entries.set(key, entry);
    return entry as { current: T | undefined };
  }, [key, scope]);
}

/** 保存标签选择、展开项等展示状态，不保存网络结果或编辑草稿。 */
export function useReadingState<T>(key: string, initial: T | (() => T)) {
  /** 上次卸载时已经提交的展示选项。 */
  const saved = useReadingSnapshot<T>(key);
  /** 当前组件仍使用 React 的普通状态更新。 */
  const state = useState<T>(() => (saved.current !== undefined ? saved.current : typeof initial === 'function' ? (initial as () => T)() : initial));
  useLayoutEffect(() => {
    saved.current = state[0];
  }, [saved, state[0]]);
  return state;
}

/** 保存一个明确滚动容器的位置，等待异步正文具备足够高度后再恢复。 */
export function useReadingScroll(key: string) {
  /** 横纵坐标单位为 CSS 像素。 */
  const saved = useReadingSnapshot<{ top: number; left: number }>(key);
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      /** 恢复期间的浏览器钳制不能覆盖原始位置。 */
      let pending = saved.current;
      /** 合并编辑器测量和异步 Markdown 布局通知。 */
      let frame = 0;
      /** 只在用户尚未接管滚动时恢复。 */
      const restore = () => {
        frame = 0;
        if (!pending) return;
        element.scrollTop = pending.top;
        element.scrollLeft = pending.left;
        if (Math.abs(element.scrollTop - pending.top) < 1 && Math.abs(element.scrollLeft - pending.left) < 1) pending = undefined;
      };
      /** 正文和容器尺寸变化共用一次布局恢复。 */
      const schedule = () => {
        if (pending && !frame) frame = requestAnimationFrame(restore);
      };
      /** 用户滚动之后以实际位置为准。 */
      const remember = () => {
        // 编辑器的 passive cleanup 可能晚于 DOM 移除，不能用卸载后的零坐标覆盖已读位置。
        if (!pending && element.isConnected && element.getClientRects().length) saved.current = { top: element.scrollTop, left: element.scrollLeft };
      };
      /** 鼠标、触屏和键盘操作优先于尚未完成的自动恢复。 */
      const takeOver = () => {
        pending = undefined;
      };
      /** 懒加载编辑器和 Markdown 会在挂载后补入正文。 */
      const mutations = new MutationObserver(schedule);
      /** 窄窗口、字体和图片布局可能改变可滚动范围。 */
      const resize = new ResizeObserver(schedule);
      mutations.observe(element, { childList: true, characterData: true, subtree: true });
      resize.observe(element);
      element.addEventListener('load', schedule, true);
      element.addEventListener('scroll', remember, { passive: true });
      element.addEventListener('wheel', takeOver, { passive: true });
      element.addEventListener('pointerdown', takeOver, { passive: true });
      element.addEventListener('keydown', takeOver);
      schedule();
      return () => {
        remember();
        cancelAnimationFrame(frame);
        mutations.disconnect();
        resize.disconnect();
        element.removeEventListener('load', schedule, true);
        element.removeEventListener('scroll', remember);
        element.removeEventListener('wheel', takeOver);
        element.removeEventListener('pointerdown', takeOver);
        element.removeEventListener('keydown', takeOver);
      };
    },
    [saved],
  );
}
