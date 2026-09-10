import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardClient, ProjectGitOperationRecord } from '../apiClient.js';

/** 操作历史的已加载连续区间；未读取时总数未知。 */
interface OperationHistoryState {
  items: ProjectGitOperationRecord[];
  total: number | null;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  failedRequest: 'refresh' | 'older';
}

/** 页面持有展示缓存，历史事实始终从桌面账本读取。 */
export function useGitOperationHistory(client: Pick<DashboardClient, 'loadProjectGitOperations'>, projectId: string) {
  /** 初始空列表不代表账本为空，必须等查询成功后才显示空状态。 */
  const [state, setState] = useState<OperationHistoryState>({ items: [], total: null, nextCursor: null, loading: false, error: null, failedRequest: 'refresh' });
  /** 请求读取最新分页边界，避免回调捕获旧游标。 */
  const current = useRef(state);
  /** 同一时刻只允许一个加载过程，滚动重复触发会合流。 */
  const request = useRef<symbol | null>(null);
  /** 进入页面的重复刷新合流，翻页期间的刷新则需要排在后面。 */
  const requestMode = useRef<'refresh' | 'older'>('refresh');
  /** 操作完成时若正在翻页，随后仍需刷新最新结果。 */
  const refreshPending = useRef(false);
  /** 页面卸载或项目变化后，旧请求不能回写。 */
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current = null;
      refreshPending.current = false;
    };
  }, [client, projectId]);

  /** 刷新读取到已加载区间末端，补齐新增记录和延迟落盘的中间记录。 */
  const load = useCallback(
    async function loadPage(mode: 'refresh' | 'older', forceRefresh = false): Promise<void> {
      if (!mounted.current) return;
      if (request.current) {
        if (mode === 'refresh' && (forceRefresh || requestMode.current === 'older')) refreshPending.current = true;
        return;
      }
      /** 一次加载固定使用开始时的已读区间。 */
      const previous = current.current;
      if (mode === 'older' && !previous.nextCursor) return;
      /** 唯一请求身份同时承担卸载后的丢弃判断。 */
      const token = Symbol('git-operation-history');
      request.current = token;
      requestMode.current = mode;
      current.current = { ...previous, loading: true, error: null };
      setState(current.current);
      try {
        /** ponytail: 刷新重读已加载区间；历史阅读量显著增大后再考虑增量变更游标。 */
        const previousTail = previous.items.at(-1);
        /** 本轮暂存的新数据在全部成功后一次提交，失败不会破坏已有区间。 */
        const received: ProjectGitOperationRecord[] = [];
        /** 刷新从最新页开始，翻页从当前连续区间末端继续。 */
        let cursor = mode === 'older' ? previous.nextCursor! : undefined;
        /** 当前页的真实总数由服务端给出。 */
        let total = previous.total ?? 0;
        do {
          /** 分页请求固定由同一个客户端和项目执行。 */
          const page = await client.loadProjectGitOperations(projectId, cursor);
          if (!mounted.current || request.current !== token) return;
          received.push(...page.items);
          total = page.total;
          cursor = page.nextCursor ?? undefined;
          if (mode === 'older' || !previousTail || page.items.some((item) => compareOperations(item, previousTail) >= 0)) break;
        } while (cursor);
        /** 刷新替换完整已读区间，翻页保留旧记录；同一命令只保留最新状态。 */
        const merged = new Map((mode === 'older' ? previous.items : []).map((item) => [item.id, item]));
        for (const item of received) merged.set(item.id, item);
        current.current = {
          items: [...merged.values()].sort(compareOperations),
          total,
          nextCursor: cursor ?? null,
          loading: false,
          error: null,
          failedRequest: mode,
        };
        setState(current.current);
      } catch (reason) {
        if (!mounted.current || request.current !== token) return;
        current.current = { ...previous, loading: false, error: reason instanceof Error ? reason.message : String(reason), failedRequest: mode };
        setState(current.current);
      } finally {
        if (request.current === token) {
          request.current = null;
          if (refreshPending.current) {
            refreshPending.current = false;
            void loadPage('refresh');
          }
        }
      }
    },
    [client, projectId],
  );

  /** 稳定回调可供进入控制台、工作台刷新及操作结束共同使用。 */
  const refresh = useCallback((forceRefresh = false) => load('refresh', forceRefresh), [load]);
  /** 自动滚动和键盘按钮共用同一道并发门禁。 */
  const loadMore = useCallback(() => load('older'), [load]);
  /** 只重试读取失败的分页请求，绝不重放 Git 操作。 */
  const retry = useCallback(() => load(current.current.failedRequest), [load]);
  return { ...state, refresh, loadMore, retry };
}

/** 与账本使用相同的时间和命令身份倒序，刷新不会改变同时间记录的顺序。 */
function compareOperations(left: ProjectGitOperationRecord, right: ProjectGitOperationRecord): number {
  /** 时间和身份组成稳定的显示顺序。 */
  const leftKey = `${left.startedAt}\0${left.id}`;
  /** 不使用本地化比较，避免切换语言造成跳位。 */
  const rightKey = `${right.startedAt}\0${right.id}`;
  return leftKey === rightKey ? 0 : leftKey > rightKey ? -1 : 1;
}
