import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from 'react';
import { PopoverSurface, usePresenceSurface } from './MotionPresence.js';

/** 菜单层级决定 Esc、方向键和外部点击的归属。 */
const activeMenus: HTMLElement[] = [];

/** 右键菜单与操作菜单共用定位、关闭、键盘和退出反馈。 */
export function MenuSurface({ onClose, ref: forwardedRef, ...props }: HTMLAttributes<HTMLDivElement> & { onClose: () => void; ref?: RefObject<HTMLDivElement | null> }) {
  /** 定位、焦点与动画共用真实表面。 */
  const localRef = useRef<HTMLDivElement>(null);
  const ref = forwardedRef ?? localRef;
  /** 回调更新不重置当前键盘选项。 */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** 退出期间移除事件监听，避免旧菜单消费后续操作。 */
  const open = usePresenceSurface(ref);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    /** 按实际尺寸贴合窗口边缘，不使用预估菜单高度。 */
    const bounds = element.getBoundingClientRect();
    if (typeof props.style?.left === 'number') element.style.left = `${Math.max(8, Math.min(props.style.left, window.innerWidth - bounds.width - 8))}px`;
    if (typeof props.style?.top === 'number') element.style.top = `${Math.max(8, Math.min(props.style.top, window.innerHeight - bounds.height - 8))}px`;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeMenus.push(element);
    /** 禁用项不可被方向键或首次聚焦选中。 */
    const items = () => [...element.querySelectorAll<HTMLElement>(':is([role="menuitem"], button):not(:disabled):not([aria-disabled="true"])')].filter((item) => item.checkVisibility() && !item.closest('[inert]'));
    items()[0]?.focus({ preventScroll: true });
    /** 点在菜单外即关闭，保留该次点击原本要执行的动作。 */
    const outside = (event: Event) => {
      if (activeMenus.at(-1) === element && !element.contains(event.target as Node)) closeRef.current();
    };
    /** 页面滚动或尺寸变化后关闭旧定位，菜单内滚动不关闭。 */
    const resized = () => closeRef.current();
    /** 只处理最上层菜单，防止 Esc 同时关闭其后的弹窗。 */
    const keydown = (event: KeyboardEvent) => {
      if (activeMenus.at(-1) !== element || event.defaultPrevented) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === 'Tab') {
          /** 菜单收起后继续正常的前后焦点顺序，避免 Tab 被困在触发器上。 */
          const candidates = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')].filter(
            (candidate) => candidate.tabIndex >= 0 && candidate.checkVisibility() && !candidate.matches(':disabled, [aria-disabled="true"]') && !candidate.closest('[inert]') && !element.contains(candidate),
          );
          const current = previous ? candidates.indexOf(previous) : -1;
          const next = (current + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length;
          candidates[next]?.focus({ preventScroll: true });
        }
        closeRef.current();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const options = items();
        const current = options.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', resized);
      const index = activeMenus.indexOf(element);
      if (index >= 0) activeMenus.splice(index, 1);
      if (element.contains(document.activeElement) && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, [open, ref, props.style?.left, props.style?.top]);
  return <PopoverSurface {...props} ref={ref} role="menu" data-zeus-primitive="menu" />;
}
