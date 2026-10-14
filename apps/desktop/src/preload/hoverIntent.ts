/** 所有应用悬停提示共用的连续停留时间，键盘与点击不经过此等待。 */
export const hoverIntentDelayMs = 800;

/** 只管理一次等待；浮层内容、关闭容错和固定状态仍由原入口负责。 */
export function createHoverIntent() {
  /** 当前等待的真实元素；其内部节点变化不会重新计时。 */
  let target: HTMLElement | null = null;
  /** 同一目标重新调度时使用最新内容，不延长等待。 */
  let reveal: (() => void) | undefined;
  /** 尚未到期的悬停等待。 */
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** 所有取消路径都释放监听，避免取消后仍弹出或卸载后保留元素。 */
  function cancel(): void {
    clearTimeout(timer);
    timer = undefined;
    target?.ownerDocument.removeEventListener('pointerdown', cancel, true);
    target?.ownerDocument.removeEventListener('keydown', keydown, true);
    target?.ownerDocument.removeEventListener('focusin', cancel, true);
    target?.ownerDocument.removeEventListener('scroll', cancel, true);
    target?.ownerDocument.removeEventListener('visibilitychange', cancel);
    target?.ownerDocument.defaultView?.removeEventListener('blur', cancel);
    target?.ownerDocument.defaultView?.removeEventListener('resize', cancel);
    target = null;
    reveal = undefined;
  }

  /** 等待中的 Escape 不拦截原有菜单或对话框的按键处理。 */
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cancel();
  }

  /** 切换目标重新计时；只有仍在页面内且仍被悬停的目标可以显示。 */
  function schedule(next: HTMLElement, show: () => void): void {
    if (target === next) {
      reveal = show;
      return;
    }
    cancel();
    target = next;
    reveal = show;
    next.ownerDocument.addEventListener('pointerdown', cancel, true);
    next.ownerDocument.addEventListener('keydown', keydown, true);
    next.ownerDocument.addEventListener('focusin', cancel, true);
    next.ownerDocument.addEventListener('scroll', cancel, true);
    next.ownerDocument.addEventListener('visibilitychange', cancel);
    next.ownerDocument.defaultView?.addEventListener('blur', cancel);
    next.ownerDocument.defaultView?.addEventListener('resize', cancel);
    timer = setTimeout(() => {
      /** 先释放等待，再显示，防止显示回调重新调度时被旧计时器清理。 */
      const current = target;
      /** 同一目标的最新显示动作。 */
      const callback = reveal;
      cancel();
      if (current?.isConnected && current.ownerDocument.visibilityState !== 'hidden' && current.matches(':hover')) callback?.();
    }, hoverIntentDelayMs);
  }

  return { schedule, cancel };
}
