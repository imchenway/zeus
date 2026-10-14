import { useLayoutEffect, useMemo, useRef } from 'react';
import { createHoverIntent } from '../../preload/hoverIntent.js';

/** React 详情复用同一等待规则，并在到期时读取最新文案与业务状态。 */
export function useHoverIntent<Value = void>(show: (value: Value, target: HTMLElement) => void) {
  /** 最新的显示动作避免等待期间更新数据后仍展示旧内容。 */
  const showRef = useRef(show);
  /** 每个浮层只保留一个等待控制器。 */
  const intent = useMemo(() => createHoverIntent(), []);
  useLayoutEffect(() => {
    showRef.current = show;
  });
  useLayoutEffect(() => () => intent.cancel(), [intent]);
  return useMemo(
    () => ({
      /** 元素身份控制计时，业务值只负责选取详情内容。 */
      schedule(target: HTMLElement, value: Value): void {
        intent.schedule(target, () => showRef.current(value, target));
      },
      /** 立即显示、离开和关闭时复用同一取消入口。 */
      cancel: intent.cancel,
    }),
    [intent],
  );
}
