/** Codex 的加速档位按速度从低到高排列。标准速度使用 null。 */
export const codexAcceleratedServiceTiers = ['priority', 'ultrafast'] as const;

/** 可以由 Zeus 速度选择器请求的 Codex 加速档位。 */
export type CodexAcceleratedServiceTier = (typeof codexAcceleratedServiceTiers)[number];

/** 识别可保存并提交给 Codex 的加速档位。 */
export function isCodexAcceleratedServiceTier(value: unknown): value is CodexAcceleratedServiceTier {
  return codexAcceleratedServiceTiers.some((tier) => tier === value);
}
