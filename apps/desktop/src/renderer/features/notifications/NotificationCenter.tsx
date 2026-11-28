import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { formatZeusDateTime, formatTaskDeadline, type AutomationNotificationStatus, type CommandRunNotification } from '@zeus/shared';
import type { NotificationsModel } from './useNotifications.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import './notifications.css';

/** 没有具体异常时用结果说明补齐描述，不额外显示状态字段。 */
const notificationDescriptions: Record<AutomationNotificationStatus | CommandRunNotification['status'], [string, string]> = {
  awaiting_review: ['执行结果等待验收。', 'The result is awaiting review.'],
  succeeded: ['执行已完成。', 'The run has completed.'],
  failed: ['执行失败。', 'The run failed.'],
  blocked: ['执行受阻，等待处理。', 'The run is blocked and needs attention.'],
  cancelled: ['执行已取消。', 'The run was cancelled.'],
  outcome_unknown: ['执行结果尚未确认。', 'The result has not been confirmed.'],
  /** 命令超时保留独立结果说明。 */
  timed_out: ['执行已超时。', 'The run timed out.'],
};

/** 原生顶层弹层提供统一列表，正文导航与已读管理各自独立。 */
export function NotificationCenter({
  model,
  language,
  projects,
}: {
  /** 工作台持有统一通知和导航回执。 */
  model: NotificationsModel;
  /** 文案与应用语言一致。 */
  language: 'zh-CN' | 'en-US';
  /** 用项目名称解释各待处理项的归属。 */
  projects: readonly { id: string; name: string }[];
}) {
  /** 当前文案语言。 */
  const zh = language === 'zh-CN';
  /** 已读按钮只出现在未读视图，待处理视图按业务状态更新。 */
  const pending = model.filter.view === 'pending';
  /** 同一工作台的弹层身份保持稳定。 */
  const id = useId();
  /** 弹层开关用于可访问属性与定位。 */
  const [open, setOpen] = useState(false);
  /** 关闭后将焦点交还铃铛。 */
  const trigger = useRef<HTMLButtonElement>(null);
  /** 弹层继承主题，但不受侧栏滚动裁剪。 */
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  /** 外部点击和 Esc 由原生弹层处理。 */
  const surface = useRef<HTMLDivElement>(null);
  /** 跳转会把焦点交给目标页面或离开确认。 */
  const navigating = useRef(false);
  /** 导航取消或失败时，把焦点交还仍存在的原条目。 */
  const returnFocus = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    /** 系统摘要打开同一个列表，不自动确认任何未读。 */
    const showNotifications = () => surface.current?.showPopover();
    window.addEventListener('zeus:task-reminders:show', showNotifications);
    return () => window.removeEventListener('zeus:task-reminders:show', showNotifications);
  }, []);

  useLayoutEffect(() => {
    setPortalHost(trigger.current?.closest<HTMLElement>('.macos-ai-app.zeus-shell') ?? null);
  }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !surface.current) return;
    /** 以真实按钮位置适配侧栏宽度。 */
    const anchor = trigger.current;
    /** 原生顶层表面保留视口边距。 */
    const panel = surface.current;
    /** 布局变化时重新计算位置，不依赖通知内容高度。 */
    const position = () => {
      /** 每轮只读取按钮所需矩形。 */
      const rect = anchor.getBoundingClientRect();
      /** 窄窗和矮窗均保留最小边距。 */
      const top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 100));
      panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${top}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(520, window.innerHeight - top - 8))}px`;
    };
    position();
    /** 只观察标题宽度，避免列表与定位相互触发。 */
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
      <Button
        unstyled
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
      </Button>
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
                // 完整异常说明需要获得焦点，先让出顶层表面。
                if (event.target instanceof Element && event.target.closest('.application-error-details-link')) surface.current?.hidePopover();
              }}
              onToggle={(event) => {
                /** 展开仅刷新内容，不批量已读。 */
                const expanded = event.newState === 'open';
                setOpen(expanded);
                if (expanded) {
                  /** 刷新前返回原操作，已失效的条目则回到弹层。 */
                  const row = returnFocus.current;
                  returnFocus.current = null;
                  (row?.isConnected && !row.disabled ? row : event.currentTarget).focus({ preventScroll: true });
                  return model.refresh();
                }
                if (!navigating.current && !document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) trigger.current?.focus({ preventScroll: true });
                navigating.current = false;
              }}
            >
              <header className="automation-notification-header">
                <strong>{zh ? '通知' : 'Notifications'}</strong>
                {!pending && model.unreadCount > 0 ? (
                  <div className="automation-notification-header-actions">
                    <span>{zh ? `${model.unreadCount} 条未读` : `${model.unreadCount} unread`}</span>
                    <Button size="compact" disabled={Boolean(model.busyId)} busy={model.busyId === 'all'} onClick={() => model.markAllRead()}>
                      {zh ? '全部已读' : 'Mark all read'}
                    </Button>
                  </div>
                ) : null}
              </header>
              <div className="automation-notification-filters">
                <div className="automation-notification-views" role="group" aria-label={zh ? '通知视图' : 'Notification view'}>
                  <Button type="button" size="compact" variant={pending ? 'secondary' : 'primary'} aria-pressed={!pending} onClick={() => model.changeFilter({})}>
                    {zh ? '未读' : 'Unread'}
                  </Button>
                  <Button type="button" size="compact" variant={pending ? 'primary' : 'secondary'} aria-pressed={pending} onClick={() => model.changeFilter({ view: 'pending' })}>
                    {zh ? '待处理' : 'Needs attention'}
                  </Button>
                </div>
                {pending && projects.length > 0 ? (
                  <ZeusSelect
                    size="compact"
                    ariaLabel={zh ? '按项目筛选' : 'Filter by project'}
                    value={model.filter.projectId ?? ''}
                    options={[{ value: '', label: zh ? '全部项目' : 'All projects' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
                    onChange={(projectId) => model.changeFilter({ view: 'pending', ...(projectId ? { projectId } : {}) })}
                  />
                ) : null}
              </div>
              {model.loadError || model.actionError ? (
                <div className="automation-notification-error" role="alert">
                  <p>{model.actionError ?? model.loadError}</p>
                  {model.loadError ? (
                    <Button size="compact" disabled={model.loading} onClick={() => model.refresh()}>
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
                {model.loaded && !model.loading && !model.items.length && !model.loadError ? (
                  <p className="automation-notification-empty" role="status">
                    {pending ? (zh ? '暂无待处理事项' : 'Nothing needs attention') : zh ? '暂无未读通知' : 'No unread notifications'}
                  </p>
                ) : null}
                <ul>
                  {model.items.map((item) => {
                    /** 不同来源的相同业务身份仍是独立通知。 */
                    const key = `${item.source}:${item.id}`;
                    /** 标题沿用原对象名称，不展示技术来源分类。 */
                    const title = item.source !== 'automation' ? item.title : item.automationName;
                    /** 未读列表沿用原标题，待处理项显示来源项目供跨项目区分。 */
                    const project = pending ? projects.find((entry) => entry.id === item.projectId) : undefined;
                    /** 问题条目可先于项目目录加载，仍显示其真实归属。 */
                    const projectName = project?.name ?? (item.source === 'question' ? item.projectName : undefined);
                    /** 描述说明截止时间或执行结果，具体异常优先展示原有完整说明组件。 */
                    const description =
                      item.source === 'question'
                        ? item.excerpt
                        : item.source === 'git_delivery'
                          ? item.status === 'succeeded'
                            ? zh
                              ? '代码交付已完成'
                              : 'Code delivery completed'
                            : zh
                              ? '代码交付需要处理'
                              : 'Code delivery needs attention'
                          : item.source === 'task'
                            ? `${zh ? '截止时间：' : 'Due: '}${formatTaskDeadline(item.deadline)}`
                            : notificationDescriptions[item.status][zh ? 0 : 1];
                    /** 无会话异常不能伪装成可导航的标题。 */
                    const canOpen = item.source !== 'automation' || Boolean(item.conversationId);
                    /** 详情按钮是独立操作，普通说明可随标题一起导航。 */
                    const error = item.source === 'automation' && item.errorMessage ? { code: item.errorCode, message: item.errorMessage } : null;
                    /** 动作名称明确区分查看结果、处理交付和回答原问题。 */
                    const action = item.source === 'question' ? (zh ? '回答问题' : 'Answer question') : item.source === 'git_delivery' ? (zh ? '处理' : 'Resolve') : zh ? '查看' : 'Open';
                    /** 同一阅读区域用于可导航内容和无会话的异常。 */
                    const summary = (
                      <>
                        <span className="automation-notification-heading">
                          <strong>{projectName ? `${projectName} · ${title}` : title}</strong>
                          {pending && canOpen ? <span className="automation-notification-action-label">{action}</span> : null}
                          {!pending && item.source !== 'question' ? (
                            <time className="automation-notification-time" dateTime={item.occurredAt}>
                              {formatZeusDateTime(item.occurredAt, language, { dateStyle: 'short', timeStyle: 'short' })}
                            </time>
                          ) : null}
                        </span>
                        {error ? null : <span className="automation-notification-description">{description}</span>}
                      </>
                    );
                    return (
                      <li key={key} className="automation-notification-item">
                        <div className="automation-notification-item-header">
                          {canOpen ? (
                            <Button
                              unstyled
                              type="button"
                              className="automation-notification-open"
                              data-icon-tooltip={title}
                              disabled={Boolean(model.busyId)}
                              onClick={(event) => {
                                /** 失败后恢复当前行，避免要求键盘用户重新找通知。 */
                                const button = event.currentTarget;
                                // 导航确认弹窗需要正常焦点；取消导航时恢复通知列表。
                                navigating.current = true;
                                surface.current?.hidePopover();
                                return model.open(item).then((opened) => {
                                  if (!opened && surface.current?.isConnected) {
                                    navigating.current = false;
                                    returnFocus.current = button;
                                    surface.current.showPopover();
                                  }
                                });
                              }}
                            >
                              {summary}
                            </Button>
                          ) : (
                            <div className="automation-notification-summary">{summary}</div>
                          )}
                          {!pending && item.source !== 'question' ? (
                            <Button
                              size="compact"
                              className="automation-notification-read"
                              disabled={Boolean(model.busyId)}
                              busy={model.busyId === key}
                              aria-label={zh ? `将“${title}”标为已读` : `Mark “${title}” as read`}
                              data-icon-tooltip={zh ? '标为已读' : 'Mark as read'}
                              onClick={() => model.markRead(item)}
                            >
                              <CheckIcon size={16} aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                        {error ? (
                          <div className="automation-notification-description">
                            <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
                          </div>
                        ) : null}
                        {item.source === 'automation' && item.canResume ? (
                          <Button
                            size="compact"
                            className="automation-notification-resume"
                            disabled={Boolean(model.busyId)}
                            busy={model.busyId === `resume:${item.id}`}
                            aria-label={zh ? `恢复“${title}”的剩余项目` : `Resume remaining projects for ${title}`}
                            onClick={() => {
                              return model.resume(item).then((resumed) => {
                                if (resumed) surface.current?.focus({ preventScroll: true });
                              });
                            }}
                          >
                            {zh ? '恢复剩余项目' : 'Resume remaining projects'}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {model.nextCursor ? (
                <footer className="automation-notification-footer">
                  <Button size="compact" disabled={model.loading} busy={model.loading} onClick={() => model.refresh(model.nextCursor ?? undefined)}>
                    {zh ? '加载更多' : 'Load more'}
                  </Button>
                </footer>
              ) : null}
            </div>,
            portalHost,
          )
        : null}
    </>
  );
}
