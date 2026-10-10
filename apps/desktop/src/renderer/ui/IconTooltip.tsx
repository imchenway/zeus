import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 为图标控件显示可见提示；禁用时仍可悬停，键盘聚焦和 Escape 同样可用。 */
export function IconTooltip(props: { label: string; children: ReactNode }) {
  /** 提示与内部按钮共享无障碍说明。 */
  const tooltipId = `zeus-icon-tooltip-${useId().replaceAll(':', '')}`;
  /** 外层保留原按钮尺寸，并接收禁用按钮周围的鼠标事件。 */
  const triggerRef = useRef<HTMLSpanElement>(null);
  /** 实际提示尺寸用于限制窗口边缘的位置。 */
  const tooltipRef = useRef<HTMLSpanElement>(null);
  /** 提示只在悬停或键盘聚焦时显示。 */
  const [open, setOpen] = useState(false);
  /** 固定位置避免输入框的滚动和容器裁切提示。 */
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  /** 与共享选择框一致，portal 挂在应用壳层以继承主题。 */
  const portalHost = typeof document === 'undefined' ? null : (triggerRef.current?.closest('.macos-ai-app') ?? document.body);

  // 绘制前定位提示并建立按钮说明，避免先显示错误位置。
  useLayoutEffect(() => {
    if (!open) return;
    /** 当前触发器和真实提示必须同时存在才能定位。 */
    const trigger = triggerRef.current;
    /** 提示已经挂载，直接测量最终文案。 */
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    /** 视口边缘和图标之间各保留八像素。 */
    const margin = 8;
    /** 触发器在窗口中的真实位置。 */
    const triggerRect = trigger.getBoundingClientRect();
    /** 长文案换行后的实际提示尺寸。 */
    const tooltipRect = tooltip.getBoundingClientRect();
    /** 优先在图标上方显示，顶部空间不足时移到下方。 */
    const above = triggerRect.top - tooltipRect.height - margin;
    setPosition({
      left: Math.max(margin, Math.min(triggerRect.left + (triggerRect.width - tooltipRect.width) / 2, window.innerWidth - tooltipRect.width - margin)),
      top: above >= margin ? above : Math.max(margin, Math.min(triggerRect.bottom + margin, window.innerHeight - tooltipRect.height - margin)),
    });
    /** 说明关联到按钮，保留控件本身已有的说明。 */
    const button = trigger.querySelector('button');
    button?.setAttribute('aria-describedby', [button.getAttribute('aria-describedby'), tooltipId].filter(Boolean).join(' '));
    return () => {
      /** 退出时仅移除本提示，其他说明不受影响。 */
      const remaining = button
        ?.getAttribute('aria-describedby')
        ?.split(' ')
        .filter((id) => id !== tooltipId)
        .join(' ');
      if (remaining) button?.setAttribute('aria-describedby', remaining);
      else button?.removeAttribute('aria-describedby');
    };
  }, [open, props.label, tooltipId]);

  // 仅在提示打开时监听关闭动作，并在退出时移除监听。
  useEffect(() => {
    if (!open) return;
    /** Escape 先关闭提示，避免同时触发会话停止或退出输入。 */
    function dismissWithEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    /** 窗口或滚动位置改变后关闭提示，避免显示过期位置。 */
    function dismiss(): void {
      setOpen(false);
    }
    document.addEventListener('keydown', dismissWithEscape, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      // 释放本提示注册的监听，避免影响后续控件。
      document.removeEventListener('keydown', dismissWithEscape, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open]);

  return (
    <span
      ref={triggerRef}
      className="zeus-icon-tooltip-trigger"
      onPointerEnter={(event) => {
        // 菜单的 portal 事件不能重新打开图标提示。
        if (event.pointerType !== 'touch' && event.target instanceof Node && event.currentTarget.contains(event.target)) setOpen(true);
      }}
      onPointerLeave={(event) => {
        // 键盘仍聚焦按钮时保留说明，否则随鼠标离开关闭。
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={(event) => {
        // 只响应触发器内部的键盘聚焦，不响应外部菜单。
        if (event.currentTarget.contains(event.target)) setOpen(true);
      }}
      onBlur={(event) => {
        // 焦点离开触发器后关闭，内部焦点移动继续保留。
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onClickCapture={() => {
        // 点击先关闭提示，让菜单和目标输入继续处理原有操作。
        setOpen(false);
      }}
    >
      {props.children}
      {open && portalHost
        ? createPortal(
            <span ref={tooltipRef} id={tooltipId} className="zeus-icon-tooltip" role="tooltip" style={position ?? { visibility: 'hidden' }}>
              {props.label}
            </span>,
            portalHost,
          )
        : null}
    </span>
  );
}
