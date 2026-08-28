import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexModelCapability } from './codexAppServerManager.js';

export interface CodexModelBudgetEvidence {
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly contextWindowSource: string;
  readonly reservedOutputSource: string;
  readonly checkedAt: string;
}

interface CodexModelCacheSnapshot {
  fetchedAt: string;
  windows: ReadonlyMap<string, number>;
}

interface VerifiedBudget {
  contextWindowTokens: number;
  reservedOutputTokens?: number;
  evidenceSource: string;
  checkedAt: string;
}

const maximumCatalogBytes = 8 * 1024 * 1024;
const maximumCatalogAgeMs = 30 * 24 * 60 * 60 * 1_000;
const maximumFutureClockSkewMs = 5 * 60 * 1_000;

/**
 * 在 app-server 完成握手时一次性冻结模型预算。发送路径只读取该代际快照，
 * 不再受之后被工具子进程改写的 models_cache.json 影响。
 */
export function resolveCodexModelBudgetSnapshot(input: {
  codexHome: string | null;
  generationId: string;
  initializedAt: string;
  providerVersion: string | null;
  models: readonly CodexModelCapability[];
}): Readonly<Record<string, Readonly<CodexModelBudgetEvidence>>> {
  const cache = readCompatibleModelCache(input.codexHome, input.providerVersion, input.initializedAt);
  const budgets: Record<string, CodexModelBudgetEvidence> = {};
  for (const model of input.models) {
    const reportedContextWindow = positiveIntegerOrNull(model.raw.contextWindow ?? model.raw.context_window ?? model.raw.modelContextWindow ?? model.raw.model_context_window);
    const cachedContextWindow = cache?.windows.get(model.model) ?? null;
    const verified = resolveVerifiedBudget(input.providerVersion, model.model);
    const contextWindowTokens = reportedContextWindow ?? cachedContextWindow ?? verified?.contextWindowTokens ?? null;
    if (!contextWindowTokens) continue;
    const reportedReservedOutput = positiveIntegerOrNull(model.raw.maxOutputTokens ?? model.raw.max_output_tokens ?? model.raw.maximumOutputTokens ?? model.raw.maximum_output_tokens);
    const reservedOutputTokens = Math.min(contextWindowTokens, reportedReservedOutput ?? verified?.reservedOutputTokens ?? Math.min(32_768, Math.max(8_192, Math.floor(contextWindowTokens / 8))));
    const appServerSource = `codex_app_server:${input.generationId}:model_catalog`;
    const cacheSource = input.providerVersion ? `codex_cli_models_cache:${input.providerVersion}:${model.model}` : null;
    budgets[model.model] = Object.freeze({
      contextWindowTokens,
      reservedOutputTokens,
      contextWindowSource: reportedContextWindow ? appServerSource : cachedContextWindow ? cacheSource! : verified!.evidenceSource,
      reservedOutputSource: reportedReservedOutput ? appServerSource : verified?.reservedOutputTokens ? verified.evidenceSource : 'zeus_conservative_window_eighth_max_32768',
      checkedAt: reportedContextWindow ? input.initializedAt : cachedContextWindow ? cache!.fetchedAt : verified!.checkedAt,
    });
  }
  return Object.freeze(budgets);
}

function readCompatibleModelCache(codexHome: string | null, providerVersion: string | null, initializedAt: string): CodexModelCacheSnapshot | null {
  if (!codexHome || !providerVersion) return null;
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(join(codexHome, 'models_cache.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumCatalogBytes) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fileDescriptor, 'utf8')) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.client_version !== providerVersion || typeof parsed.fetched_at !== 'string' || !Array.isArray(parsed.models)) return null;
    const fetchedAtMs = Date.parse(parsed.fetched_at);
    const initializedAtMs = Date.parse(initializedAt);
    if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(initializedAtMs) || initializedAtMs - fetchedAtMs > maximumCatalogAgeMs || fetchedAtMs - initializedAtMs > maximumFutureClockSkewMs) return null;
    const windows = new Map<string, number>();
    for (const candidate of parsed.models) {
      if (!isRecord(candidate) || typeof candidate.slug !== 'string') continue;
      const contextWindow = positiveIntegerOrNull(candidate.context_window);
      if (contextWindow) windows.set(candidate.slug, contextWindow);
    }
    return windows.size > 0 ? { fetchedAt: new Date(fetchedAtMs).toISOString(), windows } : null;
  } finally {
    closeSync(fileDescriptor);
  }
}

// 这些条目是按 Codex CLI 精确版本冻结的内置模型注册表证据，不允许跨版本推断。
// 0.150.1 注册表没有输出上限字段，因此仅固化上下文窗口，输出预留走上面的保守规则。
const verifiedBudgets = new Map<string, VerifiedBudget>([
  ...['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4'].map(
    (modelId) =>
      [
        catalogKey('0.150.1', modelId),
        {
          contextWindowTokens: 272_000,
          evidenceSource: `codex_cli_model_registry:${modelId}:codex-cli-0.150.1`,
          checkedAt: '2026-08-28T13:10:44.579Z',
        },
      ] as const,
  ),
  [
    catalogKey('0.150.1', 'gpt-5.3-codex-spark'),
    {
      contextWindowTokens: 128_000,
      evidenceSource: 'codex_cli_model_registry:gpt-5.3-codex-spark:codex-cli-0.150.1',
      checkedAt: '2026-08-28T13:10:44.579Z',
    },
  ],
  ...['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4'].map(
    (modelId) =>
      [
        catalogKey('0.149.0', modelId),
        {
          contextWindowTokens: 272_000,
          reservedOutputTokens: 128_000,
          evidenceSource: `codex_cli_model_registry:${modelId}:codex-cli-0.149.0`,
          checkedAt: '2026-08-22T00:00:00.000Z',
        },
      ] as const,
  ),
  [
    catalogKey('0.149.0', 'gpt-5.3-codex-spark'),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 64_000,
      evidenceSource: 'codex_cli_model_registry:gpt-5.3-codex-spark:codex-cli-0.149.0',
      checkedAt: '2026-08-22T00:00:00.000Z',
    },
  ],
]);

function resolveVerifiedBudget(providerVersion: string | null, modelId: string): VerifiedBudget | null {
  if (!providerVersion?.trim() || !modelId.trim()) return null;
  const budget = verifiedBudgets.get(catalogKey(providerVersion, modelId));
  return budget ? { ...budget } : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function catalogKey(providerVersion: string, modelId: string): string {
  return `${providerVersion.trim()}\u0000${modelId.trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
