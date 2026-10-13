import { useId, useLayoutEffect, useRef, useState } from 'react';
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import type { AutomationNotificationStatus } from '@zeus/shared';
import type { AutomationNotificationsModel } from './useAutomationNotifications.js';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import './automationNotifications.css';

/** 两种应用语言使用同一组状态语义。 */
const notificationStatusLabels: Record<AutomationNotificationStatus, [string, string]> = {
  awaiting_review: ['待验收', 'Awaiting review'],
  succeeded: ['已完成', 'Completed'],
  failed: ['失败', 'Failed'],
  blocked: ['等待处理', 'Needs attention'],
  cancelled: ['已取消', 'Cancelled'],
  outcome_unknown: ['结果未知', 'Unknown result'],
};

/** 通知使用原生弹层处理外部点击和 Esc，顶层显示不受侧栏裁剪。 */
export function AutomationNotificationCenter({ model, language }: { /** 工作台持有通知状态。 */ model: AutomationNotificationsModel; /** 应用当前语言。 */ language: 'zh-CN' | 'en-US' }) {
  /** 当前文案语言。 */
  const zh = language === 'zh-CN';
  /** 每个工作台的弹层身份保持独立。 */
  const id = useId();
  /** 原生弹层的开关状态用于可访问属性和定位。 */
  const [open, setOpen] = useState(false);
  /** 关闭后返回铃铛，避免焦点落到页面根节点。 */
  const trigger = useRef<HTMLButtonElement>(null);
  /** 顶层弹层仍留在主题容器内继承颜色。 */
  const surface = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !surface.current) return;
    /** 使用真实按钮位置，侧栏拖动宽度时同步调整。 */
    const anchor = trigger.current;
    /** 原生顶层表面不会被源列表的 overflow 裁剪。 */
    const panel = surface.current;
    /** 保留视口边距，窄窗口也不产生横向溢出。 */
    const position = () => {
      /** 每次只读取定位所需的矩形。 */
      const rect = anchor.getBoundingClientRect();
      /** 默认在按钮下方，视口空间不足时保留至少顶部边距。 */
      const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 100));
      panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${top}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(520, window.innerHeight - top - 8))}px`;
    };
    position();
    panel.focus({ preventScroll: true });
    /** 只观察侧栏标题宽度，列表内容变化不会形成尺寸观察循环。 */
    const observer = new ResizeObserver(position);
    observer.observe(anchor.parentElement ?? anchor);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="automation-notification-trigger"
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={zh ? `通知，${model.unreadCount} 条未读` : `Notifications, ${model.unreadCount} unread`}
        data-icon-tooltip={zh ? '通知' : 'Notifications'}
      >
        <BellIcon size={20} weight="regular" aria-hidden="true" />
        {model.unreadCount > 0 ? (
          <span className="automation-notification-badge" aria-hidden="true">
            {model.unreadCount > 99 ? '99+' : model.unreadCount}
          </span>
        ) : null}
      </button>
      <div
        id={id}
        ref={surface}
        popover="auto"
        role="dialog"
        tabIndex={-1}
        aria-label={zh ? '自动化通知' : 'Automation notifications'}
        className="automation-notification-popover"
        onToggle={(event) => {
          /** 弹出仅刷新列表，不提交任何已读确认。 */
          const expanded = event.newState === 'open';
          setOpen(expanded);
          if (expanded) void model.refresh();
          else if (!document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) trigger.current?.focus({ preventScroll: true });
        }}
      >
        <header className="automation-notification-header">
          <strong>{zh ? '通知' : 'Notifications'}</strong>
          <span>{zh ? `${model.unreadCount} 条未读` : `${model.unreadCount} unread`}</span>
        </header>
        {model.loadError || model.actionError ? (
          <div className="automation-notification-error" role="alert">
            <p>{model.actionError ?? model.loadError}</p>
            {model.loadError ? (
              <Button disabled={model.loading} onClick={() => void model.refresh()}>
                {zh ? '重新加载' : 'Reload'}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="automation-notification-list" aria-busy={model.loading}>
          {!model.loaded && !model.loadError ? (
            <p className="automation-notification-empty" role="status">
              {zh ? '正在读取通知…' : 'Loading notifications…'}
            </p>
          ) : null}
          {model.loaded && !model.items.length && !model.loadError ? (
            <p className="automation-notification-empty" role="status">
              {zh ? '暂无未读通知' : 'No unread notifications'}
            </p>
          ) : null}
          <ul>
            {model.items.map((item) => (
              <li key={item.id} className="automation-notification-item">
                {item.conversationId ? (
                  <button
                    type="button"
                    className="automation-notification-open"
                    disabled={Boolean(model.busyId)}
                    onClick={() => {
                      // 先让出顶层表面，导航途中的未保存确认弹窗才能获得正常焦点。
                      surface.current?.hidePopover();
                      void model.open(item).then((opened) => {
                        if (!opened && surface.current?.isConnected) surface.current.showPopover();
                      });
                    }}
                  >
                    <strong>{item.automationName}</strong>
                    <span>{item.conversationTitle || (zh ? '打开会话' : 'Open conversation')}</span>
                  </button>
                ) : (
                  <div className="automation-notification-summary">
                    <strong>{item.automationName}</strong>
                    <span>{zh ? '无可用会话' : 'No available conversation'}</span>
                  </div>
                )}
                <div className="automation-notification-meta">
                  <span>{item.projectName || (zh ? '无项目' : 'No project')}</span>
                  <span>{notificationStatusLabels[item.status][zh ? 0 : 1]}</span>
                  <time dateTime={item.occurredAt}>{new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.occurredAt))}</time>
                </div>
                {item.errorMessage ? (
                  <p className="automation-notification-reason">
                    <VisibleApplicationError error={{ code: item.errorCode, message: item.errorMessage }} language={zh ? 'zh-CN' : 'en'} />
                  </p>
                ) : null}
                {!item.conversationId || item.canResume ? (
                  <div className="automation-notification-actions">
                    {!item.conversationId ? (
                      <Button disabled={Boolean(model.busyId)} busy={model.busyId === item.id} onClick={() => void model.act(item, 'read')}>
                        {zh ? '标为已读' : 'Mark read'}
                      </Button>
                    ) : null}
                    {item.canResume ? (
                      <Button disabled={Boolean(model.busyId)} onClick={() => void model.act(item, 'resume')}>
                        {zh ? '继续剩余项目' : 'Resume remaining projects'}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
        {model.nextCursor ? (
          <footer className="automation-notification-footer">
            <Button disabled={model.loading} busy={model.loading} onClick={() => void model.refresh(model.nextCursor ?? undefined)}>
              {zh ? '加载更多' : 'Load more'}
            </Button>
          </footer>
        ) : null}
      </div>
    </>
  );
}
