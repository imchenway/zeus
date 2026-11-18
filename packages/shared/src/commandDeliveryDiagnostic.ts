/** 重放拦截时冻结的投递状态，只保留私有故障报告所需字段。 */
export interface CommandDeliveryDiagnostic {
  /** 命令身份的 SHA-256，只用于关联投递记录。 */
  commandIdSha256: string;
  /** 由命令身份和尝试次序生成的派发记录身份。 */
  outboxId: string;
  /** 从 1 开始的派发尝试次序。 */
  attempt: number;
  /** 触发重放拦截时的耐久状态。 */
  state: 'provider_write_started' | 'resolved';
  /** 未收口的派发还没有结果，使用空值。 */
  outcome: 'outcome_unknown_after_write' | 'accepted' | null;
  /** 没有已记录的回执时为空值，禁止从投递状态推导回执。 */
  receipt: { id: string; outcome: 'outcome_unknown_after_write' | 'accepted'; occurredAt: string } | null;
}

/** 只接受固定格式的身份、状态和回执，丢弃命令正文等任意扩展字段。 */
export function normalizeCommandDeliveryDiagnostic(value: unknown): CommandDeliveryDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { commandIdSha256, outboxId, attempt, state, outcome, receipt } = value as Record<string, unknown>;
  if (typeof commandIdSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(commandIdSha256) || typeof outboxId !== 'string' || !/^command_outbox_[0-9a-f]{32}$/u.test(outboxId)) return undefined;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) return undefined;
  if (state === 'provider_write_started' && outcome === null && receipt === null) return { commandIdSha256, outboxId, attempt, state, outcome, receipt };
  if (state !== 'resolved' || (outcome !== 'outcome_unknown_after_write' && outcome !== 'accepted')) return undefined;
  if (receipt === null) return { commandIdSha256, outboxId, attempt, state, outcome, receipt };
  if (!receipt || typeof receipt !== 'object') return undefined;
  const { id, outcome: receiptOutcome, occurredAt } = receipt as Record<string, unknown>;
  if (typeof id !== 'string' || !/^command_receipt_[0-9a-f]{32}$/u.test(id) || receiptOutcome !== outcome || typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))) return undefined;
  return { commandIdSha256, outboxId, attempt, state, outcome, receipt: { id, outcome, occurredAt: new Date(occurredAt).toISOString() } };
}

/** 从原错误或有限层数的包装原因读取投递证据。 */
export function readCommandDeliveryDiagnostic(error: unknown): CommandDeliveryDiagnostic | undefined {
  for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth++) {
    const value = error as Record<string, unknown>;
    const diagnostic = normalizeCommandDeliveryDiagnostic(value.commandDelivery);
    if (diagnostic) return diagnostic;
    error = value.cause;
  }
  return undefined;
}
