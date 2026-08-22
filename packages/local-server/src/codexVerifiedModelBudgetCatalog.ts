export interface CodexVerifiedModelBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  evidenceSource: string;
  checkedAt: string;
}

/**
 * app-server 0.149.0 的 model/list 不再返回窗口与最大输出字段。
 * 这里只接纳与当前 CLI 版本、精确模型 ID 同时匹配的 OpenAI 官方模型目录证据；
 * 未知 CLI 或模型继续返回 null，由派发层失败关闭，禁止用系列名猜窗口。
 */
const verifiedBudgets = new Map<string, CodexVerifiedModelBudget>([
  [
      catalogKey('0.149.0', 'gpt-5.6-sol'),
      {
          contextWindowTokens: 1_050_000,
          reservedOutputTokens: 128_000,
          evidenceSource: 'openai_official_model_catalog:gpt-5.6-sol:codex-cli-0.149.0',
          checkedAt: '2026-08-22T00:00:00.000Z',
      },
  ],
    [
    catalogKey('0.149.0', 'gpt-5.4-mini'),
    {
      contextWindowTokens: 400_000,
      reservedOutputTokens: 128_000,
      evidenceSource: 'openai_official_model_catalog:gpt-5.4-mini:codex-cli-0.149.0',
      checkedAt: '2026-08-22T00:00:00.000Z',
    },
  ],
]);

export function resolveVerifiedCodexModelBudget(providerVersion: string | null, modelId: string): CodexVerifiedModelBudget | null {
  if (!providerVersion?.trim() || !modelId.trim()) return null;
  const budget = verifiedBudgets.get(catalogKey(providerVersion, modelId));
  return budget ? { ...budget } : null;
}

function catalogKey(providerVersion: string, modelId: string): string {
  return `${providerVersion.trim()}\u0000${modelId.trim()}`;
}
