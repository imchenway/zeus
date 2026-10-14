import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationNotification, NotificationItem, TaskReminder } from '@zeus/shared';
import type { DashboardClient } from '../../apiClient.js';
import type { WorkspacePageProps } from '../workspace/workspaceContracts.js';
import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';

/** 两类通知共享列表和操作状态，导航后仍等待准确内容可见再确认。 */
export function useNotifications(input: {
  /** 复用已认证的命令客户端。 */
  client: DashboardClient | null;
  /** 所有通知共享已有实时连接。 */
  subscribe: WorkspacePageProps['onSubscribeRealtimeEvents'];
  /** 文案与应用语言保持一致。 */
  language: 'zh-CN' | 'en-US';
  /** 当前真实会话身份，不使用导航占位身份。 */
  visibleConversationId: string | null;
  /** 项目身份用于阻止跨项目误确认。 */
  visibleProjectId: string | null;
  /** 主窗口在前台且最新正文确实可见。 */
  contentVisible: boolean;
  /** 实际显示的任务详情身份。 */
  visibleTaskId: string | null;
  /** 任务详情的真实项目，独立于会话选中状态。 */
  visibleTaskProjectId: string | null;
  /** 工作台在前台且准确任务详情已经加载。 */
  taskContentVisible: boolean;
  /** 复用工作台现有离开确认与会话导航，取消返回 false。 */
  onOpenConversation(item: AutomationNotification): Promise<boolean>;
  /** 复用已有任务导航和未保存草稿保护。 */
  onOpenTask(item: TaskReminder): Promise<void>;
}) {
  /** 当前客户端和语言决定刷新函数的生命周期。 */
  const { client, subscribe, language } = input;
  /** 列表只展示未读记录。 */
  const [items, setItems] = useState<NotificationItem[]>([]);
  /** 全量数量由服务端返回，不从本页推算。 */
  const [unreadCount, setUnreadCount] = useState(0);
  /** 下一页使用服务端稳定游标。 */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** 首次读取前避免显示假的空列表。 */
  const [loaded, setLoaded] = useState(false);
  /** 刷新和加载更多共用一个请求指示。 */
  const [loading, setLoading] = useState(false);
  /** 查询失败不会丢弃已经显示的内容。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 操作失败与后台刷新错误分开保存，防止错误被实时事件抹掉。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 同一时间只处理一个用户操作。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 成功导航仍需等待正文的可见回执。 */
  const [pendingRead, setPendingRead] = useState<NotificationItem | null>(null);
  /** 旧查询响应不能覆盖后来的实时刷新或客户端切换。 */
  const queryRevision = useRef(0);
  /** 同步锁在 React 重渲染前也能阻止重复请求。 */
  const actionInFlight = useRef(false);
  /** 正文回执可能连续渲染，确认写入只提交一次。 */
  const readInFlight = useRef<string | null>(null);

  /** 首次或重新展开查询最新一页，加载更多才追加。 */
  const refresh = useCallback(
    async (cursor?: string): Promise<void> => {
      if (!client) return;
      /** 每次请求冻结代次，只接纳最新响应。 */
      const revision = ++queryRevision.current;
      setLoading(true);
      setLoadError(null);
      try {
        /** 数据库投影在接口内补齐，Renderer 不从事件猜测未读数量。 */
        const page = await client.loadNotifications(cursor);
        if (queryRevision.current !== revision) return;
        setItems((current) => (cursor ? [...new Map([...current, ...page.items].map((item) => [`${item.source}:${item.id}`, item])).values()] : page.items));
        setUnreadCount(page.unreadCount);
        setNextCursor(page.nextCursor);
        setLoaded(true);
      } catch (error) {
        if (queryRevision.current === revision) setLoadError(formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en'));
      } finally {
        if (queryRevision.current === revision) setLoading(false);
      }
    },
    [client, language],
  );

  useEffect(() => {
    setItems([]);
    setUnreadCount(0);
    setNextCursor(null);
    setLoaded(false);
    setPendingRead(null);
    setActionError(null);
    void refresh();
    /** 同一轮事件合并读取，避免每条完成事件都建立请求。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 定时器仅用于合并变化，不轮询服务。 */
    const scheduleRefresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 50);
    };
    /** 启动、断线重连以及通知变化均从服务端补读。 */
    const dispose = subscribe?.(
      (event) => {
        if (event.type.startsWith('automation.') || event.type.startsWith('task.') || event.type.startsWith('project.') || event.type === 'conversation.thread.deleted') scheduleRefresh();
      },
      (state) => {
        if (state === 'connected') scheduleRefresh();
      },
    );
    window.addEventListener('focus', scheduleRefresh);
    return () => {
      queryRevision.current += 1;
      clearTimeout(timer);
      dispose?.();
      window.removeEventListener('focus', scheduleRefresh);
    };
  }, [refresh, subscribe]);

  /** 确认后重新读取计数，旧修订确认失败时保留新提醒。 */
  const acknowledge = useCallback(
    async (item: NotificationItem): Promise<void> => {
      if (!client) return;
      setActionError(null);
      try {
        /** 只使用点击时的修订，不替换为刷新后尚未看见的修订。 */
        if (item.source === 'automation') await client.acknowledgeAutomationNotification(item.id, item.revision);
        else await client.acknowledgeTaskReminders([item.id]);
        await refresh();
      } catch (error) {
        setActionError(formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en'));
      }
    },
    [client, language, refresh],
  );

  useEffect(() => {
    if (!pendingRead) return;
    if (pendingRead.source === 'automation') {
      if (!input.contentVisible || pendingRead.conversationId !== input.visibleConversationId || pendingRead.projectId !== input.visibleProjectId) return;
    } else if (!input.taskContentVisible || pendingRead.taskId !== input.visibleTaskId || pendingRead.projectId !== input.visibleTaskProjectId) return;
    /** 同一个点击即使重渲染也只发一次确认。 */
    const key = `${pendingRead.source}:${pendingRead.id}:${pendingRead.source === 'automation' ? pendingRead.revision : ''}`;
    if (readInFlight.current === key) return;
    readInFlight.current = key;
    void acknowledge(pendingRead).finally(() => {
      setPendingRead((current) => (current === pendingRead ? null : current));
      if (readInFlight.current === key) readInFlight.current = null;
    });
  }, [acknowledge, input.contentVisible, input.visibleConversationId, input.visibleProjectId, input.taskContentVisible, input.visibleTaskId, input.visibleTaskProjectId, pendingRead]);

  return {
    items,
    unreadCount,
    nextCursor,
    loaded,
    loading,
    loadError,
    actionError,
    busyId,
    refresh,
    /** 全部已读覆盖服务端全部分页，写入成功后再刷新，失败时保留现有通知。 */
    async markAllRead(): Promise<void> {
      if (actionInFlight.current || !client) return;
      actionInFlight.current = true;
      // 单条操作使用来源与身份组合，all 仅标识全量操作。
      setBusyId('all');
      setActionError(null);
      try {
        await client.acknowledgeAllNotifications();
        await refresh();
      } catch (error) {
        setActionError(formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en'));
      } finally {
        actionInFlight.current = false;
        setBusyId(null);
      }
    },
    /** 列表导航成功后才关闭弹层；失败时保留消息并补读失效会话。 */
    async open(item: NotificationItem): Promise<boolean> {
      if (actionInFlight.current || !client || (item.source === 'automation' && !item.conversationId)) return false;
      actionInFlight.current = true;
      setBusyId(`${item.source}:${item.id}`);
      setActionError(null);
      try {
        /** 用户取消未保存内容的离开确认时，不产生已读。 */
        let opened = true;
        if (item.source === 'automation') opened = await input.onOpenConversation(item);
        else await input.onOpenTask(item);
        if (opened) setPendingRead(item);
        return opened;
      } catch (error) {
        setActionError(formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en'));
        await refresh();
        return false;
      } finally {
        actionInFlight.current = false;
        setBusyId(null);
      }
    },
    /** 单条图标可确认任意通知，不导航、不恢复或启动任何工作。 */
    async markRead(item: NotificationItem): Promise<void> {
      if (actionInFlight.current || !client) return;
      actionInFlight.current = true;
      setBusyId(`${item.source}:${item.id}`);
      setActionError(null);
      try {
        await acknowledge(item);
      } finally {
        actionInFlight.current = false;
        setBusyId(null);
      }
    },
  };
}

/** 弹层只消费数据和操作，不拥有后台连接。 */
export type NotificationsModel = ReturnType<typeof useNotifications>;
