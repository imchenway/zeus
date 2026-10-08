import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import type { TaskBoardViewSnapshot } from '@zeus/shared';
import type { TaskRecord } from '../../apiClient.js';
import type { TaskApiClient } from './taskApiClient.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';

/** 项目分页分别记录未加载、加载中、已就绪与失败，旧页不冒充空列表。 */
export interface TaskPageState {
  query: string;
  itemIds: string[];
  state: 'loading' | 'ready' | 'error';
  nextCursor: string | null;
  hasMore: boolean;
  error: string | null;
  loaded: boolean;
}
export interface TaskQuerySnapshot {
  pages: Readonly<Record<string, TaskPageState>>;
  items: readonly TaskRecord[];
  boards: Readonly<Record<string, TaskBoardViewSnapshot>>;
  loading: boolean;
  error: string | null;
  /** 可选底层原因供界面生成本地化提示，原错误字符串仍保留。 */
  errorCause?: UserFacingErrorCause | null;
  revision: number;
}

export class TaskQueryStore extends ExternalStore<TaskQuerySnapshot> {
  /** 删除后的迟到分页不得复活记录；恢复回执会清除此标记。 */
  private readonly removedIds = new Set<string>();
  constructor(
    private readonly client: TaskApiClient | null,
    initialItems: readonly TaskRecord[],
  ) {
    super({ items: initialItems, pages: {}, boards: {}, loading: false, error: null, errorCause: null, revision: 0 });
  }

  replace(items: readonly TaskRecord[]): void {
    if (items === this.snapshot.items) return;
    const present = new Set(items.map((item) => item.id));
    for (const item of this.snapshot.items) if (!present.has(item.id)) this.removedIds.add(item.id);
    for (const item of items) this.removedIds.delete(item.id);
    this.publish({ ...this.snapshot, items, error: null, errorCause: null, revision: this.snapshot.revision + 1 });
  }

  async load(input: Parameters<TaskApiClient['loadTasks']>[0]): Promise<readonly TaskRecord[]> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null, errorCause: null });
    try {
      const items = await client.loadTasks(input);
      this.replace(items);
      this.publish({ ...this.snapshot, loading: false });
      return items;
    } catch (error) {
      this.publish({ ...this.snapshot, loading: false, error: errorMessage(error), errorCause: userFacingErrorCause(error) });
      throw error;
    }
  }

  /** 摘要只合并当前页，其他项目、已打开详情与较新的事件结果保持不变。 */
  mergeSummaries(items: readonly TaskRecord[]): void {
    const merged = new Map(this.snapshot.items.map((item) => [item.id, item]));
    for (const item of items) {
      if (this.removedIds.has(item.id)) continue;
      const current = merged.get(item.id);
      if (current?.updatedAt && item.updatedAt && current.updatedAt > item.updatedAt) continue;
      merged.set(item.id, { ...current, ...item });
    }
    this.publish({ ...this.snapshot, items: [...merged.values()], revision: this.snapshot.revision + 1 });
  }

  /** 同项目只发一个请求，结果按项目身份归档，切换后不会覆盖新项目。 */
  async loadPage(projectId: string, reset = false, query = ''): Promise<void> {
    const previous = this.snapshot.pages[projectId];
    if (previous?.query === query && (previous.state === 'loading' || (!reset && previous.loaded && !previous.hasMore))) return;
    reset ||= previous?.query !== query;
    const page: TaskPageState = {
      query,
      itemIds: reset ? [] : (previous?.itemIds ?? []),
      state: 'loading',
      loaded: reset ? false : (previous?.loaded ?? false),
      nextCursor: reset ? null : (previous?.nextCursor ?? null),
      hasMore: true,
      error: null,
    };
    this.publish({ ...this.snapshot, pages: { ...this.snapshot.pages, [projectId]: page } });
    try {
      const result = await this.requireClient().loadTaskSummaries({ projectId, query, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) });
      if (this.snapshot.pages[projectId] !== page) return;
      if (result.items.some((item) => item.projectId !== projectId) || (result.hasMore && (!result.nextCursor || result.nextCursor === page.nextCursor))) throw new Error('任务分页返回了无效身份或重复游标。');
      this.mergeSummaries(result.items);
      this.publish({
        ...this.snapshot,
        pages: {
          ...this.snapshot.pages,
          [projectId]: { query, itemIds: [...new Set([...page.itemIds, ...result.items.map((item) => item.id)])], state: 'ready', loaded: true, nextCursor: result.nextCursor, hasMore: result.hasMore, error: null },
        },
      });
    } catch (error) {
      if (this.snapshot.pages[projectId] !== page) return;
      this.publish({ ...this.snapshot, pages: { ...this.snapshot.pages, [projectId]: { ...page, state: 'error', error: errorMessage(error) } } });
    }
  }

  async loadOne(taskId: string): Promise<TaskRecord> {
    const task = await this.requireClient().loadTask(taskId);
    this.upsert(task);
    return task;
  }

  async loadBoard(projectId: string): Promise<TaskBoardViewSnapshot> {
    const board = await this.requireClient().loadTaskBoard(projectId);
    this.publish({ ...this.snapshot, boards: { ...this.snapshot.boards, [projectId]: board }, error: null, errorCause: null });
    return board;
  }

  setBoard(projectId: string, board: TaskBoardViewSnapshot): void {
    this.publish({ ...this.snapshot, boards: { ...this.snapshot.boards, [projectId]: board }, error: null, errorCause: null });
  }

  upsert(task: TaskRecord): void {
    const items = this.snapshot.items.some((item) => item.id === task.id) ? this.snapshot.items.map((item) => (item.id === task.id ? task : item)) : [...this.snapshot.items, task];
    this.replace(items);
  }

  remove(taskId: string): void {
    this.replace(this.snapshot.items.filter((item) => item.id !== taskId));
  }

  private requireClient(): TaskApiClient {
    if (!this.client) throw new Error('Task API client is unavailable.');
    return this.client;
  }
}
