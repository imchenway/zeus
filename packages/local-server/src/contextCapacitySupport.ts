import { piSdkBinaryVersion } from '@zeus/ai-runtime';
import { contextCapacityChoices, type ContextCapacityCapability } from '@zeus/shared';
import type { CodexCapabilitiesSnapshot, ModelConnectionRecord } from '@zeus/ai-runtime';

/** 选项由引擎窗口配置能力及模型目录上限共同决定。 */
export function readContextCapacitySupport(identity: { runtime: 'codex' | 'pi' | 'copilot'; runtimeVersion: string | null; sourceId: string; sourceRevision: string; modelId: string; contextWindow: number | null }): ContextCapacityCapability {
  if (identity.runtime === 'copilot') return { choices: [], reason: 'Copilot SDK 当前只报告模型窗口，不提供修改上下文容量的会话配置。' };
  const maximum = identity.contextWindow;
  const choices = maximum && identity.runtimeVersion ? [...new Set([...contextCapacityChoices.filter((capacity) => capacity <= maximum), maximum])].sort((a, b) => a - b) : [];
  return { choices, reason: choices.length ? '按当前引擎的模型目录设置上下文容量，压缩由引擎管理。' : '当前接入的上下文容量未知，请使用默认。' };
}

/** 新建、恢复、下一轮及界面共用同一容量来源。 */
export function resolveContextCapacityPolicy(native: CodexCapabilitiesSnapshot | null, connection: ModelConnectionRecord | undefined, modelId: string, runtime: 'codex' | 'pi' | 'copilot', managedContextWindow: number | null = null) {
  const model = connection?.models.find((candidate) => candidate.id === modelId);
  const budget = native?.modelBudgets[modelId];
  const contextWindow = model?.contextWindow ?? (runtime === 'codex' ? (budget?.maximumContextWindowTokens ?? budget?.contextWindowTokens) : runtime === 'copilot' ? managedContextWindow : null) ?? null;
  const identity = {
    runtime,
    runtimeVersion: runtime === 'pi' ? piSdkBinaryVersion : runtime === 'copilot' ? 'copilot-sdk' : (native?.providerVersion ?? null),
    sourceId: connection?.id ?? runtime,
    sourceRevision: connection?.updatedAt ?? `${runtime}-managed-account`,
    modelId,
    contextWindow,
  };
  return { ...identity, ...readContextCapacitySupport(identity), capacitySource: model ? `model_connection:${connection!.id}:${connection!.updatedAt}` : runtime === 'copilot' && contextWindow ? 'copilot_sdk_model_catalog' : (budget?.contextWindowSource ?? null) };
}
