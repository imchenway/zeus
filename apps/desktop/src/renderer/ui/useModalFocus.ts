import { useLayoutEffect, type RefObject } from 'react';

/** 活动模态层按打开顺序排列，只有最上层接受键盘焦点。 */
const layers: HTMLElement[] = [];
/** 保存背景的原始可访问状态，嵌套层不会互相覆盖恢复记录。 */
const backgroundStates = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
/** 可参与焦点移动的原生和自定义控件。 */
const focusableSelector = 'button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** 过滤折叠、退出和禁用区域，避免键盘进入视觉上已消失的内容。 */
function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.checkVisibility() && !element.closest('[inert], [aria-hidden="true"], [aria-disabled="true"]'));
}

/** 以最上层为准同步背景，关闭顺序变化时仍恢复最初状态。 */
function syncModalBackground(): void {
  const active = layers.at(-1);
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement)) continue;
    if (!backgroundStates.has(element)) backgroundStates.set(element, { inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') });
    const original = backgroundStates.get(element)!;
    const blocked = element.dataset.motionState === 'closing' || Boolean(active && element !== active && !element.contains(active));
    element.inert = blocked || original.inert;
    if (blocked) element.setAttribute('aria-hidden', 'true');
    else if (original.ariaHidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', original.ariaHidden);
  }
  if (!active) backgroundStates.clear();
}

/** 弹窗和抽屉共同隔离背景；退出开始即释放焦点，动画不会延迟后续操作。 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layers.push(root);
    syncModalBackground();
    /** 首选显式自动聚焦的控件；无控件时落在模态根层。 */
    const focusFirst = () => {
      const elements = focusableElements(root);
      (elements.find((element) => element.hasAttribute('autofocus')) ?? elements[0] ?? root).focus({ preventScroll: true });
    };
    focusFirst();
    /** 仅最上层阻止程序性焦点穿透。 */
    const containFocus = (event: FocusEvent) => {
      if (layers.at(-1) === root && event.target instanceof Node && !root.contains(event.target)) focusFirst();
    };
    /** Tab 在可操作控件间循环，嵌套模态只处理一次。 */
    const containTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || layers.at(-1) !== root) return;
      const elements = focusableElements(root);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('focusin', containFocus);
    document.addEventListener('keydown', containTab, true);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', containTab, true);
      const wasTop = layers.at(-1) === root;
      const index = layers.indexOf(root);
      if (index >= 0) layers.splice(index, 1);
      syncModalBackground();
      if (wasTop && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
