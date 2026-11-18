/** Codex 模型目录声明的档位 ID，标准速度通常在请求中使用 null。 */
export type CodexServiceTierId = string;

/** 校验档位标识的格式。可用性由当前模型目录校验。 */
export function isCodexServiceTierId(value: unknown): value is CodexServiceTierId {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value);
}

/** 统一官方费率表和账本中已明确的档位别名。 */
export function normalizeCodexPricingServiceTier(value: string | null | undefined): string {
  if (value == null || value === 'standard') return 'default';
  return value === 'fast' ? 'priority' : value;
}
