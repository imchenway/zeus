import type { ModelConnectionRecord, ModelConnectionDiagnostic, ModelCapabilityProbeSummary } from './integrationContracts.js';
import type { IntegrationApiClient } from './integrationApiClient.js';
import { ExternalStore } from '../../externalStore.js';
import { CachedQuery } from '../../cachedQuery.js';

/** 同一连接的远端读取互斥，其他连接继续操作。 */
export type ModelConnectionJobKind = 'refreshing' | 'probing' | 'diagnosing';
/** 后台操作保留原始回执，消息随当前连接展示。 */
export type ModelConnectionJobResult = ModelConnectionRecord | ModelConnectionDiagnostic | ModelCapabilityProbeSummary | Awaited<ReturnType<IntegrationApiClient['refreshModelConnectionModels']>>;
/** 已结束的结果仍保留，离开设置页面不会丢失反馈。 */
export interface ModelConnectionJob {
  kind: ModelConnectionJobKind;
  pending: boolean;
  result?: ModelConnectionJobResult;
  error?: unknown;
}

/** 凭据本身不进入查询缓存；列表只包含服务端提供的存在状态。 */
export class ModelConnectionQueryStore extends ExternalStore<Readonly<Record<string, ModelConnectionJob>>> {
  /** 设置面板重新挂载时立即读取同一份连接快照。 */
  readonly connections: CachedQuery<ModelConnectionRecord[]>;
  /** 返回设置时恢复最近查看的连接，不保存输入中的密钥。 */
  selectedConnectionId: string | null = null;

  constructor(client: Pick<IntegrationApiClient, 'loadModelConnections'>) {
    super({});
    this.connections = new CachedQuery(() => client.loadModelConnections(), 30_000);
  }

  /** 单连接写入回执更新列表，不再等一次全量读取。 */
  upsert(connection: ModelConnectionRecord): void {
    const current = this.connections.getSnapshot().value ?? [];
    const previous = current.find((item) => item.id === connection.id);
    if (previous && Date.parse(previous.updatedAt) > Date.parse(connection.updatedAt)) return;
    this.connections.set(current.some((item) => item.id === connection.id) ? current.map((item) => (item.id === connection.id ? connection : item)) : [...current, connection]);
  }

  /** 删除回执同时移除该连接的列表项和历史操作状态。 */
  remove(id: string): void {
    if (this.selectedConnectionId === id) this.selectedConnectionId = null;
    this.connections.set((this.connections.getSnapshot().value ?? []).filter((item) => item.id !== id));
    const next = { ...this.snapshot };
    delete next[id];
    this.publish(next);
  }

  /** 请求由客户端状态持有，页面切换不取消已发出的耐久命令。 */
  async run(id: string, kind: ModelConnectionJobKind, operation: () => Promise<ModelConnectionJobResult>): Promise<void> {
    if (this.snapshot[id]?.pending) return;
    this.publish({ ...this.snapshot, [id]: { kind, pending: true } });
    try {
      const result = await operation();
      const connection = 'connection' in result ? result.connection : 'models' in result ? result : null;
      if (connection) this.upsert(connection);
      this.publish({ ...this.snapshot, [id]: { kind, pending: false, result } });
    } catch (error) {
      this.publish({ ...this.snapshot, [id]: { kind, pending: false, error } });
    }
  }
}

/** 状态按受信客户端隔离，不跨宿主连接复用。 */
const stores = new WeakMap<object, ModelConnectionQueryStore>();

/** 设置页和接入引导共用同一客户端中的列表及在途状态。 */
export function modelConnectionQueryStore(client: Pick<IntegrationApiClient, 'loadModelConnections'>): ModelConnectionQueryStore {
  let store = stores.get(client);
  if (!store) {
    store = new ModelConnectionQueryStore(client);
    stores.set(client, store);
  }
  return store;
}
