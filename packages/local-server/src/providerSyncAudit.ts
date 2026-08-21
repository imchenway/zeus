import { createHash } from 'node:crypto';

export const providerSyncAuditSchemaGeneration = 'zeus-provider-sync-audit-v1' as const;

export type ProviderSyncAuditOutcome = 'checkpoint_initialized' | 'checkpoint_rebound' | 'reconciled' | 'history_gap_budget_exceeded' | 'history_gap_boundary_missing';

export interface ProviderSyncAuditInput {
  conversationId: string;
  provider: 'codex' | 'pi';
  providerVersion: string | null;
  protocolVersion: string;
  runtimeGenerationId: string;
  nativeThreadId: string;
  nativeSessionId: string;
  baselineTurnId: string | null;
  previousWaterlineTurnId: string | null;
  nextWaterlineTurnId: string | null;
  inspectedPageCount: number;
  inspectedTurnCount: number;
  outcome: ProviderSyncAuditOutcome;
  observedAt: string;
}

export interface ProviderSyncAuditPort {
  appendConfigEvidence(input: {
    conversationId: string;
    turnId?: string | null;
    submissionId?: string | null;
    segmentId?: string | null;
    layer: 'runtime_acknowledged';
    configuration: unknown;
    evidence: unknown;
    observedAt: string;
  }): string;
}

/**
 * 追加 Provider 同步身份与水位迁移证据。正文历史不进入审计行；identity/transition digest
 * 让离线核对能发现 generation、thread/session 或水位边界被静默替换。
 */
export function appendProviderSyncAudit(port: ProviderSyncAuditPort, input: ProviderSyncAuditInput): string {
  validateInput(input);
  const identity = {
    provider: input.provider,
    providerVersion: input.providerVersion,
    protocolVersion: input.protocolVersion,
    runtimeGenerationId: input.runtimeGenerationId,
    nativeThreadId: input.nativeThreadId,
    nativeSessionId: input.nativeSessionId,
  };
  const transition = {
    baselineTurnId: input.baselineTurnId,
    previousWaterlineTurnId: input.previousWaterlineTurnId,
    nextWaterlineTurnId: input.nextWaterlineTurnId,
    inspectedPageCount: input.inspectedPageCount,
    inspectedTurnCount: input.inspectedTurnCount,
    outcome: input.outcome,
  };
  return port.appendConfigEvidence({
    conversationId: input.conversationId,
    layer: 'runtime_acknowledged',
    configuration: {
      schemaGeneration: providerSyncAuditSchemaGeneration,
      ...identity,
      baselineTurnId: input.baselineTurnId,
      previousWaterlineTurnId: input.previousWaterlineTurnId,
      nextWaterlineTurnId: input.nextWaterlineTurnId,
    },
    evidence: {
      outcome: input.outcome,
      inspectedPageCount: input.inspectedPageCount,
      inspectedTurnCount: input.inspectedTurnCount,
      identityDigest: digest(identity),
      transitionDigest: digest({ identity, transition }),
      historicalBodyRead: false,
      fallbackFullThreadRead: false,
    },
    observedAt: input.observedAt,
  });
}

function validateInput(input: ProviderSyncAuditInput): void {
  for (const [field, value] of [
    ['conversationId', input.conversationId],
    ['protocolVersion', input.protocolVersion],
    ['runtimeGenerationId', input.runtimeGenerationId],
    ['nativeThreadId', input.nativeThreadId],
    ['nativeSessionId', input.nativeSessionId],
    ['observedAt', input.observedAt],
  ] as const) {
    if (!value.trim()) throw auditError(`Provider 同步审计字段不能为空：${field}`);
  }
  for (const [field, value] of [
    ['inspectedPageCount', input.inspectedPageCount],
    ['inspectedTurnCount', input.inspectedTurnCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw auditError(`Provider 同步审计计数无效：${field}`);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function auditError(message: string): Error & { code: 'ZEUS_PROVIDER_SYNC_AUDIT_INVALID' } {
  return Object.assign(new Error(message), { code: 'ZEUS_PROVIDER_SYNC_AUDIT_INVALID' as const });
}
