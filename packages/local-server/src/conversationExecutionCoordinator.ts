import { createHash } from 'node:crypto';
import type { CodexBootstrapAdditionalContext, PortableConversationContext } from '@zeus/shared';
import type {
  ConversationExecutionRepository,
  ConversationRuntimeKind,
  ConversationSubmissionRepository,
  ZeusConversationSubmissionRecord,
  ZeusDatabase,
} from '@zeus/storage';
import {
  applyPortableContextCompaction,
  planPortableContextCompaction,
  PortableConversationContextBuilder,
  type PortableContextCompactionPlan,
  type PortableContextTargetCapabilities,
} from './conversationPortableContext.js';

export interface ConversationExecutionRoute {
  runtimeKind: ConversationRuntimeKind;
  connectionId: string | null;
  credentialSlotId: string | null;
  endpointIdentity: string;
  protocolFamily: string;
  modelId: string;
  effort: string | null;
  serviceTier: string | null;
  permissionMode: string;
  collaborationMode: string;
  workspaceIdentity: unknown;
  providerId: string | null;
  providerModel: string;
  providerProtocolVersion: string | null;
  providerBinaryVersion: string | null;
}

export interface ConversationSegmentLifecycle {
  readonly requiresNewSegment: boolean;
  readonly portableContext: PortableConversationContext | null;
  readonly codexBootstrapAdditionalContext: CodexBootstrapAdditionalContext | null;
  readonly contextCompactionPlan: PortableContextCompactionPlan | null;
  prepare(submission: ZeusConversationSubmissionRecord): Promise<void>;
  beginDispatch(): Promise<void>;
  nativeSessionReady(input: { nativeSessionId: string; nativeSessionPath?: string | null; providerId?: string | null; providerModel?: string | null; providerProtocolVersion?: string | null; providerBinaryVersion?: string | null; observedAt: string }): void;
  adapterSerialized(configuration: unknown, evidence: unknown, observedAt: string): void;
  beginContextCompaction(observedAt: string): Promise<void>;
  completeContextCompaction(input: {
    summary: string;
    usage: {
      inputTokens: number | null;
      cachedInputTokens: number | null;
      cacheWriteInputTokens: number | null;
      outputTokens: number | null;
      reasoningOutputTokens: number | null;
      totalTokens: number | null;
    };
    evidence: unknown;
    completedAt: string;
  }): Promise<void>;
  failContextCompaction(error: unknown, failedAt: string): Promise<void>;
  markProviderWriteStarted(): void;
  rejectBeforeAcceptance(error: unknown, occurredAt: string): Promise<void>;
  acceptSynchronously(input: { providerTurnId: string; acceptedAt: string; runtimeEvidence: unknown; providerEcho?: unknown }): string;
  fail(error: unknown, occurredAt: string): Promise<void>;
}

interface CoordinatorOptions {
  db: ZeusDatabase;
  execution: ConversationExecutionRepository;
  submissions: ConversationSubmissionRepository;
  now: () => string;
}

/**
 * 产品会话唯一执行协调器。
 * Provider 适配器只报告原生会话、请求写入和运行时接纳，不再自行决定分段提升与历史序号。
 */
export class ConversationExecutionCoordinator {
  private readonly portableContext: PortableConversationContextBuilder;
  private readonly leases = new Map<string, string>();

  constructor(private readonly options: CoordinatorOptions) {
    this.portableContext = new PortableConversationContextBuilder(options.execution);
  }

  createLifecycle(input: { conversationId: string; route: ConversationExecutionRoute; targetCapabilities: PortableContextTargetCapabilities; userHistoryContent: unknown }): ConversationSegmentLifecycle {
    const current = this.options.execution.currentSegment(input.conversationId);
    const currentSnapshot = current?.executionSnapshotId ? this.options.execution.getExecutionSnapshot(current.executionSnapshotId) : undefined;
    const desiredFingerprint = routeFingerprint(input.route);
    const requiresNewSegment = !current || current.runtimeKind !== input.route.runtimeKind || currentSnapshot?.routeFingerprint !== desiredFingerprint;
    const portableContext = requiresNewSegment ? this.portableContext.build(input.conversationId, input.targetCapabilities) : null;
    const contextCompactionPlan = portableContext ? planPortableContextCompaction(portableContext, input.targetCapabilities) : null;
    let executionSnapshotId: string | null = null;
    let switchOperationId: string | null = null;
    let segmentId: string | null = current?.id ?? null;
    let submissionId: string | null = null;
    let providerWriteStarted = false;
    let acceptedByRuntime = false;
    let portableContextId: string | null = null;
    let compactionStartedAt: string | null = null;
    let compactionCompleted = false;

    const codexAdditionalContext = (): CodexBootstrapAdditionalContext | null => {
      if (!portableContext) return null;
      return this.portableContext.toCodexAdditionalContext(portableContext, input.route.workspaceIdentity);
    };

    return {
      requiresNewSegment,
      get portableContext() {
        return portableContext;
      },
      get codexBootstrapAdditionalContext() {
        return codexAdditionalContext();
      },
      contextCompactionPlan,
      prepare: async (submission) => {
        if (!this.options.execution.isDispatchEnabled()) throw executionError('ZEUS_CONVERSATION_DISPATCH_DISABLED', '统一会话存储仍在启动检查中，暂不允许派发。');
        if (submission.conversationId !== input.conversationId) throw executionError('ZEUS_CONVERSATION_SUBMISSION_SCOPE_MISMATCH', '提交不属于当前产品会话。');
        submissionId = submission.id;
        const existingSnapshot = submission.executionSnapshotId ? this.options.execution.getExecutionSnapshot(submission.executionSnapshotId) : undefined;
        if (existingSnapshot && existingSnapshot.routeFingerprint !== desiredFingerprint) {
          throw executionError('ZEUS_CONVERSATION_ROUTE_SNAPSHOT_MISMATCH', '提交冻结的语义路由与本次派发目标不一致。');
        }
        const snapshot =
          existingSnapshot ??
          this.options.execution.createExecutionSnapshot({
            conversationId: input.conversationId,
            runtimeKind: input.route.runtimeKind,
            connectionId: input.route.connectionId,
            credentialSlotId: input.route.credentialSlotId,
            endpointIdentity: input.route.endpointIdentity,
            protocolFamily: input.route.protocolFamily,
            modelId: input.route.modelId,
            effort: input.route.effort,
            serviceTier: input.route.serviceTier,
            permissionMode: input.route.permissionMode,
            collaborationMode: input.route.collaborationMode,
            workspaceIdentity: input.route.workspaceIdentity,
            createdAt: this.options.now(),
          });
        executionSnapshotId = snapshot.id;
        this.options.execution.freezeSubmissionExecutionSnapshot({
          conversationId: input.conversationId,
          submissionId: submission.id,
          executionSnapshotId: snapshot.id,
        });
        if (!existingSnapshot) {
          this.options.execution.appendConfigEvidence({
            conversationId: input.conversationId,
            submissionId: submission.id,
            layer: 'selected',
            configuration: routeConfiguration(input.route),
            evidence: { source: 'composer_request' },
            observedAt: snapshot.createdAt,
          });
          this.options.execution.appendConfigEvidence({
            conversationId: input.conversationId,
            submissionId: submission.id,
            layer: 'frozen',
            configuration: routeConfiguration(input.route),
            evidence: { executionSnapshotId: snapshot.id, routeFingerprint: snapshot.routeFingerprint },
            observedAt: snapshot.createdAt,
          });
        }
        await this.options.db.save();
      },
      beginDispatch: async () => {
        if (!submissionId || !executionSnapshotId) throw executionError('ZEUS_CONVERSATION_SEGMENT_NOT_PREPARED', '提交尚未冻结执行快照。');
        const activeLease = this.leases.get(input.conversationId);
        if (activeLease && activeLease !== submissionId) throw executionError('ZEUS_CONVERSATION_EXECUTION_LEASE_HELD', '产品会话已有一个活动切换操作。');
        this.leases.set(input.conversationId, submissionId);
        try {
          // 只有真实队首开始派发时才固定模型历史水位；入队阶段只冻结路由与权限配置。
          if (portableContext && !portableContextId) {
            portableContextId = this.options.execution.recordPortableContext({
              conversationId: input.conversationId,
              throughModelHistorySequence: portableContext.throughModelHistorySequence,
              targetExecutionSnapshotId: executionSnapshotId,
              status: contextCompactionPlan ? 'compacting' : 'ready',
              content: portableContext,
              capabilityLosses: portableContext.capabilityLosses,
              estimatedInputTokens: contextCompactionPlan?.estimatedInputTokens ?? null,
              occurredAt: this.options.now(),
            });
          }
          if (requiresNewSegment) {
            const operation = this.options.execution.beginSwitch({
              conversationId: input.conversationId,
              submissionId,
              executionSnapshotId,
              runtimeKind: input.route.runtimeKind,
              providerId: input.route.providerId,
              providerModel: input.route.providerModel,
              providerProtocolVersion: input.route.providerProtocolVersion,
              providerBinaryVersion: input.route.providerBinaryVersion,
              createdAt: this.options.now(),
            });
            switchOperationId = operation.id;
            segmentId = operation.targetSegmentId;
          } else if (current) {
            this.options.execution.bindSubmissionToCurrentSegment({ conversationId: input.conversationId, submissionId, executionSnapshotId, segmentId: current.id });
          }
          await this.options.db.save();
        } catch (error) {
          const failedAt = this.options.now();
          try {
            if (switchOperationId) this.options.execution.failBeforeProviderWrite(switchOperationId, serializeError(error), failedAt);
            else this.options.execution.pauseCurrentSubmissionBeforeProviderWrite(input.conversationId, submissionId, serializeError(error), failedAt);
            await this.options.db.save();
          } catch (compensationError) {
            this.releaseLease(input.conversationId, submissionId);
            throw new AggregateError([error, compensationError], '统一会话派发预备与补偿事务同时失败。');
          }
          this.releaseLease(input.conversationId, submissionId);
          throw error;
        }
      },
      nativeSessionReady: (native) => {
        if (!submissionId || !executionSnapshotId || !segmentId) throw executionError('ZEUS_CONVERSATION_SEGMENT_NOT_PREPARED', '运行分段尚未完成本地预备。');
        if (switchOperationId) {
          this.options.execution.updateProvisionalNativeIdentity(switchOperationId, { ...native, updatedAt: native.observedAt });
        } else {
          const active = this.options.execution.currentSegment(input.conversationId);
          if (!active || active.id !== segmentId || active.nativeSessionId !== native.nativeSessionId) {
            throw executionError('ZEUS_CONVERSATION_SEGMENT_IDENTITY_MISMATCH', '运行时会话身份与当前分段不一致。');
          }
        }
      },
      adapterSerialized: (configuration, evidence, observedAt) => {
        if (!submissionId) throw executionError('ZEUS_CONVERSATION_SEGMENT_NOT_PREPARED', '运行分段尚未完成本地预备。');
        this.options.execution.appendConfigEvidence({
          conversationId: input.conversationId,
          submissionId,
          segmentId,
          layer: 'adapter_serialized',
          configuration,
          evidence,
          observedAt,
        });
      },
      beginContextCompaction: async (observedAt) => {
        if (!contextCompactionPlan || !portableContext || !portableContextId || !submissionId || !segmentId) return;
        compactionStartedAt = observedAt;
        const turnId = stableCompactionTurnId(input.conversationId, segmentId, submissionId);
        this.options.execution.appendProcessItem({
          conversationId: input.conversationId,
          turnId,
          segmentId,
          kind: 'context_compaction',
          status: 'in_progress',
          title: '上下文压缩',
          detail: { model: input.route.modelId, estimatedInputTokens: contextCompactionPlan.estimatedInputTokens },
          sourceEventId: `context-compaction:${submissionId}`,
          startedAt: observedAt,
        });
        await this.options.db.save();
      },
      completeContextCompaction: async (completed) => {
        if (!contextCompactionPlan || !portableContext || !portableContextId || !submissionId || !segmentId || compactionCompleted) return;
        applyPortableContextCompaction(portableContext, contextCompactionPlan, completed.summary, input.route.runtimeKind);
        const turnId = stableCompactionTurnId(input.conversationId, segmentId, submissionId);
        const request = this.options.execution.observeModelRequest({
          conversationId: input.conversationId,
          turnId,
          segmentId,
          requestKind: 'context_compaction',
          modelId: input.route.modelId,
          contextWindow: input.targetCapabilities.contextWindow,
          inputTokens: completed.usage.inputTokens,
          cachedInputTokens: completed.usage.cachedInputTokens,
          cacheWriteInputTokens: completed.usage.cacheWriteInputTokens,
          outputTokens: completed.usage.outputTokens,
          reasoningOutputTokens: completed.usage.reasoningOutputTokens,
          totalTokens: completed.usage.totalTokens,
          estimatedUsd: null,
          usageComplete: Object.values(completed.usage).every((value) => value !== null),
          occurredAt: completed.completedAt,
        });
        this.options.execution.updatePortableContext({ id: portableContextId, status: 'compacted', content: portableContext, updatedAt: completed.completedAt });
        this.options.execution.recordContextCheckpoint({
          conversationId: input.conversationId,
          portableContextId,
          routeFingerprint: desiredFingerprint,
          throughModelHistorySequence: portableContext.throughModelHistorySequence,
          requestUsageId: request.id,
          summary: { summary: completed.summary, evidence: completed.evidence },
          status: 'completed',
          occurredAt: completed.completedAt,
        });
        this.options.execution.appendProcessItem({
          conversationId: input.conversationId,
          turnId,
          segmentId,
          kind: 'context_compaction',
          status: 'completed',
          title: '上下文压缩',
          detail: { model: input.route.modelId, usage: completed.usage, evidence: completed.evidence },
          sourceEventId: `context-compaction:${submissionId}`,
          startedAt: compactionStartedAt ?? completed.completedAt,
          completedAt: completed.completedAt,
        });
        compactionCompleted = true;
        await this.options.db.save();
      },
      failContextCompaction: async (error, failedAt) => {
        if (!contextCompactionPlan || !portableContext || !portableContextId || !submissionId || !segmentId) return;
        const failure = serializeError(error);
        const turnId = stableCompactionTurnId(input.conversationId, segmentId, submissionId);
        this.options.execution.updatePortableContext({ id: portableContextId, status: 'failed', content: portableContext, updatedAt: failedAt });
        this.options.execution.recordContextCheckpoint({
          conversationId: input.conversationId,
          portableContextId,
          routeFingerprint: desiredFingerprint,
          throughModelHistorySequence: portableContext.throughModelHistorySequence,
          requestUsageId: null,
          summary: { failure },
          status: 'failed',
          occurredAt: failedAt,
        });
        this.options.execution.appendProcessItem({
          conversationId: input.conversationId,
          turnId,
          segmentId,
          kind: 'context_compaction',
          status: 'failed',
          title: '上下文压缩失败',
          detail: failure,
          sourceEventId: `context-compaction:${submissionId}`,
          startedAt: compactionStartedAt ?? failedAt,
          completedAt: failedAt,
        });
        await this.options.db.save();
      },
      markProviderWriteStarted: () => {
        providerWriteStarted = true;
      },
      rejectBeforeAcceptance: async (error, occurredAt) => {
        if (acceptedByRuntime) return;
        if (switchOperationId) {
          this.options.execution.rejectSwitchBeforeAcceptance(switchOperationId, serializeError(error), occurredAt);
        } else if (submissionId) {
          this.options.execution.rejectCurrentSubmissionBeforeAcceptance(input.conversationId, submissionId, serializeError(error), occurredAt);
        }
        if (submissionId) this.releaseLease(input.conversationId, submissionId);
        await this.options.db.save();
      },
      acceptSynchronously: (accepted) => {
        if (!submissionId || !segmentId) throw executionError('ZEUS_CONVERSATION_SEGMENT_NOT_PREPARED', '运行分段尚未完成本地预备。');
        const turnId = stableTurnId(input.conversationId, segmentId, accepted.providerTurnId);
        this.options.execution.appendConfigEvidence({
          conversationId: input.conversationId,
          turnId,
          submissionId,
          segmentId,
          layer: 'runtime_acknowledged',
          configuration: routeConfiguration(input.route),
          evidence: accepted.runtimeEvidence,
          observedAt: accepted.acceptedAt,
        });
        let providerMismatch = false;
        if (accepted.providerEcho !== undefined) {
          const echoed = providerConfiguration(accepted.providerEcho);
          providerMismatch =
            (echoed.modelId !== null && echoed.modelId !== input.route.modelId) ||
            (echoed.effort !== null && echoed.effort !== input.route.effort) ||
            (echoed.serviceTier !== undefined && echoed.serviceTier !== input.route.serviceTier);
          this.options.execution.appendConfigEvidence({
            conversationId: input.conversationId,
            turnId,
            submissionId,
            segmentId,
            layer: 'provider_echo',
            configuration: echoed.raw,
            evidence: { providerEcho: accepted.providerEcho, verifiableFields: echoed.verifiableFields },
            mismatch: providerMismatch,
            observedAt: accepted.acceptedAt,
          });
        }
        if (switchOperationId) {
          this.options.execution.acceptSwitchDurably({
            operationId: switchOperationId,
            providerTurnId: accepted.providerTurnId,
            turnId,
            acceptanceEvidence: accepted.runtimeEvidence,
            userHistoryContent: input.userHistoryContent,
            acceptedAt: accepted.acceptedAt,
          });
        } else {
          this.options.execution.acceptOnCurrentSegmentDurably({
            conversationId: input.conversationId,
            submissionId,
            segmentId,
            providerTurnId: accepted.providerTurnId,
            turnId,
            userHistoryContent: input.userHistoryContent,
            acceptedAt: accepted.acceptedAt,
          });
        }
        acceptedByRuntime = true;
        if (providerMismatch) {
          try {
            this.options.execution.pauseQueuedAfterConfigurationMismatch(
              input.conversationId,
              submissionId,
              { expected: routeConfiguration(input.route), providerEcho: accepted.providerEcho },
              accepted.acceptedAt,
            );
          } catch (error) {
            // 持久接纳已经提交后不能再向适配器抛出“未接纳”；后处理失败只保留为持久警告。
            try {
              this.options.execution.persistWarning({
                conversationId: input.conversationId,
                warningKind: 'configuration_mismatch_pause_failed',
                payload: { submissionId, error: serializeError(error) },
                occurredAt: accepted.acceptedAt,
              });
            } catch {
              // 接纳事实优先；数据库后续保存仍会暴露底层持久化故障。
            }
          }
        }
        this.releaseLease(input.conversationId, submissionId);
        return turnId;
      },
      fail: async (error, occurredAt) => {
        if (acceptedByRuntime) return;
        if (switchOperationId) {
          if (providerWriteStarted) this.options.execution.markOutcomeUnknown(switchOperationId, serializeError(error), occurredAt);
          else this.options.execution.failBeforeProviderWrite(switchOperationId, serializeError(error), occurredAt);
        } else if (submissionId) {
          if (providerWriteStarted) this.options.execution.markCurrentSubmissionOutcomeUnknown(input.conversationId, submissionId, serializeError(error), occurredAt);
          else this.options.execution.pauseCurrentSubmissionBeforeProviderWrite(input.conversationId, submissionId, serializeError(error), occurredAt);
        }
        if (submissionId) this.releaseLease(input.conversationId, submissionId);
        await this.options.db.save();
      },
    };
  }

  snapshot(conversationId: string, turnId?: string | null) {
    return this.options.execution.snapshot(conversationId, turnId);
  }

  private releaseLease(conversationId: string, submissionId: string): void {
    if (this.leases.get(conversationId) === submissionId) this.leases.delete(conversationId);
  }
}

function routeFingerprint(route: ConversationExecutionRoute): string {
  return createHash('sha256').update(JSON.stringify([route.runtimeKind, route.connectionId, route.endpointIdentity, route.protocolFamily, route.modelId, route.credentialSlotId])).digest('hex');
}

function routeConfiguration(route: ConversationExecutionRoute): Record<string, unknown> {
  return {
    runtimeKind: route.runtimeKind,
    connectionId: route.connectionId,
    endpointIdentity: route.endpointIdentity,
    protocolFamily: route.protocolFamily,
    modelId: route.modelId,
    effort: route.effort,
    serviceTier: route.serviceTier,
    permissionMode: route.permissionMode,
    collaborationMode: route.collaborationMode,
  };
}

function stableTurnId(conversationId: string, segmentId: string, providerTurnId: string): string {
  return `conversation_turn_${createHash('sha256').update(`${conversationId}\0${segmentId}\0${providerTurnId}`).digest('hex').slice(0, 24)}`;
}

function stableCompactionTurnId(conversationId: string, segmentId: string, submissionId: string): string {
  return `conversation_compaction_turn_${createHash('sha256').update(`${conversationId}\0${segmentId}\0${submissionId}`).digest('hex').slice(0, 24)}`;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return { name: error.name, message: error.message, code: typeof candidate.code === 'string' ? candidate.code : null };
  }
  return { message: String(error) };
}

function providerConfiguration(value: unknown): {
  modelId: string | null;
  effort: string | null;
  serviceTier: string | null | undefined;
  raw: Record<string, unknown>;
  verifiableFields: string[];
} {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const modelId = typeof raw.model === 'string' ? raw.model : typeof raw.modelId === 'string' ? raw.modelId : null;
  const effort = typeof raw.effort === 'string' ? raw.effort : typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : null;
  const hasServiceTier = Object.prototype.hasOwnProperty.call(raw, 'serviceTier') && (raw.serviceTier === null || typeof raw.serviceTier === 'string');
  return {
    modelId,
    effort,
    serviceTier: hasServiceTier ? (raw.serviceTier as string | null) : undefined,
    raw,
    verifiableFields: [modelId !== null ? 'modelId' : null, effort !== null ? 'effort' : null, hasServiceTier ? 'serviceTier' : null].filter((entry): entry is string => entry !== null),
  };
}

function executionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
