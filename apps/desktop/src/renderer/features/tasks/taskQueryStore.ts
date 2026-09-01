import type {TaskBoardViewSnapshot} from '@zeus/shared';
import type {TaskRecord} from '../../apiClient.js';
import type {TaskApiClient} from './taskApiClient.js';
import {errorMessage, ExternalStore} from '../../externalStore.js';

export interface TaskQuerySnapshot {
  items: readonly TaskRecord[];
  boards: Readonly<Record<string, TaskBoardViewSnapshot>>;
  loading: boolean;
  error: string | null;
  revision: number;
}

export class TaskQueryStore extends ExternalStore<TaskQuerySnapshot> {
  constructor(
    private readonly client: TaskApiClient | null,
    initialItems: readonly TaskRecord[],
  ) {
      super({items: initialItems, boards: {}, loading: false, error: null, revision: 0});
  }

  replace(items: readonly TaskRecord[]): void {
    if (items === this.snapshot.items) return;
    this.publish({ ...this.snapshot, items, error: null, revision: this.snapshot.revision + 1 });
  }

  async load(input: Parameters<TaskApiClient['loadTasks']>[0]): Promise<readonly TaskRecord[]> {
    const client = this.requireClient();
    this.publish({ ...this.snapshot, loading: true, error: null });
    try {
      const items = await client.loadTasks(input);
      this.replace(items);
      this.publish({ ...this.snapshot, loading: false });
      return items;
    } catch (error) {
        this.publish({...this.snapshot, loading: false, error: errorMessage(error)});
      throw error;
    }
  }

  async loadOne(taskId: string): Promise<TaskRecord> {
    const task = await this.requireClient().loadTask(taskId);
    this.upsert(task);
    return task;
  }

  async loadBoard(projectId: string): Promise<TaskBoardViewSnapshot> {
    const board = await this.requireClient().loadTaskBoard(projectId);
    this.publish({ ...this.snapshot, boards: { ...this.snapshot.boards, [projectId]: board }, error: null });
    return board;
  }

  setBoard(projectId: string, board: TaskBoardViewSnapshot): void {
    this.publish({ ...this.snapshot, boards: { ...this.snapshot.boards, [projectId]: board }, error: null });
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
