export interface CodexVerifiedModelBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  evidenceSource: string;
  checkedAt: string;
}

/**
 * app-server 0.149.0 的 model/list 不再返回窗口与最大输出字段。
 * 这里只接纳与当前 CLI 版本、精确模型 ID 同时匹配的官方 CLI 模型目录证据；
 * 未知 CLI 或模型继续返回 null，由派发层失败关闭，禁止用系列名猜窗口。
 */
const verifiedBudgets = new Map<string, CodexVerifiedModelBudget>([
  [
    catalogKey('0.149.0', 'gpt-5.6-sol'),
    {
        contextWindowTokens: 272_000,
        reservedOutputTokens: 128_000,
        evidenceSource: 'codex_cli_model_registry:gpt-5.6-sol:codex-cli-0.149.0',
        checkedAt: '2026-08-22T00:00:00.000Z',
    },
  ],
    ...['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].map(
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
    catalogKey('0.149.0', 'gpt-5.4-mini'),
    {
        contextWindowTokens: 272_000,
      reservedOutputTokens: 128_000,
        evidenceSource: 'codex_cli_model_registry:gpt-5.4-mini:codex-cli-0.149.0',
        checkedAt: '2026-08-22T00:00:00.000Z',
    },
  ],
    [
        catalogKey('0.149.0', 'gpt-5.4'),
        {
            contextWindowTokens: 272_000,
            reservedOutputTokens: 128_000,
            evidenceSource: 'codex_cli_model_registry:gpt-5.4:codex-cli-0.149.0',
            checkedAt: '2026-08-22T00:00:00.000Z',
        },
    ],
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

export function resolveVerifiedCodexModelBudget(providerVersion: string | null, modelId: string): CodexVerifiedModelBudget | null {
  if (!providerVersion?.trim() || !modelId.trim()) return null;
  const budget = verifiedBudgets.get(catalogKey(providerVersion, modelId));
  return budget ? { ...budget } : null;
}

function catalogKey(providerVersion: string, modelId: string): string {
  return `${providerVersion.trim()}\u0000${modelId.trim()}`;
}
