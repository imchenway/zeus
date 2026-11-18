/** 原生子视图无法由网页层叠顺序遮挡，需要跟随这些应用浮层。 */
export const nativeViewportOverlaySelector = '[data-motion-surface="popover"], [data-zeus-primitive="modal"], [data-zeus-primitive="drawer"], [data-zeus-primitive="overlay"]';

/** 前台对话框与实际覆盖正文的菜单会临时接管原生视图区域。 */
export function nativeViewportOccluded(viewport: HTMLElement, popovers: Iterable<HTMLElement>): boolean {
  /** 退出分栏的 DOM 已停止交互，原生画面仍随剩余宽度收拢。 */
  if (viewport.closest('[hidden], [inert]:not([data-native-viewport-transition="true"])')) return true;
  if ([...viewport.ownerDocument.body.querySelectorAll(':scope > :is([data-zeus-primitive="modal"], [data-zeus-primitive="drawer"]):is(:not([inert]), [data-motion-state="closing"])')].some((surface) => !surface.contains(viewport)))
    return true;
  const bounds = viewport.getBoundingClientRect();
  return Array.from(popovers).some((surface) => {
    if (surface.closest('[inert]') && surface.dataset.motionState !== 'closing') return false;
    const rect = surface.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top;
  });
}

/** 原生表面只需响应影响遮挡的 DOM 变化。 */
export function nativeViewportOverlaysChanged(records: MutationRecord[], viewport: HTMLElement): boolean {
  return records.some((record) => {
    if (record.type === 'attributes') {
      if (record.target.nodeType !== 1) return false;
      const surface = record.target as Element;
      return surface.matches(nativeViewportOverlaySelector) || ((record.attributeName === 'hidden' || record.attributeName === 'inert') && surface.contains(viewport));
    }
    return [...record.addedNodes, ...record.removedNodes].some((node) => {
      if (node.nodeType !== 1) return false;
      const surface = node as Element;
      return surface.matches(nativeViewportOverlaySelector) || surface.querySelector(nativeViewportOverlaySelector);
    });
  });
}

/** 浮层的绘制表面用于判断覆盖，不使用无尺寸的门户容器。 */
export const nativeViewportPopoverSelector = '[data-motion-surface="popover"], [data-zeus-primitive="overlay"]';
