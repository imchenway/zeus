import { ExternalStore } from './externalStore.js';

/** 查询保留最后一次有效值，冷加载与后台刷新分别表达。 */
export interface CachedQuerySnapshot<T> {
  value: T | null;
  /** 有效空结果也属于已读缓存，失效只影响新鲜度。 */
  hasValue: boolean;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  updatedAt: number;
}

/** 客户端内的只读查询缓存；合并在途读取，失效后的迟到结果不覆盖新值。 */
export class CachedQuery<T> extends ExternalStore<CachedQuerySnapshot<T>> {
  /** 同一缓存代次只持有一个在途读取。 */
  private pending: Promise<T> | null = null;

  /** 新鲜期以毫秒计，缓存仅属于创建它的读取范围。 */
  constructor(
    private readonly read: () => Promise<T>,
    private readonly freshForMs: number,
  ) {
    super({ value: null, hasValue: false, loading: false, refreshing: false, error: null, updatedAt: 0 });
  }

  /** 强制刷新仍合并当前请求；业务身份变化须先 invalidate。 */
  load(force = false): Promise<T> {
    if (this.pending) return this.pending;
    if (!force && this.snapshot.hasValue && this.snapshot.error === null && this.snapshot.updatedAt > 0 && Date.now() - this.snapshot.updatedAt < this.freshForMs) return Promise.resolve(this.snapshot.value as T);
    this.publish({ ...this.snapshot, loading: !this.snapshot.hasValue, refreshing: true, error: null });
    const pending = Promise.resolve()
      .then(this.read)
      .then(
        (value) => {
          if (this.pending === pending) {
            this.pending = null;
            this.publish({ value, hasValue: true, loading: false, refreshing: false, error: null, updatedAt: Date.now() });
          }
          return value;
        },
        (error: unknown) => {
          if (this.pending === pending) {
            this.pending = null;
            this.publish({ ...this.snapshot, loading: false, refreshing: false, error });
          }
          throw error;
        },
      );
    this.pending = pending;
    return pending;
  }

  /** 权威写入回执直接更新快照，并撤销旧查询的回写资格。 */
  set(value: T): void {
    this.pending = null;
    this.publish({ value, hasValue: true, loading: false, refreshing: false, error: null, updatedAt: Date.now() });
  }

  /** 保留可读内容，只撤销新鲜度和旧请求的回写资格。 */
  invalidate(): void {
    this.pending = null;
    this.publish({ ...this.snapshot, loading: false, refreshing: false, updatedAt: 0 });
  }
}
