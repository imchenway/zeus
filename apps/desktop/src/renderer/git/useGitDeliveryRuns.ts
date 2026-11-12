import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitDeliveryRun } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';

/** 进度只读取持久交付记录及其变化事件。 */
type DeliveryProgressClient = Pick<DashboardClient, 'loadGitDeliveryRuns' | 'subscribeEvents'>;

/** 查询结果带上来源，切换会话时不能短暂显示旧范围。 */
interface DeliverySnapshot {
  /** 读取结果的已认证客户端。 */
  client: DeliveryProgressClient;
  /** 项目身份。 */
  projectId: string;
  /** 任务或会话身份。 */
  scopeId: string;
  /** 当前范围的持久交付记录。 */
  runs: GitDeliveryRun[];
  /** 本次读取失败原因。 */
  error: unknown;
}

/** 未加载范围使用稳定空集合。 */
const emptyRuns: GitDeliveryRun[] = [];

/** 环境卡片与交付窗口按同一范围读取进度，事件只触发对应范围重读。 */
export function useGitDeliveryRuns(client: DeliveryProgressClient | undefined, projectId: string, scopeId: string | null, enabled = true) {
  /** 原始结果保留查询来源，错误也不跨范围展示。 */
  const [snapshot, setSnapshot] = useState<DeliverySnapshot | null>(null);
  /** 后发查询和卸载使先前回执失效。 */
  const revision = useRef(0);

  /** 手动重读与事件刷新共用请求顺序。 */
  const refresh = useCallback(async (): Promise<void> => {
    if (!client || !scopeId || !enabled) return;
    /** 仅接收当前最新请求的回执。 */
    const ticket = ++revision.current;
    try {
      /** 接口按项目与任务或会话限定读取范围。 */
      const result = await client.loadGitDeliveryRuns(projectId, scopeId);
      if (ticket === revision.current) setSnapshot({ client, projectId, scopeId, runs: result.items, error: null });
    } catch (error) {
      if (ticket === revision.current) {
        setSnapshot((current) => ({ client, projectId, scopeId, runs: current?.client === client && current.projectId === projectId && current.scopeId === scopeId ? current.runs : [], error }));
      }
      throw error;
    }
  }, [client, projectId, scopeId, enabled]);

  /** 接纳回执立即加入列表，不等待变化事件返回。 */
  function acceptRun(run: GitDeliveryRun): void {
    if (!client || !scopeId) return;
    ++revision.current;
    setSnapshot((current) => ({
      client,
      projectId,
      scopeId,
      error: null,
      runs: [run, ...(current?.client === client && current.projectId === projectId && current.scopeId === scopeId ? current.runs.filter((item) => item.id !== run.id) : [])],
    }));
  }

  useEffect(() => {
    if (!client || !scopeId || !enabled) return;
    /** 合并同一批步骤事件，隐藏页面恢复后补读真实结果。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = (): void => {
      if (document.visibilityState !== 'hidden') void refresh().catch(() => undefined);
    };
    reload();
    const unsubscribe = client.subscribeEvents(
      (event) => {
        if (event.type !== 'project.git_delivery.changed' || event.payload.projectId !== projectId || (event.payload.taskId ?? event.payload.conversationId) !== scopeId) return;
        clearTimeout(timer);
        timer = setTimeout(reload, 80);
      },
      (state) => {
        if (state === 'connected') reload();
      },
    );
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', reload);
    return () => {
      ++revision.current;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', reload);
      document.removeEventListener('visibilitychange', reload);
    };
  }, [client, projectId, scopeId, enabled, refresh]);

  /** 关闭卡片后停止订阅；重新打开前也不借用其他范围的结果。 */
  const current = snapshot && snapshot.client === client && snapshot.projectId === projectId && snapshot.scopeId === scopeId ? snapshot : null;
  return { runs: current?.runs ?? emptyRuns, error: current?.error ?? null, refresh, acceptRun };
}
