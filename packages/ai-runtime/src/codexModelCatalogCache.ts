import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 官方组件写入的目录证据，只用于确认刷新结果，不读取或修改账号凭据。 */
export interface CodexModelCatalogCache {
  /** 官方目录成功读取的时间。 */
  fetchedAtMs: number;
  /** 官方标记可展示的完整名单，用于发现列表漏掉新增条目。 */
  visibleModels: ReadonlySet<string>;
}

/** 限制读取体积，防止异常本地文件阻塞运行宿主。 */
const maximumCatalogBytes = 8 * 1024 * 1024;

/** 只接纳同一程序版本、结构完整且时间合理的官方目录缓存。 */
export function readCodexModelCatalogCache(codexHome: string | null, providerVersion: string | null): CodexModelCatalogCache | null {
  if (!codexHome || !providerVersion) return null;
  /** 不跟随文件链接，目录内容始终来自当前运行组件的数据目录。 */
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(codexHome, 'models_cache.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    /** 文件必须是有界的普通文件。 */
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumCatalogBytes) return null;
    /** 缓存由官方组件维护，所有字段先按未知数据校验。 */
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    /** 版本一致才能把缓存与本次模型接口结果关联。 */
    const record = value as Record<string, unknown>;
    if (record.client_version !== providerVersion || typeof record.fetched_at !== 'string' || !Array.isArray(record.models)) return null;
    /** 未来时间不能成为永不失效的刷新凭据。 */
    const fetchedAtMs = Date.parse(record.fetched_at);
    if (!Number.isFinite(fetchedAtMs) || fetchedAtMs > Date.now() + 5_000) return null;
    /** 只保留模型标识，避免向上层传播多余的原始目录内容。 */
    const models = new Set<string>();
    /** 与 model/list 的 includeHidden=false 使用相同展示范围。 */
    const visibleModels = new Set<string>();
    for (const model of record.models) {
      if (!model || typeof model !== 'object' || typeof model.slug !== 'string' || !model.slug || models.has(model.slug)) return null;
      if (model.visibility !== 'list' && model.visibility !== 'hide') return null;
      models.add(model.slug);
      if (model.visibility === 'list') visibleModels.add(model.slug);
    }
    return { fetchedAtMs, visibleModels };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
