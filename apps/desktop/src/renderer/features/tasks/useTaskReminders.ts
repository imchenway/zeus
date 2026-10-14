import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskReminder } from '@zeus/shared';
import type { TaskApiClient } from './taskApiClient.js';
import type { WorkspacePageProps } from '../workspace/workspaceContracts.js';
import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';

/** 任务提醒复用工作台实时连接，导航后等待真实详情可见再确认。 */
export function useTaskReminders(input: {
  /** 已认证任务接口。 */
  client: TaskApiClient | null;
  /** 工作台已有事件订阅。 */
  subscribe: WorkspacePageProps['onSubscribeRealtimeEvents'];
  /** 界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 实际显示的详情身份。 */
  visibleTaskId: string | null;
  /** 实际显示详情的项目。 */
  visibleProjectId: string | null;
  /** 工作台在前台且详情已经加载。 */
  contentVisible: boolean;
  /** 沿用现有项目导航和未保存草稿保护。 */
  onOpenTask(item: TaskReminder): Promise<void>;
}) {
  /** 接口变化使旧请求失效。 */
  const { client, subscribe, language } = input;
  /** 当前未读页。 */
  const [items, setItems] = useState<TaskReminder[]>([]);
  /** 完整未读数独立于分页。 */
  const [unreadCount, setUnreadCount] = useState(0);
  /** 分页游标。 */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** 首次加载状态。 */
  const [loaded, setLoaded] = useState(false);
  /** 正在读取列表。 */
  const [loading, setLoading] = useState(false);
  /** 保留可见的查询或操作错误。 */
  const [error, setError] = useState<string | null>(null);
  /** 当前操作身份。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 防止同一事件循环内重复点击。 */
  const actionLock = useRef(false);
  /** 查询序号阻止旧结果覆盖新结果。 */
  const queryRevision = useRef(0);
  /** 导航接纳后仍需等待实际内容显示。 */
  const [pendingRead, setPendingRead] = useState<TaskReminder | null>(null);
  /** 可见回执只能发起一次确认。 */
  const reading = useRef<string | null>(null);
  /** 错误统一使用现有用户可见文案格式。 */
  const report = useCallback((cause: unknown) => setError(formatVisibleApplicationError(cause, language === 'zh-CN' ? 'zh-CN' : 'en')), [language]);
  /** 刷新首批或加载下一页。 */
  const refresh = useCallback(
    async (cursor?: string) => {
      if (!client) return;
      /** 只有最后一次请求可以落入状态。 */
      const revision = ++queryRevision.current;
      setLoading(true);
      try {
        /** 服务端生成提醒并返回完整计数。 */
        const page = await client.loadTaskReminders(cursor);
        if (revision !== queryRevision.current) return;
        setItems((current) => (cursor ? [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()] : page.items));
        setUnreadCount(page.unreadCount);
        setNextCursor(page.nextCursor);
        setLoaded(true);
        setError(null);
      } catch (cause) {
        if (revision === queryRevision.current) report(cause);
      } finally {
        if (revision === queryRevision.current) setLoading(false);
      }
    },
    [client, report],
  );
  useEffect(() => {
    setItems([]);
    setUnreadCount(0);
    setLoaded(false);
    setPendingRead(null);
    setError(null);
    setNextCursor(null);
    void refresh();
    /** 合并同一轮多个任务变更，避免通知请求风暴。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 重连、任务变更和恢复前台都补读持久记录。 */
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 50);
    };
    /** 复用现有连接，不为提醒建立额外 WebSocket。 */
    const dispose = subscribe?.(
      (event) => {
        if (event.type.startsWith('task.') || event.type.startsWith('project.')) schedule();
      },
      (state) => {
        if (state === 'connected') schedule();
      },
    );
    window.addEventListener('focus', schedule);
    return () => {
      queryRevision.current += 1;
      clearTimeout(timer);
      dispose?.();
      window.removeEventListener('focus', schedule);
    };
  }, [refresh, subscribe]);
  useEffect(() => {
    if (!client || !pendingRead || reading.current || !input.contentVisible || input.visibleTaskId !== pendingRead.taskId || input.visibleProjectId !== pendingRead.projectId) return;
    reading.current = pendingRead.id;
    void client
      .acknowledgeTaskReminders([pendingRead.id])
      .then(() => refresh())
      .catch(report)
      .finally(() => {
        reading.current = null;
        setPendingRead((current) => (current?.id === pendingRead.id ? null : current));
      });
  }, [client, pendingRead, input.contentVisible, input.visibleTaskId, input.visibleProjectId, refresh, report]);
  /** 查询与导航失败都保留未读，按钮可明确重试。 */
  async function open(item: TaskReminder): Promise<boolean> {
    if (!client || actionLock.current) return false;
    actionLock.current = true;
    setBusyId(item.id);
    setError(null);
    try {
      await input.onOpenTask(item);
      setPendingRead(item);
      return true;
    } catch (cause) {
      report(cause);
      return false;
    } finally {
      actionLock.current = false;
      setBusyId(null);
    }
  }
  /** 全部已读先冻结各页身份，确认期间新增的提醒保持未读。 */
  async function markAllRead(): Promise<void> {
    if (!client || actionLock.current) return;
    actionLock.current = true;
    setBusyId('all');
    setError(null);
    try {
      /** 完整扫描使用稳定游标，不用本页长度代替全量。 */
      const ids = new Set<string>();
      /** 页面读取期间不提交确认，避免中途错误造成部分已读。 */
      let cursor: string | undefined;
      do {
        /** 同一轮只接纳一个页面。 */
        const page = await client.loadTaskReminders(cursor);
        for (const item of page.items) ids.add(item.id);
        if (page.nextCursor && page.nextCursor === cursor) throw new Error('提醒分页游标未推进。');
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      /** 限制每次请求大小，超大未读列表仍按冻结身份分批确认。 */
      const frozen = [...ids];
      for (let offset = 0; offset < frozen.length; offset += 1000) await client.acknowledgeTaskReminders(frozen.slice(offset, offset + 1000));
      await refresh();
    } catch (cause) {
      report(cause);
    } finally {
      actionLock.current = false;
      setBusyId(null);
    }
  }
  return { items, unreadCount, nextCursor, loaded, loading, error, busyId, refresh, open, markAllRead };
}

/** 铃铛分类直接消费同一提醒状态。 */
export type TaskRemindersModel = ReturnType<typeof useTaskReminders>;
