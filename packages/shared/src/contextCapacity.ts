/** 上下文容量的常用候选值；1K 表示 1,000 Token，最终按模型能力筛选。 */
export const contextCapacityChoices = [64_000, 128_000, 256_000, 512_000, 1_000_000] as const;

/** 选择来源只作记录；已有会话不会重新读取项目偏好。 */
export type ContextCapacitySource = 'project' | 'explicit' | 'engine_default';

/** 引擎可配置且当前模型资料允许的窗口容量。 */
export interface ContextCapacityCapability {
  /** 可选容量，空数组时仍可使用默认。 */
  choices: number[];
  /** 容量资料来源或不可用原因。 */
  reason: string;
}

/** 不支持所选窗口时明确提示，不静默改成另一容量。 */
export function contextCapacityUnavailableReason(capability: ContextCapacityCapability | undefined): string {
  return capability?.choices.length ? '当前模型不支持所选上下文容量，请选择可用容量或默认。' : (capability?.reason ?? '当前接入的上下文容量未知，请使用默认。');
}

/** 空值撤销 Zeus 容量覆盖；拒绝字符串、非整数及非法数值。 */
export function assertContextCapacity(value: unknown): asserts value is number | null {
  if (value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return;
  throw Object.assign(new Error('上下文容量必须为正整数 Token 或默认。'), { code: 'ZEUS_CONTEXT_CAPACITY_INVALID', statusCode: 400 });
}

/** 只验证窗口容量，不减去或设置引擎的压缩预留。 */
export function assertContextCapacitySupported(capacity: number | null, maximum: number | null | undefined): void {
  assertContextCapacity(capacity);
  if (capacity === null) return;
  if (!Number.isSafeInteger(maximum) || maximum! <= 0 || capacity > maximum!) {
    throw Object.assign(new Error('当前模型容量未知或不足，请选择更小容量或默认。'), { code: 'ZEUS_CONTEXT_CAPACITY_UNSUPPORTED', statusCode: 400 });
  }
}

/** 原生窗口配置的运行证据；与旧压缩目标记录隔离。 */
export interface ContextCapacityEvidence {
  /** 发出配置和引擎确认分别记录。 */
  status: 'sent' | 'confirmed';
  /** 确认时间。 */
  observedAt: string;
  /** 此次应用的用户选择，空值表示默认。 */
  contextCapacityTokens: number | null;
  /** 引擎实际窗口读回。 */
  contextWindow: number | null;
}
