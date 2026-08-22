/**
 * 公共 Command 清单之外的内部副作用治理声明。
 *
 * 这里故意不把“内部调用”解释成 exactly-once。每项只声明它继承的接纳身份、真正写入
 * 边界、可恢复依据与回执位置；动态审计会从源码重新发现调用点，未知 capability 默认失败。
 */

export const internalSideEffectPolicies = [
  {
    id: 'git_external_command',
    effectClass: 'public_command_child',
    identityBoundary: '父级不可变 commandId、operationIdentity 与 inputSha256；Git ref/worktree 是稳定资源身份。',
    writeBoundary: '调用 @zeus/git-core 前置 write marker；ref 更新使用目标 HEAD/force-with-lease 等 CAS。',
    recoveryBoundary: 'failed-before-write 可由新命令重试；write 后未知必须检查 ref/worktree，不得盲重放。',
    receiptBoundary: 'Command Delivery receipt；大结果通过校验过的 ArtifactRef 返回。',
    evidence: [
      {
        file: 'packages/local-server/src/workspaceGitCommandApplication.ts',
        markers: ['operationIdentity', 'outcome_unknown_after_write', 'resultArtifact', 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'],
      },
      {
        file: 'packages/git-core/src/index.ts',
        markers: ['targetHeadSha', '--force-with-lease', 'ZEUS_TARGET_HEAD_CHANGED'],
      },
    ],
  },
  {
    id: 'git_durable_workflow',
    effectClass: 'durable_internal_effect',
    identityBoundary: '父级 task/integration command identity 与持久 integration/worktree identity。',
    writeBoundary: 'worktree/ref/file 写入前由父级 Command Delivery 记录 write marker，并校验 source/target HEAD。',
    recoveryBoundary: '以持久 attempt、targetHeadSha/resultHeadSha 和工作树现场继续或显式 recovery_required。',
    receiptBoundary: 'Integration/Workspace Git Command receipt；不从异常推断成功。',
    evidence: [
      {
        file: 'packages/local-server/src/integrationCommandApplication.ts',
        markers: ['operationIdentity', 'outcome_unknown_after_write', 'resultArtifact'],
      },
      {
        file: 'packages/git-core/src/index.ts',
        markers: ['sourceHeadSha', 'targetHeadSha', "['update-ref'"],
      },
    ],
  },
  {
    id: 'after_commit_activation',
    effectClass: 'durable_internal_effect',
    identityBoundary: '回调只能由同一 ZeusDatabase transaction 注册；业务事实先提交。',
    writeBoundary: 'afterCommit callback 在 durable transaction 成功后才被取出执行。',
    recoveryBoundary: '回调只负责唤醒；durable outbox/事实由启动恢复重新扫描，回调本身不是事实。',
    receiptBoundary: '对应 outbox/业务表 receipt，不为内存 callback 伪造独立成功回执。',
    evidence: [
      {
        file: 'packages/storage/src/index.ts',
        markers: ['afterCommitCallbacks', 'callbackCheckpoint', 'commitPendingTransaction', 'publishAfterCommitCallbacks'],
      },
    ],
  },
  {
    id: 'projection_generation',
    effectClass: 'durable_internal_effect',
    identityBoundary: 'projection kind、generationId 与 sourceDatabaseIdentity。',
    writeBoundary: '候选库生成后校验并原子 rename；enqueueIndexWrite 只写当前 ready generation。',
    recoveryBoundary: 'active/previous 双代与 degrade 状态；投影可由 SQLite 权威事实重建。',
    receiptBoundary: 'ProjectionDatabaseRuntimeState 发布 generation/availability，不冒充业务事实。',
    evidence: [
      {
        file: 'packages/storage/src/projectionDatabaseRuntime.ts',
        markers: ['sourceDatabaseIdentity', 'generationId', 'previousAvailable', 'enqueueIndexWrite'],
      },
    ],
  },
  {
    id: 'task_file_projection',
    effectClass: 'durable_outbox_consumer',
    identityBoundary: 'taskId、requestedRevision、targetEventId。',
    writeBoundary: 'SQLite outbox 先进入 write_started；两份投影文件 fsync/rename 后才 markAccepted。',
    recoveryBoundary: 'write_started 或游标不一致时重建，不在未知文件尾继续 append。',
    receiptBoundary: 'task_event_file_projection_outbox 的 appliedRevision/state/last_error_json。',
    evidence: [
      {
        file: 'packages/storage/src/taskEventFileProjectionStore.ts',
        markers: ['requestedRevision', 'write_started', 'markAccepted', 'markRetryable'],
      },
      {
        file: 'packages/local-server/src/taskEventFileProjectionService.ts',
        markers: ['recoveryNeeded', 'projectionFilesMatchCursor', 'await eventsHandle.sync()', 'await timelineHandle.sync()'],
      },
    ],
  },
  {
    id: 'work_management_effect',
    effectClass: 'durable_outbox_consumer',
    identityBoundary: '父命令派生 child commandId；队列和 active map 均以 commandId 去重。',
    writeBoundary: '外部 Telegram send 前写 Command Delivery marker。',
    recoveryBoundary: 'prepared 可恢复；write_started 无回执收口 unknown，禁止自动重发。',
    receiptBoundary: 'Command Delivery 四类 outcome 与任务事件。',
    evidence: [
      {
        file: 'packages/local-server/src/workManagementTaskEffectService.ts',
        markers: ['effect.parsed.command.commandId', 'await prepared.send()', 'outcome_unknown_after_write', 'listPreparedTaskStatusTelegramEffects'],
      },
      {
        file: 'packages/local-server/src/workManagementCommandApplication.ts',
        markers: ['failed_before_write', 'outcome_unknown_after_write', 'recordOutcomeInCurrentTransaction'],
      },
    ],
  },
  {
    id: 'heavy_worker_generation',
    effectClass: 'bounded_background_capability',
    identityBoundary: '每个 jobId 绑定 kind、protocolVersion 与 Core generation。',
    writeBoundary: 'Worker 只产生有 hash/byteLength 的只读投影；Core 接收后再走自己的持久边界。',
    recoveryBoundary: '模块默认 closed；队列、并发、超时、结果字节和 resourceLimits 有界，关闭会 terminate。',
    receiptBoundary: 'completed/failed Worker message 与 verified_inline_projection ResultRef。',
    evidence: [
      {
        file: 'packages/local-server/src/heavyWorkerPool.ts',
        markers: ['let closed = true', 'heavyWorkerQueueLimit', 'heavyWorkerTimeoutMs', 'maxResultBytes', 'job.worker.terminate()'],
      },
      {
        file: 'packages/local-server/src/heavyWorkerEntry.ts',
        markers: ['input.jobId', 'ZEUS_HEAVY_WORKER_RESULT_TOO_LARGE', 'sha256', "type: 'completed'"],
      },
    ],
  },
  {
    id: 'provider_process_generation',
    effectClass: 'generation_lifecycle_capability',
    identityBoundary: 'runtime session/process identity token 或 Provider generationId/requestId。',
    writeBoundary: '进程、IPC 或 socket 写入由上层 Command/Provider delivery 边界接纳；PID 信号前核验稳定身份。',
    recoveryBoundary: 'generation 漂移失败关闭；未知 Provider 写入不自动重发，进程关闭显式 drain/kill。',
    receiptBoundary: 'Runtime session/Provider command receipt 与 generation-scoped response。',
    evidence: [
      {
        file: 'packages/ai-runtime/src/index.ts',
        markers: ['processIdentityToken', 'onProcessIdentity', 'runtimeProcessTreeIsAlive', 'orphan_detected'],
      },
      {
        file: 'packages/ai-runtime/src/piRuntimeWorkerDriver.ts',
        markers: ['generationId', 'requestSequence', 'pendingRequests', 'ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN', 'current.kill'],
      },
      {
        file: 'packages/local-server/src/runtimeProcessIdentity.ts',
        markers: ['assertPersistedRuntimeProcessIdentity', 'persistedRuntimeProcessIdentityTokenPattern'],
      },
      {
        file: 'packages/local-server/src/piProviderCommandDelivery.ts',
        markers: ['markProviderWriteStarted', 'outcome_unknown_after_write', 'recordTurnAcceptedAtomically'],
      },
    ],
  },
  {
    id: 'provider_recovery_lifecycle',
    effectClass: 'generation_lifecycle_capability',
    identityBoundary: 'Provider generation、conversation/submission/import identity。',
    writeBoundary: '恢复只依据 Provider snapshot/history 与持久本地状态；close 冻结接纳并排空 handler。',
    recoveryBoundary: '无法证明的 dispatch window 转为 recovery_required，不自动制造 accepted。',
    receiptBoundary: 'conversation/import 持久状态与 recovery_failed audit/event。',
    evidence: [
      {
        file: 'packages/local-server/src/codexNativeConversationCoordinator.ts',
        markers: ['ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', "pausedReason: 'recovery_required'", 'closing = true', 'closed = true'],
      },
      {
        file: 'packages/local-server/src/codexLegacyImportService.ts',
        markers: ['readExternalAgentImportHistories', 'markFailed', 'await options.db.save()', 'closed = true'],
      },
    ],
  },
  {
    id: 'polling_command_or_handoff',
    effectClass: 'polling_command_child',
    identityBoundary: '用户轮询 command identity，或 Execution Host handoff admission generation。',
    writeBoundary: '用户路径由 TelegramCommandApplication 包裹；handoff 先冻结 mutation admission 再停/恢复 timer。',
    recoveryBoundary: '单 timer；handoff 仅在 fence 重新 open 时恢复，远端结果未知由父 command 处理。',
    receiptBoundary: 'Telegram Command receipt；handoff 路径由 execution_host_handoffs journal 记录。',
    evidence: [
      {
        file: 'packages/local-server/src/telegramPollingApi.ts',
        markers: ['executeExternal', 'polling_service_start', 'polling_timer_stop', 'ZEUS_TELEGRAM_POLL_RESULT_UNKNOWN'],
      },
      {
        file: 'packages/local-server/src/executionHostHandoffApi.ts',
        markers: ["fence.state() !== 'open'", 'clearInterval(timer)', 'service.stop()', 'service.pollOnce()'],
      },
    ],
  },
];

const gitExternalCommands = new Set(['fetchGitRemote', 'commitTaskWorkspace', 'pushTaskWorkspace', 'pushLocalBranch', 'executeHighRiskGitOperation', 'executeProjectGitAction']);

export const gitInternalSideEffectCapabilities = [
  'prepareTaskWorktree',
  'cleanupPreparedTaskWorktree',
  'refreshConflictTaskWorkspace',
  'fetchGitRemote',
  'commitTaskWorkspace',
  'pushTaskWorkspace',
  'pushLocalBranch',
  'reclaimTaskWorktree',
  'reclaimDeliveredTaskWorktree',
  'removeTaskWorktreeForTerminalStatus',
  'discardTaskWorktree',
  'startTaskBranchIntegration',
  'startTaskIntegrationAttempt',
  'writeTaskIntegrationResolution',
  'writeTaskIntegrationDraft',
  'completeTaskIntegrationCommit',
  'finalizeTaskBranchIntegration',
  'cleanupTaskIntegrationWorktree',
  'executeHighRiskGitOperation',
  'executeProjectGitAction',
].map((capability) => ({
  id: `git:${capability}`,
  capability,
  policyId: gitExternalCommands.has(capability) ? 'git_external_command' : 'git_durable_workflow',
}));

/** managedReceiver 会发现该 receiver 上的所有调用；新增 method 没有下面的精确项就失败。 */
export const coreInternalSideEffectCapabilities = [
  { id: 'core:afterCommit', selector: { kind: 'method_name', method: 'afterCommit', root: 'packages/local-server/src' }, policyId: 'after_commit_activation' },
  { id: 'core:projectionDatabases.start', selector: { kind: 'managed_receiver', receiver: 'projectionDatabases', method: 'start' }, policyId: 'projection_generation' },
  { id: 'core:projectionDatabases.enqueueIndexWrite', selector: { kind: 'managed_receiver', receiver: 'projectionDatabases', method: 'enqueueIndexWrite' }, policyId: 'projection_generation' },
  { id: 'core:projectionDatabases.close', selector: { kind: 'managed_receiver', receiver: 'projectionDatabases', method: 'close' }, policyId: 'projection_generation' },
  { id: 'core:taskEventFileProjectionOutbox.enqueue', selector: { kind: 'managed_receiver', receiver: 'taskEventFileProjectionOutbox', method: 'enqueue' }, policyId: 'task_file_projection' },
  { id: 'core:taskEventFileProjection.recover', selector: { kind: 'managed_receiver', receiver: 'taskEventFileProjection', method: 'recover' }, policyId: 'task_file_projection' },
  { id: 'core:taskEventFileProjection.schedule', selector: { kind: 'managed_receiver', receiver: 'taskEventFileProjection', method: 'schedule' }, policyId: 'task_file_projection' },
  { id: 'core:taskEventFileProjection.close', selector: { kind: 'managed_receiver', receiver: 'taskEventFileProjection', method: 'close' }, policyId: 'task_file_projection' },
  { id: 'core:workManagementTaskEffects.recover', selector: { kind: 'managed_receiver', receiver: 'workManagementTaskEffects', method: 'recover' }, policyId: 'work_management_effect' },
  { id: 'core:workManagementTaskEffects.schedule', selector: { kind: 'managed_receiver', receiver: 'workManagementTaskEffects', method: 'schedule' }, policyId: 'work_management_effect' },
  { id: 'core:workManagementTaskEffects.close', selector: { kind: 'managed_receiver', receiver: 'workManagementTaskEffects', method: 'close' }, policyId: 'work_management_effect' },
  { id: 'core:prepared.send', selector: { kind: 'file_callee', file: 'packages/local-server/src/workManagementTaskEffectService.ts', callee: 'prepared.send' }, policyId: 'work_management_effect' },
  { id: 'core:codexLegacyImportService.recover', selector: { kind: 'exact_callee', callee: 'codexLegacyImportService.recover' }, policyId: 'provider_recovery_lifecycle' },
  { id: 'core:codexLegacyImportService.close', selector: { kind: 'exact_callee', callee: 'codexLegacyImportService.close' }, policyId: 'provider_recovery_lifecycle' },
  { id: 'core:codexNativeCoordinator.recover', selector: { kind: 'exact_callee', callee: 'codexNativeCoordinator.recover' }, policyId: 'provider_recovery_lifecycle' },
  { id: 'core:codexNativeCoordinator.close', selector: { kind: 'exact_callee', callee: 'codexNativeCoordinator.close' }, policyId: 'provider_recovery_lifecycle' },
  { id: 'worker:activateHeavyWorkerJobs', selector: { kind: 'heavy_worker_export', callee: 'activateHeavyWorkerJobs' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:closeHeavyWorkerJobs', selector: { kind: 'heavy_worker_export', callee: 'closeHeavyWorkerJobs' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:runCodeMapHeavyJob', selector: { kind: 'heavy_worker_export', callee: 'runCodeMapHeavyJob' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:runGitDiffHeavyJob', selector: { kind: 'heavy_worker_export', callee: 'runGitDiffHeavyJob' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:runGitStatusHeavyJob', selector: { kind: 'heavy_worker_export', callee: 'runGitStatusHeavyJob' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:new Worker', selector: { kind: 'file_constructor', file: 'packages/local-server/src/heavyWorkerPool.ts', callee: 'Worker' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:worker.terminate', selector: { kind: 'file_method_name', file: 'packages/local-server/src/heavyWorkerPool.ts', method: 'terminate' }, policyId: 'heavy_worker_generation' },
  { id: 'worker:parentPort.postMessage', selector: { kind: 'file_callee', file: 'packages/local-server/src/heavyWorkerEntry.ts', callee: 'parentPort.postMessage' }, policyId: 'heavy_worker_generation' },
  { id: 'polling:telegram.service.start', selector: { kind: 'file_method_name', file: 'packages/local-server/src/telegramPollingApi.ts', method: 'start' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:telegram.service.stop', selector: { kind: 'file_method_name', file: 'packages/local-server/src/telegramPollingApi.ts', method: 'stop' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:telegram.service.pollOnce', selector: { kind: 'file_method_name', file: 'packages/local-server/src/telegramPollingApi.ts', method: 'pollOnce' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:telegram.setInterval', selector: { kind: 'file_callee', file: 'packages/local-server/src/telegramPollingApi.ts', callee: 'setInterval' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:telegram.clearInterval', selector: { kind: 'file_callee', file: 'packages/local-server/src/telegramPollingApi.ts', callee: 'clearInterval' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:handoff.service.start', selector: { kind: 'file_method_name', file: 'packages/local-server/src/executionHostHandoffApi.ts', method: 'start' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:handoff.service.stop', selector: { kind: 'file_method_name', file: 'packages/local-server/src/executionHostHandoffApi.ts', method: 'stop' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:handoff.service.pollOnce', selector: { kind: 'file_method_name', file: 'packages/local-server/src/executionHostHandoffApi.ts', method: 'pollOnce' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:handoff.setInterval', selector: { kind: 'file_callee', file: 'packages/local-server/src/executionHostHandoffApi.ts', callee: 'setInterval' }, policyId: 'polling_command_or_handoff' },
  { id: 'polling:handoff.clearInterval', selector: { kind: 'file_callee', file: 'packages/local-server/src/executionHostHandoffApi.ts', callee: 'clearInterval' }, policyId: 'polling_command_or_handoff' },
];

/** OS/IPC primitives are file-qualified because the same `.send()` may be HTTP、WebSocket 或 child IPC。 */
export const processInternalSideEffectCapabilities = [
  { id: 'process:ai-runtime.nodeSpawn', selector: { file: 'packages/ai-runtime/src/index.ts', callee: 'nodeSpawn' } },
  { id: 'process:ai-runtime.pty.spawn', selector: { file: 'packages/ai-runtime/src/index.ts', callee: 'pty.spawn' } },
  { id: 'process:ai-runtime.process.kill', selector: { file: 'packages/ai-runtime/src/index.ts', callee: 'process.kill' } },
  { id: 'process:ai-runtime.child.kill', selector: { file: 'packages/ai-runtime/src/index.ts', callee: 'child.kill' } },
  { id: 'process:ai-runtime.handle.kill', selector: { file: 'packages/ai-runtime/src/index.ts', callee: 'handle.kill' } },
  { id: 'process:codex-app-server.nodeSpawn', selector: { file: 'packages/ai-runtime/src/codexAppServerManager.ts', callee: 'nodeSpawn' } },
  { id: 'process:codex-app-server.spawned.kill', selector: { file: 'packages/ai-runtime/src/codexAppServerManager.ts', callee: 'spawned.kill' } },
  { id: 'process:codex-app-server.child.kill', selector: { file: 'packages/ai-runtime/src/codexAppServerManager.ts', callee: 'child.kill' } },
  { id: 'process:codex-app-server.process.kill', selector: { file: 'packages/ai-runtime/src/codexAppServerManager.ts', callee: 'process.kill' } },
  { id: 'process:codex-app-server.socket.send', selector: { file: 'packages/ai-runtime/src/codexAppServerManager.ts', callee: 'socket.send' } },
  { id: 'process:codex-app-server.socket.terminate', selector: { file: 'packages/ai-runtime/src/codexAppServerManager.ts', callee: 'socket.terminate' } },
    {
        id: 'process:codex-runtime-generation.nodeSpawn',
        selector: {file: 'packages/ai-runtime/src/codexRuntimeGenerationManager.ts', callee: 'nodeSpawn'}
    },
    {
        id: 'process:codex-runtime-generation.child.kill',
        selector: {file: 'packages/ai-runtime/src/codexRuntimeGenerationManager.ts', callee: 'child.kill'}
    },
  { id: 'process:pi-worker.fork', selector: { file: 'packages/ai-runtime/src/piRuntimeWorkerDriver.ts', callee: 'fork' } },
  { id: 'process:pi-worker.child.send', selector: { file: 'packages/ai-runtime/src/piRuntimeWorkerDriver.ts', callee: 'child.send' } },
  { id: 'process:pi-worker.current.kill', selector: { file: 'packages/ai-runtime/src/piRuntimeWorkerDriver.ts', callee: 'current.kill' } },
  { id: 'process:pi-worker.process.send', selector: { file: 'packages/ai-runtime/src/piSdkRuntimeWorker.ts', callee: 'process.send' } },
  { id: 'process:pi-tools.execFileAsync', selector: { file: 'packages/local-server/src/piNativeConversationCoordinator.ts', callee: 'execFileAsync' } },
  { id: 'process:runtime-recovery.spawnSync', selector: { file: 'packages/local-server/src/runtimeProcessIdentity.ts', callee: 'spawnSync' } },
  { id: 'process:runtime-recovery.process.kill', selector: { file: 'packages/local-server/src/runtimeProcessIdentity.ts', callee: 'process.kill' } },
].map((entry) => ({ ...entry, policyId: 'provider_process_generation' }));

export const internalSideEffectCapabilityRegistry = [...gitInternalSideEffectCapabilities, ...coreInternalSideEffectCapabilities, ...processInternalSideEffectCapabilities];
