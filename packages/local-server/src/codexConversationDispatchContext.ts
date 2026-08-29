import type { CodexBootstrapAdditionalContext } from '@zeus/shared';
import type { ConversationRepository, ConversationSubmissionRepository, ConversationTurnRepository, ZeusConversationSubmissionRecord, ZeusConversationTurnRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import type { ConversationDispatchContext } from './codexNativeConversationContracts.js';
import { readCodexAdditionalContext } from './codexNativeContextProtocol.js';
import { coordinatorError, isRecord, parseJsonRecord, permissionModeFromValue } from './codexNativeConversationPolicy.js';
import type { ZeusConversationPluginRuntime } from './zeusConversationPluginRuntime.js';

export function contextFromPersistedSubmission(submission: ZeusConversationSubmissionRecord, conversation: ZeusConversationWithMessagesRecord | undefined): ConversationDispatchContext {
  const parsed = parseJsonRecord(submission.inputJson);
  const context = isRecord(parsed.context) ? parsed.context : {};
  const additionalContext = readCodexAdditionalContext(context.additionalContext);
  return {
    projectId: requiredString(typeof context.projectId === 'string' && context.projectId ? context.projectId : conversation?.projectId, 'submission projectId'),
    projectLocalPath: requiredString(context.projectLocalPath, 'submission projectLocalPath'),
    taskId: typeof context.taskId === 'string' ? context.taskId : null,
    ...(context.executionWorkspaceMode === 'direct' || context.executionWorkspaceMode === 'worktree' ? { executionWorkspaceMode: context.executionWorkspaceMode } : {}),
    model: requiredString(context.model, 'submission model'),
    modelSourceId: typeof context.modelSourceId === 'string' ? context.modelSourceId : (conversation?.modelSourceId ?? null),
    ...(typeof context.effort === 'string' ? { effort: context.effort } : {}),
    ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') && (context.serviceTier === null || typeof context.serviceTier === 'string') ? { serviceTier: context.serviceTier } : {}),
    allowCodeChanges: context.allowCodeChanges === true,
    allowTests: context.allowTests === true,
    allowGitCommit: context.allowGitCommit === true,
    permissionMode: permissionModeFromValue(context.permissionMode, context.allowCodeChanges === true ? 'auto' : 'read-only'),
    ...(Array.isArray(context.allowedAttachmentRoots) && context.allowedAttachmentRoots.every((root) => typeof root === 'string') ? { allowedAttachmentRoots: context.allowedAttachmentRoots } : {}),
    ...(Array.isArray(context.writableRoots) && context.writableRoots.every((root) => typeof root === 'string') ? { writableRoots: context.writableRoots } : {}),
    workMode: context.workMode === 'plan' || context.workMode === 'default' ? context.workMode : 'default',
    ...(context.applyLegacyTaskGuards === false ? { applyLegacyTaskGuards: false } : {}),
    ...(context.ephemeral === true ? { ephemeral: true } : {}),
    ...(additionalContext ? { additionalContext } : {}),
    ...(isRecord(context.operationContext) ? { operationContext: context.operationContext } : {}),
    ...(context.holdDispatch === true ? { holdDispatch: true } : {}),
  };
}

export function contextFromPersistedConversation(input: { conversation: ZeusConversationWithMessagesRecord; submissions: ZeusConversationSubmissionRecord[]; turns: ZeusConversationTurnRecord[] }): ConversationDispatchContext {
  const activeTurn = [...input.turns].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
  const submission =
    (activeTurn ? input.submissions.find((candidate) => candidate.id === activeTurn.clientSubmissionId) : undefined) ??
    [...input.submissions].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).at(-1);
  if (!submission) throw coordinatorError('ZEUS_NATIVE_CONTEXT_UNAVAILABLE', 'Native conversation dispatch context is unavailable.');
  return {
    ...contextFromPersistedSubmission(submission, input.conversation),
    permissionMode: input.conversation.permissionMode,
    workMode: input.conversation.collaborationMode,
  };
}

export async function prepareRecoveredCodexPlugins(input: {
  plugins?: ZeusConversationPluginRuntime;
  conversationIds: Iterable<string>;
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  turns: ConversationTurnRepository;
  contexts: Map<string, ConversationDispatchContext>;
}): Promise<void> {
  if (!input.plugins) return;
  for (const conversationId of input.conversationIds) {
    const conversation = input.conversations.getById(conversationId);
    if (!conversation) continue;
    const context = input.contexts.get(conversationId) ?? contextFromPersistedConversation({ conversation, submissions: input.submissions.listByConversation(conversationId), turns: input.turns.listByConversation(conversationId) });
    input.contexts.set(conversationId, context);
    await input.plugins.prepare({ conversationId, projectId: context.projectId, cwd: context.projectLocalPath, model: context.model, source: 'resume' });
  }
}

export async function emitPluginCompactionHook(input: {
  plugins?: ZeusConversationPluginRuntime;
  event: 'PreCompact' | 'PostCompact';
  conversationId: string;
  cwd: string;
  model: string;
  turnId?: string | null;
}): Promise<CodexBootstrapAdditionalContext | undefined> {
  if (!input.plugins) return undefined;
  const result = await input.plugins.emitHook({
    event: input.event,
    conversationId: input.conversationId,
    cwd: input.cwd,
    model: input.model,
    turnId: input.turnId,
    payload: { trigger: 'auto' },
  });
  if (!result.continue) throw coordinatorError('ZEUS_PLUGIN_HOOK_COMPACTION_BLOCKED', result.stopReasons.join('\n') || 'Plugin Hook 已阻断上下文压缩。');
  if (input.event !== 'PostCompact') return undefined;
  const sessionStart = await input.plugins.emitHook({
    event: 'SessionStart',
    conversationId: input.conversationId,
    cwd: input.cwd,
    model: input.model,
    turnId: input.turnId,
    payload: { source: 'compact' },
  });
  if (!sessionStart.continue) throw coordinatorError('ZEUS_PLUGIN_HOOK_COMPACTION_BLOCKED', sessionStart.stopReasons.join('\n') || 'Plugin SessionStart Hook 已停止压缩后的模型续接。');
  const value = [...sessionStart.systemMessages, ...sessionStart.additionalContext].filter(Boolean).join('\n');
  return value ? { zeus_plugin_compact_hook_context: { kind: 'application', value } } : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', `Missing ${label}.`);
  return value;
}
