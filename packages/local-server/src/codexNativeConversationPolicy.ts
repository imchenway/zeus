import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { type CodexAppServerEvent, type CodexCommandApprovalDecision, type CodexSandboxPolicy, type CodexServerRequestResponse, type CodexThreadSnapshot } from '@zeus/ai-runtime';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope, type TokenUsageBreakdown } from '@zeus/shared';
import { currentDatabasePerformanceTraceId } from '@zeus/storage';
import type {
  CodexMcpServerStartupState,
  ConversationCollaborationMode,
  ConversationItemPhase,
  ConversationItemType,
  ConversationPermissionMode,
  ConversationProviderItemRepository,
  ConversationServerRequestKind,
  ConversationServerRequestRepository,
  ProviderEventReceiptInput,
  ZeusConversationServerRequestRecord,
  ZeusConversationSubmissionRecord,
  ZeusConversationTurnRecord,
  ZeusConversationRecord,
  ZeusConversationWithMessagesRecord,
} from '@zeus/storage';
import type { NativeConversationAttachmentInput, NativeSubmissionError, RespondNativeRequestInput } from './codexNativeConversationContracts.js';
import { sanitizeConversationItemPayload } from './conversationResources.js';

interface ConversationDispatchContext {
  projectId: string;
  projectLocalPath: string;
  taskId: string | null;
  executionWorkspaceMode?: 'direct' | 'worktree';
  model: string;
  modelSourceId: string | null;
  effort?: string;
  serviceTier?: string | null;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  permissionMode: ConversationPermissionMode;
  allowedAttachmentRoots?: string[];
  writableRoots?: string[];
  workMode: ConversationCollaborationMode;
  applyLegacyTaskGuards?: boolean;
  ephemeral?: boolean;
  additionalContext?: Record<string, unknown>;
  operationContext?: Record<string, unknown>;
  holdDispatch?: boolean;
}

export function providerPermissionProfile(context: ConversationDispatchContext): { sandbox: CodexSandboxPolicy; approvalPolicy: 'on-request' | 'never'; approvalsReviewer: 'user' } {
  if (context.permissionMode === 'full-access') return { sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' };
  if (context.permissionMode === 'auto') {
    return {
      sandbox: { type: 'workspaceWrite', writableRoots: (context.writableRoots?.length ? context.writableRoots : [context.projectLocalPath]).map((root) => resolve(root)), networkAccess: false },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    };
  }
  return { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
}

export function stripRequestTransport(response: CodexServerRequestResponse): RespondNativeRequestInput['response'] {
  const effectiveResponse = { ...response } as Record<string, unknown>;
  delete effectiveResponse.generationId;
  delete effectiveResponse.requestId;
  return effectiveResponse as RespondNativeRequestInput['response'];
}

export type FileApprovalTargetAuditStatus = 'auditable' | 'outside_project' | 'provider_root_scope' | 'unavailable';

export interface FileApprovalTargetAudit {
  status: FileApprovalTargetAuditStatus;
  paths: string[];
}

export function nativePendingRequestProjection(
  request: ZeusConversationServerRequestRecord,
  authority?: {
    conversation: ZeusConversationRecord;
    projectRoot: string | null;
    providerItems: ConversationProviderItemRepository;
  },
): Record<string, unknown> {
  const payload = parseJsonRecord(request.payloadJson);
  return {
    id: request.id,
    conversationId: request.conversationId,
    turnId: request.turnId,
    itemId: request.itemId,
    generationId: request.transportGenerationId,
    type: request.requestKind === 'request_user_input' ? 'userInput' : request.requestKind === 'mcp' ? 'MCP' : request.requestKind,
    status: request.status,
    payload,
    response: request.responseJson ? parseJsonRecord(request.responseJson) : null,
    containsSecret: request.containsSecret,
    expiresAt: request.expiresAt,
    autoResolutionState: request.autoResolutionState,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
    ...(request.requestKind === 'file' && authority
      ? {
          fileApproval: inspectFileApprovalTargets(payload, authority.conversation, authority.projectRoot, authority.providerItems),
        }
      : {}),
  };
}

export function buildInteractionRecoveryContinuation(request: ZeusConversationServerRequestRecord, response: RespondNativeRequestInput['response'], privacyNote?: string): string {
  const approvalBoundary = request.requestKind === 'command' || request.requestKind === 'file' || request.requestKind === 'permissions';
  return [
    'Zeus 已在请求通道切换后的安全恢复点继续当前会话。请从这里继续，不要重复此前已经完成的操作或副作用。',
    `待处理请求类型：${request.requestKind}`,
    `待处理请求：${request.payloadJson}`,
    `用户本次回复：${JSON.stringify(response)}`,
    ...(approvalBoundary ? ['安全边界：这次决定只针对上面记录的原操作。若继续执行命令、文件修改或权限操作，必须重新发出完全明确的操作请求，由 Zeus 按新宿主的当前策略再次校验；不得把该决定套用到任何不同操作。'] : []),
    ...(privacyNote ? [privacyNote] : []),
  ].join('\n\n');
}

export function buildInteractionRecoveryDisplayText(request: ZeusConversationServerRequestRecord, response: RespondNativeRequestInput['response']): string {
  if (request.containsSecret) return '已提交敏感回答';
  if (response.type === 'request_user_input') {
    const answers = Object.values(response.answers).flatMap((answer) => answer.answers);
    return answers.length > 0 ? answers.join('；') : '已回复';
  }
  if ('decision' in response && typeof response.decision === 'string') return `已选择：${response.decision}`;
  if (response.type === 'permissions') return '已回复权限请求';
  if (response.type === 'mcp') return '已回复外部工具请求';
  return '已回复';
}

export function replayResolvedRequest(request: NonNullable<ReturnType<ConversationServerRequestRepository['getById']>>, providerRequestId: string | number): CodexServerRequestResponse | null {
  if (request.containsSecret || !request.responseJson) return null;
  let response: unknown;
  try {
    response = JSON.parse(request.responseJson);
  } catch {
    return null;
  }
  if (!isRecord(response)) return null;
  const expectedType: Record<ConversationServerRequestKind, string> = {
    command: 'command',
    file: 'file',
    permissions: 'permissions',
    request_user_input: 'request_user_input',
    mcp: 'mcp',
  };
  if (response.type !== expectedType[request.requestKind]) return null;
  const providerResponse = { ...response };
  delete providerResponse.answerAttachments;
  return {
    ...providerResponse,
    generationId: request.transportGenerationId,
    requestId: providerRequestId,
  } as CodexServerRequestResponse;
}

export function developerInstructionsFor(context: ConversationDispatchContext, browserToolsAvailable: boolean): string {
  const instructions: string[] = [];
  if (browserToolsAvailable) {
    instructions.push(
      '用户未明确指定其他浏览器时，在 Zeus 会话中执行网页打开、导航、点击、输入、页面检查或截图，必须优先使用当前会话的 zeus_browser 动态工具。不得把 Codex Browser 插件返回的浏览器列表为空视为 Zeus 内置浏览器不可用，也不得因此改用外部 Playwright。用户明确点名其他浏览器时，尊重该选择并如实报告其可用性。',
    );
  }
  if (context.applyLegacyTaskGuards !== false) {
    if (!context.allowTests) instructions.push('不得运行会修改项目状态的测试。');
    if (!context.allowGitCommit) instructions.push('不得执行 git commit、push、merge、rebase、reset、revert、stash、checkout -b 或其他 Git 历史修改动作。');
  }
  return instructions.join('\n');
}

export function permissionModeFromValue(value: unknown, fallback: ConversationPermissionMode): ConversationPermissionMode {
  return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : fallback;
}

export function providerEventReceipt(event: CodexAppServerEvent, identity: string): ProviderEventReceiptInput {
  const params = isRecord(event.params) ? event.params : {};
  return {
    identity,
    generationId: event.generationId,
    sequence: event.sequence,
    method: event.method,
    threadId: typeof params.threadId === 'string' ? params.threadId : null,
    providerTurnId: providerTurnIdFrom(params),
    providerItemId: providerItemIdFrom(params),
    requestId: event.requestId === undefined ? null : String(event.requestId),
    receivedAt: event.receivedAt,
  };
}

export function providerTurnIdFrom(params: Record<string, unknown>): string | null {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof params.turnId === 'string' ? params.turnId : typeof turn.id === 'string' ? turn.id : null;
}

export function providerTurnUserClientId(turn: Record<string, unknown>): string | null {
  if (!Array.isArray(turn.items)) return null;
  for (const candidate of turn.items) {
    if (!isRecord(candidate) || candidate.type !== 'userMessage') continue;
    if (typeof candidate.clientId === 'string' && candidate.clientId.trim()) return candidate.clientId;
  }
  return null;
}

export function providerTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return new Date(value * 1_000).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

export function providerTurnStatus(params: Record<string, unknown>): string {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof turn.status === 'string' ? turn.status : typeof params.status === 'string' ? params.status : 'unknown';
}

export function providerTurnTerminalStatus(params: Record<string, unknown>): 'completed' | 'interrupted' | 'failed' {
  const status = providerTurnStatus(params);
  return status === 'completed' || status === 'interrupted' || status === 'failed' ? status : 'failed';
}

export function normalizeTurnPlan(params: Record<string, unknown>): {
  explanation: string | null;
  steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>;
} {
  if (!(params.explanation === null || typeof params.explanation === 'string')) {
    throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Invalid turn plan explanation.');
  }
  if (!Array.isArray(params.plan)) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Invalid turn plan steps.');
  const steps = params.plan.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.step !== 'string' || !candidate.step.trim()) {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid turn plan step at index ${index}.`);
    }
    const statusValue = candidate.status;
    if (statusValue !== 'pending' && statusValue !== 'inProgress' && statusValue !== 'completed') {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid turn plan status at index ${index}.`);
    }
    const status = statusValue as 'pending' | 'inProgress' | 'completed';
    return { step: candidate.step.trim(), status };
  });
  return { explanation: params.explanation, steps };
}

export function providerTurnFailure(params: Record<string, unknown>, providerTurnId: string): Error & { code: string } {
  const turn = isRecord(params.turn) ? params.turn : {};
  const providerError = isRecord(turn.error) ? turn.error : isRecord(params.error) ? params.error : null;
  const providerStatus = providerTurnStatus(params);
  const message =
    typeof providerError?.message === 'string' && providerError.message.trim() ? providerError.message : providerStatus === 'failed' ? 'Codex provider turn failed.' : `Codex provider emitted unsupported terminal status: ${providerStatus}.`;
  return Object.assign(coordinatorError('ZEUS_CODEX_TURN_FAILED', message), { providerTurnId, providerStatus });
}

export function providerTurnFailureRecord(params: Record<string, unknown>, failure: Error & { code: string }): Record<string, unknown> {
  const turn = isRecord(params.turn) ? params.turn : {};
  const providerError = isRecord(turn.error) ? turn.error : isRecord(params.error) ? params.error : null;
  return {
    code: failure.code,
    message: failure.message,
    providerTurnId: typeof turn.id === 'string' ? turn.id : null,
    providerStatus: providerTurnStatus(params),
    ...(providerError
      ? {
          providerError: {
            ...(typeof providerError.message === 'string' ? { message: providerError.message } : {}),
            ...(providerError.codexErrorInfo !== undefined ? { codexErrorInfo: providerError.codexErrorInfo } : {}),
            ...(typeof providerError.additionalDetails === 'string' ? { additionalDetails: providerError.additionalDetails } : {}),
          },
        }
      : {}),
  };
}

export function failedTurnErrorFromRecord(turn: ZeusConversationTurnRecord): Error & { code: string } {
  let persisted: Record<string, unknown> = {};
  try {
    const parsed = turn.errorJson ? JSON.parse(turn.errorJson) : null;
    if (isRecord(parsed)) persisted = parsed;
  } catch {
    // Corrupt historical error details must not upgrade a failed turn to success.
  }
  const message = typeof persisted.message === 'string' && persisted.message ? persisted.message : 'Codex provider turn failed.';
  return Object.assign(coordinatorError('ZEUS_CODEX_TURN_FAILED', message), { providerTurnId: turn.providerTurnId });
}

export function findSnapshotTurn(snapshot: CodexThreadSnapshot, submission: ZeusConversationSubmissionRecord): Record<string, unknown> | null {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  if (submission.providerTurnId) {
    const byProviderId = turns.find((turn) => turn.id === submission.providerTurnId);
    if (byProviderId) return byProviderId;
  }
  return turns.find((turn) => turn.clientUserMessageId === submission.clientMessageId || turn.clientMessageId === submission.clientMessageId) ?? null;
}

/** 目标轮次身份不是 steer 消息的送达回执；仅接受 Provider 精确用户消息或 turn/start 的耐久接纳事实。 */
export function submissionDeliveryConfirmedForTurn(submission: ZeusConversationSubmissionRecord, turn: ZeusConversationTurnRecord, exactProviderMessage: boolean): boolean {
  return exactProviderMessage || (submission.id === turn.clientSubmissionId && submission.submissionOutcome === 'accepted' && Boolean(submission.acceptedAt));
}

export function snapshotConfirmsIdleProviderThread(snapshot: CodexThreadSnapshot): boolean {
  if (snapshot.status?.type !== 'idle' && snapshot.status?.type !== 'notLoaded') return false;
  const snapshotTurns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  return snapshotTurns.every((turn) => {
    const classification = classifySnapshotTurn(turn);
    return classification === 'completed' || classification === 'interrupted' || classification === 'failed';
  });
}

export function snapshotConfirmsSafeResumeBoundary(snapshot: CodexThreadSnapshot, localTurns: readonly ZeusConversationTurnRecord[]): boolean {
  if (!snapshotConfirmsIdleProviderThread(snapshot)) return false;
  const snapshotTurns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  const terminalLocalIds = new Set(localTurns.filter((turn) => turn.providerTurnId && (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed')).map((turn) => turn.providerTurnId as string));
  if (terminalLocalIds.size === 0) return snapshotTurns.length === 0;
  return snapshotTurns.some((turn) => typeof turn.id === 'string' && terminalLocalIds.has(turn.id) && ['completed', 'interrupted', 'failed'].includes(classifySnapshotTurn(turn)));
}

export function classifySnapshotTurn(turn: Record<string, unknown> | null): 'active' | 'completed' | 'interrupted' | 'failed' | 'unknown' {
  if (!turn) return 'unknown';
  const rawStatus = typeof turn.status === 'string' ? turn.status : isRecord(turn.state) && typeof turn.state.type === 'string' ? turn.state.type : '';
  const status = rawStatus.toLowerCase().replaceAll(/[^a-z]/gu, '');
  if (['active', 'running', 'started', 'inprogress', 'waiting', 'pending'].includes(status)) return 'active';
  if (['completed', 'complete', 'succeeded', 'success'].includes(status)) return 'completed';
  if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
  if (['failed', 'error'].includes(status)) return 'failed';
  return 'unknown';
}

export function providerItemIdFrom(params: Record<string, unknown>): string | null {
  const item = isRecord(params.item) ? params.item : {};
  return typeof params.itemId === 'string' ? params.itemId : typeof item.id === 'string' ? item.id : null;
}

export function itemTypeFromMethod(method: string): ConversationItemType {
  return itemTypeFromValue(method.split('/')[1]);
}

export function itemTypeFromValue(value: unknown): ConversationItemType {
  const normalized = typeof value === 'string' ? value : 'providerEvent';
  const allowed: ConversationItemType[] = [
    'userMessage',
    'agentMessage',
    'reasoning',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'plan',
    'imageView',
    'imageGeneration',
    'webSearch',
    'contextCompaction',
    'collabAgentToolCall',
    'subAgentActivity',
    'providerEvent',
    'error',
  ];
  // 未识别的协议事件保持中性，避免 Codex 新增能力被误报成“本轮错误”；显式 error 仍按错误处理。
  return allowed.includes(normalized as ConversationItemType) ? (normalized as ConversationItemType) : 'providerEvent';
}

export function phaseFromItem(item: Record<string, unknown>): ConversationItemPhase {
  if (item.phase === 'final_answer' || item.phase === 'finalAnswer') return 'final_answer';
  if (typeof item.phase === 'string' && item.phase.trim().length > 0) return 'prework';
  return item.type === 'agentMessage' ? 'final_answer' : 'prework';
}

export function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  return '';
}

export function reasoningSummaryProjection(existing: { payloadJson: string; textContent: string } | undefined, params: Record<string, unknown>, summaryIndex: number): { payload: Record<string, unknown>; textContent: string } {
  const existingPayload = existing ? parseJsonRecord(existing.payloadJson) : {};
  const presentation = isRecord(existingPayload.presentation) ? existingPayload.presentation : {};
  const segments = Array.isArray(presentation.summarySegments)
    ? presentation.summarySegments.map((entry) => (typeof entry === 'string' ? entry : ''))
    : Array.isArray(existingPayload.summary)
      ? existingPayload.summary.map((entry) => (typeof entry === 'string' ? entry : ''))
      : [];
  while (segments.length <= summaryIndex) segments.push('');
  if (typeof params.delta === 'string') segments[summaryIndex] = `${segments[summaryIndex] ?? ''}${params.delta}`;
  const visibleSegments = segments.filter((entry) => entry.trim().length > 0);
  const textContent = visibleSegments.join('\n\n');
  return {
    textContent,
    payload: {
      ...existingPayload,
      summary: visibleSegments,
      presentation: {
        ...presentation,
        kind: 'reasoning_summary',
        segmentIndex: summaryIndex,
        summarySegments: segments,
        liveText: segments[summaryIndex] ?? '',
      },
    },
  };
}

export function liveProgressProjection(existing: { payloadJson: string } | undefined, kind: 'command_output' | 'tool_progress', value: string, append: boolean): { payload: Record<string, unknown> } {
  const existingPayload = existing ? parseJsonRecord(existing.payloadJson) : {};
  const presentation = isRecord(existingPayload.presentation) ? existingPayload.presentation : {};
  const previousText = typeof presentation.liveText === 'string' ? presentation.liveText : '';
  const combinedText = append ? `${previousText}${value}` : value;
  const liveText = combinedText.length > 200_000 ? combinedText.slice(-200_000) : combinedText;
  return {
    payload: {
      ...existingPayload,
      presentation: {
        ...presentation,
        kind,
        liveText,
        truncated: combinedText.length > liveText.length,
      },
    },
  };
}

export function completedItemProjection(
  existing: { payloadJson: string; textContent: string } | undefined,
  completedPayload: Record<string, unknown>,
  itemType: ConversationItemType,
): { payload: Record<string, unknown>; textContent: string } {
  const existingPayload = existing ? parseJsonRecord(existing.payloadJson) : {};
  const existingPresentation = isRecord(existingPayload.presentation) ? existingPayload.presentation : null;
  const completedPresentation = isRecord(completedPayload.presentation) ? completedPayload.presentation : null;
  const payload: Record<string, unknown> = {
    ...existingPayload,
    ...completedPayload,
    ...(existingPresentation || completedPresentation ? { presentation: { ...(existingPresentation ?? {}), ...(completedPresentation ?? {}) } } : {}),
  };

  if (itemType !== 'reasoning') return { payload: sanitizeConversationItemPayload(payload), textContent: itemText(completedPayload) };

  const completedSummary = readableReasoningSummary(completedPayload);
  const presentation = isRecord(payload.presentation) ? payload.presentation : {};
  const streamedSegments = Array.isArray(presentation.summarySegments) ? presentation.summarySegments.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
  const summary = completedSummary.length > 0 ? completedSummary : streamedSegments;
  if (summary.length > 0) payload.summary = summary;
  return {
    payload,
    textContent: summary.length > 0 ? summary.join('\n\n') : (existing?.textContent ?? ''),
  };
}

export function readableReasoningSummary(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.summary)) return [];
  return item.summary.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

export function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function requestKindFromMethod(method: string): ConversationServerRequestKind | null {
  if (method === 'item/commandExecution/requestApproval') return 'command';
  if (method === 'item/fileChange/requestApproval') return 'file';
  if (method === 'item/permissions/requestApproval') return 'permissions';
  if (method === 'item/tool/requestUserInput') return 'request_user_input';
  if (method === 'mcpServer/elicitation/request') return 'mcp';
  return null;
}

export function hasSecretQuestion(params: Record<string, unknown>): boolean {
  return Array.isArray(params.questions) && params.questions.some((question) => isRecord(question) && (question.isSecret === true || question.secret === true));
}

export function invalidServerRequestResponse(message: string): Error & { code: string } {
  return coordinatorError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', message);
}

export function isGrantDecision(decision: unknown): boolean {
  return decision === 'accept' || decision === 'acceptForSession';
}

export function isExecpolicyAmendmentDecision(value: unknown): value is Exclude<CodexCommandApprovalDecision, string> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['acceptWithExecpolicyAmendment'])) return false;
  const amendment = value.acceptWithExecpolicyAmendment;
  return (
    isRecord(amendment) &&
    hasOnlyKeys(amendment, ['execpolicy_amendment']) &&
    Array.isArray(amendment.execpolicy_amendment) &&
    amendment.execpolicy_amendment.length > 0 &&
    amendment.execpolicy_amendment.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

export function isAdvertisedCommandDecision(payload: Record<string, unknown>, decision: CodexCommandApprovalDecision): boolean {
  if (!Array.isArray(payload.availableDecisions)) return false;
  if (isExecpolicyAmendmentDecision(decision)) return payload.availableDecisions.some((entry) => jsonValuesEqual(entry, decision));
  return payload.availableDecisions.some((entry) => entry === decision || (isRecord(entry) && [entry.decision, entry.id, entry.value, entry.name].includes(decision)));
}

export function hasAuditableFileApprovalTarget(payload: Record<string, unknown>, conversation: ZeusConversationWithMessagesRecord, context: ConversationDispatchContext, providerItems: ConversationProviderItemRepository): boolean {
  return inspectFileApprovalTargets(payload, conversation, context.projectLocalPath, providerItems).status === 'auditable';
}

export function inspectFileApprovalTargets(payload: Record<string, unknown>, conversation: ZeusConversationRecord, projectRoot: string | null, providerItems: ConversationProviderItemRepository): FileApprovalTargetAudit {
  if (!projectRoot || !existingDirectoryRealpath(projectRoot)) return { status: 'unavailable', paths: [] };

  const grantRoot = payload.grantRoot;
  if (grantRoot !== undefined && grantRoot !== null) {
    return {
      status: 'provider_root_scope',
      paths: typeof grantRoot === 'string' && grantRoot.trim() ? [grantRoot.trim()] : [],
    };
  }

  const directTargetKeys = ['path', 'filePath', 'targetPath'] as const;
  const directTargets: string[] = [];
  for (const key of directTargetKeys) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) return { status: 'unavailable', paths: [] };
    directTargets.push(value.trim());
  }
  if (directTargets.length > 0) {
    return {
      status: directTargets.every((target) => isAuditableProjectTarget(target, projectRoot)) ? 'auditable' : 'outside_project',
      paths: [...new Set(directTargets)],
    };
  }

  if (typeof payload.itemId !== 'string' || !payload.itemId || !conversation.providerThreadId) return { status: 'unavailable', paths: [] };
  const item = providerItems.getByProvider(conversation.providerThreadId, payload.itemId);
  if (!item || item.conversationId !== conversation.id || item.itemType !== 'fileChange') return { status: 'unavailable', paths: [] };
  const itemPayload = parseJsonRecord(item.payloadJson);
  if (!Array.isArray(itemPayload.changes) || itemPayload.changes.length === 0) return { status: 'unavailable', paths: [] };
  const linkedTargets = itemPayload.changes.map((change) => (isRecord(change) && typeof change.path === 'string' && change.path.trim() ? change.path.trim() : null));
  if (!linkedTargets.every((target): target is string => target !== null)) return { status: 'unavailable', paths: [] };
  const paths = [...new Set(linkedTargets)];
  return {
    status: paths.every((target) => isAuditableProjectTarget(target, projectRoot)) ? 'auditable' : 'outside_project',
    paths,
  };
}

export function isAuditableProjectTarget(value: string, projectRoot: string): boolean {
  const projectRealPath = existingDirectoryRealpath(projectRoot);
  if (!projectRealPath) return false;
  const projectLexicalPath = resolve(projectRoot);
  const targetPath = resolve(isAbsolute(value) ? value : resolve(projectLexicalPath, value));
  if (!isInsideRoot(targetPath, projectLexicalPath)) return false;
  let existingAncestor = targetPath;
  while (true) {
    try {
      return isInsideRoot(realpathSync(existingAncestor), projectRealPath);
    } catch {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return false;
      existingAncestor = parent;
    }
  }
}

export function isValidMcpElicitationResponse(payload: Record<string, unknown>, response: Extract<RespondNativeRequestInput['response'], { type: 'mcp' }>): boolean {
  if (!isJsonValue(response.content) || !isJsonValue(response._meta)) return false;
  if (response.action === 'decline' || response.action === 'cancel') return response.content === null && response._meta === null;
  if (response.action !== 'accept') return false;
  if (!hasCanonicalMcpElicitationEnvelope(payload)) return false;
  if (payload.mode === 'url') return response.content === null && response._meta === null;
  if (response._meta !== null) return false;
  if (payload.mode === 'form') return response.content !== null && matchesCanonicalMcpFormSchema(payload.requestedSchema, response.content);
  if (payload.mode === 'openai/form') return response.content !== null && matchesSupportedJsonSchema(payload.requestedSchema, response.content);
  return false;
}

export function hasCanonicalMcpElicitationEnvelope(payload: Record<string, unknown>): boolean {
  const commonKeys = ['threadId', 'turnId', 'serverName', 'mode', '_meta', 'message'];
  if (
    typeof payload.threadId !== 'string' ||
    !payload.threadId.trim() ||
    !(payload.turnId === null || (typeof payload.turnId === 'string' && Boolean(payload.turnId.trim()))) ||
    typeof payload.serverName !== 'string' ||
    !payload.serverName.trim() ||
    typeof payload.message !== 'string' ||
    !payload.message.trim() ||
    !Object.prototype.hasOwnProperty.call(payload, '_meta') ||
    !isJsonValue(payload._meta)
  ) {
    return false;
  }
  if (payload.mode === 'form' || payload.mode === 'openai/form') {
    return hasOnlyKeys(payload, [...commonKeys, 'requestedSchema']) && Object.prototype.hasOwnProperty.call(payload, 'requestedSchema');
  }
  if (payload.mode !== 'url' || !hasOnlyKeys(payload, [...commonKeys, 'url', 'elicitationId'])) return false;
  if (typeof payload.elicitationId !== 'string' || !payload.elicitationId.trim() || typeof payload.url !== 'string') return false;
  try {
    const url = new URL(payload.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function matchesCanonicalMcpFormSchema(schemaValue: unknown, value: unknown): boolean {
  if (!isRecord(schemaValue) || schemaValue.type !== 'object' || !isRecord(schemaValue.properties) || !hasOnlyKeys(schemaValue, ['$schema', 'type', 'properties', 'required'])) return false;
  if (schemaValue.$schema !== undefined && typeof schemaValue.$schema !== 'string') return false;
  const propertyEntries = Object.entries(schemaValue.properties);
  const required = schemaValue.required === undefined ? [] : schemaValue.required;
  if (!Array.isArray(required) || !required.every((entry) => typeof entry === 'string') || new Set(required).size !== required.length) return false;
  const propertyNames = new Set(propertyEntries.map(([name]) => name));
  if (required.some((name) => !propertyNames.has(name))) return false;
  if (!isRecord(value) || Object.keys(value).some((name) => !propertyNames.has(name))) return false;
  if (required.some((name) => !Object.prototype.hasOwnProperty.call(value, name))) return false;
  return propertyEntries.every(([name, propertySchema]) => isSupportedMcpPrimitiveSchema(propertySchema) && (!Object.prototype.hasOwnProperty.call(value, name) || matchesSupportedMcpPrimitiveSchema(propertySchema, value[name])));
}

export function isSupportedMcpPrimitiveSchema(schemaValue: unknown): schemaValue is Record<string, unknown> {
  if (!isRecord(schemaValue) || typeof schemaValue.type !== 'string') return false;
  const commonKeys = ['type', 'title', 'description', 'default'];
  if ((schemaValue.title !== undefined && typeof schemaValue.title !== 'string') || (schemaValue.description !== undefined && typeof schemaValue.description !== 'string')) return false;
  if (schemaValue.type === 'string') {
    const hasEnum = Object.prototype.hasOwnProperty.call(schemaValue, 'enum');
    const hasOneOf = Object.prototype.hasOwnProperty.call(schemaValue, 'oneOf');
    if (hasEnum && hasOneOf) return false;
    if (hasEnum) {
      if (!hasOnlyKeys(schemaValue, [...commonKeys, 'enum', 'enumNames'])) return false;
      const choices = supportedStringChoices(schemaValue);
      return choices !== null && (schemaValue.default === undefined || (typeof schemaValue.default === 'string' && choices.includes(schemaValue.default)));
    }
    if (hasOneOf) {
      if (!hasOnlyKeys(schemaValue, [...commonKeys, 'oneOf'])) return false;
      const choices = supportedStringChoices(schemaValue);
      return choices !== null && (schemaValue.default === undefined || (typeof schemaValue.default === 'string' && choices.includes(schemaValue.default)));
    }
    if (!hasOnlyKeys(schemaValue, [...commonKeys, 'minLength', 'maxLength', 'format'])) return false;
    if (!isOptionalNonNegativeInteger(schemaValue.minLength) || !isOptionalNonNegativeInteger(schemaValue.maxLength)) return false;
    if (typeof schemaValue.minLength === 'number' && typeof schemaValue.maxLength === 'number' && schemaValue.minLength > schemaValue.maxLength) return false;
    if (schemaValue.format !== undefined && (typeof schemaValue.format !== 'string' || !['email', 'uri', 'date', 'date-time'].includes(schemaValue.format))) return false;
    return schemaValue.default === undefined || (typeof schemaValue.default === 'string' && matchesCanonicalStringValue(schemaValue.default, schemaValue));
  }
  if (schemaValue.type === 'number' || schemaValue.type === 'integer') {
    if (!hasOnlyKeys(schemaValue, [...commonKeys, 'minimum', 'maximum'])) return false;
    if (![schemaValue.minimum, schemaValue.maximum, schemaValue.default].every((entry) => entry === undefined || (typeof entry === 'number' && Number.isFinite(entry)))) return false;
    if (typeof schemaValue.minimum === 'number' && typeof schemaValue.maximum === 'number' && schemaValue.minimum > schemaValue.maximum) return false;
    return schemaValue.default === undefined || matchesCanonicalNumberValue(schemaValue.default, schemaValue);
  }
  if (schemaValue.type === 'boolean') return hasOnlyKeys(schemaValue, commonKeys) && (schemaValue.default === undefined || typeof schemaValue.default === 'boolean');
  if (schemaValue.type === 'array') {
    if (!hasOnlyKeys(schemaValue, [...commonKeys, 'minItems', 'maxItems', 'items'])) return false;
    if (!isOptionalNonNegativeInteger(schemaValue.minItems) || !isOptionalNonNegativeInteger(schemaValue.maxItems)) return false;
    if (typeof schemaValue.minItems === 'number' && typeof schemaValue.maxItems === 'number' && schemaValue.minItems > schemaValue.maxItems) return false;
    const choices = supportedArrayChoices(schemaValue.items);
    if (choices === null || (typeof schemaValue.minItems === 'number' && schemaValue.minItems > choices.length)) return false;
    return schemaValue.default === undefined || matchesCanonicalArrayValue(schemaValue.default, schemaValue, choices);
  }
  return false;
}

export function matchesSupportedMcpPrimitiveSchema(schemaValue: unknown, value: unknown): boolean {
  if (!isSupportedMcpPrimitiveSchema(schemaValue)) return false;
  if (schemaValue.type === 'string') {
    if (typeof value !== 'string') return false;
    const choices = supportedStringChoices(schemaValue);
    return choices !== null && (choices.length > 0 ? choices.includes(value) : matchesCanonicalStringValue(value, schemaValue));
  }
  if (schemaValue.type === 'number' || schemaValue.type === 'integer') return matchesCanonicalNumberValue(value, schemaValue);
  if (schemaValue.type === 'boolean') return typeof value === 'boolean';
  if (schemaValue.type === 'array') {
    const choices = supportedArrayChoices(schemaValue.items);
    return choices !== null && matchesCanonicalArrayValue(value, schemaValue, choices);
  }
  return false;
}

export function supportedStringChoices(schema: Record<string, unknown>): string[] | null {
  const choiceShapes = [schema.enum !== undefined, schema.oneOf !== undefined].filter(Boolean).length;
  if (choiceShapes > 1) return null;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every((entry) => typeof entry === 'string') || new Set(schema.enum).size !== schema.enum.length) return null;
    if (schema.enumNames !== undefined && (!Array.isArray(schema.enumNames) || schema.enumNames.length !== schema.enum.length || !schema.enumNames.every((entry) => typeof entry === 'string'))) return null;
    return schema.enum;
  }
  if (schema.enumNames !== undefined) return null;
  if (schema.oneOf !== undefined) return supportedConstOptions(schema.oneOf);
  return [];
}

export function matchesCanonicalStringValue(value: string, schema: Record<string, unknown>): boolean {
  const length = Array.from(value).length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
  if (schema.format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (schema.format === 'uri') {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (schema.format === 'date') return isValidCanonicalDate(value);
  if (schema.format === 'date-time') return isValidCanonicalDateTime(value);
  return true;
}

export function matchesCanonicalNumberValue(value: unknown, schema: Record<string, unknown>): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return false;
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  return typeof schema.maximum !== 'number' || value <= schema.maximum;
}

export function matchesCanonicalArrayValue(value: unknown, schema: Record<string, unknown>, choices: readonly string[]): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string') || new Set(value).size !== value.length) return false;
  if (!value.every((entry) => choices.includes(entry))) return false;
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
  return typeof schema.maxItems !== 'number' || value.length <= schema.maxItems;
}

export function isValidCanonicalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidCanonicalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !isValidCanonicalDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

export function supportedArrayChoices(itemsValue: unknown): string[] | null {
  if (!isRecord(itemsValue)) return null;
  if (itemsValue.type === 'string' && hasOnlyKeys(itemsValue, ['type', 'enum'])) {
    return Array.isArray(itemsValue.enum) && itemsValue.enum.length > 0 && itemsValue.enum.every((entry) => typeof entry === 'string') && new Set(itemsValue.enum).size === itemsValue.enum.length ? itemsValue.enum : null;
  }
  if (hasOnlyKeys(itemsValue, ['anyOf'])) return supportedConstOptions(itemsValue.anyOf);
  return null;
}

export function supportedConstOptions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const choices: string[] = [];
  for (const option of value) {
    if (!isRecord(option) || !hasOnlyKeys(option, ['const', 'title']) || typeof option.const !== 'string' || typeof option.title !== 'string') return null;
    choices.push(option.const);
  }
  return new Set(choices).size === choices.length ? choices : null;
}

export function matchesSupportedJsonSchema(schemaValue: unknown, value: unknown): boolean {
  if (!isSupportedJsonSchemaDefinition(schemaValue)) return false;
  if (Array.isArray(schemaValue.enum) && !schemaValue.enum.some((entry) => jsonValuesEqual(entry, value))) return false;
  const type = typeof schemaValue.type === 'string' ? schemaValue.type : null;
  if (type === 'object') {
    if (!isRecord(value)) return false;
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const required = Array.isArray(schemaValue.required) ? (schemaValue.required as string[]) : [];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schemaValue.additionalProperties === false && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    return Object.entries(properties).every(([key, schema]) => !Object.prototype.hasOwnProperty.call(value, key) || matchesSupportedJsonSchema(schema, value[key]));
  }
  if (type === 'array') return Array.isArray(value) && (schemaValue.items === undefined || value.every((entry) => matchesSupportedJsonSchema(schemaValue.items, entry)));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return type === null && isJsonValue(value);
}

export function isSupportedJsonSchemaDefinition(schemaValue: unknown): schemaValue is Record<string, unknown> {
  if (!isRecord(schemaValue) || !hasOnlyKeys(schemaValue, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'title', 'description', 'default'])) return false;
  if (schemaValue.enum !== undefined && (!Array.isArray(schemaValue.enum) || !schemaValue.enum.every(isJsonValue))) return false;
  if (schemaValue.title !== undefined && typeof schemaValue.title !== 'string') return false;
  if (schemaValue.description !== undefined && typeof schemaValue.description !== 'string') return false;
  if (schemaValue.default !== undefined && !isJsonValue(schemaValue.default)) return false;
  const type = schemaValue.type;
  if (type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return false;
  if (type === 'object') {
    if (schemaValue.properties !== undefined && (!isRecord(schemaValue.properties) || !Object.values(schemaValue.properties).every(isSupportedJsonSchemaDefinition))) return false;
    if (schemaValue.required !== undefined && (!Array.isArray(schemaValue.required) || !schemaValue.required.every((entry) => typeof entry === 'string'))) return false;
    if (schemaValue.additionalProperties !== undefined && typeof schemaValue.additionalProperties !== 'boolean') return false;
  } else if (schemaValue.properties !== undefined || schemaValue.required !== undefined || schemaValue.additionalProperties !== undefined) {
    return false;
  }
  if (type === 'array') {
    if (schemaValue.items !== undefined && !isSupportedJsonSchemaDefinition(schemaValue.items)) return false;
  } else if (schemaValue.items !== undefined) {
    return false;
  }
  return true;
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
}

export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function evaluateCommandApproval(payload: Record<string, unknown>, context: ConversationDispatchContext): { allowed: boolean; reason: string | null } {
  if (context.permissionMode === 'read-only') return { allowed: false, reason: 'read_only_mode' };
  const projectRealPath = existingDirectoryRealpath(context.projectLocalPath);
  if (!projectRealPath) return { allowed: false, reason: 'project_realpath_unavailable' };
  if (!isSupportedCommandApprovalPolicy(payload, context, projectRealPath)) return { allowed: false, reason: 'unsupported_or_elevated_policy' };
  const argv = directCommandArgv(payload);
  if (!argv || argv.some(hasShellMetaOrVariable)) return { allowed: false, reason: 'command_not_direct_argv' };
  if (isDirectPwd(argv)) return { allowed: true, reason: null };
  if (isDirectGitStatus(argv, context, projectRealPath)) return { allowed: true, reason: null };
  return { allowed: false, reason: 'command_not_allowlisted' };
}

export function directCommandArgv(payload: Record<string, unknown>): string[] | null {
  const item = isRecord(payload.item) ? payload.item : {};
  if ([payload.commandText, payload.cmd, payload.argv, item.command, item.commandText, item.argv].some((candidate) => candidate !== undefined)) return null;
  if (Array.isArray(payload.command)) return payload.command.length > 0 && payload.command.every((entry) => typeof entry === 'string' && entry.length > 0) ? payload.command : null;
  if (typeof payload.command !== 'string') return null;
  return strictSimpleCommandArgv(payload.command);
}

export function strictSimpleCommandArgv(command: string): string[] | null {
  if (command.length === 0 || command.trim() !== command || /[^\S ]/u.test(command)) return null;
  const argv = command.split(/ +/u);
  return argv.every((token) => token.length > 0 && !hasShellMetaOrVariable(token)) ? argv : null;
}

const shellMetaOrVariableCharacters = new Set(`;&|<>\`$\\\n\r*?[]{}()'"~!#`);

export function hasShellMetaOrVariable(value: string): boolean {
  return [...value].some((character) => shellMetaOrVariableCharacters.has(character));
}

const allowedCommandRequestFields = new Set([
  'threadId',
  'turnId',
  'itemId',
  'startedAtMs',
  'approvalId',
  'environmentId',
  'reason',
  'networkApprovalContext',
  'command',
  'cwd',
  'commandActions',
  'additionalPermissions',
  'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments',
  'availableDecisions',
  'sandboxPolicy',
  'sandbox',
  'networkAccess',
  'writableRoots',
  'sandboxPermissions',
  'sandbox_permissions',
  'approvalPolicy',
]);

export function isSupportedCommandApprovalPolicy(payload: Record<string, unknown>, context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (Object.keys(payload).some((key) => !allowedCommandRequestFields.has(key))) return false;
  for (const key of ['threadId', 'turnId', 'itemId'] as const) if (payload[key] !== undefined && typeof payload[key] !== 'string') return false;
  if (payload.startedAtMs !== undefined && !isNonNegativeInteger(payload.startedAtMs)) return false;
  for (const key of ['approvalId', 'reason'] as const) if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string') return false;
  if (payload.environmentId !== undefined && payload.environmentId !== null) return false;
  if (payload.networkApprovalContext !== undefined && payload.networkApprovalContext !== null) return false;
  if (payload.commandActions !== undefined && payload.commandActions !== null && (!Array.isArray(payload.commandActions) || !payload.commandActions.every(isJsonValue))) return false;
  if (payload.additionalPermissions !== undefined && payload.additionalPermissions !== null) return false;
  if (payload.proposedExecpolicyAmendment !== undefined && payload.proposedExecpolicyAmendment !== null) return false;
  if (payload.proposedNetworkPolicyAmendments !== undefined && payload.proposedNetworkPolicyAmendments !== null && (!Array.isArray(payload.proposedNetworkPolicyAmendments) || payload.proposedNetworkPolicyAmendments.length > 0))
    return false;
  if (payload.networkAccess !== undefined && payload.networkAccess !== false) return false;
  if (payload.sandboxPermissions !== undefined && payload.sandboxPermissions !== 'use_default') return false;
  if (payload.sandbox_permissions !== undefined && payload.sandbox_permissions !== 'use_default') return false;
  if (payload.approvalPolicy !== undefined && payload.approvalPolicy !== 'untrusted') return false;
  if (payload.cwd !== undefined && payload.cwd !== null && (typeof payload.cwd !== 'string' || !isExistingProjectDirectory(payload.cwd, context, projectRealPath))) return false;
  if (payload.writableRoots !== undefined && !areProjectWritableRoots(payload.writableRoots, context, projectRealPath)) return false;
  if (payload.sandboxPolicy !== undefined && !isSupportedCommandSandbox(payload.sandboxPolicy, context, projectRealPath)) return false;
  if (payload.sandbox !== undefined && !isSupportedCommandSandbox(payload.sandbox, context, projectRealPath)) return false;
  return true;
}

export function isSupportedCommandSandbox(value: unknown, context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'readOnly') return Object.keys(value).every((key) => key === 'type' || key === 'networkAccess') && value.networkAccess === false;
  if (value.type !== 'workspaceWrite') return false;
  if (Object.keys(value).some((key) => key !== 'type' && key !== 'writableRoots' && key !== 'networkAccess')) return false;
  return value.networkAccess === false && areProjectWritableRoots(value.writableRoots, context, projectRealPath);
}

export function areProjectWritableRoots(value: unknown, context: ConversationDispatchContext, projectRealPath: string): boolean {
  return context.permissionMode !== 'read-only' && Array.isArray(value) && value.every((entry) => typeof entry === 'string' && isExistingProjectDirectory(entry, context, projectRealPath));
}

export function isExistingProjectDirectory(value: string, context: ConversationDispatchContext, projectRealPath: string): boolean {
  const targetRealPath = existingDirectoryRealpath(isAbsolute(value) ? value : resolve(context.projectLocalPath, value));
  if (targetRealPath === null) return false;
  const allowedRoots = [projectRealPath, ...(context.writableRoots ?? []).map(existingDirectoryRealpath).filter((entry): entry is string => entry !== null)];
  return allowedRoots.some((root) => isInsideRoot(targetRealPath, root));
}

export function existingDirectoryRealpath(value: string): string | null {
  try {
    const realPath = realpathSync(resolve(value));
    return statSync(realPath).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

export function trustedExecutableRealpath(value: string, allowlist: ReadonlySet<string>): boolean {
  if (!isAbsolute(value)) return false;
  try {
    const realPath = realpathSync(value);
    return statSync(realPath).isFile() && allowlist.has(realPath);
  } catch {
    return false;
  }
}

export function isDirectPwd(argv: readonly string[]): boolean {
  return argv.length === 1 && trustedExecutableRealpath(argv[0] ?? '', trustedPwdExecutableRealpaths);
}

export function isSupportedPermissionRequest(payload: Record<string, unknown>): boolean {
  const permissions = isRecord(payload.permissions) ? payload.permissions : null;
  if (!permissions || Object.keys(permissions).some((key) => key !== 'network' && key !== 'fileSystem')) return false;
  if (permissions.network !== undefined) {
    if (!isRecord(permissions.network) || Object.keys(permissions.network).some((key) => key !== 'enabled') || (permissions.network.enabled !== null && typeof permissions.network.enabled !== 'boolean')) return false;
  }
  if (permissions.fileSystem !== undefined) {
    if (!isRecord(permissions.fileSystem) || Object.keys(permissions.fileSystem).some((key) => !['read', 'write', 'globScanMaxDepth'].includes(key))) return false;
    for (const key of ['read', 'write'] as const) {
      const value = permissions.fileSystem[key];
      if (value !== undefined && value !== null && (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))) return false;
    }
    if (permissions.fileSystem.globScanMaxDepth !== undefined && !isNonNegativeInteger(permissions.fileSystem.globScanMaxDepth)) return false;
  }
  return true;
}

export function isSupportedPermissionGrant(value: unknown): value is Extract<CodexServerRequestResponse, { type: 'permissions' }>['permissions'] {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'network' && key !== 'fileSystem')) return false;
  if (value.network !== undefined) {
    if (!isRecord(value.network) || Object.keys(value.network).some((key) => key !== 'enabled') || (value.network.enabled !== null && typeof value.network.enabled !== 'boolean')) return false;
  }
  if (value.fileSystem !== undefined) {
    if (!isRecord(value.fileSystem) || Object.keys(value.fileSystem).some((key) => !['read', 'write', 'globScanMaxDepth'].includes(key))) return false;
    for (const key of ['read', 'write'] as const) {
      const paths = value.fileSystem[key];
      if (paths !== undefined && paths !== null && (!Array.isArray(paths) || !paths.every((entry) => typeof entry === 'string'))) return false;
    }
    if (value.fileSystem.globScanMaxDepth !== undefined && !isNonNegativeInteger(value.fileSystem.globScanMaxDepth)) return false;
  }
  return true;
}

export function validatePermissionGrant(requestPayload: Record<string, unknown>, grant: Extract<CodexServerRequestResponse, { type: 'permissions' }>['permissions'], context: ConversationDispatchContext): void {
  const requested = requestPayload.permissions as { network?: { enabled: boolean | null }; fileSystem?: { read: string[] | null; write: string[] | null; globScanMaxDepth?: number } };
  if (grant.network?.enabled === true) throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'Network access is disabled by the Task execution policy.');
  const projectRealPath = existingDirectoryRealpath(context.projectLocalPath);
  if (!projectRealPath) throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'Project root cannot be resolved for a filesystem permission grant.');
  const requestedFs = requested.fileSystem;
  const grantedFs = grant.fileSystem;
  if (!grantedFs) return;
  for (const key of ['read', 'write'] as const) {
    const grantedPaths = grantedFs[key];
    if (grantedPaths === null || grantedPaths === undefined) continue;
    if (key === 'write' && context.permissionMode === 'read-only' && grantedPaths.length > 0) {
      throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'Filesystem write access is disabled by the conversation permission mode.');
    }
    if (grantedPaths.length === 0) continue;
    const requestedPaths = requestedFs?.[key];
    if (!Array.isArray(requestedPaths)) throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST', `Filesystem ${key} grant exceeds requested permissions.`);
    for (const path of grantedPaths) {
      const grantedRealPath = existingPermissionRealpath(path, context.projectLocalPath, projectRealPath);
      const requestedRealPaths = requestedPaths.map((requestedPath) => existingPermissionRealpath(requestedPath, context.projectLocalPath, projectRealPath));
      if (!grantedRealPath || !requestedRealPaths.includes(grantedRealPath)) {
        throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST', `Filesystem ${key} grant exceeds project or request boundary.`);
      }
    }
  }
  if (grantedFs.globScanMaxDepth !== undefined) {
    if (requestedFs?.globScanMaxDepth === undefined || grantedFs.globScanMaxDepth > requestedFs.globScanMaxDepth) {
      throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST', 'Filesystem glob scan depth exceeds requested permissions.');
    }
  }
}

export function existingPermissionRealpath(value: string, projectRoot: string, projectRealPath: string): string | null {
  try {
    const targetRealPath = realpathSync(isAbsolute(value) ? value : resolve(projectRoot, value));
    return isInsideRoot(targetRealPath, projectRealPath) ? targetRealPath : null;
  } catch {
    return null;
  }
}

const supportedLocalImageExtensions: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/bmp': ['.bmp'],
  'image/heic': ['.heic', '.heif'],
  'image/tiff': ['.tif', '.tiff'],
};

export function isSupportedLocalImageAttachment(attachment: NativeConversationAttachmentInput, canonicalPath: string): boolean {
  return supportedLocalImageExtensions[attachment.mime.toLowerCase()]?.includes(extname(canonicalPath).toLowerCase()) === true;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const trustedPwdExecutableRealpaths = new Set(['/bin/pwd']);
const trustedGitExecutableRealpaths = new Set(['/usr/bin/git']);
const directGitStatusOptions = new Set([
  '--short',
  '-s',
  '--porcelain',
  '--porcelain=v1',
  '--porcelain=v2',
  '--branch',
  '-b',
  '--show-stash',
  '--ahead-behind',
  '--no-ahead-behind',
  '--ignored',
  '--long',
  '--verbose',
  '-v',
  '-vv',
  '--null',
  '-z',
  '--untracked-files=no',
  '--untracked-files=normal',
  '--untracked-files=all',
]);

export function isDirectGitStatus(argv: readonly string[], context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (!context.allowGitCommit || !trustedExecutableRealpath(argv[0] ?? '', trustedGitExecutableRealpaths)) return false;
  let index = 1;
  while (index < argv.length) {
    const option = argv[index] ?? '';
    if (option === '-C') {
      const path = argv[index + 1];
      if (!path || !isExistingProjectDirectory(path, context, projectRealPath)) return false;
      index += 2;
      continue;
    }
    if (option === '--no-pager') {
      index += 1;
      continue;
    }
    break;
  }
  if ((argv[index] ?? '').toLowerCase() !== 'status') return false;
  return argv.slice(index + 1).every((argument) => argument === '--' || directGitStatusOptions.has(argument) || !argument.startsWith('-'));
}

export function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

export function requestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function conversationSubmissionDispatchEnvelope(submission: ZeusConversationSubmissionRecord): CommandEnvelope {
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: `command_conversation_submission_${createHash('sha256').update(submission.id).digest('hex').slice(0, 32)}`,
    commandType: 'conversation.submission.dispatch',
    actor: { kind: 'local_api', id: 'zeus-local-server' },
    scope: { kind: 'submission', id: submission.id },
    expectedRevision: null,
    idempotencyKey: submission.idempotencyKey,
    issuedAt: submission.createdAt,
    traceIdentity: currentDatabasePerformanceTraceId(),
    payload: {
      conversationId: submission.conversationId,
      submissionId: submission.id,
      clientMessageId: submission.clientMessageId,
      requestHash: submission.requestHash,
      requestedDelivery: submission.requestedDelivery,
      kind: submission.kind,
    },
  };
}

export function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted native conversation state is invalid.');
  return parsed;
}

export function submissionErrorSnapshot(errorJson: string | null): NativeSubmissionError | null {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson) as unknown;
    if (!isRecord(parsed)) return null;
    const code = typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code : 'ZEUS_NATIVE_SUBMISSION_FAILED';
    const message = typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message : 'Native message submission failed.';
    return {
      code,
      message,
      recoveryRequired: parsed.recoveryRequired === true || code.includes('RECOVERY') || code.includes('WORKTREE_UNAVAILABLE'),
    };
  } catch {
    return null;
  }
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Missing ${label}.`);
  return value;
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid ${label}.`);
  return value;
}

export function tokenUsageBreakdown(value: Record<string, unknown>): TokenUsageBreakdown {
  return {
    totalTokens: requireSafeInteger(value.totalTokens, 'totalTokens'),
    inputTokens: requireSafeInteger(value.inputTokens, 'inputTokens'),
    cachedInputTokens: requireSafeInteger(value.cachedInputTokens ?? 0, 'cachedInputTokens'),
    cacheWriteInputTokens: requireSafeInteger(value.cacheWriteInputTokens ?? 0, 'cacheWriteInputTokens'),
    outputTokens: requireSafeInteger(value.outputTokens, 'outputTokens'),
    reasoningOutputTokens: requireSafeInteger(value.reasoningOutputTokens ?? 0, 'reasoningOutputTokens'),
  };
}

export function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid ${label}.`);
  return value;
}

export function normalizeMcpStartupStatusMap(value: Record<string, unknown>): Record<string, CodexMcpServerStartupState> {
  return Object.fromEntries(
    Object.entries(value).map(([serverId, state]) => {
      if (typeof state === 'string') return [serverId, state];
      if (isRecord(state) && typeof state.status === 'string' && (state.error === undefined || state.error === null || typeof state.error === 'string')) {
        return [serverId, { status: state.status, ...(state.error === undefined ? {} : { error: state.error as string | null }) } satisfies CodexMcpServerStartupState];
      }
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid MCP startup status for ${serverId}.`);
    }),
  );
}

export function normalizeSingleMcpStartupStatus(params: Record<string, unknown>): { serverId: string; state: CodexMcpServerStartupState } {
  const serverId = requireString(params.name, 'MCP server name');
  const status = requireString(params.status, `MCP startup status for ${serverId}`);
  if (params.error !== undefined && params.error !== null && typeof params.error !== 'string') {
    throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid MCP startup error for ${serverId}.`);
  }
  if (params.failureReason !== undefined && params.failureReason !== null && typeof params.failureReason !== 'string') {
    throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid MCP startup failure reason for ${serverId}.`);
  }
  const error = typeof params.error === 'string' ? params.error : typeof params.failureReason === 'string' ? params.failureReason : params.error === null || params.failureReason === null ? null : undefined;
  return {
    serverId,
    state: { status, ...(error === undefined ? {} : { error }) },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeError(error: unknown): { message: string; code?: string } {
  return { message: error instanceof Error ? error.message : String(error), ...(isRecord(error) && typeof error.code === 'string' ? { code: error.code } : {}) };
}

export function toRecoverySubmissionError(error: unknown): { message: string; code: string; recoveryRequired: true } {
  const serialized = serializeError(error);
  return {
    message: serialized.message,
    code: serialized.code ?? 'ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW',
    recoveryRequired: true,
  };
}

export function isProviderThreadArchivedError(error: unknown): boolean {
  return /\bis archived\b[\s\S]*\bunarchive\b/i.test(error instanceof Error ? error.message : String(error));
}

export function isProviderThreadAlreadyAvailableError(error: unknown): boolean {
  return /\bno archived rollout found for thread id\b/i.test(error instanceof Error ? error.message : String(error));
}

export function isRejectedHistoricalFileChangeError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
  return code === 'ZEUS_TURN_CHANGE_SET_PATH_FORBIDDEN' || code === 'ZEUS_TURN_CHANGE_SET_PATH_INVALID';
}

export function isProviderTurnAlreadyEndedSteerError(error: unknown): boolean {
  return /\bno active turn to steer\b/i.test(error instanceof Error ? error.message : String(error));
}

export function isToolResultItem(itemType: string): boolean {
  return itemType === 'commandExecution' || itemType === 'mcpToolCall' || itemType === 'dynamicToolCall' || itemType === 'webSearch' || itemType === 'fileChange';
}

export function coordinatorError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
