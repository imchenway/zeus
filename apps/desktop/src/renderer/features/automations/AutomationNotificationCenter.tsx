import { formatTaskDeadline } from '@zeus/shared';
import type { TaskRemindersModel } from '../tasks/useTaskReminders.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
export function AutomationNotificationCenter({
  model,
  tasks,
  language,
}: {
  /** 工作台持有自动化通知状态。 */ model: AutomationNotificationsModel;
  /** 任务提醒共用铃铛，业务确认独立。 */ tasks?: TaskRemindersModel;
  /** 应用当前语言。 */ language: 'zh-CN' | 'en-US';
}) {
  /** 当前文案语言。 */
  const zh = language === 'zh-CN';
  /** 两类通知共用入口和总数，保留各自的操作含义。 */
  const [category, setCategory] = useState<'automation' | 'tasks'>('automation');
  /** 铃铛数字覆盖所有分类。 */
  const totalUnread = model.unreadCount + (tasks?.unreadCount ?? 0);
  /** 恢复会继续原运行并重新启用规则，不能暗示只是查看或确认通知。 */
  const resumeDescription = zh
    ? '请先处理失败原因。恢复后继续本次尚未启动的项目，已启动的项目会先核对已有结果，不会重复启动；同时重新启用后续自动化排程。'
    : 'Resolve the failure first. Resume the projects not yet started in this run. Existing work is checked without starting it again. Future scheduled runs are also re-enabled.';
  /** 每个工作台的弹层身份保持独立。 */
  const id = useId();
  /** 原生弹层的开关状态用于可访问属性和定位。 */
  const [open, setOpen] = useState(false);
  /** 关闭后返回铃铛，避免焦点落到页面根节点。 */
  const trigger = useRef<HTMLButtonElement>(null);
  /** 弹层挂在当前主题壳层，隔离侧栏导航样式并继承颜色。 */
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  /** 原生弹层负责顶层显示和外部点击关闭。 */
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /** 系统摘要打开任务分类，不把任何通知自动标为已读。 */
    const showTasks = () => {
      setCategory('tasks');
      surface.current?.showPopover();
    };
    window.addEventListener('zeus:task-reminders:show', showTasks);
    return () => window.removeEventListener('zeus:task-reminders:show', showTasks);
  }, []);

  useLayoutEffect(() => {
    setPortalHost(trigger.current?.closest<HTMLElement>('.macos-ai-app.zeus-shell') ?? null);
  }, []);

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
        aria-label={zh ? `通知，${totalUnread} 条未读` : `Notifications, ${totalUnread} unread`}
        data-icon-tooltip={zh ? '通知' : 'Notifications'}
      >
        <BellIcon size={20} weight="regular" aria-hidden="true" />
        {totalUnread > 0 ? (
          <span className="automation-notification-badge" aria-hidden="true">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        ) : null}
      </button>
      {portalHost
        ? createPortal(
            <div
              id={id}
              ref={surface}
              popover="auto"
              role="dialog"
              tabIndex={-1}
              aria-label={zh ? '通知中心' : 'Notifications'}
              className="automation-notification-popover"
              onClickCapture={(event) => {
                // 打开完整异常说明前让出顶层，避免通知遮住说明窗口。
                if (event.target instanceof Element && event.target.closest('.application-error-details-link')) surface.current?.hidePopover();
              }}
              onToggle={(event) => {
                /** 弹出仅刷新列表，不提交任何已读确认。 */
                const expanded = event.newState === 'open';
                setOpen(expanded);
                if (expanded) {
                  void model.refresh();
                  void tasks?.refresh();
                } else if (!document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) trigger.current?.focus({ preventScroll: true });
              }}
            >
              <header className="automation-notification-header">
                <strong>{zh ? '通知' : 'Notifications'}</strong>
                <div className="automation-notification-header-actions">
                  <span>{zh ? `${totalUnread} 条未读` : `${totalUnread} unread`}</span>
                  <Button
                    size="compact"
                    disabled={category === 'tasks' ? !tasks?.unreadCount || Boolean(tasks.busyId) : !model.unreadCount || Boolean(model.busyId)}
                    busy={category === 'tasks' ? tasks?.busyId === 'all' : model.busyId === 'all'}
                    onClick={() => {
                      if (category === 'tasks') void tasks?.markAllRead();
                      else void model.markAllRead();
                    }}
                  >
                    {zh ? '本类全部已读' : 'Mark category read'}
                  </Button>
                </div>
              </header>
              {tasks ? (
                <div className="automation-notification-actions" role="group" aria-label={zh ? '通知分类' : 'Notification categories'}>
                  <Button size="compact" variant="secondary" aria-pressed={category === 'automation'} onClick={() => setCategory('automation')}>
                    {zh ? '自动化' : 'Automations'} ({model.unreadCount})
                  </Button>
                  <Button size="compact" variant="secondary" aria-pressed={category === 'tasks'} onClick={() => setCategory('tasks')}>
                    {zh ? '任务提醒' : 'Task reminders'} ({tasks.unreadCount})
                  </Button>
                </div>
              ) : null}
              {category === 'tasks' && tasks ? (
                <>
                  {tasks.error ? (
                    <div role="alert" className="automation-notification-reason">
                      <VisibleApplicationError error={tasks.error} language={zh ? 'zh-CN' : 'en'} />
                      <Button size="compact" variant="secondary" onClick={() => void tasks.refresh()}>
                        {zh ? '重试' : 'Retry'}
                      </Button>
                    </div>
                  ) : null}
                  <div className="automation-notification-list" aria-busy={tasks.loading}>
                    {tasks.loading && !tasks.loaded ? <p role="status">{zh ? '正在加载提醒…' : 'Loading reminders…'}</p> : null}
                    {tasks.loaded && !tasks.items.length && !tasks.error ? <p className="automation-notification-empty">{zh ? '暂无未读任务提醒' : 'No unread task reminders'}</p> : null}
                    <ul>
                      {tasks.items.map((item) => (
                        <li key={item.id} className="automation-notification-item">
                          <button
                            type="button"
                            className="automation-notification-open"
                            disabled={Boolean(tasks.busyId)}
                            onClick={() => {
                              surface.current?.hidePopover();
                              void tasks.open(item).then((opened) => {
                                if (!opened) surface.current?.showPopover();
                              });
                            }}
                          >
                            <strong>{item.title}</strong>
                            <span>{formatTaskDeadline(item.deadline)}</span>
                          </button>
                          <div className="automation-notification-meta">
                            <span>{item.projectName}</span>
                            <time dateTime={item.occurredAt}>{new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.occurredAt))}</time>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {tasks.nextCursor ? (
                    <footer className="automation-notification-footer">
                      <Button size="compact" disabled={tasks.loading} busy={tasks.loading} onClick={() => void tasks.refresh(tasks.nextCursor ?? undefined)}>
                        {zh ? '加载更多' : 'Load more'}
                      </Button>
                    </footer>
                  ) : null}
                </>
              ) : (
                <>
                  {model.loadError || model.actionError ? (
                    <div className="automation-notification-error" role="alert">
                      <p>{model.actionError ?? model.loadError}</p>
                      {model.loadError ? (
                        <Button size="compact" disabled={model.loading} onClick={() => void model.refresh()}>
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
                              title={`${item.automationName}\n${item.conversationTitle || (zh ? '打开会话' : 'Open conversation')}`}
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
                              {item.conversationTitle && item.conversationTitle !== item.automationName ? <span>{item.conversationTitle}</span> : null}
                            </button>
                          ) : (
                            <div className="automation-notification-summary">
                              <strong title={item.automationName}>{item.automationName}</strong>
                              <span>{zh ? '无可用会话' : 'No available conversation'}</span>
                            </div>
                          )}
                          <div className="automation-notification-meta">
                            <span className="automation-notification-project" title={item.projectName || (zh ? '无项目' : 'No project')}>
                              {item.projectName || (zh ? '无项目' : 'No project')}
                            </span>
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
                                <Button size="compact" disabled={Boolean(model.busyId)} busy={model.busyId === item.id} onClick={() => void model.act(item, 'read')}>
                                  {zh ? '标为已读' : 'Mark read'}
                                </Button>
                              ) : null}
                              {item.canResume ? (
                                <Button size="compact" disabled={Boolean(model.busyId)} title={resumeDescription} aria-description={resumeDescription} onClick={() => void model.act(item, 'resume')}>
                                  {zh ? '恢复自动化' : 'Resume automation'}
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
                      <Button size="compact" disabled={model.loading} busy={model.loading} onClick={() => void model.refresh(model.nextCursor ?? undefined)}>
                        {zh ? '加载更多' : 'Load more'}
                      </Button>
                    </footer>
                  ) : null}
                </>
              )}
            </div>,
            portalHost,
          )
        : null}
    </>
  );
}
