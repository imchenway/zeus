import type { AppendAuditLogInput } from '@zeus/storage';
import type { ContextDispatchAuditPort, ContextDispatchAuditRecord, ContextProviderPreflightAuditRecord } from './contextDispatchService.js';

export interface CreateContextDispatchAuditPortOptions {
  append(input: AppendAuditLogInput): void;
  commit(): Promise<void>;
  now(): Date;
}

/** 把 Context manifest/decision 记入既有审计账本；只保存身份、hash、计数和选择理由，不复制正文。 */
export function createContextDispatchAuditPort(options: CreateContextDispatchAuditPortOptions): ContextDispatchAuditPort {
  return {
    async recordCompilation(record: ContextDispatchAuditRecord): Promise<void> {
      options.append({
        actorType: record.actorType,
        ...(record.actorRef ? { actorRef: record.actorRef } : {}),
        action: 'context.compiled',
        resourceType: 'compiled_context',
        resourceId: record.fingerprint,
        payload: {
          schemaVersion: record.schemaVersion,
          projectId: record.projectId,
          taskId: record.taskId,
          taskCode: record.taskCode,
          conversationId: record.conversationId,
          submissionId: record.submissionId,
          providerId: record.providerId,
          modelId: record.modelId,
          operationRisk: record.operationRisk,
          fingerprint: record.fingerprint,
          usedTokens: record.usedTokens,
          availableTokens: record.availableTokens,
          tokenAccounting: record.tokenAccounting,
          preflightTokenCount: record.preflightTokenCount,
          watermarks: record.watermarks,
          decisions: record.decisions,
        },
        createdAt: record.compiledAt,
      });
      await options.commit();
    },

    async recordProviderPreflight(record: ContextProviderPreflightAuditRecord): Promise<void> {
      options.append({
        actorType: 'zeus_context_compiler',
        action: record.accepted ? 'context.provider_preflight_accepted' : 'context.provider_preflight_rejected',
        resourceType: 'compiled_context',
        resourceId: record.fingerprint,
        payload: {
          schemaVersion: record.schemaVersion,
          providerId: record.providerId,
          modelId: record.modelId,
          contextWindowTokens: record.contextWindowTokens,
          reservedOutputTokens: record.reservedOutputTokens,
          inputTokens: record.result.inputTokens,
          exact: record.result.exact,
          source: record.result.source,
          countedAt: record.result.countedAt,
          accepted: record.accepted,
          remainingTokens: record.remainingTokens,
        },
        createdAt: options.now().toISOString(),
      });
      await options.commit();
    },
  };
}
