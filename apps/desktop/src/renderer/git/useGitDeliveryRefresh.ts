import { useEffect, useRef } from 'react';
import type { GitEnvironmentScope, GitEnvironmentSummary } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';
import { subscribeProjectGitRefresh } from './projectGitWorkbenchState.js';

/** 所有交付范围沿用环境摘要的真实目录监听，不自行轮询或接收客户端路径。 */
export function useGitDeliveryRefresh(options: {
  /** 当前范围的认证客户端。 */
  client: Pick<DashboardClient, 'subscribeEvents'> | null;
  /** 窗口关闭后释放订阅。 */
  open: boolean;
  /** 提交、合入或冲突处理期间保留通知，结束后再更新快照。 */
  blocked: boolean;
  /** 项目是订阅的归属边界。 */
  projectId: string;
  /** 任务或会话身份由服务端解析成实际工作树。 */
  scope: GitEnvironmentScope;
  /** 重新读取当前范围的完整 Git 状态。 */
  refresh(): Promise<void>;
  /** 读取或订阅失败交给当前页面的错误入口。 */
  onError(error: unknown): void;
}): void {
  /** 订阅保持稳定，刷新使用最新的操作状态与审阅选择。 */
  const latest = useRef(options);
  latest.current = options;
  /** 操作结束时唤醒同一订阅内尚未处理的通知。 */
  const resume = useRef<(() => void) | null>(null);
  /** 仅持久身份参与连接生命周期，文件选择不重建连接。 */
  const {
    client,
    open,
    projectId,
    scope: { taskId, workspaceId, conversationId },
  } = options;

  useEffect(() => {
    if (!open || !client) return;
    /** 固定当前客户端，页面换范围后由 effect 清理旧连接。 */
    const subscribeEvents = client.subscribeEvents;
    /** 旧连接关闭后不能发起读取或上报迟到错误。 */
    let active = true;
    /** 多条变化合并为一次读取，读取期间到达的变化留到下一次。 */
    let pending = false;
    /** 同一订阅不并发刷新，避免复用变化前的在途快照。 */
    let reading = false;
    /** 页面隐藏时释放订阅，服务端按空闲期限回收目录监听。 */
    let unsubscribe: (() => void) | undefined;
    /** 重连后忽略旧连接的迟到事件。 */
    let generation = 0;
    /** 当前业务操作结束后继续消费已收到的文件变化。 */
    async function drain(): Promise<void> {
      if (!active || reading || !pending || latest.current.blocked || document.visibilityState === 'hidden') return;
      reading = true;
      pending = false;
      try {
        await latest.current.refresh();
      } catch (error) {
        if (active) latest.current.onError(error);
      } finally {
        reading = false;
        if (active && pending) void drain();
      }
    }
    /** 本机事件和宿主文件事件进入同一刷新队列。 */
    function schedule(): void {
      pending = true;
      void drain();
    }
    /** 摘要端点复用现有认证、自动重连和跨平台目录监听。 */
    function connect(): void {
      unsubscribe?.();
      unsubscribe = undefined;
      /** 每次可见性切换使上一次连接的回调失效。 */
      const current = ++generation;
      if (document.visibilityState === 'hidden') return;
      /** 订阅只传持久身份，服务端自行解析目录。 */
      const query = new URLSearchParams();
      if (taskId) query.set('taskId', taskId);
      if (workspaceId) query.set('workspaceId', workspaceId);
      if (conversationId) query.set('conversationId', conversationId);
      unsubscribe = subscribeEvents(
        (event) => {
          if (!active || current !== generation) return;
          // 缓存预览供环境卡片立即显示；交付窗口只响应重新核对后的摘要。
          if (event.type === 'git.summary.updated' && (event.payload.summary as GitEnvironmentSummary).projectId === projectId) schedule();
          else if (event.type === 'git.summary.error') latest.current.onError(new Error(String(event.payload.message ?? 'Git 状态读取失败。')));
        },
        () => undefined,
        { path: `/api/projects/${encodeURIComponent(projectId)}/git/summary-events?${query}` },
      );
    }
    resume.current = () => void drain();
    /** 保留同窗口 Git 操作和重新聚焦的既有刷新入口。 */
    const unsubscribeLocal = subscribeProjectGitRefresh(projectId, schedule);
    connect();
    document.addEventListener('visibilitychange', connect);
    return () => {
      active = false;
      resume.current = null;
      unsubscribe?.();
      unsubscribeLocal();
      document.removeEventListener('visibilitychange', connect);
    };
  }, [client, open, projectId, taskId, workspaceId, conversationId]);

  useEffect(() => {
    if (!options.blocked) resume.current?.();
  }, [options.blocked]);
}
