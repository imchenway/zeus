import type { MemoryApiClient } from './memoryApiClient.js';
import type { MemoryCandidateInput, MemoryListQuery, MemoryRecord, SupersedingMemoryCandidateInput } from './memoryContracts.js';
import { errorMessage, ExternalStore } from '../../externalStore.js';

export interface MemoryQuerySnapshot {
  query: Omit<MemoryListQuery, 'before'>;
  items: readonly MemoryRecord[];
  phase: 'idle' | 'loading' | 'ready' | 'error';
  loadingMore: boolean;
  command: 'idle' | 'creating' | 'superseding' | 'tombstoning';
  error: string | null;
  nextCursor: MemoryListQuery['before'] | null;
}

const defaultQuery: MemoryQuerySnapshot['query'] = {
  scope: { kind: 'global', id: '*' },
  includeTombstones: true,
  limit: 50,
};

/**
 * Memory 的有界分页 projection。它不保存业务事实：scope 切换会丢弃旧页，命令完成后
 * 总是从服务端重新读取；最多保留 500 条展示记录，防止设置页演变为第二份数据库。
 */
export class MemoryQueryStore extends ExternalStore<MemoryQuerySnapshot> {
  private revision = 0;

  constructor(private readonly client: MemoryApiClient) {
    super({
      query: defaultQuery,
      items: [],
      phase: 'idle',
      loadingMore: false,
      command: 'idle',
      error: null,
      nextCursor: null,
    });
  }

  async setQuery(query: MemoryQuerySnapshot['query']): Promise<void> {
    if (sameQuery(this.snapshot.query, query) && this.snapshot.phase !== 'idle') return;
    this.revision += 1;
    this.publish({ ...this.snapshot, query, items: [], nextCursor: null, phase: 'loading', loadingMore: false, error: null });
    await this.loadPage(false, this.revision);
  }

  async reload(): Promise<void> {
    this.revision += 1;
    this.publish({ ...this.snapshot, items: [], nextCursor: null, phase: 'loading', loadingMore: false, error: null });
    await this.loadPage(false, this.revision);
  }

  async loadMore(): Promise<void> {
    if (!this.snapshot.nextCursor || this.snapshot.loadingMore || this.snapshot.phase === 'loading') return;
    const revision = this.revision;
    this.publish({ ...this.snapshot, loadingMore: true, error: null });
    await this.loadPage(true, revision);
  }

  async create(input: MemoryCandidateInput): Promise<void> {
    await this.runCommand('creating', () => this.client.create(input));
  }

  async supersede(previousId: string, input: SupersedingMemoryCandidateInput): Promise<void> {
    await this.runCommand('superseding', () => this.client.supersede(previousId, input));
  }

  async tombstone(id: string, reason: string): Promise<void> {
    await this.runCommand('tombstoning', () => this.client.tombstone(id, reason));
  }

  private async runCommand(command: Exclude<MemoryQuerySnapshot['command'], 'idle'>, operation: () => Promise<unknown>): Promise<void> {
    if (this.snapshot.command !== 'idle') return;
    this.publish({ ...this.snapshot, command, error: null });
    try {
      await operation();
      this.publish({ ...this.snapshot, command: 'idle' });
      await this.reload();
    } catch (error) {
      this.publish({ ...this.snapshot, command: 'idle', error: errorMessage(error) });
      throw error;
    }
  }

  private async loadPage(append: boolean, revision: number): Promise<void> {
    try {
      const page = await this.client.list({ ...this.snapshot.query, ...(append && this.snapshot.nextCursor ? { before: this.snapshot.nextCursor } : {}) });
      if (revision !== this.revision) return;
      const items = append ? mergeBoundedMemoryPages(this.snapshot.items, page.items) : page.items.slice(0, 500);
      this.publish({ ...this.snapshot, items, phase: 'ready', loadingMore: false, error: null, nextCursor: page.hasMore ? page.nextCursor : null });
    } catch (error) {
      if (revision !== this.revision) return;
      this.publish({ ...this.snapshot, phase: 'error', loadingMore: false, error: errorMessage(error) });
    }
  }
}

function mergeBoundedMemoryPages(current: readonly MemoryRecord[], next: readonly MemoryRecord[]): MemoryRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of next) byId.set(record.id, record);
  return [...byId.values()].slice(0, 500);
}

function sameQuery(left: MemoryQuerySnapshot['query'], right: MemoryQuerySnapshot['query']): boolean {
  return left.scope.kind === right.scope.kind && left.scope.id === right.scope.id && left.includeTombstones === right.includeTombstones && left.limit === right.limit;
}
