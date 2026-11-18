import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexReasoningCatalogEntry } from './modelConnectionCatalog.js';

/** 官方组件写入的目录，供目录同步核对和档位判定。 */
export interface CodexModelCatalogCache {
  /** 官方目录成功读取的时间。 */
  fetchedAtMs: number;
  /** 官方标记可展示的完整名单，用于发现列表漏掉新增条目。 */
  visibleModels: ReadonlySet<string>;
  /** 可见模型的档位，按完整模型 ID 索引。 */
  visibleReasoningEfforts: ReadonlyMap<string, CodexReasoningCatalogEntry>;
}

/** 限制读取体积，防止异常本地文件阻塞运行宿主。 */
const maximumCatalogBytes = 8 * 1024 * 1024;

/** 同步核对需要匹配程序版本，省略版本时只读取本地目录。 */
export function readCodexModelCatalogCache(codexHome: string | null, providerVersion?: string | null): CodexModelCatalogCache | null {
  if (!codexHome || providerVersion === null || providerVersion === '') return null;
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
    /** 缓存必须标明生成版本和读取时间。 */
    const record = value as Record<string, unknown>;
    if (typeof record.client_version !== 'string' || !record.client_version || typeof record.fetched_at !== 'string' || !Array.isArray(record.models)) return null;
    if (providerVersion !== undefined && record.client_version !== providerVersion) return null;
    /** 未来时间不能成为永不失效的刷新凭据。 */
    const fetchedAtMs = Date.parse(record.fetched_at);
    if (!Number.isFinite(fetchedAtMs) || fetchedAtMs > Date.now() + 5_000) return null;
    /** 记录已出现的完整模型 ID，用于检测无效的重复声明。 */
    const models = new Set<string>();
    /** 与 model/list 的 includeHidden=false 使用相同展示范围。 */
    const visibleModels = new Set<string>();
    /** 保留每个模型的档位顺序和默认档位。 */
    const visibleReasoningEfforts = new Map<string, CodexReasoningCatalogEntry>();
    for (const model of record.models) {
      if (!model || typeof model !== 'object' || typeof model.slug !== 'string' || !model.slug || models.has(model.slug)) return null;
      if (model.visibility !== 'list' && model.visibility !== 'hide') return null;
      models.add(model.slug);
      if (model.visibility === 'list') {
        visibleModels.add(model.slug);
        if (Array.isArray(model.supported_reasoning_levels)) {
          const levels = model.supported_reasoning_levels.flatMap((level: unknown) => {
            if (level && typeof level === 'object' && 'effort' in level && typeof level.effort === 'string' && level.effort) return [level.effort];
            return [];
          });
          if (levels.length) {
            visibleReasoningEfforts.set(model.slug, { efforts: levels, defaultEffort: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : null });
          }
        }
      }
    }
    return { fetchedAtMs, visibleModels, visibleReasoningEfforts };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
