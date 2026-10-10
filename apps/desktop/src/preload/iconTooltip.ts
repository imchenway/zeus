/** 图标提示的共享样式；网页评论在自己的 ShadowRoot 内复用，并沿用应用主题或系统明暗色。 */
export const iconTooltipStyles = `
.zeus-icon-tooltip {
  background: var(--zeus-product-panel, light-dark(#fff, #202124));
  border: 1px solid var(--zeus-product-line, light-dark(#dedee3, #48484e));
  border-radius: 7px; box-shadow: 0 6px 20px rgb(0 0 0 / 16%); box-sizing: border-box;
  color: var(--zeus-product-text, light-dark(#202124, #f1f1f3));
  font: 500 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  width: max-content; max-width: min(300px, calc(100vw - 16px)); padding: 6px 9px;
  position: fixed; inset: auto; margin: 0; white-space: normal; z-index: 2147483647;
  pointer-events: auto; overflow-wrap: anywhere;
}
[data-icon-tooltip]:disabled { pointer-events: auto; }
@media (forced-colors: active) {
  .zeus-icon-tooltip { background: Canvas; border-color: CanvasText; color: CanvasText; }
}`;

/** 在页面或评论 ShadowRoot 内管理明确标记的图标提示，不增加包裹层或逐按钮监听。 */
export function installIconTooltips(root: Document | ShadowRoot): () => void {
  /** 提示只访问触发控件所属的文档。 */
  const document = root.ownerDocument ?? (root as Document);
  /** 当前窗口提供视口尺寸与窗口事件。 */
  const window = document.defaultView!;
  /** 样式只注入当前根，避免污染被评论的网页。 */
  const style = document.createElement('style');
  style.textContent = iconTooltipStyles;
  (root instanceof Document ? root.head : root).append(style);
  /** 一个根内只显示一个提示，并关联到实际控件。 */
  const tooltip = document.createElement('span');
  tooltip.id = `zeus-icon-tooltip-${window.crypto.randomUUID()}`;
  tooltip.className = 'zeus-icon-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('popover', 'manual');
  /** 当前触发器包括工具栏的包裹层和直接标记的按钮。 */
  let active: HTMLElement | null = null;
  /** 无障碍说明挂在实际可聚焦控件上。 */
  let described: HTMLElement | null = null;
  /** 鼠标所属触发器用于判断失焦后是否继续显示。 */
  let hovered: HTMLElement | null = null;
  /** 鼠标跨过图标与气泡的间隙时短暂保留，便于移入气泡阅读。 */
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 只在提示显示时观察文案变化和控件移除。 */
  const observer = new MutationObserver(() => {
    if (!active?.isConnected || !active.getAttribute('data-icon-tooltip')) hide();
    else update();
  });

  /** 关闭提示并保留其他功能建立的说明。 */
  function hide(): void {
    clearTimeout(leaveTimer);
    observer.disconnect();
    if (described) {
      /** 其他功能的说明仍然保留。 */
      const remaining = described
        .getAttribute('aria-describedby')
        ?.split(/\s+/u)
        .filter((id) => id !== tooltip.id)
        .join(' ');
      if (remaining) described.setAttribute('aria-describedby', remaining);
      else described.removeAttribute('aria-describedby');
    }
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    tooltip.remove();
    active = null;
    described = null;
  }

  /** 实测尺寸后限制窗口边界；优先上方，顶部不足时改到下方。 */
  function update(): void {
    if (!active) return;
    /** 只在文案变化时写入，避免观察器重复触发。 */
    const label = active.getAttribute('data-icon-tooltip') ?? '';
    if (tooltip.textContent !== label) tooltip.textContent = label;
    /** 提示与图标之间留出八像素。 */
    const margin = 8;
    /** 当前触发器在视口中的位置。 */
    const triggerRect = active.getBoundingClientRect();
    /** 文案换行后的实际尺寸。 */
    const tooltipRect = tooltip.getBoundingClientRect();
    /** 优先采用上方位置。 */
    const above = triggerRect.top - tooltipRect.height - margin;
    tooltip.style.left = `${Math.max(margin, Math.min(triggerRect.left + (triggerRect.width - tooltipRect.width) / 2, window.innerWidth - tooltipRect.width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(above >= margin ? above : triggerRect.bottom + margin, window.innerHeight - tooltipRect.height - margin))}px`;
  }

  /** 提示跟随当前模态或菜单，并使用顶层浮层避免裁切。 */
  function show(trigger: HTMLElement): void {
    if (!trigger.getAttribute('data-icon-tooltip')) return;
    clearTimeout(leaveTimer);
    if (active === trigger) {
      update();
      return;
    }
    hide();
    active = trigger;
    described = trigger.matches('button, input, select, [tabindex]') ? trigger : trigger.querySelector<HTMLElement>('button, input, select, [tabindex]');
    /** 原有说明和当前提示共同关联控件。 */
    const description = described?.getAttribute('aria-describedby');
    described?.setAttribute('aria-describedby', [description, tooltip.id].filter(Boolean).join(' '));
    /** 保持在当前焦点隔离范围内，避免模态打开时说明变成 inert。 */
    const host = trigger.closest(':popover-open, .macos-ai-app') ?? (root instanceof Document ? root.body : root);
    host.append(tooltip);
    tooltip.showPopover();
    update();
    observer.observe(root, { childList: true, subtree: true });
    observer.observe(trigger, { attributes: true, attributeFilter: ['data-icon-tooltip'] });
  }

  /** 事件路径支持 SVG 和 ShadowRoot 内动态生成的控件。 */
  function triggerFor(event: Event): HTMLElement | null {
    for (const node of event.composedPath()) {
      if (node instanceof HTMLElement && node.hasAttribute('data-icon-tooltip')) return node;
    }
    return null;
  }

  /** 鼠标进入图标时显示；进入气泡后保持，触摸不触发。 */
  function enter(event: Event): void {
    clearTimeout(leaveTimer);
    if ((event as PointerEvent).pointerType === 'touch') return;
    if (event.composedPath().includes(tooltip)) {
      hovered = active;
      return;
    }
    hovered = triggerFor(event);
    if (hovered) show(hovered);
    else if (!described?.matches(':focus-visible')) leaveTimer = setTimeout(hide, 200);
  }

  /** 鼠标离开控件和气泡后关闭，键盘焦点仍在时保留。 */
  function leave(event: Event): void {
    clearTimeout(leaveTimer);
    /** 下一步目标可以是图标内部节点或提示文字。 */
    const next = (event as PointerEvent).relatedTarget;
    if (next instanceof Node && (active?.contains(next) || tooltip.contains(next))) return;
    hovered = null;
    if (!described?.matches(':focus-visible')) leaveTimer = setTimeout(hide, 200);
  }

  /** 键盘聚焦显示，鼠标点击产生的焦点不会重新打开提示。 */
  function focus(event: Event): void {
    /** 聚焦节点可能是图标内部的选择框。 */
    const trigger = triggerFor(event);
    if (trigger && event.target instanceof HTMLElement && event.target.matches(':focus-visible')) show(trigger);
  }

  /** 焦点离开后，仅在鼠标仍悬停时保留提示。 */
  function blur(): void {
    if (hovered !== active) hide();
  }

  /** Tab 自动滚入视口后重新定位；鼠标滚动或控件已离开视口时关闭。 */
  function scroll(): void {
    if (active && described?.matches(':focus-visible')) {
      /** 聚焦控件仍可见时保留说明，避免自动滚动立即吞掉键盘提示。 */
      const rect = active.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
        update();
        return;
      }
    }
    hide();
  }

  /** Escape 只关闭已显示的提示，避免同次按键继续关闭模态或操作会话。 */
  function keydown(event: Event): void {
    if ((event as KeyboardEvent).key !== 'Escape' || !active) return;
    event.preventDefault();
    event.stopPropagation();
    hide();
  }

  root.addEventListener('pointerover', enter, true);
  root.addEventListener('pointerout', leave, true);
  root.addEventListener('focusin', focus, true);
  root.addEventListener('focusout', blur, true);
  root.addEventListener('keydown', keydown, true);
  root.addEventListener('click', hide, true);
  root.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  /** 页面退出时释放提示和全部监听。 */
  return () => {
    hide();
    style.remove();
    root.removeEventListener('pointerover', enter, true);
    root.removeEventListener('pointerout', leave, true);
    root.removeEventListener('focusin', focus, true);
    root.removeEventListener('focusout', blur, true);
    root.removeEventListener('keydown', keydown, true);
    root.removeEventListener('click', hide, true);
    root.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', hide);
    window.removeEventListener('blur', hide);
  };
}
