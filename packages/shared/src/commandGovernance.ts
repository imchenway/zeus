/**
 * Command、Provider 与恢复状态的机读治理契约。
 *
 * 这里不声称跨 SQLite、Provider 与文件系统的 exactly-once。transition 描述允许的领域推进，
 * concurrency 则指向运行时真实使用的 revision/CAS/稳定身份边界；架构 verifier 会把状态联合
 * 类型、SQLite/文件恢复证据和本表逐项核对，新增状态或删除 CAS 证据都会失败关闭。
 */

export type CommandGovernanceCategory = 'command' | 'provider' | 'recovery';
export type CommandConcurrencyKind = 'immutable_identity' | 'expected_revision' | 'expected_updated_at' | 'generation_cas' | 'state_cas' | 'offline_lease_and_hash';

export interface CommandGovernanceStateMachine {
  id: string;
  category: CommandGovernanceCategory;
  stateType: { file: string; exportName: string };
  states: readonly string[];
  transitions: Readonly<Record<string, readonly string[]>>;
  terminalStates: readonly string[];
  concurrencyPolicyIds: readonly string[];
}

export interface CommandConcurrencyPolicy {
  id: string;
  category: CommandGovernanceCategory;
  kind: CommandConcurrencyKind;
  sourceFiles: readonly string[];
  evidenceMarkers: readonly string[];
  semantics: string;
}

export const commandGovernanceStateMachines = [
  {
    id: 'command_delivery_attempt',
    category: 'command',
    stateType: { file: 'packages/storage/src/commandDeliveryStore.ts', exportName: 'CommandDeliveryAttemptState' },
    states: ['prepared', 'provider_write_started', 'failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted'],
    transitions: {
      prepared: ['provider_write_started', 'failed_before_write', 'explicitly_rejected', 'accepted'],
      provider_write_started: ['explicitly_rejected', 'outcome_unknown_after_write', 'accepted'],
      failed_before_write: [],
      explicitly_rejected: [],
      outcome_unknown_after_write: ['accepted'],
      accepted: [],
    },
    terminalStates: ['failed_before_write', 'explicitly_rejected', 'accepted'],
    concurrencyPolicyIds: ['command_immutable_identity', 'command_delivery_state_cas', 'provider_generation_cas'],
  },
  {
    id: 'command_run',
    category: 'command',
    stateType: { file: 'packages/shared/src/commands.ts', exportName: 'CommandRunStatus' },
    states: ['pending_confirmation', 'starting', 'running', 'stopping', 'succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'],
    transitions: {
      pending_confirmation: ['starting', 'cancelled', 'rejected'],
      starting: ['running', 'failed', 'timed_out', 'cancelled', 'rejected'],
      running: ['stopping', 'succeeded', 'failed', 'timed_out', 'cancelled'],
      stopping: ['succeeded', 'failed', 'timed_out', 'cancelled'],
      succeeded: [],
      failed: [],
      timed_out: [],
      cancelled: [],
      rejected: [],
    },
    terminalStates: ['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'],
    concurrencyPolicyIds: ['command_immutable_identity', 'command_delivery_state_cas'],
  },
  {
    id: 'conversation_submission',
    category: 'provider',
    stateType: { file: 'packages/storage/src/conversationStore.ts', exportName: 'ConversationSubmissionStatus' },
    states: ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'],
    transitions: {
      queued: ['dispatching', 'paused', 'failed', 'cancelled', 'deleted'],
      dispatching: ['queued', 'active', 'paused', 'failed', 'cancelled', 'deleted'],
      active: ['paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'],
      paused: ['queued', 'dispatching', 'active', 'failed', 'cancelled', 'deleted'],
      completed: ['deleted'],
      resolved: ['deleted'],
      failed: ['deleted'],
      cancelled: ['deleted'],
      deleted: [],
    },
    terminalStates: ['deleted'],
    concurrencyPolicyIds: ['command_immutable_identity', 'provider_generation_cas'],
  },
  {
    id: 'conversation_turn',
    category: 'provider',
    stateType: { file: 'packages/storage/src/conversationStore.ts', exportName: 'ConversationTurnStatus' },
    states: ['queued', 'dispatching', 'running', 'waiting', 'paused', 'completed', 'interrupted', 'failed'],
    transitions: {
      queued: ['dispatching', 'running', 'paused', 'interrupted', 'failed'],
      dispatching: ['running', 'waiting', 'paused', 'completed', 'interrupted', 'failed'],
      running: ['waiting', 'paused', 'completed', 'interrupted', 'failed'],
      waiting: ['running', 'paused', 'completed', 'interrupted', 'failed'],
      paused: ['running', 'interrupted', 'failed'],
      completed: [],
      interrupted: [],
      failed: [],
    },
    terminalStates: ['completed', 'interrupted', 'failed'],
    concurrencyPolicyIds: ['command_immutable_identity', 'provider_generation_cas', 'handoff_request_snapshot_cas'],
  },
  {
    id: 'conversation_provider',
    category: 'provider',
    stateType: { file: 'packages/storage/src/conversationStore.ts', exportName: 'ConversationProviderState' },
    states: ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'],
    transitions: {
      unbound: ['binding', 'ready', 'archived', 'closed', 'failed'],
      binding: ['ready', 'active', 'paused', 'failed'],
      ready: ['binding', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'],
      active: ['ready', 'waiting', 'paused', 'archived', 'closed', 'failed'],
      waiting: ['active', 'ready', 'paused', 'archived', 'closed', 'failed'],
      paused: ['binding', 'ready', 'active', 'archived', 'closed', 'failed'],
      archived: ['ready', 'closed'],
      closed: [],
      failed: ['binding', 'paused', 'closed'],
    },
    terminalStates: ['closed'],
    concurrencyPolicyIds: ['provider_generation_cas', 'handoff_request_snapshot_cas'],
  },
  {
    id: 'provider_native_operation',
    category: 'provider',
    stateType: { file: 'packages/local-server/src/codexNativeConversationContracts.ts', exportName: 'NativeOperationStatus' },
    states: ['queued', 'active', 'steering', 'steered', 'interrupted', 'responded', 'provider_archived', 'recovery_required'],
    transitions: {
      queued: ['active', 'interrupted', 'recovery_required'],
      active: ['steering', 'interrupted', 'responded', 'provider_archived', 'recovery_required'],
      steering: ['active', 'steered', 'interrupted', 'recovery_required'],
      steered: ['active', 'interrupted', 'responded', 'recovery_required'],
      interrupted: [],
      responded: [],
      provider_archived: [],
      recovery_required: [],
    },
    terminalStates: ['interrupted', 'responded', 'provider_archived', 'recovery_required'],
    concurrencyPolicyIds: ['command_immutable_identity', 'provider_generation_cas'],
  },
  {
    id: 'runtime_session',
    category: 'provider',
    stateType: { file: 'packages/storage/src/runtimeSessionStore.ts', exportName: 'RuntimeSessionStatus' },
    states: ['running', 'exited', 'failed', 'stopped', 'orphan_detected', 'lost'],
    transitions: {
      running: ['exited', 'failed', 'stopped', 'orphan_detected', 'lost'],
      orphan_detected: ['running', 'exited', 'failed', 'stopped', 'lost'],
      exited: [],
      failed: [],
      stopped: [],
      lost: [],
    },
    terminalStates: ['exited', 'failed', 'stopped', 'lost'],
    concurrencyPolicyIds: ['command_immutable_identity', 'provider_generation_cas'],
  },
  {
    id: 'execution_host_handoff',
    category: 'recovery',
    stateType: { file: 'packages/storage/src/executionHostHandoffStore.ts', exportName: 'ExecutionHostHandoffStatus' },
    states: ['draining', 'prepared', 'claimed', 'completed', 'recovery_required', 'aborted'],
    transitions: {
      draining: ['prepared', 'recovery_required', 'aborted'],
      prepared: ['claimed', 'recovery_required'],
      claimed: ['completed', 'recovery_required'],
      completed: [],
      recovery_required: [],
      aborted: [],
    },
    terminalStates: ['completed', 'recovery_required', 'aborted'],
    concurrencyPolicyIds: ['handoff_request_snapshot_cas', 'provider_generation_cas'],
  },
  {
    id: 'storage_health',
    category: 'recovery',
    stateType: { file: 'packages/storage/src/index.ts', exportName: 'ZeusStorageHealthState' },
    states: ['writable', 'read_only_fault', 'read_only_validation'],
    transitions: {
      writable: ['read_only_fault'],
      read_only_fault: [],
      read_only_validation: [],
    },
    terminalStates: ['read_only_fault', 'read_only_validation'],
    concurrencyPolicyIds: ['storage_restart_revalidation'],
  },
  {
    id: 'recovery_promotion',
    category: 'recovery',
    stateType: { file: 'packages/storage/src/recoveryCandidatePromotion.ts', exportName: 'RecoveryPromotionPhase' },
    states: ['preflight', 'managed_data_prepared', 'rollback_ready', 'database_promoted', 'managed_data_activated', 'completed', 'rolled_back', 'failed'],
    transitions: {
      preflight: ['managed_data_prepared', 'rollback_ready', 'rolled_back', 'failed'],
      managed_data_prepared: ['rollback_ready', 'rolled_back', 'failed'],
      rollback_ready: ['database_promoted', 'rolled_back', 'failed'],
      database_promoted: ['managed_data_activated', 'completed', 'rolled_back', 'failed'],
      managed_data_activated: ['completed', 'rolled_back', 'failed'],
      completed: [],
      rolled_back: [],
      failed: [],
    },
    terminalStates: ['completed', 'rolled_back', 'failed'],
    concurrencyPolicyIds: ['recovery_offline_lease_and_hash'],
  },
] as const satisfies readonly CommandGovernanceStateMachine[];

export const commandConcurrencyPolicies = [
  {
    id: 'command_immutable_identity',
    category: 'command',
    kind: 'immutable_identity',
    sourceFiles: ['packages/shared/src/commandEnvelope.ts', 'packages/storage/src/commandDeliveryStore.ts'],
    evidenceMarkers: ['commandId', 'idempotencyKey', 'envelopeSha256', 'requestSha256', 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT'],
    semantics: '同一 commandId 只接受同一规范信封与请求摘要；冲突身份立即拒绝。',
  },
  {
    id: 'command_delivery_state_cas',
    category: 'command',
    kind: 'state_cas',
    sourceFiles: ['packages/storage/src/commandDeliveryStore.ts'],
    evidenceMarkers: ['assertDomainStateTransition', "WHERE id = ? AND state = 'prepared'", 'ZEUS_COMMAND_DELIVERY_STATE_CONFLICT'],
    semantics: 'prepare/write marker/outcome 只能从允许状态推进；unknown 禁止盲重放。',
  },
  {
    id: 'command_expected_revision',
    category: 'command',
    kind: 'expected_revision',
    sourceFiles: ['packages/shared/src/commandEnvelope.ts', 'packages/local-server/src/conversationCommandRoutes.ts'],
    evidenceMarkers: ['expectedRevision', 'assertExpectedRevision', 'ZEUS_COMMAND_EXPECTED_REVISION_CONFLICT', 'ZEUS_INVALID_ATTENTION_REVISION'],
    semantics: '有数值 revision 的领域必须精确 CAS；create 或无 revision 的外部能力显式使用 null。',
  },
  {
    id: 'task_expected_updated_at',
    category: 'command',
    kind: 'expected_updated_at',
    sourceFiles: ['packages/local-server/src/workManagementTaskOperations.ts', 'packages/storage/src/workManagementStore.ts'],
    evidenceMarkers: ['expectedUpdatedAt', 'ZEUS_TASK_EDIT_VERSION_REQUIRED', 'existing.updatedAt !== input.expectedUpdatedAt', 'updated_at = ?'],
    semantics: '任务编辑使用持久 updatedAt 作为版本令牌，陈旧编辑返回冲突而不覆盖新事实。',
  },
  {
    id: 'provider_generation_cas',
    category: 'provider',
    kind: 'generation_cas',
    sourceFiles: ['packages/storage/src/commandDeliveryStore.ts', 'packages/local-server/src/providerRuntimeRecoveryService.ts', 'packages/local-server/src/codexProviderCommandApplication.ts'],
    evidenceMarkers: ['providerGenerationId', 'generationId', 'expectedGenerationId', 'outcome_unknown_after_write'],
    semantics: 'Provider 写入绑定 owning generation 与稳定 native identity；跨 generation 不自动重发。',
  },
  {
    id: 'handoff_request_snapshot_cas',
    category: 'recovery',
    kind: 'state_cas',
    sourceFiles: ['packages/storage/src/executionHostHandoffStore.ts'],
    evidenceMarkers: ['identity_sha256', 'expected_conversation_updated_at', 'expected_turn_updated_at', 'pending_request_compare_and_swap_mismatch', 'SELECT changes() AS count'],
    semantics: 'handoff 逐请求重算身份与 checkpoint，并以请求、turn、conversation 稳定字段 CAS。',
  },
  {
    id: 'storage_restart_revalidation',
    category: 'recovery',
    kind: 'state_cas',
    sourceFiles: ['packages/storage/src/index.ts'],
    evidenceMarkers: ['read_only_fault', 'runWriteRecoveryPreflight', 'quick_check', 'recoveryRequiresCoreRestart'],
    semantics: '关键写失败后本 generation 永久只读；仅新 Core generation 重新核验写能力。',
  },
  {
    id: 'recovery_offline_lease_and_hash',
    category: 'recovery',
    kind: 'offline_lease_and_hash',
    sourceFiles: ['packages/storage/src/recoveryCandidatePromotion.ts'],
    evidenceMarkers: ['databaseWriterCount: 0', 'assertStillExclusive', 'expectedDatabaseSha256', 'rename(stagingDatabasePath, targetDatabasePath)', 'restoreDatabaseFromRollback'],
    semantics: '恢复提升只在 Core 停止、写入者为零的离线租约内按哈希原子替换并可回退。',
  },
] as const satisfies readonly CommandConcurrencyPolicy[];
