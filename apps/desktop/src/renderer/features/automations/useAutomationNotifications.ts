import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationNotification } from '@zeus/shared';
import type { DashboardClient } from '../../apiClient.js';
import type { WorkspacePageProps } from '../workspace/workspaceContracts.js';
import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';

/** 通知数据驻留工作台，切换到会话后仍可等待正文可见再确认。 */
export function useAutomationNotifications(input: {
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
  /** 复用工作台现有离开确认与会话导航，取消返回 false。 */
  onOpenConversation(item: AutomationNotification): Promise<boolean>;
}) {
  /** 当前客户端和语言决定刷新函数的生命周期。 */
  const { client, subscribe, language } = input;
  /** 列表只展示未读记录。 */
  const [items, setItems] = useState<AutomationNotification[]>([]);
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
  const [pendingRead, setPendingRead] = useState<AutomationNotification | null>(null);
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
        const page = await client.loadAutomationNotifications(cursor);
        if (queryRevision.current !== revision) return;
        setItems((current) => (cursor ? [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()] : page.items));
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
        if (event.type.startsWith('automation.') || event.type === 'conversation.thread.deleted') scheduleRefresh();
      },
      (state) => {
        if (state === 'connected') scheduleRefresh();
      },
    );
    return () => {
      queryRevision.current += 1;
      clearTimeout(timer);
      dispose?.();
    };
  }, [refresh, subscribe]);

  /** 确认后重新读取计数，旧修订确认失败时保留新提醒。 */
  const acknowledge = useCallback(
    async (item: AutomationNotification): Promise<void> => {
      if (!client) return;
      setActionError(null);
      try {
        /** 只使用点击时的修订，不替换为刷新后尚未看见的修订。 */
        await client.acknowledgeAutomationNotification(item.id, item.revision);
        await refresh();
      } catch (error) {
        setActionError(formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en'));
      }
    },
    [client, language, refresh],
  );

  useEffect(() => {
    if (!pendingRead || !input.contentVisible || pendingRead.conversationId !== input.visibleConversationId || pendingRead.projectId !== input.visibleProjectId) return;
    /** 同一个点击即使重渲染也只发一次确认。 */
    const key = `${pendingRead.id}:${pendingRead.revision}`;
    if (readInFlight.current === key) return;
    readInFlight.current = key;
    void acknowledge(pendingRead).finally(() => {
      setPendingRead((current) => (current?.id === pendingRead.id && current.revision === pendingRead.revision ? null : current));
      if (readInFlight.current === key) readInFlight.current = null;
    });
  }, [acknowledge, input.contentVisible, input.visibleConversationId, input.visibleProjectId, pendingRead]);

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
    /** 列表导航成功后才关闭弹层；失败时保留消息并补读失效会话。 */
    async open(item: AutomationNotification): Promise<boolean> {
      if (actionInFlight.current || !item.conversationId || !client) return false;
      actionInFlight.current = true;
      setBusyId(item.id);
      setActionError(null);
      try {
        /** 用户取消未保存内容的离开确认时，不产生已读。 */
        const opened = await input.onOpenConversation(item);
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
    /** 无会话异常由用户明确确认，恢复继续使用原运行接口。 */
    async act(item: AutomationNotification, action: 'read' | 'resume'): Promise<void> {
      if (actionInFlight.current || !client) return;
      actionInFlight.current = true;
      setBusyId(item.id);
      setActionError(null);
      try {
        if (action === 'read') await acknowledge(item);
        else {
          await client.resumeAutomationRun(item.runId);
          await refresh();
        }
      } catch (error) {
        setActionError(formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en'));
      } finally {
        actionInFlight.current = false;
        setBusyId(null);
      }
    },
  };
}

/** 弹层只消费数据和操作，不拥有后台连接。 */
export type AutomationNotificationsModel = ReturnType<typeof useAutomationNotifications>;
