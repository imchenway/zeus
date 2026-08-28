import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexModelCacheBudgetEvidence {
  contextWindowTokens: number;
  evidenceSource: string;
  checkedAt: string;
}

interface CachedModelCatalog {
  path: string;
  mtimeMs: number;
  size: number;
  value: unknown;
}

const maximumCatalogBytes = 8 * 1024 * 1024;
const maximumCatalogAgeMs = 30 * 24 * 60 * 60 * 1_000;
const maximumFutureClockSkewMs = 5 * 60 * 1_000;
let cachedCatalog: CachedModelCatalog | null = null;

/**
 * 读取当前 Codex CLI 自己维护的模型目录，只接纳版本、模型 ID、时间与文件边界都可核验的窗口证据。
 * 该目录跟随 CLI 小版本刷新，避免 Zeus 因补丁版本变化退回人工硬编码或猜测模型窗口。
 */
export function resolveCodexModelCacheBudget(input: { codexHome: string | null; providerVersion: string | null; modelId: string; now?: Date }): CodexModelCacheBudgetEvidence | null {
  const codexHome = input.codexHome?.trim();
  const providerVersion = input.providerVersion?.trim();
  const modelId = input.modelId.trim();
  if (!codexHome || !providerVersion || !modelId) return null;

  const catalogPath = join(codexHome, 'models_cache.json');
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(catalogPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumCatalogBytes) return null;
    let parsed: unknown;
    try {
      if (cachedCatalog && cachedCatalog.path === catalogPath && cachedCatalog.mtimeMs === stat.mtimeMs && cachedCatalog.size === stat.size) parsed = cachedCatalog.value;
      else {
        parsed = JSON.parse(readFileSync(fileDescriptor, 'utf8')) as unknown;
        cachedCatalog = { path: catalogPath, mtimeMs: stat.mtimeMs, size: stat.size, value: parsed };
      }
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.client_version !== providerVersion || typeof parsed.fetched_at !== 'string' || !Array.isArray(parsed.models)) return null;
    const fetchedAtMs = Date.parse(parsed.fetched_at);
    const nowMs = (input.now ?? new Date()).getTime();
    if (!Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs > maximumCatalogAgeMs || fetchedAtMs - nowMs > maximumFutureClockSkewMs) return null;

    const model = parsed.models.find((candidate) => isRecord(candidate) && candidate.slug === modelId);
    if (!isRecord(model) || !Number.isSafeInteger(model.context_window) || (model.context_window as number) <= 0) return null;
    return {
      contextWindowTokens: model.context_window as number,
      evidenceSource: `codex_cli_models_cache:${providerVersion}:${modelId}`,
      checkedAt: new Date(fetchedAtMs).toISOString(),
    };
  } finally {
    closeSync(fileDescriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
