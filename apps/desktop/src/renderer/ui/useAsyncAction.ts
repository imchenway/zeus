import { useEffect, useRef, useState } from 'react';

/** 同一入口的异步操作立即显示忙碌并拒绝重复触发，同步交互不增加等待。 */
export function useAsyncAction<Args extends unknown[]>(callback?: (...args: Args) => unknown) {
  /** 引用在本轮渲染前就阻止重复点击，状态负责更新可访问反馈。 */
  const active = useRef(false);
  /** 已离开的页面不再接收本次反馈，实际命令继续由调用方完成。 */
  const mounted = useRef(true);
  /** 仅当前入口变化，不触发页面级的全局忙碌。 */
  const [pending, setPending] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 返回原操作的完成链，业务未处理的失败继续进入现有全局错误出口。 */
  function execute(...args: Args): unknown {
    if (active.current) return;
    /** 同步返回直接透传；只有真实的异步结果进入等待状态。 */
    const result = callback?.(...args);
    if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return result;
    active.current = true;
    setPending(true);
    return Promise.resolve(result).finally(() => {
      active.current = false;
      if (mounted.current) setPending(false);
    });
  }

  return { pending, execute };
}
