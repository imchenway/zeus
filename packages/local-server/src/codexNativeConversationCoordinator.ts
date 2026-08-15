import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type {
  CodexAppServerEvent,
  CodexAppServerManager,
  CodexCommandApprovalDecision,
  CodexResponsesRuntime,
  CodexSandboxPolicy,
  CodexServerRequestResponse,
  CodexThreadGoal,
  CodexThreadSnapshot,
  CodexTurnSnapshot,
} from '@zeus/ai-runtime';
import { buildTaskPushInputParts, calculateCacheHitRate, type NativeTokenUsageSnapshot, type TaskPushMessageLayout, type TokenUsageBreakdown } from '@zeus/shared';
import {
  type CodexMcpServerStartupState,
  type ConversationCollaborationMode,
  type ConversationGoalEventKind,
  ConversationGoalRepository,
  type ConversationItemPhase,
  ConversationItemRepository,
  type ConversationItemType,
  type ConversationNextTurnSettings,
  type ConversationPermissionMode,
  ConversationPlanActionRepository,
  ConversationProviderSyncCheckpointRepository,
  ConversationRepository,
  ConversationResourceRepository,
  type ConversationServerRequestKind,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  type ProviderEventReceiptInput,
  ProviderEventReceiptRepository,
  SettingRepository,
  type ZeusConversationServerRequestRecord,
  type ZeusConversationSubmissionRecord,
  type ZeusConversationItemRecord,
  type ZeusConversationTurnRecord,
  type ZeusConversationWithMessagesRecord,
  type ZeusDatabase,
} from '@zeus/storage';
import type {
  ArchiveConversationInput,
  CodexNativeConversationCoordinator,
  InterruptNativeTurnInput,
  NativeAcceptedOperation,
  NativeConversationAttachmentInput,
  NativeQuestionAnswerAttachmentInput,
  NativeConversationRunState,
  NativeProviderWriteLifecycle,
  NativeQueueSnapshot,
  NativeSubmissionError,
  NativeTurnResult,
  RecoverNativeQueueInput,
  RespondNativeRequestInput,
  RespondPlanImplementationRequestInput,
  RestoreArchivedConversationInput,
  SendQueuedNowInput,
  SnoozeNativeRequestInput,
  StartNativeEphemeralConversationInput,
  StartProjectConversationInput,
  StartTaskConversationInput,
  SteerNativeMessageInput,
  SubmitNativeMessageInput,
  WaitForNativeTurnResultInput,
} from './codexNativeConversationContracts.js';
import { parseCanonicalRequestUserInputQuestions, validateCanonicalRequestUserInputAnswers } from './codexNativeRuiValidation.js';
import { chooseNativeUserMessageContent, type ResolvedNativeUserMessageSubmission, resolveNativeUserMessageSubmission } from './codexNativeUserMessageProjection.js';
import type { BrowserAutomationPort } from './browserAutomation.js';
import { zeusBrowserDynamicTools } from './browserDynamicTools.js';
import { normalizeConversationResources, sanitizeConversationItemPayload, toConversationResource } from './conversationResources.js';
import type { TurnChangeSetService } from './turnChangeSets.js';
import type { CodexUsageService } from './codexUsageService.js';

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
  bypassConcurrency?: boolean;
  workMode: ConversationCollaborationMode;
  applyLegacyTaskGuards?: boolean;
  ephemeral?: boolean;
  additionalContext?: Record<string, unknown>;
  holdDispatch?: boolean;
}

interface PersistedSubmissionInput {
  text: string;
  attachments?: NativeConversationAttachmentInput[];
  browserComments?: Record<string, unknown>[];
  conversationContext?: Record<string, unknown>;
  context: ConversationDispatchContext;
  displayText?: string;
  origin?: 'implement_plan';
  planItemId?: string;
  delivery?: 'queue' | 'steer_now';
  expectedTurnId?: string | null;
  taskPushLayout?: TaskPushMessageLayout;
  internalOperation?: boolean;
  requestAnswerId?: string;
  goalObjective?: string;
}

interface NativeTurnResultWaiter {
  resolve(result: NativeTurnResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface NativeConversationDispatchLease {
  submissionId: string;
  lifecycles: Set<NativeProviderWriteLifecycle>;
  rpcStartedResourceId: string | null;
  promise?: Promise<NativeAcceptedOperation>;
}

export interface CreateCodexNativeConversationCoordinatorOptions {
  manager: CodexAppServerManager;
  enabled?: boolean;
  commandPath: string | (() => string);
  externalAgentHome?: string;
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  items: ConversationItemRepository;
  resources?: ConversationResourceRepository;
  changeSets?: TurnChangeSetService;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
  planActions?: ConversationPlanActionRepository;
  goals?: ConversationGoalRepository;
  receipts?: ProviderEventReceiptRepository;
  syncCheckpoints?: ConversationProviderSyncCheckpointRepository;
  settings: SettingRepository;
  usage?: CodexUsageService;
  getConcurrency: (projectId: string) => { project: number; global: number; maxPerProject: number; maxGlobal: number };
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  now?: () => string;
  operationId?: () => string;
  turnResultTimeoutMs?: number;
  browserAutomation?: BrowserAutomationPort;
  trustedAttachmentRoots?: string[];
  generatedImageRoot?: string;
  getProjectRoot?: (projectId: string) => string | null;
  ensureExecutionContext?: (input: {
    conversationId: string;
    mode: 'reconcile' | 'submit' | 'dispatch' | 'recover_queue' | 'restore';
  }) => Promise<{ projectLocalPath: string; writableRoots?: string[]; executionWorkspaceMode?: 'direct' | 'worktree' } | null>;
  resolveResponsesRuntime?: (input: { modelSourceId: string | null; model: string }) => Promise<CodexResponsesRuntime | null>;
}

export interface CodexNativeConversationRuntime extends CodexNativeConversationCoordinator {
  startEphemeralConversation(input: StartNativeEphemeralConversationInput): Promise<NativeAcceptedOperation>;
  waitForTurnResult(input: WaitForNativeTurnResultInput): Promise<NativeTurnResult>;
  /** 仅依据已持久的终态轮次和精确消息身份收口历史提交，不连接 Provider。 */
  reconcilePersistedTerminalSubmissions(): Promise<number>;
  close(input?: { mode: 'handoff' | 'final' }): Promise<void>;
}

const providerEventErrorsSettingKey = 'codex.native.provider_event_errors';
const providerEventHotReceiptLimit = 10_000;

/** 只接收 app-server 明确返回的绝对路径；缺失或相对路径都不推测本地会话位置。 */
function threadPath(snapshot: CodexThreadSnapshot): string | undefined {
  return typeof snapshot.path === 'string' && snapshot.path.trim() && isAbsolute(snapshot.path.trim()) ? snapshot.path.trim() : undefined;
}

const compatibilitySnapshotItemIdPattern = /^item-\d+$/u;

function compatibilitySnapshotItemIdentity(item: Pick<ZeusConversationItemRecord, 'providerThreadId' | 'providerTurnId' | 'itemType' | 'status' | 'phase' | 'textContent'>): string {
  return JSON.stringify([item.providerThreadId, item.providerTurnId, item.itemType, item.status, item.phase]);
}

function claimCompatibilitySnapshotSourceItems(
  target: Pick<ZeusConversationItemRecord, 'providerThreadId' | 'providerTurnId' | 'itemType' | 'status' | 'phase' | 'textContent'>,
  candidates: readonly ZeusConversationItemRecord[],
  claimedItemIds: Set<string>,
): ZeusConversationItemRecord[] {
  const scoped = candidates.filter(
    (candidate) => !compatibilitySnapshotItemIdPattern.test(candidate.providerItemId) && !claimedItemIds.has(candidate.id) && compatibilitySnapshotItemIdentity(candidate) === compatibilitySnapshotItemIdentity(target),
  );
  const maximumSegmentCount = target.itemType === 'reasoning' ? scoped.length : Math.min(scoped.length, 1);
  for (let start = 0; start < scoped.length; start += 1) {
    const matched: ZeusConversationItemRecord[] = [];
    let combinedText = '';
    for (let index = start; index < scoped.length && matched.length < maximumSegmentCount; index += 1) {
      const candidate = scoped[index]!;
      matched.push(candidate);
      combinedText = combinedText ? `${combinedText}\n\n${candidate.textContent}` : candidate.textContent;
      if (combinedText === target.textContent) return matched;
      if (!target.textContent.startsWith(combinedText)) break;
    }
  }
  return [];
}

/**
 * 部分 Codex 版本在恢复旧 JSONL 时会把真实 `msg_* / rs_*` 条目改投影为 `item-N`。
 * 只有存在逐字段相同的真实条目时才抑制兼容别名；同文但没有真实身份的条目继续保留。
 */
export function filterCompatibilitySnapshotItemAliases(items: readonly ZeusConversationItemRecord[]): {
  items: ZeusConversationItemRecord[];
  suppressedProviderItemIds: Set<string>;
} {
  const claimedItemIds = new Set<string>();
  const suppressedProviderItemIds = new Set<string>();
  const projectedItems = items.filter((item) => {
    if (!compatibilitySnapshotItemIdPattern.test(item.providerItemId)) return true;
    const sourceItems = claimCompatibilitySnapshotSourceItems(item, items, claimedItemIds);
    if (sourceItems.length === 0) return true;
    for (const sourceItem of sourceItems) claimedItemIds.add(sourceItem.id);
    suppressedProviderItemIds.add(item.providerItemId);
    return false;
  });
  return { items: projectedItems, suppressedProviderItemIds };
}

export function createCodexNativeConversationCoordinator(options: CreateCodexNativeConversationCoordinatorOptions): CodexNativeConversationRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const operationId = options.operationId ?? randomUUID;
  const planActions = options.planActions ?? new ConversationPlanActionRepository(options.db);
  const goals = options.goals ?? new ConversationGoalRepository(options.db);
  const resources = options.resources ?? new ConversationResourceRepository(options.db);
  const receipts = options.receipts ?? new ProviderEventReceiptRepository(options.db);
  const syncCheckpoints = options.syncCheckpoints ?? new ConversationProviderSyncCheckpointRepository(options.db);
  const runStates = new Map<string, NativeConversationRunState>();
  const contexts = new Map<string, ConversationDispatchContext>();
  const executionContextPromises = new Map<string, Promise<void>>();
  const dispatchLeases = new Map<string, NativeConversationDispatchLease>();
  const hotReceiptIdentities = new Set<string>();
  const maintainedReceiptGenerations = new Set<string>();
  const completedTurnResults = new Map<string, NativeTurnResult>();
  const failedTurnResults = new Map<string, Error & { code: string }>();
  const turnResultWaiters = new Map<string, NativeTurnResultWaiter[]>();
  const autoResolutionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 敏感回答不能落入 submission JSON；仅在当前宿主内存中保留到新 turn 被 app-server 接受。
  const volatileSubmissionText = new Map<string, string>();
  let closing = false;
  let closed = false;
  let providerEventChain = Promise.resolve();
  let generationReconcileChain = Promise.resolve();
  let reconciledGenerationId: string | null = null;
  let hotReceiptGenerationId: string | null = null;
  let queueDrainPromise: Promise<void> | null = null;
  let handoffPromise: Promise<void> | null = null;
  let finalizationPromise: Promise<void> | null = null;
  const readableDeltaCoalesceMs = 40;
  const pendingReadableDeltas = new Map<string, { latest: CodexAppServerEvent; events: CodexAppServerEvent[] }>();
  let readableDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPersistDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPersistDirty = false;
  let persistenceChain = Promise.resolve();

  const unsubscribe = options.manager.subscribe((event) => {
    if (event.method === 'item/tool/call') {
      void handleDynamicBrowserToolCall(event);
      return;
    }
    return enqueueProviderEvent(event);
  });

  function enqueueProviderEvent(event: CodexAppServerEvent): Promise<void> {
    if (isReadableItemTextDeltaEvent(event.method) && readableDeltaKey(event) && typeof readableDeltaText(event) === 'string') {
      if (isKnownProviderEvent(event)) return providerEventChain;
      const key = readableDeltaKey(event)!;
      const previous = pendingReadableDeltas.get(key);
      if (previous) {
        previous.events.push(event);
        previous.latest = event;
        pendingReadableDeltas.delete(key);
        pendingReadableDeltas.set(key, previous);
      } else {
        pendingReadableDeltas.set(key, { latest: event, events: [event] });
      }
      scheduleReadableDeltaFlush();
      return providerEventChain;
    }
    flushReadableDeltas();
    providerEventChain = providerEventChain.then(() => handleProviderEvent(event)).catch((error) => safelyHandleProviderEventError(event, error));
    return providerEventChain;
  }

  function enqueueProviderTurnReconciliation(conversation: ZeusConversationWithMessagesRecord): Promise<void> {
    flushReadableDeltas();
    const reconciliation = providerEventChain.then(() => reconcileProviderTurnsSinceCheckpoint(conversation));
    // 历史补偿与实时事件共用一条串行链，防止旧检查点覆盖刚接收的新轮次。
    providerEventChain = reconciliation.catch(() => undefined);
    return reconciliation;
  }

  function scheduleReadableDeltaFlush(): void {
    if (readableDeltaFlushTimer) return;
    readableDeltaFlushTimer = setTimeout(() => {
      readableDeltaFlushTimer = null;
      flushReadableDeltas();
    }, readableDeltaCoalesceMs);
  }

  function flushReadableDeltas(): void {
    if (readableDeltaFlushTimer) clearTimeout(readableDeltaFlushTimer);
    readableDeltaFlushTimer = null;
    if (pendingReadableDeltas.size === 0) return;
    const batches = [...pendingReadableDeltas.values()];
    pendingReadableDeltas.clear();
    providerEventChain = providerEventChain
      .then(async () => {
        for (const batch of batches) {
          const latest = batch.latest;
          const latestParams = isRecord(latest.params) ? latest.params : {};
          const mergedEvent: CodexAppServerEvent = {
            ...latest,
            params: {
              ...latestParams,
              delta: batch.events.map((event) => readableDeltaText(event) ?? '').join(''),
            },
          };
          try {
            await handleProviderEvent(mergedEvent, batch.events);
          } catch (error) {
            await safelyHandleProviderEventError(mergedEvent, error, batch.events);
          }
        }
      })
      .catch(() => undefined);
  }

  function isKnownProviderEvent(event: CodexAppServerEvent): boolean {
    const identity = eventIdentity(event);
    return hotReceiptGenerationId === event.generationId && hotReceiptIdentities.has(identity) ? true : receipts.has(identity);
  }

  function assertOpen(): void {
    if (closing || closed) throw coordinatorError('ZEUS_CODEX_COORDINATOR_CLOSED', 'Codex native conversation coordinator is closed.');
    if (options.enabled === false) throw coordinatorError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
  }

  async function persist(): Promise<void> {
    await options.db.save();
  }

  function clearScheduledPersistTimers(): void {
    if (scheduledPersistTimer) clearTimeout(scheduledPersistTimer);
    if (scheduledPersistDeadlineTimer) clearTimeout(scheduledPersistDeadlineTimer);
    scheduledPersistTimer = null;
    scheduledPersistDeadlineTimer = null;
  }

  function enqueuePersist(): Promise<void> {
    const run = persistenceChain.then(() => persist());
    // 单次失败由当前调用者处理；后续保存仍需能够继续尝试。
    persistenceChain = run.catch(() => undefined);
    return run;
  }

  async function flushScheduledPersist(): Promise<void> {
    clearScheduledPersistTimers();
    if (!scheduledPersistDirty) {
      await persistenceChain;
      return;
    }
    scheduledPersistDirty = false;
    await enqueuePersist();
  }

  function reportScheduledPersistFailure(error: unknown): void {
    options.broadcast('codex.native.error', {
      error: 'ZEUS_CODEX_PERSIST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * 过程事件先更新内存与界面，再在安静窗口合并落盘；持续输出最长十秒必须形成一次持久检查点。
   * 询问、审批和轮次边界不走这里，由事件处理器立即 flush。
   */
  function schedulePersist(): void {
    scheduledPersistDirty = true;
    if (scheduledPersistTimer) clearTimeout(scheduledPersistTimer);
    scheduledPersistTimer = setTimeout(() => {
      scheduledPersistTimer = null;
      void flushScheduledPersist().catch(reportScheduledPersistFailure);
    }, 2_000);
    if (!scheduledPersistDeadlineTimer) {
      scheduledPersistDeadlineTimer = setTimeout(() => {
        scheduledPersistDeadlineTimer = null;
        void flushScheduledPersist().catch(reportScheduledPersistFailure);
      }, 10_000);
    }
  }

  function requiresImmediatePersist(event: CodexAppServerEvent, createdPlanImplementationRequest: unknown): boolean {
    return (
      event.requestId !== undefined ||
      event.method === 'turn/started' ||
      event.method === 'turn/completed' ||
      event.method === 'thread/goal/updated' ||
      event.method === 'thread/goal/cleared' ||
      event.method === 'serverRequest/resolved' ||
      createdPlanImplementationRequest !== null
    );
  }

  function syncItemResources(
    conversation: ZeusConversationWithMessagesRecord,
    turn: ZeusConversationTurnRecord,
    item: ReturnType<ConversationItemRepository['getByProvider']> extends infer RecordType ? Exclude<RecordType, undefined> : never,
    payload: Record<string, unknown>,
    text: string,
    timestamp: string,
  ) {
    const projectRoot = contexts.get(conversation.id)?.projectLocalPath ?? options.getProjectRoot?.(conversation.projectId) ?? null;
    if (!projectRoot) return [];
    const submission = item.itemType === 'userMessage' ? submissionForProviderUserItem(conversation.id, turn, payload) : undefined;
    const resourcePayload = submission ? { ...payload, attachments: submissionAttachments(submission) } : payload;
    const normalized = normalizeConversationResources({
      projectId: conversation.projectId,
      projectRoot,
      conversationId: conversation.id,
      turnId: turn.id,
      item,
      payload: resourcePayload,
      text,
      trustedAttachmentRoots: options.trustedAttachmentRoots ?? [],
      generatedImageRoot: options.generatedImageRoot,
      now: timestamp,
    });
    return resources
      .replaceForItem(item.id, normalized, timestamp)
      .map(toConversationResource)
      .filter((resource): resource is NonNullable<typeof resource> => resource !== null);
  }

  function commandPath(): string {
    return typeof options.commandPath === 'function' ? options.commandPath() : options.commandPath;
  }

  async function handleDynamicBrowserToolCall(event: CodexAppServerEvent): Promise<void> {
    if (closed || event.requestId === undefined) return;
    const params = isRecord(event.params) ? event.params : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    const callId = typeof params.callId === 'string' ? params.callId : '';
    const namespace = typeof params.namespace === 'string' ? params.namespace : '';
    const tool = typeof params.tool === 'string' ? params.tool : '';
    const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
    const conversation = threadId ? options.conversations.getByProviderThreadId(threadId) : undefined;
    try {
      if (!options.browserAutomation) throw coordinatorError('ZEUS_BROWSER_AUTOMATION_UNAVAILABLE', 'The built-in browser automation host is unavailable.');
      if (!conversation || !threadId || !turnId || !callId) throw coordinatorError('ZEUS_BROWSER_TOOL_CONTEXT_INVALID', 'The browser tool call is not attached to a durable Zeus conversation.');
      if (namespace !== 'zeus_browser' || !tool) throw coordinatorError('ZEUS_BROWSER_TOOL_UNSUPPORTED', 'The requested dynamic tool is not owned by the Zeus browser namespace.');
      const result = await options.browserAutomation.invoke({
        conversationId: conversation.id,
        threadId,
        turnId,
        callId,
        tool,
        arguments: argumentsValue,
      });
      await options.manager.respondToServerRequest({
        generationId: event.generationId,
        requestId: event.requestId,
        type: 'dynamic_tool',
        contentItems: result.contentItems,
        success: result.success,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await options.manager.respondToServerRequest({
          generationId: event.generationId,
          requestId: event.requestId,
          type: 'dynamic_tool',
          contentItems: [{ type: 'inputText', text: `Zeus built-in browser tool failed: ${detail.slice(0, 1200)}` }],
          success: false,
        });
      } catch (responseError) {
        options.broadcast('conversation.native.error', {
          ...(conversation ? { conversationId: conversation.id } : {}),
          providerThreadId: threadId || null,
          providerTurnId: turnId || null,
          error: 'ZEUS_BROWSER_TOOL_RESPONSE_FAILED',
          message: responseError instanceof Error ? responseError.message : String(responseError),
        });
      }
    }
  }

  function activeNativeCounts(projectId: string): { project: number; global: number } {
    let project = 0;
    let global = 0;
    for (const [conversationId, state] of runStates) {
      if (state.type !== 'dispatching' && state.type !== 'active' && state.type !== 'waiting') continue;
      global += 1;
      if (contexts.get(conversationId)?.projectId === projectId) project += 1;
    }
    return { project, global };
  }

  function hasConcurrency(context: ConversationDispatchContext): boolean {
    if (context.bypassConcurrency) return true;
    const external = options.getConcurrency(context.projectId);
    const active = activeNativeCounts(context.projectId);
    return external.project + active.project < external.maxPerProject && external.global + active.global < external.maxGlobal;
  }

  function contextFromSubmission(submission: ZeusConversationSubmissionRecord): ConversationDispatchContext {
    const parsed = parseJsonRecord(submission.inputJson);
    const context = isRecord(parsed.context) ? parsed.context : {};
    const conversationProjectId = options.conversations.getById(submission.conversationId)?.projectId;
    return {
      // 早期持久 submission 可能缺少 projectId；会话归属是同一事实的权威兼容来源。
      projectId: requireString(typeof context.projectId === 'string' && context.projectId ? context.projectId : conversationProjectId, 'submission projectId'),
      projectLocalPath: requireString(context.projectLocalPath, 'submission projectLocalPath'),
      taskId: typeof context.taskId === 'string' ? context.taskId : null,
      ...(context.executionWorkspaceMode === 'direct' || context.executionWorkspaceMode === 'worktree' ? { executionWorkspaceMode: context.executionWorkspaceMode } : {}),
      model: requireString(context.model, 'submission model'),
      modelSourceId: typeof context.modelSourceId === 'string' ? context.modelSourceId : (options.conversations.getById(submission.conversationId)?.modelSourceId ?? null),
      ...(typeof context.effort === 'string' ? { effort: context.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') && (context.serviceTier === null || typeof context.serviceTier === 'string') ? { serviceTier: context.serviceTier } : {}),
      allowCodeChanges: context.allowCodeChanges === true,
      allowTests: context.allowTests === true,
      allowGitCommit: context.allowGitCommit === true,
      permissionMode: permissionModeFromValue(context.permissionMode, context.allowCodeChanges === true ? 'auto' : 'read-only'),
      ...(Array.isArray(context.allowedAttachmentRoots) && context.allowedAttachmentRoots.every((root) => typeof root === 'string') ? { allowedAttachmentRoots: context.allowedAttachmentRoots } : {}),
      ...(Array.isArray(context.writableRoots) && context.writableRoots.every((root) => typeof root === 'string') ? { writableRoots: context.writableRoots } : {}),
      ...(context.bypassConcurrency === true ? { bypassConcurrency: true } : {}),
      workMode: context.workMode === 'plan' || context.workMode === 'default' ? context.workMode : 'default',
      ...(context.applyLegacyTaskGuards === false ? { applyLegacyTaskGuards: false } : {}),
      ...(context.ephemeral === true ? { ephemeral: true } : {}),
      ...(isRecord(context.additionalContext) ? { additionalContext: context.additionalContext } : {}),
      ...(context.holdDispatch === true ? { holdDispatch: true } : {}),
    };
  }

  async function ensureConversationExecutionContext(conversationId: string, mode: 'reconcile' | 'submit' | 'dispatch' | 'recover_queue' | 'restore'): Promise<void> {
    if (!options.ensureExecutionContext) return;
    const existing = executionContextPromises.get(conversationId);
    if (existing) return existing;
    const promise = (async () => {
      const resolved = await options.ensureExecutionContext!({ conversationId, mode });
      if (!resolved) return;
      const conversation = requireConversation(conversationId);
      const current = contexts.get(conversationId) ?? contextFromConversation(conversation);
      const next: ConversationDispatchContext = {
        ...current,
        projectLocalPath: resolve(resolved.projectLocalPath),
        ...(resolved.writableRoots ? { writableRoots: resolved.writableRoots.map((root) => resolve(root)) } : {}),
        ...(resolved.executionWorkspaceMode ? { executionWorkspaceMode: resolved.executionWorkspaceMode } : {}),
      };
      contexts.set(conversationId, next);
      for (const submission of options.submissions.listByConversation(conversationId)) {
        if ((submission.status !== 'queued' && submission.status !== 'paused') || submission.providerTurnId) continue;
        const submissionContext = contextFromSubmission(submission);
        persistSubmissionExecutionContext(submission, {
          ...submissionContext,
          projectLocalPath: next.projectLocalPath,
          ...(next.writableRoots ? { writableRoots: next.writableRoots } : {}),
          ...(next.executionWorkspaceMode ? { executionWorkspaceMode: next.executionWorkspaceMode } : {}),
        });
      }
      await persist();
    })();
    executionContextPromises.set(conversationId, promise);
    try {
      await promise;
    } finally {
      if (executionContextPromises.get(conversationId) === promise) executionContextPromises.delete(conversationId);
    }
  }

  function persistSubmissionExecutionContext(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): void {
    const input = parseJsonRecord(submission.inputJson);
    options.db.execute(`UPDATE conversation_submissions SET input_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ ...input, context }), now(), submission.id]);
  }

  function submissionText(submission: ZeusConversationSubmissionRecord): string {
    const text = parseJsonRecord(submission.inputJson).text;
    if (typeof text !== 'string') throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted submission text is invalid.');
    return text;
  }

  function submissionGoalObjective(submission: ZeusConversationSubmissionRecord): string | null {
    const value = parseJsonRecord(submission.inputJson).goalObjective;
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 4_000) {
      throw coordinatorError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。');
    }
    return value.trim();
  }

  function submissionTaskPushLayout(submission: ZeusConversationSubmissionRecord): TaskPushMessageLayout | null {
    const value = parseJsonRecord(submission.inputJson).taskPushLayout;
    if (value === undefined) return null;
    if (!isRecord(value) || value.kind !== 'task_push' || !Array.isArray(value.blocks) || typeof value.supplementalInfo !== 'string' || (value.supplementalAttachments !== undefined && !Array.isArray(value.supplementalAttachments))) {
      throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted task push layout is invalid.');
    }
    return { ...value, supplementalAttachments: value.supplementalAttachments ?? [] } as unknown as TaskPushMessageLayout;
  }

  function submissionAttachments(submission: ZeusConversationSubmissionRecord): NativeConversationAttachmentInput[] {
    const value = parseJsonRecord(submission.inputJson).attachments;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment input is invalid.');
    return value.map((attachment) => {
      if (
        !isRecord(attachment) ||
        typeof attachment.name !== 'string' ||
        !attachment.name ||
        typeof attachment.mime !== 'string' ||
        !attachment.mime ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0
      ) {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment metadata is invalid.');
      }
      const localPath = typeof attachment.localPath === 'string' && attachment.localPath ? attachment.localPath : undefined;
      const uploadRef = typeof attachment.uploadRef === 'string' && attachment.uploadRef ? attachment.uploadRef : undefined;
      if ((localPath ? 1 : 0) + (uploadRef ? 1 : 0) !== 1) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment identity is invalid.');
      const authorizedPath = typeof attachment.authorizedPath === 'string' && attachment.authorizedPath ? attachment.authorizedPath : undefined;
      if (authorizedPath && (!localPath || uploadRef)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment path authority is invalid.');
      const taskPushAttachmentKey = typeof attachment.taskPushAttachmentKey === 'string' && attachment.taskPushAttachmentKey.trim() ? attachment.taskPushAttachmentKey.trim() : undefined;
      return {
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        ...(localPath ? { localPath } : {}),
        ...(uploadRef ? { uploadRef } : {}),
        ...(authorizedPath ? { authorizedPath } : {}),
        ...(taskPushAttachmentKey ? { taskPushAttachmentKey } : {}),
      };
    });
  }

  function submissionBrowserComments(submission: ZeusConversationSubmissionRecord): Record<string, unknown>[] {
    const value = parseJsonRecord(submission.inputJson).browserComments;
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw coordinatorError('ZEUS_NATIVE_BROWSER_COMMENTS_INVALID', 'Durable browser comment metadata is invalid.');
    }
    return value;
  }

  function submissionConversationContext(submission: ZeusConversationSubmissionRecord): Record<string, unknown> | null {
    const value = parseJsonRecord(submission.inputJson).conversationContext;
    if (value === undefined) return null;
    if (!isRecord(value) || !Array.isArray(value.responseAnnotations) || !Array.isArray(value.codeComments)) {
      throw coordinatorError('ZEUS_NATIVE_CONVERSATION_CONTEXT_INVALID', 'Durable conversation context metadata is invalid.');
    }
    return value;
  }

  function submissionProviderInput(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): Array<Record<string, unknown>> {
    const text = volatileSubmissionText.get(submission.id) ?? submissionText(submission);
    const attachments = submissionAttachments(submission);
    const allowedRoots = [...(context.allowedAttachmentRoots?.length ? context.allowedAttachmentRoots : [context.projectLocalPath]), ...(options.trustedAttachmentRoots ?? [])]
      .map(existingDirectoryRealpath)
      .filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index);
    if (allowedRoots.length === 0 && attachments.length > 0) {
      throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_PROJECT_UNAVAILABLE', 'No trusted attachment root can be resolved.');
    }
    const providerAttachment = (attachment: NativeConversationAttachmentInput): Record<string, unknown> => {
      if (attachment.uploadRef) {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_UPLOAD_UNSUPPORTED', 'Native attachment uploadRef has no provider resolver.');
      }
      const localPath = attachment.localPath;
      if (!localPath || !isAbsolute(localPath)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Native attachment localPath must be absolute.');
      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(localPath);
        const pathStat = statSync(canonicalPath);
        const exactlyAuthorized = Boolean(attachment.authorizedPath) && realpathSync(attachment.authorizedPath!) === canonicalPath;
        if ((!exactlyAuthorized && !allowedRoots.some((root) => isInsideRoot(canonicalPath, root))) || (!pathStat.isFile() && !pathStat.isDirectory())) {
          throw new Error('outside trusted roots or not a file/directory');
        }
      } catch {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_PATH_UNAVAILABLE', 'Native attachment must resolve to an authorized file or directory.');
      }
      return isSupportedLocalImageAttachment(attachment, canonicalPath) ? { type: 'localImage', path: canonicalPath } : { type: 'mention', name: attachment.name, path: canonicalPath };
    };
    const taskPushLayout = submissionTaskPushLayout(submission);
    const inputs: Array<Record<string, unknown>> = [];
    if (taskPushLayout) {
      const attachmentsByKey = new Map(attachments.flatMap((attachment) => (attachment.taskPushAttachmentKey ? [[attachment.taskPushAttachmentKey, attachment] as const] : [])));
      for (const part of buildTaskPushInputParts(taskPushLayout)) {
        if (part.type === 'text') {
          if (part.text) inputs.push({ type: 'text', text: part.text });
          continue;
        }
        const attachment = attachmentsByKey.get(part.attachmentKey);
        if (!attachment) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', `Task push attachment placement is missing: ${part.attachmentKey}`);
        inputs.push(providerAttachment(attachment));
      }
    } else {
      if (text.trim()) inputs.push({ type: 'text', text });
      for (const attachment of attachments) inputs.push(providerAttachment(attachment));
    }
    if (inputs.length === 0) throw coordinatorError('ZEUS_INVALID_CONVERSATION_MESSAGE', 'Native submission requires text or attachments.');
    return inputs;
  }

  function toQueueSnapshot(conversationId: string): NativeQueueSnapshot {
    const entries = options.submissions.listByConversation(conversationId).filter((submission) => (submission.status === 'queued' || submission.status === 'paused') && !submission.providerTurnId);
    return {
      conversationId,
      state: runStates.get(conversationId) ?? { type: 'idle' },
      submissions: entries.map((submission, index) => {
        const input = parseJsonRecord(submission.inputJson);
        const error = submissionErrorSnapshot(submission.errorJson);
        return {
          id: submission.id,
          conversationId: submission.conversationId,
          content:
            submissionText(submission) ||
            submissionAttachments(submission)
              .map((attachment) => attachment.name)
              .join('、'),
          status: submission.status as 'queued' | 'paused',
          delivery: input.delivery === 'steer_now' ? ('steer_now' as const) : ('queue' as const),
          attachments: submissionAttachments(submission),
          ...(submissionConversationContext(submission) ? { conversationContext: submissionConversationContext(submission)! } : {}),
          expectedTurnId: typeof input.expectedTurnId === 'string' ? input.expectedTurnId : null,
          clientUserMessageId: submission.clientMessageId,
          position: submission.queuePosition ?? index + 1,
          providerTurnId: null,
          pausedReason: submission.pausedReason,
          error,
          createdAt: submission.createdAt,
          updatedAt: submission.updatedAt,
        };
      }),
    };
  }

  function createSubmission(
    conversationId: string,
    content: string,
    input: {
      submissionId?: string;
      idempotencyKey: string;
      clientUserMessageId: string;
      attachments?: NativeConversationAttachmentInput[];
      browserComments?: Record<string, unknown>[];
      conversationContext?: Record<string, unknown>;
      displayText?: string;
      taskPushLayout?: TaskPushMessageLayout;
      origin?: 'implement_plan';
      planItemId?: string;
      requestAnswerId?: string;
      internalOperation?: boolean;
      goalObjective?: string;
    },
    context: ConversationDispatchContext,
  ): ZeusConversationSubmissionRecord {
    const queuedCount = options.submissions.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed').length;
    const payload: PersistedSubmissionInput = {
      text: content,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.browserComments?.length ? { browserComments: input.browserComments } : {}),
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      context,
      ...(input.displayText ? { displayText: input.displayText } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.planItemId ? { planItemId: input.planItemId } : {}),
      ...(input.taskPushLayout ? { taskPushLayout: input.taskPushLayout } : {}),
      ...(input.requestAnswerId ? { requestAnswerId: input.requestAnswerId } : {}),
      ...(input.internalOperation ? { internalOperation: true } : {}),
      ...(input.goalObjective ? { goalObjective: input.goalObjective } : {}),
    };
    const existing = input.submissionId ? options.submissions.getById(input.submissionId) : undefined;
    if (existing) {
      if (existing.conversationId !== conversationId || existing.idempotencyKey !== input.idempotencyKey) {
        throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved submission id is already owned by another conversation operation.');
      }
      return options.submissions.updateQueuedInput(existing.id, { requestHash: requestHash(payload), input: payload });
    }
    return options.submissions.createOrGet({
      ...(input.submissionId ? { id: input.submissionId } : {}),
      conversationId,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(payload),
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'queued',
      queuePosition: queuedCount + 1,
      input: payload,
      createdAt: now(),
    });
  }

  function nextTurnSettingsFromContext(context: ConversationDispatchContext): ConversationNextTurnSettings {
    return {
      model: context.model,
      ...(context.effort ? { effort: context.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
      permissionMode: context.permissionMode,
      collaborationMode: context.workMode,
    };
  }

  function contextWithLatestNextTurnSettings(conversationId: string, context: ConversationDispatchContext): ConversationDispatchContext {
    const settings = options.conversations.getNextTurnSettings(conversationId);
    if (!settings) return context;
    const latest: ConversationDispatchContext = {
      ...context,
      model: settings.model,
      permissionMode: settings.permissionMode,
      workMode: settings.collaborationMode,
    };
    delete latest.effort;
    delete latest.serviceTier;
    if (settings.effort) latest.effort = settings.effort;
    if (Object.prototype.hasOwnProperty.call(settings, 'serviceTier')) latest.serviceTier = settings.serviceTier;
    return latest;
  }

  async function startTaskConversation(input: StartTaskConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    if (!input.holdDispatch) await assertCodexAccountReady(input.modelSourceId ?? null, input.model);
    const legacyContext = resolveLegacyReference(input);
    const additionalContext = input.additionalContext ? { ...input.additionalContext, ...(legacyContext ? { legacyReference: legacyContext } : {}) } : legacyContext;
    const existingConversation = input.conversationId ? options.conversations.getById(input.conversationId) : undefined;
    const permissionMode = existingConversation?.permissionMode ?? input.permissionMode ?? (input.allowCodeChanges ? 'auto' : 'read-only');
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: input.taskId,
      ...(input.executionWorkspaceMode ? { executionWorkspaceMode: input.executionWorkspaceMode } : {}),
      model: input.model,
      modelSourceId: input.modelSourceId ?? null,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
      allowCodeChanges: input.allowCodeChanges,
      allowTests: input.allowTests,
      allowGitCommit: input.allowGitCommit,
      permissionMode,
      ...(input.allowedAttachmentRoots?.length ? { allowedAttachmentRoots: input.allowedAttachmentRoots.map((root) => resolve(root)) } : {}),
      ...(input.writableRoots?.length ? { writableRoots: input.writableRoots.map((root) => resolve(root)) } : {}),
      ...(input.bypassConcurrency ? { bypassConcurrency: true } : {}),
      workMode: input.workMode ?? existingConversation?.collaborationMode ?? 'default',
      ...(input.applyLegacyTaskGuards === false ? { applyLegacyTaskGuards: false } : {}),
      ...(input.ephemeral ? { ephemeral: true } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      ...(input.holdDispatch ? { holdDispatch: true } : {}),
    };
    if (
      existingConversation &&
      (existingConversation.projectId !== input.projectId ||
        existingConversation.taskId !== input.taskId ||
        existingConversation.workspaceId !== (input.workspaceId ?? null) ||
        existingConversation.environmentId !== (input.environmentId ?? null) ||
        existingConversation.transportKind !== 'codex_native')
    ) {
      throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved native conversation id is already owned by another resource.');
    }
    const conversation =
      existingConversation ??
      options.conversations.create({
        ...(input.conversationId ? { id: input.conversationId } : {}),
        projectId: input.projectId,
        taskId: input.taskId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        title: input.conversationTitle?.trim().slice(0, 80) || `任务会话：${input.taskTitle.slice(0, 48)}`,
        summary: input.prompt.slice(0, 240),
        status: 'starting',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerModel: input.model,
        modelSourceId: input.modelSourceId ?? undefined,
        modelId: input.model,
        providerState: 'unbound',
        legacySourceConversationId: input.legacyReference?.conversationId,
        permissionMode,
        collaborationMode: context.workMode,
      });
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    if (!input.holdDispatch) releaseHeldSubmissions(conversation.id, context);
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (input.holdDispatch || !hasConcurrency(context)) return accepted(submission, 'queued', null, null);
    if (input.deferInitialDispatch) {
      // 冲突会话先把稳定身份和用户消息交给界面，Provider 启动失败由会话队列继续呈现和恢复。
      requestQueueDrain();
      return accepted(submission, 'queued', null, null);
    }
    return dispatchSubmission(conversation, submission, input.providerWriteLifecycle);
  }

  async function startProjectConversation(input: StartProjectConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    await assertCodexAccountReady(input.modelSourceId ?? null, input.model);
    const title = projectConversationTitle(input.prompt, input.attachments);
    const existingConversation = input.conversationId ? options.conversations.getById(input.conversationId) : undefined;
    const permissionMode = existingConversation?.permissionMode ?? input.permissionMode ?? 'auto';
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: null,
      model: input.model,
      modelSourceId: input.modelSourceId ?? null,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
      allowCodeChanges: permissionMode !== 'read-only',
      allowTests: permissionMode !== 'read-only',
      allowGitCommit: false,
      permissionMode,
      workMode: input.collaborationMode ?? existingConversation?.collaborationMode ?? 'default',
    };
    if (existingConversation && (existingConversation.projectId !== input.projectId || existingConversation.taskId !== null || existingConversation.transportKind !== 'codex_native')) {
      throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved project conversation id is already owned by another resource.');
    }
    const conversation =
      existingConversation ??
      options.conversations.create({
        ...(input.conversationId ? { id: input.conversationId } : {}),
        projectId: input.projectId,
        title,
        summary: [...input.prompt].slice(0, 240).join('') || input.attachments?.[0]?.name || '',
        status: 'starting',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerModel: input.model,
        modelSourceId: input.modelSourceId ?? undefined,
        modelId: input.model,
        providerState: 'unbound',
        permissionMode,
        collaborationMode: context.workMode,
      });
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (!hasConcurrency(context)) return accepted(submission, 'queued', null, null);
    return dispatchSubmission(conversation, submission, input.providerWriteLifecycle);
  }

  function projectConversationTitle(prompt: string, attachments: NativeConversationAttachmentInput[] | undefined): string {
    const firstLine = prompt
      .split(/\r\n?|\n/u)
      .map((line) => line.replace(/\s+/gu, ' ').trim())
      .find(Boolean);
    if (firstLine) return [...firstLine].slice(0, 48).join('');
    const attachmentName = attachments?.find((attachment) => attachment.name.trim())?.name.trim();
    if (attachmentName) return [...attachmentName].slice(0, 48).join('');
    throw coordinatorError('ZEUS_INVALID_CONVERSATION_START', 'Project conversation content or attachments are required.');
  }

  /** 创建任何产品会话前复验账号，避免先持久化一条必然失败的占位会话。 */
  async function assertCodexAccountReady(modelSourceId: string | null, model: string): Promise<void> {
    if (options.resolveResponsesRuntime && (await options.resolveResponsesRuntime({ modelSourceId, model }))) return;
    const account = await options.manager.readAccount({ refreshToken: true });
    if (!account.requiresOpenaiAuth || account.signedIn) return;
    throw coordinatorError('ZEUS_CODEX_LOGIN_REQUIRED', 'Zeus 专属 Codex 尚未登录。请先完成登录，再创建会话。');
  }

  async function responsesRuntimeFor(context: Pick<ConversationDispatchContext, 'modelSourceId' | 'model'>): Promise<CodexResponsesRuntime | null> {
    return options.resolveResponsesRuntime?.({ modelSourceId: context.modelSourceId, model: context.model }) ?? null;
  }

  function goalEventKind(previous: ReturnType<ConversationGoalRepository['get']>, next: CodexThreadGoal): ConversationGoalEventKind | undefined {
    if (!previous) return 'created';
    if (previous.objective !== next.objective) return 'edited';
    if (previous.status === next.status) return undefined;
    if (next.status === 'paused') return 'paused';
    if (next.status === 'active') return 'resumed';
    if (next.status === 'blocked') return 'blocked';
    if (next.status === 'usageLimited') return 'usage_limited';
    if (next.status === 'budgetLimited') return 'budget_limited';
    return 'completed';
  }

  function projectGoal(conversationId: string, goal: CodexThreadGoal, providerTurnId: string | null, occurredAt: string) {
    const previous = goals.get(conversationId);
    if (previous && previous.providerUpdatedAt > goal.updatedAt) return previous;
    const eventKind = goalEventKind(previous, goal);
    const projected = goals.upsert(
      {
        conversationId,
        providerThreadId: goal.threadId,
        objective: goal.objective,
        status: goal.status,
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        providerCreatedAt: goal.createdAt,
        providerUpdatedAt: goal.updatedAt,
      },
      { ...(eventKind ? { eventKind } : {}), providerTurnId, occurredAt },
    );
    const terminalAttention = goal.status === 'complete' || goal.status === 'blocked' || goal.status === 'usageLimited' || goal.status === 'budgetLimited';
    if (eventKind && terminalAttention) {
      options.conversations.markAttentionUnread(conversationId, {
        kind: goal.status === 'complete' ? 'completed' : 'unread',
        turnId: providerTurnId,
        occurredAt,
      });
    }
    options.broadcast('conversation.goal.updated', {
      conversationId,
      goal: projected,
      timeline: goals.listEvents(conversationId),
      eventKind: eventKind ?? null,
      notificationEligible: Boolean(eventKind && terminalAttention),
    });
    return projected;
  }

  async function requireGoalConversation(conversationId: string) {
    assertOpen();
    await ensureGenerationReconciled();
    const conversation = requireConversation(conversationId);
    if (!conversation.providerThreadId) throw coordinatorError('ZEUS_CODEX_GOAL_THREAD_REQUIRED', '创建目标前必须先建立原生会话。');
    const capabilities = options.manager.getState();
    if (capabilities.type !== 'ready' || !capabilities.capabilities.goals.supported || !capabilities.capabilities.goals.enabled) {
      throw coordinatorError('ZEUS_CODEX_GOALS_UNAVAILABLE', '当前 Agent 或 app-server 不支持原生目标。');
    }
    return { conversation, threadId: conversation.providerThreadId };
  }

  async function setGoal(input: { conversationId: string; objective: string }) {
    const objective = input.objective.trim();
    if (!objective || [...objective].length > 4_000) throw coordinatorError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。');
    const { threadId } = await requireGoalConversation(input.conversationId);
    const current = goals.get(input.conversationId) ?? (await options.manager.readThreadGoal({ threadId }).then((goal) => (goal ? projectGoal(input.conversationId, goal, null, now()) : undefined)));
    if (current?.status === 'active' && current.objective !== objective) {
      const paused = await options.manager.setThreadGoal({ threadId, status: 'paused' });
      projectGoal(input.conversationId, paused, null, now());
    }
    const goal = await options.manager.setThreadGoal({ threadId, objective, ...(current ? {} : { status: 'active' as const }) });
    const projected = projectGoal(input.conversationId, goal, null, now());
    await persist();
    return projected;
  }

  async function readGoal(input: { conversationId: string }) {
    const { threadId } = await requireGoalConversation(input.conversationId);
    const goal = await options.manager.readThreadGoal({ threadId });
    if (!goal) {
      goals.clear({ conversationId: input.conversationId, providerThreadId: threadId, occurredAt: now() });
      await persist();
      return null;
    }
    const projected = projectGoal(input.conversationId, goal, null, now());
    await persist();
    return projected;
  }

  async function pauseGoal(input: { conversationId: string }) {
    const { threadId } = await requireGoalConversation(input.conversationId);
    const projected = projectGoal(input.conversationId, await options.manager.setThreadGoal({ threadId, status: 'paused' }), null, now());
    await persist();
    return projected;
  }

  async function resumeGoal(input: { conversationId: string }) {
    const { threadId } = await requireGoalConversation(input.conversationId);
    const projected = projectGoal(input.conversationId, await options.manager.setThreadGoal({ threadId, status: 'active' }), null, now());
    await persist();
    return projected;
  }

  async function clearGoal(input: { conversationId: string }) {
    const { threadId } = await requireGoalConversation(input.conversationId);
    const result = await options.manager.clearThreadGoal({ threadId });
    if (result.cleared) goals.clear({ conversationId: input.conversationId, providerThreadId: threadId, occurredAt: now() });
    await persist();
    options.broadcast('conversation.goal.cleared', { conversationId: input.conversationId, cleared: result.cleared, timeline: goals.listEvents(input.conversationId) });
    return result;
  }

  async function startEphemeralConversation(input: StartNativeEphemeralConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    await assertCodexAccountReady(null, input.model);
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: null,
      model: input.model,
      modelSourceId: null,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
      allowCodeChanges: false,
      allowTests: false,
      allowGitCommit: false,
      permissionMode: 'read-only',
      workMode: 'default',
      ephemeral: true,
    };
    if (!hasConcurrency(context)) throw coordinatorError('ZEUS_CODEX_CONCURRENCY_FULL', 'Codex native Graph question cannot start because concurrency is full.');
    const conversation = options.conversations.create({
      projectId: input.projectId,
      title: input.title,
      summary: input.prompt.slice(0, 240),
      status: 'starting',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerModel: input.model,
      providerState: 'unbound',
      permissionMode: 'read-only',
      collaborationMode: 'default',
    });
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    const operation = await dispatchSubmission(conversation, submission);
    if (operation.status === 'queued') {
      await closeEphemeralConversation(conversation.id, null, 'cancelled', { code: 'ZEUS_CODEX_CONCURRENCY_FULL' }, false);
      throw coordinatorError('ZEUS_CODEX_CONCURRENCY_FULL', 'Codex native Graph question cannot start because concurrency is full.');
    }
    if (operation.status === 'recovery_required') {
      throw coordinatorError('ZEUS_CODEX_EPHEMERAL_DISPATCH_FAILED', 'Codex native Graph provider dispatch failed.');
    }
    return operation;
  }

  function waitForTurnResult(input: WaitForNativeTurnResultInput): Promise<NativeTurnResult> {
    assertOpen();
    const key = `${input.conversationId}:${input.providerTurnId}`;
    const completed = completedTurnResults.get(key);
    if (completed) return Promise.resolve(completed);
    const failed = failedTurnResults.get(key);
    if (failed) return Promise.reject(failed);
    const persistedTurn = options.turns.listByConversation(input.conversationId).find((turn) => turn.providerTurnId === input.providerTurnId);
    if (persistedTurn?.status === 'failed') return Promise.reject(failedTurnErrorFromRecord(persistedTurn));
    const timeoutMs = input.timeoutMs ?? options.turnResultTimeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(coordinatorError('ZEUS_CODEX_TURN_RESULT_TIMEOUT_INVALID', 'Native turn result timeout must be a positive number.'));
    return new Promise((resolveResult, rejectResult) => {
      const waiters = turnResultWaiters.get(key) ?? [];
      const waiter: NativeTurnResultWaiter = {
        resolve: resolveResult,
        reject: rejectResult,
        timer: setTimeout(() => {
          void timeoutTurnResult(input, key).catch((error) => rejectResult(error instanceof Error ? error : new Error(String(error))));
        }, timeoutMs),
      };
      waiters.push(waiter);
      turnResultWaiters.set(key, waiters);
    });
  }

  async function timeoutTurnResult(input: WaitForNativeTurnResultInput, key: string): Promise<void> {
    if (!turnResultWaiters.has(key)) return;
    const error = coordinatorError('ZEUS_CODEX_TURN_RESULT_TIMEOUT', 'Codex native turn did not complete before the timeout.');
    await closeEphemeralConversation(input.conversationId, input.providerTurnId, 'cancelled', serializeError(error), true);
    rejectTurnResultWaiters(key, error);
  }

  function resolveLegacyReference(input: StartTaskConversationInput): Record<string, unknown> | undefined {
    if (!input.legacyReference) return undefined;
    const legacy = options.conversations.getById(input.legacyReference.conversationId);
    if (!legacy || legacy.transportKind !== 'legacy_cli') throw coordinatorError('ZEUS_LEGACY_CONVERSATION_NOT_FOUND', 'Selected legacy conversation was not found.');
    const selected = new Set(input.legacyReference.messageIds);
    if (selected.size !== input.legacyReference.messageIds.length) throw coordinatorError('ZEUS_LEGACY_MESSAGE_SELECTION_INVALID', 'Legacy message ids must be explicit and unique.');
    const messages = input.legacyReference.messageIds.map((messageId) => {
      const message = legacy.messages.find((candidate) => candidate.id === messageId);
      if (!message) throw coordinatorError('ZEUS_LEGACY_MESSAGE_SELECTION_INVALID', `Legacy message does not belong to selected conversation: ${messageId}`);
      return { messageId: message.id, role: message.role, content: message.content };
    });
    return { kind: 'untrusted', items: messages };
  }

  async function submitMessage(input: SubmitNativeMessageInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const previousContext = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const context: ConversationDispatchContext = {
      ...previousContext,
      permissionMode: input.permissionMode ?? previousContext.permissionMode,
      workMode: input.collaborationMode ?? conversation.collaborationMode,
      ...(input.model ? { model: input.model } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'modelSourceId') ? { modelSourceId: input.modelSourceId ?? null } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'serviceTier') ? { serviceTier: input.serviceTier } : {}),
    };
    if (input.model && input.model !== previousContext.model && !input.effort) delete context.effort;
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    const submission = createSubmission(conversation.id, input.content, input, context);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (context.holdDispatch) return accepted(submission, 'queued', conversation.providerThreadId, null);
    try {
      await ensureGenerationReconciled();
    } catch {
      return accepted(submission, 'queued', conversation.providerThreadId, null);
    }
    let refreshed = requireConversation(conversation.id);
    if (refreshed.providerState === 'archived') {
      try {
        await restoreArchivedProviderThread(refreshed.id);
        refreshed = requireConversation(refreshed.id);
      } catch {
        return accepted(submission, 'provider_archived', refreshed.providerThreadId, null);
      }
    }
    try {
      await ensureConversationExecutionContext(refreshed.id, 'submit');
      const recoveryState = runStates.get(refreshed.id) ?? inferRunState(refreshed);
      if (recoveryState.type === 'paused' && recoveryState.reason === 'recovery_required') {
        refreshed = await recoverPausedConversation(refreshed.id, 'submit');
      }
    } catch (error) {
      const failure = serializeError(error);
      options.submissions.updateStatus(submission.id, 'failed', {
        error: failure,
        resolvedAt: now(),
      });
      await persist();
      options.broadcast('conversation.native.error', {
        conversationId: refreshed.id,
        providerThreadId: refreshed.providerThreadId,
        error: { ...failure, recoveryRequired: false },
      });
      options.broadcast('conversation.queue.changed', { conversationId: refreshed.id });
      throw error;
    }
    const state = runStates.get(conversation.id) ?? inferRunState(refreshed);
    runStates.set(conversation.id, state);
    if (state.type !== 'idle' || !hasConcurrency(context)) return accepted(submission, 'queued', refreshed.providerThreadId, null);
    return dispatchSubmission(refreshed, submission, input.providerWriteLifecycle);
  }

  async function steerMessage(input: SteerNativeMessageInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const context = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const queuedCount = options.submissions.listByConversation(conversation.id).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed').length;
    const payload: PersistedSubmissionInput = {
      text: input.content,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.browserComments?.length ? { browserComments: input.browserComments } : {}),
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      context,
      ...(input.displayText ? { displayText: input.displayText } : {}),
      delivery: 'steer_now',
      expectedTurnId: input.expectedTurnId,
      ...(input.requestAnswerId ? { requestAnswerId: input.requestAnswerId } : {}),
    };
    const existingSubmission = input.requestAnswerId ? options.submissions.listByConversation(conversation.id).find((candidate) => candidate.idempotencyKey === input.idempotencyKey) : undefined;
    const submission = options.submissions.createOrGet({
      conversationId: conversation.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(payload),
      clientMessageId: input.clientUserMessageId,
      kind: 'steer',
      requestedDelivery: 'send_now',
      status: 'dispatching',
      queuePosition: queuedCount + 1,
      input: payload,
      targetProviderTurnId: input.expectedTurnId,
      providerTurnId: input.expectedTurnId,
      createdAt: now(),
      dispatchedAt: now(),
    });
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);

    if (existingSubmission) {
      if (existingSubmission.status === 'dispatching' || existingSubmission.status === 'active') {
        return accepted(existingSubmission, 'steering', conversation.providerThreadId, input.expectedTurnId);
      }
      if (existingSubmission.status === 'resolved' || existingSubmission.status === 'completed') {
        return accepted(existingSubmission, 'steered', conversation.providerThreadId, input.expectedTurnId);
      }
      if (existingSubmission.status === 'queued') return accepted(existingSubmission, 'queued', conversation.providerThreadId, null);
      throw coordinatorError('ZEUS_REQUEST_ANSWER_ATTACHMENT_DELIVERY_UNCERTAIN', 'The request answer attachment delivery result is uncertain and will not be repeated automatically.');
    }

    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if ((state.type !== 'active' && state.type !== 'waiting') || state.turnId !== input.expectedTurnId) {
      const requeued = options.submissions.requeueRejectedSteer(submission.id, now());
      await persist();
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        queue: toQueueSnapshot(conversation.id),
      });
      requestQueueDrain();
      return accepted(requeued, 'queued', conversation.providerThreadId, null);
    }

    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    input.providerWriteLifecycle?.markRpcStarted(submission.id);
    try {
      await options.manager.steerTurn({
        threadId: providerThreadId,
        turnId: input.expectedTurnId,
        clientUserMessageId: submission.clientMessageId,
        input: submissionProviderInput(submission, context),
      });
    } catch (error) {
      if (isProviderTurnAlreadyEndedSteerError(error)) {
        options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        await providerEventChain.catch(() => undefined);
        try {
          const snapshot = await options.manager.readThread({ threadId: providerThreadId });
          const generationId = options.manager.generationForThread(providerThreadId) ?? readyGenerationId();
          if (generationId) reconcileConversationSnapshot(requireConversation(conversation.id), snapshot, generationId);
        } catch (reconcileError) {
          options.broadcast('conversation.native.steer_requeued', {
            conversationId: conversation.id,
            providerThreadId,
            providerTurnId: input.expectedTurnId,
            submissionId: submission.id,
            reconciliationError: serializeError(reconcileError),
          });
        }
        const confirmedQueued = options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        options.broadcast('conversation.queue.changed', {
          conversationId: conversation.id,
          queue: toQueueSnapshot(conversation.id),
        });
        requestQueueDrain();
        return accepted(confirmedQueued, 'queued', providerThreadId, null);
      }
      options.submissions.updateStatus(submission.id, 'paused', {
        providerTurnId: input.expectedTurnId,
        pausedReason: 'recovery_required',
        error: toRecoverySubmissionError(error),
        updatedAt: now(),
      });
      await persist();
      options.broadcast('conversation.submission.steering', {
        conversationId: conversation.id,
        submissionId: submission.id,
        providerThreadId,
        providerTurnId: input.expectedTurnId,
      });
      throw error;
    }

    // turn/steer 成功只证明 Provider 接受了请求，不证明对应用户消息已经进入轮次。
    const steering = options.submissions.getById(submission.id) ?? submission;
    options.broadcast('conversation.submission.steering', {
      conversationId: conversation.id,
      submissionId: submission.id,
      providerThreadId,
      providerTurnId: input.expectedTurnId,
    });
    return accepted(steering, 'steering', providerThreadId, input.expectedTurnId);
  }

  function contextFromConversation(conversation: ZeusConversationWithMessagesRecord): ConversationDispatchContext {
    const submissions = options.submissions.listByConversation(conversation.id);
    const activeTurn = [...options.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
    const submission =
      (activeTurn ? submissions.find((candidate) => candidate.id === activeTurn.clientSubmissionId) : undefined) ??
      [...submissions].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).at(-1);
    if (!submission) throw coordinatorError('ZEUS_NATIVE_CONTEXT_UNAVAILABLE', 'Native conversation dispatch context is unavailable.');
    return {
      ...contextFromSubmission(submission),
      permissionMode: conversation.permissionMode,
      workMode: conversation.collaborationMode,
    };
  }

  function interruptedQueueSubmissions(submissions: readonly ZeusConversationSubmissionRecord[]): ZeusConversationSubmissionRecord[] {
    return submissions.filter((submission) => !submission.providerTurnId && (submission.status === 'queued' || (submission.status === 'paused' && submission.pausedReason === 'interrupted')));
  }

  function inferRunState(conversation: ZeusConversationWithMessagesRecord): NativeConversationRunState {
    if (conversation.providerState === 'archived') return { type: 'paused', reason: 'provider_archived' };
    if (interruptedQueueSubmissions(options.submissions.listByConversation(conversation.id)).some((submission) => submission.status === 'paused')) {
      return { type: 'paused', reason: 'interrupted' };
    }
    const activeTurn = [...options.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
    if (activeTurn?.providerTurnId) {
      if (activeTurn.status === 'waiting') {
        const pending = options.requests.listByConversation(conversation.id).find((request) => request.turnId === activeTurn.id && isPendingInteractionAuthority(request));
        if (pending) {
          return {
            type: 'waiting',
            turnId: activeTurn.providerTurnId,
            requestId: pending.id,
            reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
          };
        }
      }
      return { type: 'active', turnId: activeTurn.providerTurnId, phase: 'prework' };
    }
    return conversation.providerState === 'paused' ? { type: 'paused', reason: 'recovery_required' } : { type: 'idle' };
  }

  async function recoverPausedConversation(conversationId: string, mode: 'submit' | 'dispatch' | 'recover_queue' | 'restore'): Promise<ZeusConversationWithMessagesRecord> {
    let conversation = requireConversation(conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'paused' || state.reason !== 'recovery_required') return conversation;
    await ensureConversationExecutionContext(conversation.id, mode);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    if (!conversation.providerThreadId) {
      const recoverableBeforeProviderStart =
        context.executionWorkspaceMode === 'direct' &&
        options.submissions.listByConversation(conversation.id).some((submission) => {
          if (submission.status !== 'paused' || submission.providerTurnId || submission.pausedReason !== 'recovery_required') return false;
          return submission.errorJson ? parseJsonRecord(submission.errorJson).code === 'ZEUS_NATIVE_CONVERSATION_WORKTREE_UNAVAILABLE' : false;
        });
      if (!recoverableBeforeProviderStart) {
        throw coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'The paused conversation has no provider thread that can be safely resumed.');
      }
      // 该错误发生在 Provider RPC 之前；恢复原提交是安全重试，不会重复创建线程或重复发送。
      runStates.set(conversation.id, { type: 'idle' });
      return conversation;
    }
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const responsesRuntime = await responsesRuntimeFor(context);
    const resumed = await options.manager.resumeThread({ threadId: providerThreadId, cwd: context.projectLocalPath, ...(responsesRuntime ? { responsesRuntime } : {}) });
    persistThreadProviderSettings(conversation.id, resumed);
    await enqueueProviderTurnReconciliation(requireConversation(conversation.id));
    const snapshot = await options.manager.readThread({ threadId: providerThreadId });
    if (!snapshotConfirmsIdleProviderThread(snapshot) || !snapshotConfirmsSafeResumeBoundary(snapshot, options.turns.listByConversation(conversation.id))) {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread state cannot confirm that the previous turn is terminal.');
    }
    conversation = options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'ready',
    });
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    options.broadcast('conversation.thread.changed', {
      conversationId: conversation.id,
      providerThreadId,
      providerState: 'ready',
    });
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerState: 'ready' });
    return conversation;
  }

  function readyGenerationId(): string | null {
    const state = options.manager.getState();
    return state.type === 'ready' ? state.generationId : null;
  }

  function recoverStaleInteractionRequests(conversationId: string, currentGenerationId: string): void {
    const timestamp = now();
    const requests = options.requests.listByConversation(conversationId);
    const latestRequest = requests.at(-1);
    for (const request of requests) {
      if (options.manager.hasGeneration(request.transportGenerationId) || isInteractionRecoveryCheckpointRequest(request)) continue;
      const recoverableFailure = request.id === latestRequest?.id && isRetiredGenerationFailure(request);
      if (request.status !== 'pending' && !recoverableFailure) continue;
      options.requests.restorePendingAfterTransportRecovery(request.id, {
        recoveryReason: 'app_server_generation_changed',
        sourceGenerationId: request.transportGenerationId,
        currentGenerationId,
        restoredAt: timestamp,
      });
    }
  }

  function dispatchSubmission(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    providerWriteLifecycle?: NativeProviderWriteLifecycle,
    providerArchiveRecoveryAttempted = false,
  ): Promise<NativeAcceptedOperation> {
    // 接口直派和后台队列排空共享会话级派发租约；同一提交只能启动一次 Provider 轮次。
    const activeLease = dispatchLeases.get(conversationInput.id);
    if (activeLease) {
      if (activeLease.submissionId !== submission.id) {
        const conversation = options.conversations.getById(conversationInput.id);
        return Promise.resolve(accepted(submission, 'queued', conversation?.providerThreadId ?? null, null));
      }
      attachDispatchLifecycle(activeLease, providerWriteLifecycle);
      if (activeLease.promise) return activeLease.promise;
    }

    const lease: NativeConversationDispatchLease = {
      submissionId: submission.id,
      lifecycles: new Set(),
      rpcStartedResourceId: null,
    };
    attachDispatchLifecycle(lease, providerWriteLifecycle);
    const promise = dispatchSubmissionWithLease(conversationInput, submission, lease, providerArchiveRecoveryAttempted).finally(() => {
      if (dispatchLeases.get(conversationInput.id) === lease) dispatchLeases.delete(conversationInput.id);
    });
    lease.promise = promise;
    dispatchLeases.set(conversationInput.id, lease);
    return promise;
  }

  async function dispatchSubmissionWithLease(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    lease: NativeConversationDispatchLease,
    providerArchiveRecoveryAttempted: boolean,
  ): Promise<NativeAcceptedOperation> {
    let conversation = options.conversations.getById(conversationInput.id);
    if (!conversation) throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation was not found.');
    try {
      await ensureConversationExecutionContext(conversation.id, 'dispatch');
      const recoveryState = runStates.get(conversation.id) ?? inferRunState(conversation);
      if (recoveryState.type === 'paused' && recoveryState.reason === 'recovery_required') {
        conversation = await recoverPausedConversation(conversation.id, 'dispatch');
      }
    } catch (error) {
      options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: toRecoverySubmissionError(error), updatedAt: now() });
      runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      await persist();
      options.broadcast('conversation.native.recovery_failed', {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId,
        submissionId: submission.id,
        error: serializeError(error),
      });
      return accepted(submission, 'recovery_required', conversation.providerThreadId, null);
    }
    const context = contextWithLatestNextTurnSettings(conversation.id, contextFromSubmission(submission));
    if (conversation.permissionMode !== context.permissionMode) options.conversations.updatePermissionMode(conversation.id, context.permissionMode);
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    persistSubmissionExecutionContext(submission, context);
    conversation = requireConversation(conversation.id);
    contexts.set(conversation.id, context);
    try {
      await ensureGenerationReconciled();
      conversation = options.conversations.getById(conversation.id) ?? conversation;
      if (!hasConcurrency(context)) return accepted(submission, 'queued', conversation.providerThreadId, null);
      markDispatchRpcStarted(lease, submission.id);
      runStates.set(conversation.id, { type: 'dispatching', submissionId: submission.id });
      options.submissions.updateStatus(submission.id, 'dispatching', { dispatchedAt: now() });
      await persist();
      if (!conversation.providerThreadId) {
        const profile = providerPermissionProfile(context);
        const responsesRuntime = await responsesRuntimeFor(context);
        const thread = await options.manager.startThread({
          model: context.model,
          ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
          cwd: context.projectLocalPath,
          sandbox: profile.sandbox,
          approvalPolicy: profile.approvalPolicy,
          approvalsReviewer: profile.approvalsReviewer,
          developerInstructions: developerInstructionsFor(context, options.browserAutomation !== undefined),
          ephemeral: context.ephemeral,
          ...(options.browserAutomation ? { dynamicTools: zeusBrowserDynamicTools() } : {}),
          ...(responsesRuntime ? { responsesRuntime } : {}),
        });
        conversation = options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: thread.id,
          providerModel: context.model,
          providerState: 'ready',
        });
        persistThreadProviderSettings(conversation.id, thread);
        await persist();
        options.broadcast('conversation.transport.changed', {
          conversationId: conversation.id,
          transportKind: 'codex_native',
          providerState: conversation.providerState,
          providerThreadId: conversation.providerThreadId,
        });
        options.broadcast('conversation.thread.changed', {
          conversationId: conversation.id,
          providerThreadId: conversation.providerThreadId,
          providerState: conversation.providerState,
        });
      }
      const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
      const initialGoalObjective = submissionGoalObjective(submission);
      if (initialGoalObjective) {
        const goal = await options.manager.setThreadGoal({ threadId: providerThreadId, objective: initialGoalObjective, status: 'active' });
        projectGoal(conversation.id, goal, null, now());
        await persist();
      }
      const profile = providerPermissionProfile(context);
      const turn = await options.manager.startTurn({
        threadId: providerThreadId,
        clientUserMessageId: submission.clientMessageId,
        input: submissionProviderInput(submission, context),
        ...(context.additionalContext ? { additionalContext: context.additionalContext } : {}),
        model: context.model,
        ...(context.effort ? { effort: context.effort } : {}),
        ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
        summary: 'auto',
        ...(context.workMode
          ? {
              collaborationMode: {
                mode: context.workMode,
                settings: {
                  model: context.model,
                  reasoning_effort: context.effort ?? null,
                  developer_instructions: null,
                },
              },
            }
          : {}),
        cwd: context.projectLocalPath,
        approvalPolicy: profile.approvalPolicy,
        approvalsReviewer: profile.approvalsReviewer,
        sandboxPolicy: profile.sandbox,
      });
      volatileSubmissionText.delete(submission.id);
      const timestamp = now();
      const existingProviderTurn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === turn.id);
      options.turns.upsert({
        ...(existingProviderTurn ? { id: existingProviderTurn.id } : {}),
        conversationId: conversation.id,
        providerThreadId,
        providerTurnId: turn.id,
        clientSubmissionId: submission.id,
        status: 'running',
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const syncCheckpoint = syncCheckpoints.getByConversation(conversation.id);
      if (syncCheckpoint) {
        syncCheckpoints.advance({ conversationId: conversation.id, providerThreadId, lastSyncedTurnId: turn.id, timestamp });
      } else {
        syncCheckpoints.initialize({ conversationId: conversation.id, providerThreadId, baselineTurnId: turn.id, timestamp });
      }
      options.submissions.updateStatus(submission.id, 'active', { providerTurnId: turn.id, dispatchedAt: timestamp });
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: context.model, providerState: 'active' });
      runStates.set(conversation.id, { type: 'active', turnId: turn.id, phase: 'prework' });
      await persist();
      // submission 已进入 provider 轮次后必须同步清出队列表面，避免其他窗口继续展示旧快照。
      options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerTurnId: turn.id, submissionId: submission.id });
      if (!existingProviderTurn) {
        options.broadcast('conversation.turn.started', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: turn.id,
          submissionId: submission.id,
          status: 'running',
          startedAt: timestamp,
        });
      }
      return accepted(submission, 'active', providerThreadId, turn.id);
    } catch (error) {
      const current = options.conversations.getById(conversation.id);
      const providerThreadId = current?.providerThreadId ?? null;
      if (context.ephemeral) {
        options.submissions.updateStatus(submission.id, 'failed', { resolvedAt: now(), error: serializeError(error) });
        if (current?.providerThreadId) {
          options.conversations.bindProvider(current.id, {
            providerId: 'codex',
            providerThreadId: current.providerThreadId,
            providerModel: current.providerModel,
            providerState: 'closed',
          });
        } else if (current) {
          options.conversations.updateRuntimeState(current.id, { status: 'failed', summary: 'Codex native ephemeral dispatch failed.' });
          options.conversations.archive(current.id);
        }
        runStates.delete(conversation.id);
        contexts.delete(conversation.id);
      } else if (providerThreadId === null && options.manager.getState().type !== 'ready') {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'transport_unavailable', error: serializeError(error) });
        runStates.set(conversation.id, { type: 'paused', reason: 'transport_unavailable' });
      } else if (isProviderThreadArchivedError(error)) {
        markConversationProviderArchived(conversation.id, error);
        await persist();
        if (!providerArchiveRecoveryAttempted) {
          try {
            await restoreArchivedProviderThread(conversation.id);
            const retrySubmission = options.submissions.getById(submission.id);
            const retryConversation = options.conversations.getById(conversation.id);
            if (retrySubmission && retryConversation) return dispatchSubmissionWithLease(retryConversation, retrySubmission, lease, true);
          } catch {
            // 恢复函数已保留原始消息与可重试状态。
          }
        }
        return accepted(submission, 'provider_archived', providerThreadId, null);
      } else {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: serializeError(error) });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      }
      await persist();
      options.broadcast('conversation.queue.changed', { conversationId: conversation.id, submissionId: submission.id });
      requestQueueDrain();
      return accepted(submission, 'recovery_required', providerThreadId, null);
    }
  }

  function attachDispatchLifecycle(lease: NativeConversationDispatchLease, lifecycle: NativeProviderWriteLifecycle | undefined): void {
    if (!lifecycle || lease.lifecycles.has(lifecycle)) return;
    lease.lifecycles.add(lifecycle);
    if (lease.rpcStartedResourceId) lifecycle.markRpcStarted(lease.rpcStartedResourceId);
  }

  function markDispatchRpcStarted(lease: NativeConversationDispatchLease, resourceId: string): void {
    lease.rpcStartedResourceId = resourceId;
    for (const lifecycle of lease.lifecycles) lifecycle.markRpcStarted(resourceId);
  }

  async function closeEphemeralConversation(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown, interrupt: boolean): Promise<void> {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
    if (!context.ephemeral) return;
    if (interrupt && providerTurnId && conversation.providerThreadId) {
      try {
        await options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId });
      } catch (interruptError) {
        options.broadcast('conversation.native.ephemeral_interrupt_failed', {
          conversationId,
          providerThreadId: conversation.providerThreadId,
          providerTurnId,
          error: serializeError(interruptError),
        });
      }
    }
    markEphemeralConversationClosed(conversationId, providerTurnId, submissionStatus, error);
    await persist();
    requestQueueDrain();
  }

  function markEphemeralConversationClosed(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown): void {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
    if (!context.ephemeral) return;
    const timestamp = now();
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active' || submission.status === 'paused') {
        options.submissions.updateStatus(submission.id, submissionStatus, { resolvedAt: timestamp, error });
      }
    }
    const turn = providerTurnId ? options.turns.listByConversation(conversationId).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (turn) {
      options.turns.upsert({
        ...turn,
        status: submissionStatus === 'cancelled' ? 'interrupted' : 'failed',
        error,
        completedAt: timestamp,
        updatedAt: timestamp,
      });
    }
    options.conversations.updateRuntimeState(conversationId, {
      status: submissionStatus === 'failed' ? 'failed' : 'closed',
      summary: submissionStatus === 'failed' ? 'Codex native ephemeral conversation failed.' : 'Codex native ephemeral conversation closed.',
    });
    if (conversation.providerThreadId) {
      options.conversations.bindProvider(conversationId, {
        providerId: 'codex',
        providerThreadId: conversation.providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'closed',
      });
    } else {
      options.conversations.updateRuntimeState(conversationId, { status: submissionStatus === 'failed' ? 'failed' : 'closed' });
      options.conversations.archive(conversationId);
    }
    runStates.delete(conversationId);
    contexts.delete(conversationId);
  }

  function rejectTurnResultWaiters(key: string, error: Error): void {
    const waiters = turnResultWaiters.get(key) ?? [];
    turnResultWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  interface NativeUserMessageProjection extends ResolvedNativeUserMessageSubmission {
    content: string;
  }

  function projectProviderUserMessage(
    conversation: ZeusConversationWithMessagesRecord,
    turn: ZeusConversationTurnRecord,
    itemPayload: Record<string, unknown>,
    providerContent: string,
    providerItemId: string,
  ): NativeUserMessageProjection | null {
    const existingProviderMessage = conversation.messages.find((message) => message.providerItemId === providerItemId);
    const existingClientIds = new Set(
      conversation.messages
        .filter((message) => message.providerItemId !== providerItemId)
        .map(conversationMessageClientId)
        .filter((value): value is string => Boolean(value)),
    );
    const submissions = options.submissions.listByConversation(conversation.id);
    const resolved = resolveNativeUserMessageSubmission({
      submissions,
      providerClientId: typeof itemPayload.clientId === 'string' ? itemPayload.clientId : null,
      clientSubmissionId: turn.clientSubmissionId,
      providerTurnId: turn.providerTurnId,
      existingMessage: existingProviderMessage ? { clientMessageId: conversationMessageClientId(existingProviderMessage) } : undefined,
      existingClientMessageIds: existingClientIds,
    });
    const submissionInput = resolved.submission ? parseJsonRecord(resolved.submission.inputJson) : {};
    if (submissionInput.internalOperation === true) return null;
    return {
      ...resolved,
      content: chooseNativeUserMessageContent({
        displayText: itemPayload.displayText,
        submissionDisplayText: submissionInput.displayText,
        submissionText: resolved.submission ? submissionText(resolved.submission) : undefined,
        existingContent: existingProviderMessage?.content,
        providerContent,
      }),
    };
  }

  function persistProviderUserMessage(
    conversation: ZeusConversationWithMessagesRecord,
    itemPayload: Record<string, unknown>,
    projection: NativeUserMessageProjection,
    providerTurnId: string,
    providerThreadId: string,
    providerItemId: string,
    createdAt: string,
  ): string | null {
    const existingProviderMessage = conversation.messages.find((message) => message.providerItemId === providerItemId);
    const projectedSubmission = projection.submission;
    const providerClientId = typeof itemPayload.clientId === 'string' && itemPayload.clientId.trim() ? itemPayload.clientId : null;
    // 引导确认身份只能来自 Provider 原始事件；禁止用当前轮次或 submission 回退补造 clientId。
    const exactSteeringIdentity = !projectedSubmission || !isSteeringSubmission(projectedSubmission) || providerClientId === projectedSubmission.clientMessageId;
    const clientMessageId = exactSteeringIdentity ? projection.clientMessageId : null;
    const submission = exactSteeringIdentity ? projectedSubmission : undefined;
    const existingMetadata = existingProviderMessage ? parseJsonRecord(existingProviderMessage.metadataJson) : {};
    // 来源只属于 Zeus 本地投影，精确匹配回本机 submission 后必须移除远程标记，不能污染正文或 Provider 输入。
    const stableMetadata = { ...existingMetadata };
    delete stableMetadata.inputOrigin;
    options.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: projection.content,
      source: 'codex_native',
      metadata: {
        ...stableMetadata,
        inputOrigin: submission ? 'zeus_local' : 'remote_device',
        ...(clientMessageId ? { clientUserMessageId: clientMessageId } : {}),
        ...(submission ? { attachments: submissionAttachments(submission) } : {}),
        ...(submission && submissionTaskPushLayout(submission) ? { taskPushLayout: submissionTaskPushLayout(submission) } : {}),
        ...(submission && submissionBrowserComments(submission).length ? { browserComments: submissionBrowserComments(submission) } : {}),
        ...(submission && submissionConversationContext(submission) ? { conversationContext: submissionConversationContext(submission) } : {}),
        ...(typeof itemPayload.origin === 'string' ? { origin: itemPayload.origin } : {}),
        ...(typeof itemPayload.planItemId === 'string' ? { planItemId: itemPayload.planItemId } : {}),
        ...(submission && typeof parseJsonRecord(submission.inputJson).requestAnswerId === 'string' ? { requestAnswerId: parseJsonRecord(submission.inputJson).requestAnswerId } : {}),
      },
      createdAt,
      providerThreadId,
      providerTurnId,
      providerItemId,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    resolveExactSteeringSubmission(conversation.id, itemPayload, providerThreadId, providerTurnId);
    return clientMessageId;
  }

  function resolveExactSteeringSubmission(conversationId: string, itemPayload: Record<string, unknown>, providerThreadId: string, providerTurnId: string): void {
    const providerClientId = typeof itemPayload.clientId === 'string' && itemPayload.clientId.trim() ? itemPayload.clientId : null;
    if (!providerClientId) return;
    const submission = options.submissions
      .listByConversation(conversationId)
      .find(
        (candidate) =>
          candidate.kind === 'steer' &&
          candidate.requestedDelivery === 'send_now' &&
          candidate.clientMessageId === providerClientId &&
          candidate.providerTurnId === providerTurnId &&
          (candidate.status === 'dispatching' || (candidate.status === 'paused' && candidate.pausedReason === 'recovery_required')),
      );
    if (!submission) return;
    options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId, resolvedAt: now() });
    options.broadcast('conversation.submission.steered', {
      conversationId,
      submissionId: submission.id,
      providerThreadId,
      providerTurnId,
      clientUserMessageId: providerClientId,
    });
  }

  function conversationMessageClientId(message: { clientMessageId: string | null; metadataJson: string }): string | null {
    if (message.clientMessageId?.trim()) return message.clientMessageId;
    const metadata = parseJsonRecord(message.metadataJson);
    return typeof metadata.clientUserMessageId === 'string' && metadata.clientUserMessageId.trim() ? metadata.clientUserMessageId : null;
  }

  function isSteeringSubmission(submission: ZeusConversationSubmissionRecord): boolean {
    return submission.kind === 'steer' && submission.requestedDelivery === 'send_now';
  }

  function hasExactProviderUserMessage(conversation: ZeusConversationWithMessagesRecord, submission: ZeusConversationSubmissionRecord, providerTurnId: string): boolean {
    const current = options.conversations.getById(conversation.id) ?? conversation;
    return current.messages.some((message) => message.role === 'user' && message.providerTurnId === providerTurnId && conversationMessageClientId(message) === submission.clientMessageId);
  }

  /**
   * Provider 一个轮次可以承载多条用户消息；轮次终止时必须收口全部已精确送达的提交。
   * 只有轮次首提交身份或 Provider 用户消息身份能够对上时才判定送达，其余保留为需要恢复。
   */
  function reconcileTerminalTurnSubmissions(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, timestamp: string, failure?: unknown) {
    const providerTurnId = requireString(turn.providerTurnId, 'provider turn id');
    const candidates = options.submissions.listByConversation(conversation.id).filter((submission) => submission.providerTurnId === providerTurnId && (submission.status === 'dispatching' || submission.status === 'active'));
    const primarySubmission = candidates.find((submission) => submission.id === turn.clientSubmissionId && !isSteeringSubmission(submission)) ?? candidates.find((submission) => !isSteeringSubmission(submission));
    const recoveryRequired: ZeusConversationSubmissionRecord[] = [];
    let reconciledCount = 0;

    for (const submission of candidates) {
      const delivered = submission.id === turn.clientSubmissionId || hasExactProviderUserMessage(conversation, submission, providerTurnId);
      if (!delivered) {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED', 'The provider turn ended without exact evidence that this user message was received.'));
        recoveryRequired.push(submission);
        reconciledCount += 1;
        continue;
      }
      if (isSteeringSubmission(submission)) {
        options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId, resolvedAt: timestamp, updatedAt: timestamp });
      } else {
        options.submissions.updateStatus(submission.id, turn.status === 'failed' ? 'failed' : 'completed', {
          providerTurnId,
          resolvedAt: timestamp,
          updatedAt: timestamp,
          ...(turn.status === 'failed' ? { error: failure ?? failedTurnErrorFromRecord(turn) } : {}),
        });
      }
      reconciledCount += 1;
    }

    return { primarySubmission, recoveryRequired, reconciledCount };
  }

  /** 执行宿主启动时先用本地终态轮次和消息身份修复历史残留，不依赖 Provider 联机。 */
  function reconcilePersistedTerminalTurnSubmissions(): number {
    const candidatesByConversation = new Map<string, ZeusConversationSubmissionRecord[]>();
    for (const submission of options.submissions.listRecoverable()) {
      if ((submission.status !== 'dispatching' && submission.status !== 'active') || !submission.providerTurnId) continue;
      const entries = candidatesByConversation.get(submission.conversationId) ?? [];
      entries.push(submission);
      candidatesByConversation.set(submission.conversationId, entries);
    }

    let reconciledCount = 0;
    for (const [conversationId, candidates] of candidatesByConversation) {
      const conversation = options.conversations.getById(conversationId);
      if (!conversation || conversation.agentKind !== 'codex' || conversation.transportKind !== 'codex_native') continue;
      const candidateTurnIds = new Set(candidates.map((submission) => submission.providerTurnId).filter((providerTurnId): providerTurnId is string => Boolean(providerTurnId)));
      const terminalTurns = options.turns
        .listByConversation(conversationId)
        .filter((turn) => Boolean(turn.providerTurnId && candidateTurnIds.has(turn.providerTurnId)) && (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed'));
      let requiresRecovery = false;
      for (const turn of terminalTurns) {
        const result = reconcileTerminalTurnSubmissions(conversation, turn, turn.completedAt ?? turn.updatedAt);
        reconciledCount += result.reconciledCount;
        requiresRecovery ||= result.recoveryRequired.length > 0;
      }
      if (requiresRecovery && conversation.providerThreadId && conversation.providerState !== 'archived' && conversation.providerState !== 'closed' && conversation.providerState !== 'failed') {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: conversation.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'paused',
        });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      }
      if (terminalTurns.length > 0) options.broadcast('conversation.queue.changed', { conversationId });
    }
    return reconciledCount;
  }

  function submissionForProviderUserItem(conversationId: string, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>): ZeusConversationSubmissionRecord | undefined {
    const submissions = options.submissions.listByConversation(conversationId);
    const providerClientId = typeof itemPayload.clientId === 'string' && itemPayload.clientId.trim() ? itemPayload.clientId : null;
    // 同一 turn 可以被远端继续引导；Provider 已给 clientId 时只能精确匹配，不能误绑到该 turn 的首条本机 submission。
    if (providerClientId) return submissions.find((candidate) => candidate.clientMessageId === providerClientId);
    return turn.clientSubmissionId ? submissions.find((candidate) => candidate.id === turn.clientSubmissionId) : undefined;
  }

  function submissionPresentation(conversationId: string, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>): Record<string, unknown> {
    const submission = submissionForProviderUserItem(conversationId, turn, itemPayload);
    if (!submission) return { inputOrigin: 'remote_device' };
    const input = parseJsonRecord(submission.inputJson);
    return {
      inputOrigin: 'zeus_local',
      ...(typeof input.displayText === 'string' && input.displayText.trim() ? { displayText: input.displayText } : {}),
      ...(isRecord(input.taskPushLayout) && input.taskPushLayout.kind === 'task_push' ? { taskPushLayout: input.taskPushLayout } : {}),
      ...(input.origin === 'implement_plan' ? { origin: input.origin } : {}),
      ...(typeof input.planItemId === 'string' ? { planItemId: input.planItemId } : {}),
      ...(typeof input.requestAnswerId === 'string' ? { requestAnswerId: input.requestAnswerId } : {}),
      ...(isRecord(input.conversationContext) ? { conversationContext: input.conversationContext } : {}),
    };
  }

  async function editQueuedSubmission(input: { conversationId: string; submissionId: string; content: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    const persisted = parseJsonRecord(submission.inputJson);
    // 展示文本与实际派发文本必须同时更新，否则队列里看到的是新内容，接管后却会恢复成旧气泡。
    const next = {
      ...persisted,
      text: input.content,
      ...(typeof persisted.displayText === 'string' ? { displayText: input.content } : {}),
    };
    options.submissions.updateQueuedInput(submission.id, { requestHash: requestHash(next), input: next, updatedAt: now() });
    await persist();
    return toQueueSnapshot(input.conversationId);
  }

  async function deleteQueuedSubmission(input: { conversationId: string; submissionId: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    if (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') {
      throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE', 'Only queued, paused, or failed submissions can be deleted.');
    }
    options.submissions.updateStatus(submission.id, 'deleted', { resolvedAt: now() });
    const remaining = options.submissions.listByConversation(input.conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    options.submissions.reorderQueued(
      input.conversationId,
      remaining.map((entry) => entry.id),
      now(),
    );
    await persist();
    return toQueueSnapshot(input.conversationId);
  }

  async function reorderQueue(input: { conversationId: string; orderedSubmissionIds: string[] }): Promise<NativeQueueSnapshot> {
    assertOpen();
    requireConversation(input.conversationId);
    options.submissions.reorderQueued(input.conversationId, input.orderedSubmissionIds, now());
    await persist();
    return toQueueSnapshot(input.conversationId);
  }

  async function sendQueuedNow(input: SendQueuedNowInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'active' && state.type !== 'waiting') throw coordinatorError('ZEUS_NATIVE_TURN_NOT_ACTIVE', 'send-now requires a current active Codex native turn.');
    if (submission.status !== 'queued') throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_QUEUED', 'Submission is not queued.');
    const turnId = state.turnId;
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const context = { ...contextFromSubmission(submission), permissionMode: conversation.permissionMode };
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    input.providerWriteLifecycle?.markRpcStarted(submission.id);
    options.submissions.updateStatus(submission.id, 'dispatching', { providerTurnId: turnId, dispatchedAt: now() });
    await persist();
    try {
      await options.manager.steerTurn({ threadId: providerThreadId, turnId, clientUserMessageId: submission.clientMessageId, input: submissionProviderInput(submission, context) });
    } catch (error) {
      if (isProviderTurnAlreadyEndedSteerError(error)) {
        let requeued = options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        // 先让已经到达的 turn/completed 事件收敛旧轮次，再尝试读取一次权威快照；两者失败都不能把明确未发送的输入升级成未知副作用。
        await providerEventChain.catch(() => undefined);
        const currentConversation = requireConversation(conversation.id);
        try {
          const snapshot = await options.manager.readThread({ threadId: providerThreadId });
          const generationId = options.manager.generationForThread(providerThreadId) ?? readyGenerationId();
          if (generationId) reconcileConversationSnapshot(currentConversation, snapshot, generationId);
        } catch (reconcileError) {
          options.broadcast('conversation.native.steer_requeued', {
            conversationId: conversation.id,
            providerThreadId,
            providerTurnId: turnId,
            submissionId: submission.id,
            reconciliationError: serializeError(reconcileError),
          });
        }
        // 恢复对账可能按“重启后的未发送内容”暂停队列；本次输入来自当前用户动作，应继续作为普通下一轮排队。
        requeued = options.submissions.requeueRejectedSteer(submission.id, now());
        await persist();
        options.broadcast('conversation.queue.changed', {
          conversationId: conversation.id,
          queue: toQueueSnapshot(conversation.id),
        });
        requestQueueDrain();
        return accepted(requeued, 'queued', providerThreadId, null);
      }
      options.submissions.updateStatus(submission.id, 'paused', {
        providerTurnId: turnId,
        pausedReason: 'recovery_required',
        error: toRecoverySubmissionError(error),
        updatedAt: now(),
      });
      await persist();
      options.broadcast('conversation.submission.steering', { conversationId: conversation.id, submissionId: submission.id, providerThreadId, providerTurnId: turnId });
      throw error;
    }
    const steering = options.submissions.getById(submission.id) ?? submission;
    options.broadcast('conversation.submission.steering', { conversationId: conversation.id, submissionId: submission.id, providerThreadId, providerTurnId: turnId });
    return accepted(steering, 'steering', providerThreadId, turnId);
  }

  async function interruptTurn(input: InterruptNativeTurnInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'active' && state.type !== 'waiting') throw coordinatorError('ZEUS_NATIVE_TURN_NOT_ACTIVE', 'No active Codex native turn to interrupt.');
    if (state.turnId !== input.providerTurnId) throw coordinatorError('ZEUS_NATIVE_TURN_MISMATCH', 'Interrupt target is not the current active provider turn.');
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    await input.providerWriteLifecycle?.markPrepared(input.providerTurnId);
    input.providerWriteLifecycle?.markRpcStarted(input.providerTurnId);
    await persist();
    await options.manager.interruptTurn({ threadId: providerThreadId, turnId: input.providerTurnId });
    const terminalResult = await waitForTurnResult({ conversationId: conversation.id, providerTurnId: input.providerTurnId });
    if (terminalResult.status !== 'interrupted') {
      throw coordinatorError('ZEUS_NATIVE_INTERRUPT_OUTCOME_UNKNOWN', 'Codex did not confirm a terminal outcome for the interrupted turn.');
    }
    const submission = options.submissions.listByConversation(conversation.id).find((entry) => entry.providerTurnId === input.providerTurnId);
    return {
      operationId: operationId(),
      conversationId: conversation.id,
      submissionId: submission?.id ?? '',
      status: 'interrupted',
      providerThreadId,
      providerTurnId: input.providerTurnId,
    };
  }

  async function resumeInterruptedQueue(input: { conversationId: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'paused' || state.reason !== 'interrupted') throw coordinatorError('ZEUS_NATIVE_QUEUE_NOT_INTERRUPTED', 'Queue is not paused by an interrupted turn.');
    const paused = options.submissions.listByConversation(conversation.id).filter((entry) => entry.status === 'paused' && entry.pausedReason === 'interrupted' && !entry.providerTurnId);
    for (const submission of paused) options.submissions.updateStatus(submission.id, 'queued');
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    const next = options.submissions.listByConversation(conversation.id).find((entry) => entry.status === 'queued' && !entry.providerTurnId);
    if (next) await dispatchSubmission(conversation, next);
    return toQueueSnapshot(conversation.id);
  }

  async function recoverQueue(input: RecoverNativeQueueInput): Promise<NativeQueueSnapshot> {
    assertOpen();
    let conversation = requireConversation(input.conversationId);
    if (conversation.archived || conversation.providerState === 'archived') {
      throw coordinatorError('ZEUS_NATIVE_QUEUE_PROVIDER_ARCHIVED', 'The provider conversation must be restored explicitly before its queue can be recovered.');
    }
    await ensureGenerationReconciled();
    conversation = requireConversation(input.conversationId);
    const deliveryUnconfirmed = options.submissions.listByConversation(conversation.id).find((submission) => submission.status === 'paused' && submission.pausedReason === 'recovery_required' && Boolean(submission.providerTurnId));
    if (deliveryUnconfirmed) {
      // 已进入终态轮次但缺少送达证据的内容不能由普通队列恢复自动重发，否则可能造成重复用户消息。
      throw coordinatorError('ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED', 'A user message has an unconfirmed delivery result and cannot be resent automatically.');
    }
    try {
      await ensureConversationExecutionContext(conversation.id, 'recover_queue');
      const state = runStates.get(conversation.id) ?? inferRunState(conversation);
      if (state.type === 'paused' && state.reason === 'recovery_required') {
        conversation = await recoverPausedConversation(conversation.id, 'recover_queue');
      }
    } catch (error) {
      markConversationRecoveryRequired(conversation.id, error);
      await persist();
      options.broadcast('conversation.native.recovery_failed', {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId,
        error: serializeError(error),
      });
      throw error;
    }
    for (const submission of options.submissions.listByConversation(conversation.id)) {
      if (submission.status === 'paused' && submission.pausedReason === 'recovery_required' && !submission.providerTurnId) {
        options.submissions.updateStatus(submission.id, 'queued');
      }
    }
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    await drainQueuedSubmissions();
    return toQueueSnapshot(conversation.id);
  }

  async function archiveConversation(input: ArchiveConversationInput): Promise<NativeQueueSnapshot> {
    assertOpen();
    let conversation = requireConversation(input.conversationId);
    if (conversation.archived) return toQueueSnapshot(conversation.id);
    assertConversationCanBeArchived(conversation);
    await ensureGenerationReconciled();
    conversation = requireConversation(input.conversationId);
    if (conversation.archived) return toQueueSnapshot(conversation.id);
    assertConversationCanBeArchived(conversation);
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    if (conversation.providerState !== 'archived') await options.manager.archiveThread({ threadId: providerThreadId });
    let archivedThreadPath: string | undefined;
    try {
      archivedThreadPath = threadPath(await options.manager.readThread({ threadId: providerThreadId }));
    } catch {
      // 旧版 app-server 可能不允许读取已归档线程；此时保留上次已确认路径，不自行猜测。
    }
    if (archivedThreadPath) {
      options.conversations.updateProviderThreadPath(conversation.id, {
        providerThreadId,
        providerThreadPath: archivedThreadPath,
      });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'archived',
    });
    options.conversations.archive(conversation.id);
    runStates.set(conversation.id, { type: 'paused', reason: 'provider_archived' });
    contexts.delete(conversation.id);
    await persist();
    options.broadcast('conversation.thread.archived', {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      providerThreadId,
      providerState: 'archived',
    });
    return toQueueSnapshot(conversation.id);
  }

  function assertConversationCanBeArchived(conversation: ZeusConversationWithMessagesRecord): void {
    const pendingRequest = options.requests.listByConversation(conversation.id).find((request) => request.status === 'pending');
    const unfinishedTurn = options.turns.listByConversation(conversation.id).find((turn) => turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting');
    const pendingSubmission = options.submissions
      .listByConversation(conversation.id)
      .find((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active' || (submission.status === 'paused' && !submission.providerTurnId));
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (
      pendingRequest ||
      unfinishedTurn ||
      pendingSubmission ||
      conversation.providerState === 'binding' ||
      conversation.providerState === 'active' ||
      conversation.providerState === 'waiting' ||
      state.type === 'dispatching' ||
      state.type === 'active' ||
      state.type === 'waiting'
    ) {
      throw coordinatorError('ZEUS_NATIVE_CONVERSATION_IN_PROGRESS', 'The conversation still has an active turn, queued message, or pending request and cannot be archived.');
    }
  }

  async function restoreArchivedConversation(input: RestoreArchivedConversationInput): Promise<NativeQueueSnapshot> {
    assertOpen();
    let conversation = requireConversation(input.conversationId);
    if (conversation.providerState === 'archived') {
      await ensureGenerationReconciled();
      conversation = requireConversation(input.conversationId);
      if (conversation.providerState === 'archived') await restoreArchivedProviderThread(conversation.id);
    }
    if (conversation.archived) await ensureConversationExecutionContext(conversation.id, 'restore');
    if (conversation.archived) {
      options.conversations.restore(conversation.id);
      await persist();
      options.broadcast('conversation.thread.unarchived', {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        taskId: conversation.taskId,
        providerThreadId: conversation.providerThreadId,
        providerState: 'ready',
      });
    }
    await drainQueuedSubmissions();
    return toQueueSnapshot(conversation.id);
  }

  async function restoreArchivedProviderThread(conversationId: string): Promise<NativeQueueSnapshot> {
    let conversation = requireConversation(conversationId);
    if (conversation.providerState !== 'archived') return toQueueSnapshot(conversation.id);
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    await ensureConversationExecutionContext(conversation.id, 'restore');
    conversation = requireConversation(conversation.id);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    contexts.set(conversation.id, context);
    try {
      const responsesRuntime = await responsesRuntimeFor(context);
      if (responsesRuntime) {
        await options.manager.ensureReady({
          commandPath: commandPath(),
          ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}),
          providerEnvironment: responsesRuntime.environment,
        });
      }
      await options.manager.unarchiveThread({ threadId: providerThreadId });
      const resumed = await options.manager.resumeThread({ threadId: providerThreadId, cwd: context.projectLocalPath, ...(responsesRuntime ? { responsesRuntime } : {}) });
      persistThreadProviderSettings(conversation.id, resumed);
      await enqueueProviderTurnReconciliation(requireConversation(conversation.id));
      const snapshot = await options.manager.readThread({ threadId: providerThreadId });
      for (const submission of options.submissions.listByConversation(conversation.id)) {
        if (submission.status === 'paused' && submission.pausedReason === 'provider_archived' && !submission.providerTurnId) {
          options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'user_confirmation' });
        }
      }
      conversation = options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'ready',
      });
      runStates.set(conversation.id, { type: 'idle' });
      reconcileConversationSnapshot(conversation, snapshot, requireString(readyGenerationId(), 'transport generation id'));
      await persist();
      options.broadcast('conversation.thread.changed', {
        conversationId: conversation.id,
        providerThreadId,
        providerState: 'ready',
      });
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        providerThreadId,
        providerState: 'ready',
      });
      return toQueueSnapshot(conversation.id);
    } catch (error) {
      markConversationProviderArchived(conversation.id, error);
      await persist();
      throw error;
    }
  }

  async function respondToRequest(input: RespondNativeRequestInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const request = options.requests.getById(input.requestId);
    if (!request) throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
    if (request.status !== 'pending') throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
    clearAutoResolutionTimer(request.id);
    const conversation = requireConversation(request.conversationId);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    const providerRequestId = JSON.parse(request.providerRequestIdJson) as string | number;
    const response = input.response;
    let wireResponse = { ...response, generationId: request.transportGenerationId, requestId: providerRequestId } as CodexServerRequestResponse;
    const payload = parseJsonRecord(request.payloadJson);
    const grantSessionFileEdits = request.requestKind === 'file' && response.type === 'file' && response.decision === 'acceptForSession';

    if (request.requestKind === 'command') {
      if (response.type !== 'command') throw invalidServerRequestResponse('Response type does not match the pending command approval.');
      if (isExecpolicyAmendmentDecision(response.decision)) {
        if (!isAdvertisedCommandDecision(payload, response.decision)) {
          throw invalidServerRequestResponse('The provider did not advertise the requested execpolicy amendment.');
        }
      } else if (isGrantDecision(response.decision)) {
        if (!isAdvertisedCommandDecision(payload, response.decision)) {
          const policy = evaluateCommandApproval(payload, context);
          if (!policy.allowed) wireResponse = { type: 'command', decision: 'decline', generationId: request.transportGenerationId, requestId: providerRequestId };
          else throw invalidServerRequestResponse('The provider did not advertise the requested command approval decision.');
        }
      }
    }
    if (request.requestKind === 'file') {
      if (response.type !== 'file') throw invalidServerRequestResponse('Response type does not match the pending file approval.');
      if (isGrantDecision(response.decision) && payload.grantRoot !== undefined && payload.grantRoot !== null) {
        throw invalidServerRequestResponse('File approvals cannot grant provider-requested root scope.');
      } else if (isGrantDecision(response.decision) && !hasAuditableFileApprovalTarget(payload, conversation, context, options.items)) {
        throw invalidServerRequestResponse('The pending file approval does not identify an auditable project-local target.');
      }
    }
    if (request.requestKind === 'permissions') {
      if (response.type !== 'permissions' || !isSupportedPermissionRequest(payload) || !isSupportedPermissionGrant(response.permissions)) {
        await failPermissionRequest(conversation, request, payload, coordinatorError('ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', 'Codex permission request or grant schema is unsupported.'));
      }
      if (response.type !== 'permissions') throw coordinatorError('ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', 'Codex permission response type is unsupported.');
      try {
        validatePermissionGrant(payload, response.permissions, context);
      } catch (error) {
        await failPermissionRequest(conversation, request, payload, error);
      }
    }
    if (request.requestKind === 'mcp') {
      if (response.type !== 'mcp' || !isValidMcpElicitationResponse(payload, response)) {
        throw invalidServerRequestResponse('MCP elicitation response does not satisfy the pending request mode and schema.');
      }
    }
    if (request.requestKind === 'request_user_input') {
      if (response.type !== 'request_user_input') throw invalidServerRequestResponse('Response type does not match the pending request_user_input request.');
      const validationError = validateCanonicalRequestUserInputAnswers(payload, response.answers);
      if (validationError) throw invalidServerRequestResponse(validationError);
      validateRequestAnswerAttachments(request, payload, input.answerAttachments ?? []);
    } else if (input.answerAttachments?.length) {
      throw invalidServerRequestResponse('Only request_user_input responses can include answer attachments.');
    }
    const currentGenerationId = readyGenerationId();
    if (!options.manager.hasGeneration(request.transportGenerationId)) {
      if (!isInteractionRecoveryCheckpointRequest(request)) {
        options.requests.restorePendingAfterTransportRecovery(request.id, {
          recoveryReason: 'app_server_generation_changed',
          sourceGenerationId: request.transportGenerationId,
          currentGenerationId,
          restoredAt: now(),
        });
      }
      const recoveredRequest = options.requests.getById(request.id) ?? request;
      const recovered = await respondAfterInteractionRecovery({
        request: recoveredRequest,
        conversation,
        response: stripRequestTransport(wireResponse),
        input,
      });
      if (grantSessionFileEdits) {
        options.conversations.setSessionFileEditGrant(conversation.id, conversation.projectId, true);
        await persist();
      }
      return recovered;
    }
    if (input.answerAttachments?.length) {
      await deliverRequestAnswerAttachments(request, conversation, input.answerAttachments);
    }
    await input.providerWriteLifecycle?.markPrepared(request.id);
    input.providerWriteLifecycle?.markRpcStarted(request.id);
    await persist();
    await options.manager.respondToServerRequest(wireResponse);
    if (grantSessionFileEdits) options.conversations.setSessionFileEditGrant(conversation.id, conversation.projectId, true);
    const effectiveResponse = stripRequestTransport(wireResponse);
    const secret = request.containsSecret && effectiveResponse.type === 'request_user_input';
    options.requests.resolve(request.id, {
      response: requestResponseWithAttachmentPresentation(effectiveResponse, input.answerAttachmentPresentation),
      isSecret: secret,
      ...(secret && effectiveResponse.type === 'request_user_input'
        ? { questionIds: Object.keys(effectiveResponse.answers), answerCount: Object.values(effectiveResponse.answers).reduce((total, answer) => total + answer.answers.length, 0) }
        : {}),
      resolvedAt: now(),
    });
    const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    if (turn?.providerTurnId) {
      const pending = options.requests.listByConversation(conversation.id).find((candidate) => candidate.turnId === turn.id && candidate.status === 'pending' && options.manager.hasGeneration(candidate.transportGenerationId));
      if (pending) {
        options.turns.upsert({ ...turn, status: 'waiting', updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'waiting',
        });
        runStates.set(conversation.id, {
          type: 'waiting',
          turnId: turn.providerTurnId,
          requestId: pending.id,
          reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
        });
      } else {
        options.turns.upsert({ ...turn, status: 'running', updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'active',
        });
        runStates.set(conversation.id, { type: 'active', turnId: turn.providerTurnId, phase: 'prework' });
      }
    }
    await persist();
    options.broadcast('conversation.request.resolved', {
      conversationId: conversation.id,
      requestId: request.id,
      requestKind: request.requestKind,
      ...('decision' in effectiveResponse ? { effectiveDecision: effectiveResponse.decision } : {}),
    });
    const submission = request.turnId ? options.submissions.listByConversation(conversation.id).find((entry) => entry.providerTurnId === options.turns.getById(request.turnId ?? '')?.providerTurnId) : undefined;
    return {
      operationId: operationId(),
      conversationId: conversation.id,
      submissionId: submission?.id ?? '',
      status: 'responded',
      providerThreadId: conversation.providerThreadId,
      providerTurnId: request.turnId ? (options.turns.getById(request.turnId)?.providerTurnId ?? null) : null,
    };
  }

  function validateRequestAnswerAttachments(request: ZeusConversationServerRequestRecord, payload: Record<string, unknown>, groups: NativeQuestionAnswerAttachmentInput[]): void {
    if (groups.length === 0) return;
    if (request.containsSecret) throw invalidServerRequestResponse('Sensitive request_user_input questions cannot include attachments.');
    const canonical = parseCanonicalRequestUserInputQuestions(payload);
    if (!canonical.ok) throw invalidServerRequestResponse(canonical.message);
    const questions = new Map(canonical.questions.map((question) => [question.id, question]));
    const seen = new Set<string>();
    let attachmentCount = 0;
    for (const group of groups) {
      if (!group.questionId || seen.has(group.questionId)) throw invalidServerRequestResponse('Answer attachment question ids must be explicit and unique.');
      const question = questions.get(group.questionId);
      if (!question) throw invalidServerRequestResponse(`Answer attachments do not belong to canonical question ${group.questionId}.`);
      if (question.isSecret) throw invalidServerRequestResponse(`Sensitive question ${group.questionId} cannot include attachments.`);
      if (!Array.isArray(group.attachments) || group.attachments.length === 0) throw invalidServerRequestResponse(`Answer attachment group ${group.questionId} must not be empty.`);
      seen.add(group.questionId);
      attachmentCount += group.attachments.length;
    }
    if (attachmentCount > 100) throw invalidServerRequestResponse('A request_user_input response cannot include more than 100 attachments.');
  }

  async function deliverRequestAnswerAttachments(request: ZeusConversationServerRequestRecord, conversation: ZeusConversationWithMessagesRecord, groups: NativeQuestionAnswerAttachmentInput[]): Promise<void> {
    const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    const providerTurnId = turn?.providerTurnId;
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (!providerTurnId || state.type !== 'waiting' || state.turnId !== providerTurnId || state.requestId !== request.id) {
      throw coordinatorError('ZEUS_REQUEST_ANSWER_ATTACHMENT_TURN_UNAVAILABLE', 'The current waiting turn is unavailable for request answer attachments.');
    }
    const attachments = flattenQuestionAnswerAttachments(groups);
    const mapping = groups.map((group) => `- ${group.questionId}: ${group.attachments.map((attachment) => attachment.name).join('、')}`).join('\n');
    const acceptance = await steerMessage({
      conversationId: conversation.id,
      content: `以下附件属于当前 request_user_input 的对应问题，请与随后提交的文字答案共同理解：\n${mapping}`,
      displayText: '已提交询问回答附件',
      attachments,
      expectedTurnId: providerTurnId,
      idempotencyKey: `request-answer-attachments:${request.id}`,
      clientUserMessageId: `request-answer-attachments:${request.id}`,
      requestAnswerId: request.id,
    });
    if (acceptance.status === 'steering' || acceptance.status === 'steered') return;
    if (acceptance.submissionId) {
      options.submissions.updateStatus(acceptance.submissionId, 'cancelled', { resolvedAt: now() });
      await persist();
    }
    throw coordinatorError('ZEUS_REQUEST_ANSWER_ATTACHMENT_NOT_DELIVERED', 'Request answer attachments were not accepted by the current turn.');
  }

  function flattenQuestionAnswerAttachments(groups: NativeQuestionAnswerAttachmentInput[]): NativeConversationAttachmentInput[] {
    const byIdentity = new Map<string, NativeConversationAttachmentInput>();
    for (const attachment of groups.flatMap((group) => group.attachments)) {
      const identity = attachment.authorizedPath ?? attachment.localPath ?? attachment.uploadRef ?? `${attachment.name}:${attachment.size}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, attachment);
    }
    return [...byIdentity.values()];
  }

  function requestResponseWithAttachmentPresentation(response: RespondNativeRequestInput['response'], presentation: RespondNativeRequestInput['answerAttachmentPresentation']): unknown {
    return presentation && Object.keys(presentation).length > 0 ? { ...response, answerAttachments: presentation } : response;
  }

  function isInteractionRecoveryCheckpointRequest(request: ZeusConversationServerRequestRecord): boolean {
    if (!request.responseJson) return false;
    try {
      const response = parseJsonRecord(request.responseJson);
      return response.interactionRecoveryCheckpoint === true || response.handoffCheckpoint === true;
    } catch {
      return false;
    }
  }

  function isRetiredGenerationFailure(request: ZeusConversationServerRequestRecord): boolean {
    if (request.status !== 'failed' || !request.responseJson) return false;
    try {
      return parseJsonRecord(request.responseJson).error === 'ZEUS_CODEX_REQUEST_GENERATION_STALE';
    } catch {
      return false;
    }
  }

  function isPendingInteractionAuthority(request: ZeusConversationServerRequestRecord): boolean {
    return request.status === 'pending' && (options.manager.hasGeneration(request.transportGenerationId) || isInteractionRecoveryCheckpointRequest(request));
  }

  async function respondAfterInteractionRecovery(inputValue: {
    request: ZeusConversationServerRequestRecord;
    conversation: ZeusConversationWithMessagesRecord;
    response: RespondNativeRequestInput['response'];
    input: RespondNativeRequestInput;
  }): Promise<NativeAcceptedOperation> {
    const { request, conversation, response } = inputValue;
    await inputValue.input.providerWriteLifecycle?.markPrepared(request.id);
    const secret = request.containsSecret && response.type === 'request_user_input';
    options.requests.resolve(request.id, {
      response: requestResponseWithAttachmentPresentation(response, inputValue.input.answerAttachmentPresentation),
      isSecret: secret,
      ...(secret && response.type === 'request_user_input' ? { questionIds: Object.keys(response.answers), answerCount: Object.values(response.answers).reduce((total, answer) => total + answer.answers.length, 0) } : {}),
      resolvedAt: now(),
    });

    const previousTurn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    if (previousTurn && previousTurn.status !== 'completed') {
      options.turns.upsert({ ...previousTurn, status: 'interrupted', completedAt: now(), updatedAt: now() });
      const previousSubmission = previousTurn.clientSubmissionId ? options.submissions.getById(previousTurn.clientSubmissionId) : undefined;
      if (previousSubmission && (previousSubmission.status === 'active' || previousSubmission.status === 'dispatching' || previousSubmission.status === 'paused')) {
        options.submissions.updateStatus(previousSubmission.id, 'completed', { resolvedAt: now() });
      }
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
      providerModel: conversation.providerModel,
      providerState: 'ready',
    });
    runStates.set(conversation.id, { type: 'idle' });

    const actualContent = buildInteractionRecoveryContinuation(request, response);
    const displayText = buildInteractionRecoveryDisplayText(request, response);
    const persistedContent = secret
      ? buildInteractionRecoveryContinuation(
          request,
          {
            type: 'request_user_input',
            answers: {},
          },
          '敏感回答仅在本次恢复执行的内存中传递，未写入本地记录。',
        )
      : actualContent;
    const context = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const submission = createSubmission(
      conversation.id,
      persistedContent,
      {
        idempotencyKey: `interaction-recovery-response:${request.id}`,
        clientUserMessageId: `interaction-recovery-response:${request.id}`,
        displayText,
        ...(inputValue.input.answerAttachments?.length ? { attachments: flattenQuestionAnswerAttachments(inputValue.input.answerAttachments) } : {}),
        ...(inputValue.input.answerAttachments?.length ? { requestAnswerId: request.id } : {}),
      },
      context,
    );
    if (secret) volatileSubmissionText.set(submission.id, actualContent);
    await persist();
    options.broadcast('conversation.request.resolved', {
      conversationId: conversation.id,
      requestId: request.id,
      requestKind: request.requestKind,
      resumedAfterTransportRecovery: true,
    });
    try {
      await ensureGenerationReconciled();
    } catch {
      return accepted(submission, 'queued', conversation.providerThreadId, null);
    }
    const refreshed = requireConversation(conversation.id);
    if (!hasConcurrency(context)) return accepted(submission, 'queued', refreshed.providerThreadId, null);
    return dispatchSubmission(refreshed, submission, inputValue.input.providerWriteLifecycle);
  }

  async function snoozeRequest(input: SnoozeNativeRequestInput): Promise<void> {
    assertOpen();
    const request = options.requests.getById(input.requestId);
    if (!request || request.requestKind !== 'request_user_input' || request.status !== 'pending') {
      throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex user input request is not pending.');
    }
    clearAutoResolutionTimer(request.id);
    options.requests.snooze(request.id);
    await persist();
    options.broadcast('conversation.request.snoozed', {
      conversationId: request.conversationId,
      requestId: request.id,
    });
  }

  function clearAutoResolutionTimer(requestId: string): void {
    const timer = autoResolutionTimers.get(requestId);
    if (timer) clearTimeout(timer);
    autoResolutionTimers.delete(requestId);
  }

  function scheduleAutoResolution(request: ZeusConversationServerRequestRecord): void {
    clearAutoResolutionTimer(request.id);
    if (request.requestKind !== 'request_user_input' || request.status !== 'pending' || request.autoResolutionState !== 'scheduled' || !request.expiresAt) return;
    const deadline = Date.parse(request.expiresAt);
    const current = Date.parse(now());
    if (!Number.isFinite(deadline) || !Number.isFinite(current)) return;
    const delay = Math.max(0, Math.min(2_147_000_000, deadline - current));
    autoResolutionTimers.set(
      request.id,
      setTimeout(() => {
        autoResolutionTimers.delete(request.id);
        void autoResolveRequest(request.id).catch((error) =>
          options.broadcast('conversation.native.error', {
            conversationId: request.conversationId,
            requestId: request.id,
            error: serializeError(error),
          }),
        );
      }, delay),
    );
  }

  async function autoResolveRequest(requestId: string): Promise<void> {
    const request = options.requests.getById(requestId);
    if (!request || request.status !== 'pending' || request.autoResolutionState !== 'scheduled') return;
    await respondToRequest({ requestId, response: { type: 'request_user_input', answers: {} } });
    options.requests.expire(requestId, { response: { type: 'request_user_input', answers: {} }, resolvedAt: now() });
    await persist();
  }

  async function respondToPlanImplementationRequest(input: RespondPlanImplementationRequestInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const request = planActions.getById(input.requestId);
    if (!request || request.conversationId !== conversation.id) {
      throw coordinatorError('ZEUS_PLAN_IMPLEMENTATION_REQUEST_NOT_FOUND', 'Plan implementation request was not found.');
    }
    const planItem = options.items.listByConversation(conversation.id).find((item) => item.id === request.planItemId);
    if (!planItem || planItem.itemType !== 'plan' || planItem.status !== 'completed' || !planItem.textContent.trim()) {
      throw coordinatorError('ZEUS_PLAN_IMPLEMENTATION_REQUEST_INVALID', 'Plan implementation request does not reference a completed non-empty plan.');
    }
    const timestamp = now();
    if (input.action === 'dismiss') {
      planActions.resolveLatestPending(request.id, conversation.id, { status: 'dismissed', resolvedAt: timestamp });
      await persist();
      options.broadcast('conversation.plan_implementation_request.changed', {
        conversationId: conversation.id,
        requestId: request.id,
        status: 'dismissed',
      });
      return {
        operationId: operationId(),
        conversationId: conversation.id,
        submissionId: '',
        status: 'responded',
        providerThreadId: conversation.providerThreadId,
        providerTurnId: null,
      };
    }

    const refinement = input.action === 'refine';
    const feedback = input.feedback?.trim() ?? '';
    if (refinement && !feedback) throw coordinatorError('ZEUS_PLAN_REFINEMENT_REQUIRED', 'Plan refinement feedback is required.');
    const previousContext = contextWithLatestNextTurnSettings(conversation.id, contexts.get(conversation.id) ?? contextFromConversation(conversation));
    const nextMode: ConversationCollaborationMode = refinement ? 'plan' : 'default';
    const context: ConversationDispatchContext = {
      ...previousContext,
      permissionMode: conversation.permissionMode,
      workMode: nextMode,
    };
    const content = refinement ? feedback : `请实施以下已确认计划。严格按计划执行，并在完成后报告验证结果。\n\n${planItem.textContent}`;
    const submissionIdentity = operationId();
    const submission = options.db.transaction(() => {
      options.conversations.updateCollaborationMode(conversation.id, nextMode);
      const created = createSubmission(
        conversation.id,
        content,
        {
          submissionId: `conversation_submission_${submissionIdentity}`,
          idempotencyKey: `plan-action:${request.id}:${input.action}`,
          clientUserMessageId: `plan-action-client:${request.id}:${input.action}`,
          ...(refinement
            ? {}
            : {
                displayText: '是，实施此计划',
                origin: 'implement_plan' as const,
                planItemId: planItem.id,
              }),
        },
        context,
      );
      planActions.resolveLatestPendingInCurrentTransaction(request.id, conversation.id, {
        status: refinement ? 'refinement_requested' : 'implemented',
        submissionId: created.id,
        resolvedAt: timestamp,
      });
      return created;
    });
    contexts.set(conversation.id, context);
    options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(context));
    await persist();
    options.broadcast('conversation.plan_implementation_request.changed', {
      conversationId: conversation.id,
      requestId: request.id,
      status: refinement ? 'refinement_requested' : 'implemented',
      submissionId: submission.id,
      collaborationMode: nextMode,
    });
    const refreshed = requireConversation(conversation.id);
    const state = runStates.get(conversation.id) ?? inferRunState(refreshed);
    runStates.set(conversation.id, state);
    if (state.type !== 'idle' || !hasConcurrency(context)) return accepted(submission, 'queued', refreshed.providerThreadId, null);
    return dispatchSubmission(refreshed, submission);
  }

  async function failPermissionRequest(conversation: ZeusConversationWithMessagesRecord, request: ReturnType<ConversationServerRequestRepository['getById']> & {}, payload: Record<string, unknown>, failure: unknown): Promise<never> {
    const turn = request?.turnId ? options.turns.getById(request.turnId) : undefined;
    const serialized: { message: string; code?: string; interruptError?: { message: string; code?: string } } = serializeError(failure);
    try {
      if (turn?.providerTurnId && conversation.providerThreadId) await options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: turn.providerTurnId });
    } catch (interruptError) {
      serialized.interruptError = serializeError(interruptError);
    }
    options.requests.upsert({
      conversationId: conversation.id,
      turnId: request?.turnId,
      itemId: request?.itemId,
      transportGenerationId: request!.transportGenerationId,
      providerRequestId: JSON.parse(request!.providerRequestIdJson) as string | number,
      requestKind: 'permissions',
      payload,
      status: 'failed',
      response: { error: serialized.code ?? 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', message: serialized.message },
      createdAt: request!.createdAt,
      resolvedAt: now(),
    });
    await persist();
    throw coordinatorError(serialized.code ?? 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', serialized.message);
  }

  async function recover(): Promise<void> {
    assertOpen();
    await reconcilePersistedTerminalSubmissions();
    try {
      await ensureGenerationReconciled(true);
    } catch (error) {
      for (const submission of options.submissions.listRecoverable()) {
        if (options.conversations.getById(submission.conversationId)?.agentKind !== 'codex') continue;
        if (submission.status !== 'dispatching' && submission.status !== 'active') continue;
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: { code: 'ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', cause: serializeError(error) } });
        runStates.set(submission.conversationId, { type: 'paused', reason: 'recovery_required' });
      }
      await persist();
      return;
    }
    recoverCompletedPlanImplementationRequests();
    await persist();
    for (const conversation of options.conversations.listNativeBound('codex')) {
      for (const request of options.requests.listByConversation(conversation.id)) scheduleAutoResolution(request);
    }
    await drainQueuedSubmissions();
  }

  function recoverCompletedPlanImplementationRequests(): void {
    for (const conversation of options.conversations.listNativeBound('codex')) {
      const submissions = options.submissions.listByConversation(conversation.id);
      for (const turn of options.turns.listByConversation(conversation.id)) {
        if (turn.status !== 'completed') continue;
        const submission = submissions.find((candidate) => candidate.id === turn.clientSubmissionId);
        ensurePlanImplementationRequest(conversation.id, turn, submission, turn.completedAt ?? turn.updatedAt);
      }
    }
  }

  async function reconcilePersistedTerminalSubmissions(): Promise<number> {
    assertOpen();
    await providerEventChain;
    const reconciledCount = reconcilePersistedTerminalTurnSubmissions();
    if (reconciledCount > 0) await persist();
    return reconciledCount;
  }

  async function capacityChanged(): Promise<void> {
    if (closing || closed || options.enabled === false) return;
    await drainQueuedSubmissions();
    // 容量信号若与既有 drain 竞态，须在其 finalizer 清空 queueDrainPromise 后再跑一轮，避免丢失 terminal runtime 释放事件。
    if (!closing && !closed) await drainQueuedSubmissions();
  }

  function requestQueueDrain(): void {
    queueMicrotask(() => {
      void drainQueuedSubmissions().catch((error) => {
        options.broadcast('conversation.native.queue_dispatch_failed', { error: serializeError(error) });
      });
    });
  }

  function drainQueuedSubmissions(): Promise<void> {
    if (queueDrainPromise) return queueDrainPromise;
    const drain = (async () => {
      while (!closing && !closed) {
        const candidates = nextQueuedSubmissionPerConversation();
        let dispatched = false;
        for (const submission of candidates) {
          let conversation = options.conversations.getById(submission.conversationId);
          if (!conversation || conversation.archived || conversation.providerState === 'archived' || conversation.providerState === 'closed' || conversation.providerState === 'failed') continue;
          let state = runStates.get(conversation.id) ?? inferRunState(conversation);
          if (state.type === 'paused' && state.reason === 'recovery_required') {
            try {
              conversation = await recoverPausedConversation(conversation.id, 'dispatch');
              state = runStates.get(conversation.id) ?? inferRunState(conversation);
            } catch (error) {
              markConversationRecoveryRequired(conversation.id, error);
              await persist();
              options.broadcast('conversation.native.recovery_failed', {
                conversationId: conversation.id,
                providerThreadId: conversation.providerThreadId,
                submissionId: submission.id,
                error: serializeError(error),
              });
              continue;
            }
          }
          const context = { ...contextFromSubmission(submission), permissionMode: conversation.permissionMode };
          if (context.holdDispatch) continue;
          contexts.set(conversation.id, context);
          runStates.set(conversation.id, state);
          if (state.type !== 'idle' || !hasConcurrency(context)) continue;
          if (closing || closed) return;
          const result = await dispatchSubmission(conversation, submission);
          if (result.status === 'active') dispatched = true;
        }
        if (!dispatched) return;
      }
    })();
    queueDrainPromise = drain.finally(() => {
      queueDrainPromise = null;
    });
    return queueDrainPromise;
  }

  function nextQueuedSubmissionPerConversation(): ZeusConversationSubmissionRecord[] {
    const heads = new Map<string, ZeusConversationSubmissionRecord>();
    for (const submission of options.submissions.listRecoverable()) {
      if (submission.status !== 'queued') continue;
      if (options.conversations.getById(submission.conversationId)?.agentKind !== 'codex') continue;
      const current = heads.get(submission.conversationId);
      if (!current || compareConversationQueueOrder(submission, current) < 0) heads.set(submission.conversationId, submission);
    }
    return [...heads.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  function releaseHeldSubmissions(conversationId: string, context: ConversationDispatchContext): void {
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.providerTurnId || (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed')) continue;
      const input = parseJsonRecord(submission.inputJson) as unknown as PersistedSubmissionInput;
      if (!isRecord(input.context)) continue;
      const nextInput: PersistedSubmissionInput = { ...input, context: { ...input.context, ...context } };
      delete nextInput.context.holdDispatch;
      options.submissions.updateQueuedInput(submission.id, { requestHash: requestHash(nextInput), input: nextInput });
    }
  }

  function compareConversationQueueOrder(left: ZeusConversationSubmissionRecord, right: ZeusConversationSubmissionRecord): number {
    return (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  }

  async function ensureGenerationReconciled(force = false): Promise<void> {
    const capabilities = await options.manager.ensureReady({ commandPath: commandPath(), ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) });
    if (!force && reconciledGenerationId === capabilities.generationId) return;
    const initialGenerationId = capabilities.generationId;
    const reconcile = generationReconcileChain
      .catch(() => undefined)
      .then(async () => {
        if (!force && reconciledGenerationId === initialGenerationId) return;
        let targetGenerationId = initialGenerationId;
        for (let pass = 0; pass < 3; pass += 1) {
          await reconcileBoundConversations(targetGenerationId);
          const current = options.manager.getState();
          if (current.type !== 'ready') throw coordinatorError('ZEUS_CODEX_GENERATION_CHANGED_DURING_RECOVERY', 'Codex app-server generation changed during native conversation recovery.');
          if (current.generationId === targetGenerationId) {
            reconciledGenerationId = targetGenerationId;
            return;
          }
          targetGenerationId = current.generationId;
        }
        throw coordinatorError('ZEUS_CODEX_GENERATION_CHANGED_DURING_RECOVERY', 'Codex app-server generation did not stabilize during native conversation recovery.');
      });
    generationReconcileChain = reconcile.catch(() => undefined);
    await reconcile;
  }

  async function reconcileBoundConversations(generationId: string): Promise<void> {
    const boundConversationIds = new Set<string>();
    for (const conversation of options.conversations.listNativeBound('codex')) {
      boundConversationIds.add(conversation.id);
      // 已归档 Provider 会话只能由用户显式恢复，启动恢复不得触碰其线程。
      if (conversation.archived || conversation.providerState === 'archived') continue;
      try {
        recoverStaleInteractionRequests(conversation.id, generationId);
        await ensureConversationExecutionContext(conversation.id, 'reconcile');
        const contextual = options.submissions.listByConversation(conversation.id).find((submission) => isRecord(parseJsonRecord(submission.inputJson).context));
        if (contextual && !contexts.has(conversation.id)) contexts.set(conversation.id, contextFromSubmission(contextual));
        const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
        const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
        contexts.set(conversation.id, context);
        const responsesRuntime = await responsesRuntimeFor(context);
        const resumed = await options.manager.resumeThread({
          threadId: providerThreadId,
          ...(context.projectLocalPath ? { cwd: context.projectLocalPath } : {}),
          ...(responsesRuntime ? { responsesRuntime } : {}),
        });
        persistThreadProviderSettings(conversation.id, resumed);
        const authoritativeGenerationId = options.manager.generationForThread(providerThreadId) ?? generationId;
        await enqueueProviderTurnReconciliation(requireConversation(conversation.id));
        const snapshot = await options.manager.readThread({ threadId: providerThreadId });
        reconcileConversationSnapshot(conversation, snapshot, authoritativeGenerationId);
        restoreRecoverableInteractionState(conversation.id);
      } catch (error) {
        if (isProviderThreadArchivedError(error)) markConversationProviderArchived(conversation.id, error);
        else markConversationRecoveryRequired(conversation.id, error);
        options.broadcast(isProviderThreadArchivedError(error) ? 'conversation.thread.archived' : 'conversation.native.recovery_failed', {
          conversationId: conversation.id,
          providerThreadId: conversation.providerThreadId,
          generationId,
          error: serializeError(error),
        });
      }
      await persist();
    }
    for (const submission of options.submissions.listRecoverable()) {
      if (options.conversations.getById(submission.conversationId)?.agentKind !== 'codex') continue;
      if ((submission.status !== 'dispatching' && submission.status !== 'active') || boundConversationIds.has(submission.conversationId)) continue;
      markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'Native submission has no recoverable provider thread.'));
    }
  }

  function restoreRecoverableInteractionState(conversationId: string): void {
    const request = options.requests.listByConversation(conversationId).find((candidate) => isPendingInteractionAuthority(candidate));
    if (!request?.turnId) return;
    const turn = options.turns.getById(request.turnId);
    const conversation = options.conversations.getById(conversationId);
    if (!turn?.providerTurnId || !conversation?.providerThreadId) return;
    options.turns.upsert({ ...turn, status: 'waiting', completedAt: null, updatedAt: now() });
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: conversation.providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'waiting',
    });
    runStates.set(conversation.id, {
      type: 'waiting',
      turnId: turn.providerTurnId,
      requestId: request.id,
      reason: request.requestKind === 'request_user_input' ? 'user_input' : 'approval',
    });
  }

  async function ensureProviderSyncCheckpoint(conversation: ZeusConversationWithMessagesRecord) {
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const existing = syncCheckpoints.getByConversation(conversation.id);
    if (existing) {
      if (existing.providerThreadId !== providerThreadId) throw coordinatorError('ZEUS_NATIVE_SYNC_CHECKPOINT_CONFLICT', 'Provider sync checkpoint belongs to another thread.');
      return existing;
    }
    const latest = await options.manager.listThreadTurns({ threadId: providerThreadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    return syncCheckpoints.initialize({
      conversationId: conversation.id,
      providerThreadId,
      baselineTurnId: latest.data[0]?.id ?? null,
      timestamp: now(),
    });
  }

  async function reconcileProviderTurnsSinceCheckpoint(conversation: ZeusConversationWithMessagesRecord): Promise<void> {
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const checkpoint = await ensureProviderSyncCheckpoint(conversation);
    const turnsDescending: CodexTurnSnapshot[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let checkpointIndex = -1;
    do {
      const page = await options.manager.listThreadTurns({
        threadId: providerThreadId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      for (const turn of page.data) {
        if (turnsDescending.some((candidate) => candidate.id === turn.id)) continue;
        turnsDescending.push(turn);
      }
      if (checkpoint.lastSyncedTurnId) checkpointIndex = turnsDescending.findIndex((turn) => turn.id === checkpoint.lastSyncedTurnId);
      cursor = page.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw coordinatorError('ZEUS_NATIVE_SYNC_CURSOR_INVALID', 'Provider turn pagination repeated one cursor.');
        seenCursors.add(cursor);
      }
    } while (cursor && (!checkpoint.lastSyncedTurnId || checkpointIndex < 0));

    if (checkpoint.lastSyncedTurnId && checkpointIndex < 0) {
      throw coordinatorError('ZEUS_NATIVE_SYNC_CHECKPOINT_MISSING', 'Provider history no longer contains the last synchronized turn; historical boundaries will not be guessed.');
    }

    const eligibleDescending = checkpoint.lastSyncedTurnId ? turnsDescending.slice(0, checkpointIndex + 1) : turnsDescending;
    const localTurns = new Map(
      options.turns
        .listByConversation(conversation.id)
        .filter((turn) => turn.providerTurnId)
        .map((turn) => [turn.providerTurnId as string, turn]),
    );
    for (const providerTurn of [...eligibleDescending].reverse()) {
      const existingTurn = localTurns.get(providerTurn.id);
      // 首次启用时的基线只定义边界；它不在 Zeus 本地时不得作为历史缺口导入。
      if (providerTurn.id === checkpoint.baselineTurnId && !existingTurn) continue;
      const projected = projectProviderSnapshotTurn(conversation, providerThreadId, providerTurn, existingTurn);
      localTurns.set(providerTurn.id, projected);
    }

    const newest = eligibleDescending[0];
    if (newest) syncCheckpoints.advance({ conversationId: conversation.id, providerThreadId, lastSyncedTurnId: newest.id, timestamp: now() });
  }

  function projectProviderSnapshotTurn(conversation: ZeusConversationWithMessagesRecord, providerThreadId: string, providerTurn: CodexTurnSnapshot, existingTurn: ZeusConversationTurnRecord | undefined): ZeusConversationTurnRecord {
    const classification = classifySnapshotTurn(providerTurn);
    if (classification === 'unknown') throw coordinatorError('ZEUS_NATIVE_PROVIDER_TURN_INVALID', `Provider turn has an unknown status: ${providerTurn.id}`);
    const timestamp = now();
    const startedAt = providerTimestamp(providerTurn.startedAt, existingTurn?.startedAt ?? timestamp);
    const completedAt = classification === 'active' ? null : providerTimestamp(providerTurn.completedAt, existingTurn?.completedAt ?? timestamp);
    const submissions = options.submissions.listByConversation(conversation.id);
    const providerClientId = providerTurnUserClientId(providerTurn);
    const matchedSubmission = (providerClientId ? submissions.find((candidate) => candidate.clientMessageId === providerClientId) : undefined) ?? submissions.find((candidate) => candidate.providerTurnId === providerTurn.id);
    const status = classification === 'active' ? 'running' : classification;
    const wasTerminal = existingTurn?.status === 'completed' || existingTurn?.status === 'interrupted' || existingTurn?.status === 'failed';
    const stateChanged = !existingTurn || existingTurn.status !== status;
    const turn = options.turns.upsert({
      ...(existingTurn ? { id: existingTurn.id } : {}),
      conversationId: conversation.id,
      providerThreadId,
      providerTurnId: providerTurn.id,
      clientSubmissionId: matchedSubmission?.id ?? existingTurn?.clientSubmissionId ?? null,
      status,
      ...(classification === 'failed' ? { error: providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id)) } : {}),
      startedAt,
      completedAt,
      createdAt: existingTurn?.createdAt ?? startedAt,
      updatedAt: timestamp,
    });

    const matchedCompatibilityItemIds = new Set<string>();
    for (const candidate of Array.isArray(providerTurn.items) ? providerTurn.items : []) {
      if (!isRecord(candidate)) continue;
      projectProviderSnapshotItem(conversation, turn, candidate, classification, timestamp, matchedCompatibilityItemIds);
    }

    if (classification === 'active') {
      if (matchedSubmission && (matchedSubmission.status === 'dispatching' || matchedSubmission.status === 'queued')) {
        options.submissions.updateStatus(matchedSubmission.id, 'active', { providerTurnId: providerTurn.id, dispatchedAt: startedAt });
      }
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: conversation.providerModel, providerState: 'active' });
      runStates.set(conversation.id, { type: 'active', turnId: providerTurn.id, phase: 'prework' });
      if (stateChanged) {
        options.broadcast('conversation.turn.started', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: providerTurn.id,
          ...(turn.clientSubmissionId ? { submissionId: turn.clientSubmissionId } : {}),
          status: 'running',
          startedAt,
        });
      }
    } else {
      if (matchedSubmission && (matchedSubmission.status === 'active' || matchedSubmission.status === 'dispatching')) {
        options.submissions.updateStatus(matchedSubmission.id, classification === 'failed' ? 'failed' : 'completed', { providerTurnId: providerTurn.id, resolvedAt: completedAt ?? timestamp });
      }
      if (classification === 'failed') {
        const failureRecord = providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id));
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) {
          options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required', error: failureRecord });
        }
      }
      const interruptedQueue = classification === 'interrupted' ? interruptedQueueSubmissions(submissions) : [];
      for (const queued of interruptedQueue.filter((entry) => entry.status === 'queued')) {
        options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
      }
      const interruptedWithQueue = classification === 'interrupted' && interruptedQueue.length > 0;
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId,
        providerModel: conversation.providerModel,
        providerState: classification === 'failed' ? 'failed' : interruptedWithQueue ? 'paused' : 'ready',
      });
      runStates.set(conversation.id, classification === 'failed' ? { type: 'paused', reason: 'recovery_required' } : interruptedWithQueue ? { type: 'paused', reason: 'interrupted' } : { type: 'idle' });
      if (!wasTerminal) options.changeSets?.seal({ conversation, turn, timestamp });
      if (!wasTerminal && !goals.get(conversation.id)) {
        options.conversations.markAttentionUnread(conversation.id, {
          kind: classification,
          turnId: providerTurn.id,
          occurredAt: completedAt ?? timestamp,
        });
      }
      if (stateChanged) {
        options.broadcast('conversation.turn.completed', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: providerTurn.id,
          status: classification,
          completedAt: completedAt ?? timestamp,
        });
      }
    }
    return turn;
  }

  function projectProviderSnapshotItem(
    conversation: ZeusConversationWithMessagesRecord,
    turn: ZeusConversationTurnRecord,
    itemPayload: Record<string, unknown>,
    turnClassification: ReturnType<typeof classifySnapshotTurn>,
    timestamp: string,
    matchedCompatibilityItemIds: Set<string>,
  ): void {
    const providerThreadId = turn.providerThreadId;
    const providerTurnId = requireString(turn.providerTurnId, 'provider turn id');
    const providerItemId = typeof itemPayload.id === 'string' && itemPayload.id.trim() ? itemPayload.id : null;
    if (!providerItemId) return;
    const itemType = itemTypeFromValue(itemPayload.type);
    const presentedItemPayload = sanitizeConversationItemPayload(itemType === 'userMessage' ? { ...itemPayload, ...submissionPresentation(conversation.id, turn, itemPayload) } : itemPayload);
    const existing = options.items.getByProvider(providerThreadId, providerItemId);
    const userMessageProjection = itemType === 'userMessage' ? projectProviderUserMessage(conversation, turn, presentedItemPayload, itemText(itemPayload), providerItemId) : null;
    if (itemType === 'userMessage' && !userMessageProjection) return;
    const completedProjection = userMessageProjection
      ? { ...completedItemProjection(existing, presentedItemPayload, itemType), textContent: userMessageProjection.content }
      : completedItemProjection(existing, presentedItemPayload, itemType);
    const itemFailed = itemPayload.status === 'failed';
    const itemTerminal = turnClassification !== 'active' || itemFailed || itemPayload.status === 'completed';
    const projectedStatus = itemFailed ? 'failed' : itemTerminal ? 'completed' : 'in_progress';
    if (compatibilitySnapshotItemIdPattern.test(providerItemId)) {
      const sourceItems = claimCompatibilitySnapshotSourceItems(
        {
          providerThreadId,
          providerTurnId,
          itemType,
          status: projectedStatus,
          phase: phaseFromItem(itemPayload),
          textContent: completedProjection.textContent,
        },
        options.items.listByConversation(conversation.id).filter((candidate) => candidate.turnId === turn.id),
        matchedCompatibilityItemIds,
      );
      if (sourceItems.length > 0) {
        for (const sourceItem of sourceItems) matchedCompatibilityItemIds.add(sourceItem.id);
        return;
      }
    }
    const item = itemTerminal
      ? options.items.upsertCompleted({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId,
          providerTurnId,
          providerItemId,
          itemType,
          phase: phaseFromItem(itemPayload),
          payload: completedProjection.payload,
          textContent: completedProjection.textContent,
          status: projectedStatus,
          startedAt: existing?.startedAt ?? turn.startedAt,
          completedAt: itemFailed || turnClassification !== 'active' ? (turn.completedAt ?? timestamp) : timestamp,
          updatedAt: timestamp,
        })
      : options.items.upsertProgress({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId,
          providerTurnId,
          providerItemId,
          itemType,
          phase: phaseFromItem(itemPayload),
          payload: completedProjection.payload,
          textContent: completedProjection.textContent,
          startedAt: existing?.startedAt ?? turn.startedAt,
          updatedAt: timestamp,
        });
    let durableClientMessageId: string | null = null;
    if (item.itemType === 'userMessage' && userMessageProjection) {
      durableClientMessageId = persistProviderUserMessage(conversation, presentedItemPayload, userMessageProjection, providerTurnId, providerThreadId, providerItemId, timestamp);
    } else if (item.itemType === 'agentMessage' && itemTerminal) {
      options.conversations.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: item.textContent,
        source: 'codex_native',
        metadata: { phase: item.phase },
        createdAt: timestamp,
        providerThreadId,
        providerTurnId,
        providerItemId,
      });
    }
    if (item.itemType === 'fileChange') {
      options.changeSets?.capture({ conversation, turn, providerItemId, changes: itemPayload.changes, phase: itemTerminal ? 'post' : 'pre', timestamp });
    }
    const itemResources = syncItemResources(conversation, turn, item, presentedItemPayload, item.textContent, timestamp);
    options.broadcast('conversation.item.updated', {
      conversationId: conversation.id,
      providerThreadId,
      providerTurnId,
      providerItemId,
      itemType: item.itemType,
      itemPayload: { ...parseJsonRecord(item.payloadJson), ...(item.itemType === 'userMessage' ? { clientId: durableClientMessageId } : {}) },
      textContent: item.textContent,
      status: item.status,
      phase: item.phase,
      itemResources,
    });
  }

  function reconcileConversationSnapshot(conversation: ZeusConversationWithMessagesRecord, snapshot: CodexThreadSnapshot, generationId: string): void {
    const snapshotPath = threadPath(snapshot);
    if (snapshotPath && conversation.nativeSessionPath !== snapshotPath) {
      conversation = options.conversations.updateProviderThreadPath(conversation.id, {
        providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
        providerThreadPath: snapshotPath,
      });
    }
    const submissions = options.submissions.listByConversation(conversation.id);
    const pendingSteering = submissions.filter((submission) => isSteeringSubmission(submission) && (submission.status === 'dispatching' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required')));
    const inFlight = submissions.filter((submission) => !isSteeringSubmission(submission) && (submission.status === 'dispatching' || submission.status === 'active'));
    for (const submission of pendingSteering) {
      const snapshotTurn = findSnapshotTurn(snapshot, submission);
      const providerTurnId = snapshotTurn && typeof snapshotTurn.id === 'string' ? snapshotTurn.id : submission.providerTurnId;
      const classification = classifySnapshotTurn(snapshotTurn);
      if (providerTurnId && hasExactProviderUserMessage(conversation, submission, providerTurnId)) {
        if (submission.status !== 'resolved') options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId, resolvedAt: now() });
        continue;
      }
      if (!snapshotTurn || !providerTurnId || classification === 'unknown' || classification !== 'active') {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_STEER_OUTCOME_UNKNOWN', 'Provider thread state cannot confirm the steering user message.'));
      }
    }
    if (inFlight.length === 0) {
      const activeProviderTurn = (Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : []).find((candidate) => classifySnapshotTurn(candidate) === 'active');
      const activeProviderTurnId = activeProviderTurn && typeof activeProviderTurn.id === 'string' ? activeProviderTurn.id : null;
      const projectedRemoteTurn = activeProviderTurnId ? options.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === activeProviderTurnId && !turn.clientSubmissionId) : undefined;
      if (activeProviderTurnId && projectedRemoteTurn) {
        options.turns.upsert({ ...projectedRemoteTurn, status: 'running', completedAt: null, updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerModel: conversation.providerModel,
          providerState: 'active',
        });
        runStates.set(conversation.id, { type: 'active', turnId: activeProviderTurnId, phase: 'prework' });
        return;
      }
      const unresolvedSteering = pendingSteering.some((submission) => {
        const current = options.submissions.getById(submission.id);
        return current?.status === 'paused' && current.pausedReason === 'recovery_required';
      });
      if (unresolvedSteering) {
        if (conversation.providerThreadId && conversation.providerState !== 'archived' && conversation.providerState !== 'closed' && conversation.providerState !== 'failed') {
          options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: conversation.providerThreadId,
            providerModel: conversation.providerModel,
            providerState: 'paused',
          });
        }
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        return;
      }
      if (!snapshotConfirmsIdleProviderThread(snapshot)) {
        markConversationRecoveryRequired(conversation.id, coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread state cannot confirm that there is no active turn.'));
        return;
      }
      if (conversation.providerState === 'failed' || conversation.providerState === 'closed') {
        markConversationRecoveryRequired(conversation.id, coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_RESUMABLE', 'The provider conversation cannot be resumed safely.'));
        return;
      }
      if (conversation.providerState === 'paused') {
        if (!snapshotConfirmsSafeResumeBoundary(snapshot, options.turns.listByConversation(conversation.id))) {
          markConversationRecoveryRequired(conversation.id, coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread state cannot confirm that the previous turn is terminal.'));
          return;
        }
      }
      if (conversation.providerState !== 'ready') {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerModel: conversation.providerModel,
          providerState: 'ready',
        });
      }
      // 恢复只确认原会话可以继续，不替用户发送重启前尚未进入 Codex 轮次的内容。
      pauseUnsentSubmissionsForConfirmation(conversation.id);
      runStates.set(conversation.id, { type: 'idle' });
      return;
    }
    for (const submission of inFlight) {
      const currentSubmission = options.submissions.getById(submission.id);
      if (!currentSubmission || (currentSubmission.status !== 'dispatching' && currentSubmission.status !== 'active')) continue;
      const snapshotTurn = findSnapshotTurn(snapshot, submission);
      const providerTurnId = snapshotTurn && typeof snapshotTurn.id === 'string' ? snapshotTurn.id : submission.providerTurnId;
      const classification = classifySnapshotTurn(snapshotTurn);
      if (!snapshotTurn || !providerTurnId || classification === 'unknown') {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'Provider thread state cannot confirm the in-flight submission.'));
        continue;
      }
      const timestamp = now();
      const existingTurn = options.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === providerTurnId || turn.clientSubmissionId === submission.id);
      const turn = upsertRecoveredTurn(existingTurn, {
        conversationId: conversation.id,
        providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
        providerTurnId,
        clientSubmissionId: existingTurn?.clientSubmissionId ?? submission.id,
        status: classification === 'completed' ? 'completed' : classification === 'interrupted' ? 'interrupted' : classification === 'failed' ? 'failed' : 'running',
        timestamp,
      });
      if (classification === 'active') {
        const pending = options.requests.listByConversation(conversation.id).find((request) => request.turnId === turn.id && request.status === 'pending' && request.transportGenerationId === generationId);
        if (pending) options.turns.upsert({ ...turn, status: 'waiting', updatedAt: timestamp });
        options.submissions.updateStatus(submission.id, 'active', { providerTurnId });
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: pending ? 'waiting' : 'active' });
        runStates.set(
          conversation.id,
          pending ? { type: 'waiting', turnId: providerTurnId, requestId: pending.id, reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval' } : { type: 'active', turnId: providerTurnId, phase: 'prework' },
        );
      } else if (classification === 'completed') {
        const result = reconcileTerminalTurnSubmissions(conversation, turn, timestamp);
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: result.recoveryRequired.length > 0 ? 'paused' : 'ready',
        });
        runStates.set(conversation.id, result.recoveryRequired.length > 0 ? { type: 'paused', reason: 'recovery_required' } : { type: 'idle' });
      } else if (classification === 'interrupted') {
        const result = reconcileTerminalTurnSubmissions(conversation, turn, timestamp);
        const interruptedQueue = interruptedQueueSubmissions(submissions);
        for (const queued of interruptedQueue.filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
        const hasInterruptedQueue = interruptedQueue.length > 0;
        const requiresRecovery = result.recoveryRequired.length > 0;
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: requiresRecovery || hasInterruptedQueue ? 'paused' : 'ready',
        });
        runStates.set(conversation.id, requiresRecovery ? { type: 'paused', reason: 'recovery_required' } : hasInterruptedQueue ? { type: 'paused', reason: 'interrupted' } : { type: 'idle' });
      } else {
        const failureParams = { turn: snapshotTurn };
        const failure = providerTurnFailure(failureParams, providerTurnId);
        const failureRecord = providerTurnFailureRecord(failureParams, failure);
        const failedTurn = options.turns.upsert({ ...turn, status: 'failed', error: failureRecord, completedAt: timestamp, updatedAt: timestamp });
        reconcileTerminalTurnSubmissions(conversation, failedTurn, timestamp, failureRecord);
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) {
          options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required', error: failureRecord });
        }
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: 'failed' });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        const resultKey = `${conversation.id}:${providerTurnId}`;
        failedTurnResults.set(resultKey, failure);
        rejectTurnResultWaiters(resultKey, failure);
      }
    }
  }

  function pauseUnsentSubmissionsForConfirmation(conversationId: string): void {
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if ((submission.status !== 'queued' && submission.status !== 'paused') || submission.providerTurnId) continue;
      options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'user_confirmation' });
    }
  }

  function upsertRecoveredTurn(
    existing: ZeusConversationTurnRecord | undefined,
    input: {
      conversationId: string;
      providerThreadId: string;
      providerTurnId: string;
      clientSubmissionId: string;
      status: ZeusConversationTurnRecord['status'];
      timestamp: string;
    },
  ): ZeusConversationTurnRecord {
    return options.turns.upsert({
      ...(existing ? { id: existing.id } : {}),
      conversationId: input.conversationId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      clientSubmissionId: input.clientSubmissionId,
      status: input.status,
      startedAt: existing?.startedAt ?? input.timestamp,
      completedAt: input.status === 'completed' || input.status === 'interrupted' || input.status === 'failed' ? input.timestamp : null,
      createdAt: existing?.createdAt ?? input.timestamp,
      updatedAt: input.timestamp,
    });
  }

  function markConversationRecoveryRequired(conversationId: string, error: unknown): void {
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active') markSubmissionRecoveryRequired(submission, error);
    }
    const conversation = options.conversations.getById(conversationId);
    if (conversation?.providerThreadId && conversation.providerState !== 'archived' && conversation.providerState !== 'closed' && conversation.providerState !== 'failed') {
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId: conversation.providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'paused',
      });
    }
    runStates.set(conversationId, { type: 'paused', reason: 'recovery_required' });
  }

  function markConversationProviderArchived(conversationId: string, error: unknown): void {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation?.providerThreadId) return;
    const archivedError = {
      code: 'ZEUS_CODEX_THREAD_ARCHIVED',
      message: 'The Codex provider thread is archived.',
      cause: serializeError(error),
    };
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status !== 'queued' && submission.status !== 'dispatching' && submission.status !== 'active') continue;
      options.submissions.updateStatus(submission.id, 'paused', {
        pausedReason: 'provider_archived',
        error: archivedError,
      });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: conversation.providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'archived',
    });
    runStates.set(conversationId, { type: 'paused', reason: 'provider_archived' });
    options.broadcast('conversation.thread.changed', {
      conversationId,
      providerThreadId: conversation.providerThreadId,
      providerState: 'archived',
    });
    options.broadcast('conversation.queue.changed', { conversationId });
  }

  function markSubmissionRecoveryRequired(submission: ZeusConversationSubmissionRecord, error: unknown): void {
    options.submissions.updateStatus(submission.id, 'paused', {
      pausedReason: 'recovery_required',
      error: toRecoverySubmissionError(error),
    });
    runStates.set(submission.conversationId, { type: 'paused', reason: 'recovery_required' });
  }

  function ensurePlanImplementationRequest(conversationId: string, turn: ZeusConversationTurnRecord, submission: ZeusConversationSubmissionRecord | undefined, timestamp: string) {
    if (!submission || contextFromSubmission(submission).workMode !== 'plan') return null;
    const planItem = options.items
      .listByConversation(conversationId)
      .filter((item) => item.turnId === turn.id && item.itemType === 'plan' && item.status === 'completed' && item.textContent.trim())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .at(-1);
    if (!planItem) return null;
    return planActions.createPending({
      conversationId,
      turnId: turn.id,
      planItemId: planItem.id,
      createdAt: timestamp,
    });
  }

  async function failInvalidInteractionAuthority(input: {
    conversation: ZeusConversationWithMessagesRecord;
    threadId: string;
    providerTurnId: string | null;
    turn: ZeusConversationTurnRecord | undefined;
    request: { id: string; status: string };
    error: Record<string, unknown>;
    timestamp: string;
  }): Promise<Record<string, unknown>> {
    const interactionError: Record<string, unknown> = { ...input.error, recoveryRequired: false };
    if (input.request.status === 'pending') options.requests.fail(input.request.id, { error: interactionError, resolvedAt: input.timestamp });
    let interruptFailed = false;
    if (input.providerTurnId) {
      try {
        await options.manager.interruptTurn({ threadId: input.threadId, turnId: input.providerTurnId });
      } catch (error) {
        interruptFailed = true;
        interactionError.interruptError = serializeError(error);
      }
    }
    if (input.turn) {
      options.turns.upsert({ ...input.turn, status: 'failed', error: interactionError, completedAt: input.timestamp, updatedAt: input.timestamp });
      const activeSubmission = input.turn.clientSubmissionId ? options.submissions.getById(input.turn.clientSubmissionId) : undefined;
      if (activeSubmission && (activeSubmission.status === 'dispatching' || activeSubmission.status === 'active')) {
        options.submissions.updateStatus(activeSubmission.id, 'failed', {
          providerTurnId: input.providerTurnId,
          error: interactionError,
          resolvedAt: input.timestamp,
          updatedAt: input.timestamp,
        });
      }
    }
    options.conversations.bindProvider(input.conversation.id, {
      providerId: 'codex',
      providerThreadId: input.threadId,
      providerModel: input.conversation.providerModel,
      providerState: interruptFailed ? 'failed' : 'ready',
    });
    runStates.set(input.conversation.id, { type: 'idle' });
    options.broadcast('conversation.queue.changed', { conversationId: input.conversation.id });
    return interactionError;
  }

  async function handleProviderEvent(event: CodexAppServerEvent, receiptEvents: readonly CodexAppServerEvent[] = [event]): Promise<void> {
    if (closed) return;
    const identity = eventIdentity(event);
    if (hasProcessedProviderEvent(event, identity)) return;
    const params = isRecord(event.params) ? event.params : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const conversation = threadId ? options.conversations.getByProviderThreadId(threadId) : undefined;
    let broadcast: { type: string; payload: Record<string, unknown> } | null = null;
    let drainAfterTurn = false;
    let queueChangedAfterTurn = false;
    let createdPlanImplementationRequest: ReturnType<ConversationPlanActionRepository['getById']> | null = null;

    if (event.method === 'thread/goal/updated' && conversation && threadId) {
      const goal = await options.manager.readThreadGoal({ threadId });
      if (goal) projectGoal(conversation.id, goal, typeof params.turnId === 'string' ? params.turnId : null, event.receivedAt);
    } else if (event.method === 'thread/goal/cleared' && conversation && threadId) {
      const cleared = goals.clear({ conversationId: conversation.id, providerThreadId: threadId, occurredAt: event.receivedAt });
      if (cleared) options.broadcast('conversation.goal.cleared', { conversationId: conversation.id, cleared: true, timeline: goals.listEvents(conversation.id) });
    } else if (event.method === 'serverRequest/resolved') {
      const providerRequestId = typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : null;
      if (providerRequestId === null) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Codex serverRequest/resolved omitted requestId.');
      const request = options.requests.getByProvider(event.generationId, providerRequestId);
      if (request?.status === 'pending') {
        const durableConversation = options.conversations.getById(request.conversationId);
        if (durableConversation) {
          clearAutoResolutionTimer(request.id);
          options.requests.resolveExternally(request.id, { source: 'provider', resolvedAt: event.receivedAt });
          const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
          if (turn?.providerTurnId) {
            const nextPending = options.requests
              .listByConversation(durableConversation.id)
              .find((candidate) => candidate.turnId === turn.id && candidate.status === 'pending' && options.manager.hasGeneration(candidate.transportGenerationId));
            if (nextPending) {
              options.turns.upsert({ ...turn, status: 'waiting', updatedAt: event.receivedAt });
              options.conversations.bindProvider(durableConversation.id, {
                providerId: 'codex',
                providerThreadId: turn.providerThreadId,
                providerModel: durableConversation.providerModel,
                providerState: 'waiting',
              });
              runStates.set(durableConversation.id, {
                type: 'waiting',
                turnId: turn.providerTurnId,
                requestId: nextPending.id,
                reason: nextPending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
              });
            } else {
              options.turns.upsert({ ...turn, status: 'running', updatedAt: event.receivedAt });
              options.conversations.bindProvider(durableConversation.id, {
                providerId: 'codex',
                providerThreadId: turn.providerThreadId,
                providerModel: durableConversation.providerModel,
                providerState: 'active',
              });
              runStates.set(durableConversation.id, { type: 'active', turnId: turn.providerTurnId, phase: 'prework' });
            }
          }
          broadcast = {
            type: 'conversation.request.resolved',
            payload: {
              conversationId: durableConversation.id,
              requestId: request.id,
              requestKind: request.requestKind,
              resolvedBy: 'provider',
            },
          };
        }
      }
    } else if (event.method === 'transport/server_request_identity_conflict' && event.requestId !== undefined) {
      const request = options.requests.getByProvider(event.generationId, event.requestId);
      if (request?.status === 'pending') {
        const durableConversation = options.conversations.getById(request.conversationId);
        const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
        const durableThreadId = durableConversation?.providerThreadId ?? turn?.providerThreadId ?? threadId;
        const providerTurnId = turn?.providerTurnId ?? providerTurnIdFrom(params);
        if (durableConversation && durableThreadId) {
          const recoveryError = await failInvalidInteractionAuthority({
            conversation: durableConversation,
            threadId: durableThreadId,
            providerTurnId,
            turn,
            request,
            error: {
              error: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT',
              message: 'The provider reused one generation-scoped request identity with conflicting method or payload authority.',
              recoveryRequired: false,
              generationId: event.generationId,
              providerRequestId: event.requestId,
              originalMethod: params.originalMethod,
              receivedMethod: params.receivedMethod,
            },
            timestamp: event.receivedAt,
          });
          options.broadcast('conversation.request.resolved', {
            conversationId: durableConversation.id,
            requestId: request.id,
            providerTurnId,
            generationId: event.generationId,
            sequence: event.sequence,
          });
          broadcast = {
            type: 'conversation.native.error',
            payload: {
              conversationId: durableConversation.id,
              providerThreadId: durableThreadId,
              providerTurnId,
              requestId: request.id,
              ...recoveryError,
            },
          };
        }
      }
    } else if (event.method === 'turn/started' && conversation && threadId) {
      const providerTurn = isRecord(params.turn) ? params.turn : params;
      const providerTurnId = providerTurnIdFrom(params);
      if (!providerTurnId) return;
      const timestamp = providerTimestamp(providerTurn.startedAt, event.receivedAt);
      const submissions = options.submissions.listByConversation(conversation.id);
      const providerClientId = providerTurnUserClientId(providerTurn);
      const matchedSubmission = (providerClientId ? submissions.find((candidate) => candidate.clientMessageId === providerClientId) : undefined) ?? submissions.find((candidate) => candidate.providerTurnId === providerTurnId);
      const existingTurn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
      const existingTerminal = existingTurn?.status === 'completed' || existingTurn?.status === 'interrupted' || existingTurn?.status === 'failed';
      const turn =
        existingTerminal && existingTurn
          ? existingTurn
          : options.turns.upsert({
              ...(existingTurn ? { id: existingTurn.id } : {}),
              conversationId: conversation.id,
              providerThreadId: threadId,
              providerTurnId,
              clientSubmissionId: matchedSubmission?.id ?? existingTurn?.clientSubmissionId ?? null,
              status: 'running',
              startedAt: existingTurn?.startedAt ?? timestamp,
              completedAt: null,
              createdAt: existingTurn?.createdAt ?? timestamp,
              updatedAt: event.receivedAt,
            });
      // 迟到的 started 事件不能把已经终态的轮次和会话重新激活。
      if (!existingTerminal) {
        if (matchedSubmission && (matchedSubmission.status === 'dispatching' || matchedSubmission.status === 'queued')) {
          options.submissions.updateStatus(matchedSubmission.id, 'active', { providerTurnId, dispatchedAt: timestamp });
        }
        const checkpoint = syncCheckpoints.getByConversation(conversation.id);
        if (checkpoint) {
          syncCheckpoints.advance({ conversationId: conversation.id, providerThreadId: threadId, lastSyncedTurnId: providerTurnId, timestamp: event.receivedAt });
        } else {
          syncCheckpoints.initialize({ conversationId: conversation.id, providerThreadId: threadId, baselineTurnId: providerTurnId, timestamp: event.receivedAt });
        }
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: threadId, providerModel: conversation.providerModel, providerState: 'active' });
        runStates.set(conversation.id, { type: 'active', turnId: providerTurnId, phase: 'prework' });
        if (!existingTurn) {
          broadcast = {
            type: 'conversation.turn.started',
            payload: {
              conversationId: conversation.id,
              projectId: conversation.projectId,
              providerThreadId: threadId,
              providerTurnId,
              ...(turn.clientSubmissionId ? { submissionId: turn.clientSubmissionId } : {}),
              status: 'running',
              startedAt: turn.startedAt ?? timestamp,
            },
          };
        }
      }
    } else if (event.method === 'turn/plan/updated' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      if (!providerTurnId) return;
      const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
      if (!turn) return;
      const plan = normalizeTurnPlan(params);
      options.turns.updatePlan(turn.id, plan, event.receivedAt);
      broadcast = {
        type: 'conversation.turn.plan.updated',
        payload: {
          conversationId: conversation.id,
          projectId: conversation.projectId,
          providerThreadId: threadId,
          providerTurnId,
          plan,
        },
      };
    } else if (event.method === 'turn/diff/updated' && conversation && threadId && options.changeSets) {
      const providerTurnId = providerTurnIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !turn || typeof params.diff !== 'string') return;
      options.changeSets.updateUnifiedDiff({
        conversation,
        turn,
        diff: params.diff,
        timestamp: event.receivedAt,
      });
    } else if (event.method === 'turn/completed' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      if (!providerTurnId) return;
      const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
      if (!turn) return;
      if (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') return;
      const terminalStatus = providerTurnTerminalStatus(params);
      const interrupted = terminalStatus === 'interrupted';
      const failed = terminalStatus === 'failed';
      const timestamp = event.receivedAt;
      const failure = failed ? providerTurnFailure(params, providerTurnId) : null;
      const turnItems = options.items.listByConversation(conversation.id).filter((item) => item.turnId === turn.id);
      const completedTurnItems = turnItems.filter((item) => item.status === 'completed');
      for (const streamedItem of turnItems.filter((item) => item.status === 'in_progress')) {
        const streamedText = streamedItem.textContent.trim();
        const supersedingItem =
          streamedText.length > 0
            ? completedTurnItems.find(
                (candidate) =>
                  candidate.itemType === streamedItem.itemType &&
                  candidate.phase === streamedItem.phase &&
                  candidate.updatedAt > streamedItem.updatedAt &&
                  candidate.textContent.trim().length > streamedText.length &&
                  candidate.textContent.trim().startsWith(streamedText),
              )
            : undefined;
        const streamedPayload = parseJsonRecord(streamedItem.payloadJson);
        const streamedPresentation = isRecord(streamedPayload.presentation) ? streamedPayload.presentation : {};
        const reconciledItem = options.items.upsertCompleted({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId: streamedItem.providerItemId,
          itemType: streamedItem.itemType,
          phase: streamedItem.phase,
          payload: supersedingItem
            ? {
                ...streamedPayload,
                presentation: {
                  ...streamedPresentation,
                  supersededBy: supersedingItem.providerItemId,
                },
              }
            : streamedPayload,
          textContent: supersedingItem ? '' : streamedItem.textContent,
          status: failed ? 'failed' : 'completed',
          startedAt: streamedItem.startedAt,
          completedAt: timestamp,
          updatedAt: timestamp,
        });
        options.broadcast('conversation.item.updated', {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId: reconciledItem.providerItemId,
          itemType: reconciledItem.itemType,
          itemPayload: parseJsonRecord(reconciledItem.payloadJson),
          textContent: reconciledItem.textContent,
          status: reconciledItem.status,
          phase: reconciledItem.phase,
        });
      }
      const terminalTurn = options.turns.upsert({
        ...turn,
        status: terminalStatus,
        ...(failure ? { error: providerTurnFailureRecord(params, failure) } : {}),
        completedAt: timestamp,
        updatedAt: timestamp,
      });
      options.changeSets?.seal({ conversation, turn, timestamp });
      const submissions = options.submissions.listByConversation(conversation.id);
      const terminalReconciliation = reconcileTerminalTurnSubmissions(conversation, terminalTurn, timestamp, failure ? providerTurnFailureRecord(params, failure) : undefined);
      const activeSubmission = terminalReconciliation.primarySubmission;
      const recoveryRequiredSubmissions = terminalReconciliation.recoveryRequired;
      for (const submission of recoveryRequiredSubmissions) {
        options.broadcast('conversation.submission.steering', {
          conversationId: conversation.id,
          submissionId: submission.id,
          providerThreadId: threadId,
          providerTurnId,
        });
      }
      if (!failed && !interrupted) createdPlanImplementationRequest = ensurePlanImplementationRequest(conversation.id, turn, activeSubmission, timestamp);
      if (failed) {
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required' });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      } else if (recoveryRequiredSubmissions.length > 0) {
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      } else if (interrupted) {
        const interruptedQueue = interruptedQueueSubmissions(submissions);
        for (const queued of interruptedQueue.filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
        const hasInterruptedQueue = interruptedQueue.length > 0;
        runStates.set(conversation.id, hasInterruptedQueue ? { type: 'paused', reason: 'interrupted' } : { type: 'idle' });
      } else {
        runStates.set(conversation.id, { type: 'idle' });
      }
      const hasInterruptedQueue = interrupted && interruptedQueueSubmissions(submissions).length > 0;
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId: threadId,
        providerModel: conversation.providerModel,
        providerState: failed ? 'failed' : recoveryRequiredSubmissions.length > 0 || (interrupted && hasInterruptedQueue) ? 'paused' : 'ready',
      });
      const ephemeral = contexts.get(conversation.id)?.ephemeral === true;
      const conversationGoal = goals.get(conversation.id);
      if (!ephemeral && !conversationGoal) {
        options.conversations.markAttentionUnread(conversation.id, {
          kind: failed ? 'failed' : interrupted ? 'interrupted' : 'completed',
          turnId: providerTurnId,
          occurredAt: timestamp,
        });
      }
      const resultKey = `${conversation.id}:${providerTurnId}`;
      if (failure) {
        failedTurnResults.set(resultKey, failure);
        rejectTurnResultWaiters(resultKey, failure);
      } else {
        const refreshed = options.conversations.getById(conversation.id);
        const answer = [...(refreshed?.messages ?? [])].reverse().find((message) => message.providerTurnId === providerTurnId && message.role === 'assistant')?.content ?? '';
        const result: NativeTurnResult = {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          status: interrupted ? 'interrupted' : 'completed',
          answer,
        };
        completedTurnResults.set(resultKey, result);
        for (const waiter of turnResultWaiters.get(resultKey) ?? []) {
          clearTimeout(waiter.timer);
          waiter.resolve(result);
        }
        turnResultWaiters.delete(resultKey);
      }
      if (ephemeral) {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: threadId,
          providerModel: conversation.providerModel,
          providerState: 'closed',
        });
        runStates.delete(conversation.id);
        contexts.delete(conversation.id);
      }
      broadcast = {
        type: 'conversation.turn.completed',
        payload: {
          conversationId: conversation.id,
          projectId: conversation.projectId,
          providerThreadId: threadId,
          providerTurnId,
          status: terminalStatus,
          completedAt: timestamp,
          hasUnreadAttention: options.conversations.getById(conversation.id)?.attentionUnread === true,
          notificationEligible: !conversationGoal,
        },
      };
      queueChangedAfterTurn = interrupted || recoveryRequiredSubmissions.length > 0;
      drainAfterTurn = !failed && !interrupted && recoveryRequiredSubmissions.length === 0 && conversationGoal?.status !== 'active';
    } else if (event.method === 'item/started' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const itemPayload = isRecord(params.item) ? params.item : {};
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn) return;
      const presentedItemPayload = sanitizeConversationItemPayload(itemPayload.type === 'userMessage' ? { ...itemPayload, ...submissionPresentation(conversation.id, turn, itemPayload) } : itemPayload);
      const itemType = itemTypeFromValue(itemPayload.type);
      const userMessageProjection = itemType === 'userMessage' ? projectProviderUserMessage(conversation, turn, presentedItemPayload, itemText(itemPayload), providerItemId) : null;
      if (itemType === 'userMessage' && !userMessageProjection) return;
      const item = userMessageProjection
        ? options.items.upsertProgress({
            conversationId: conversation.id,
            turnId: turn.id,
            providerThreadId: threadId,
            providerTurnId,
            providerItemId,
            itemType,
            phase: phaseFromItem(itemPayload),
            payload: presentedItemPayload,
            textContent: userMessageProjection.content,
            startedAt: event.receivedAt,
            updatedAt: event.receivedAt,
          })
        : options.items.appendDelta({
            conversationId: conversation.id,
            turnId: turn.id,
            providerThreadId: threadId,
            providerTurnId,
            providerItemId,
            itemType,
            phase: phaseFromItem(itemPayload),
            payload: presentedItemPayload,
            delta: '',
            startedAt: event.receivedAt,
            updatedAt: event.receivedAt,
          });
      if (item.itemType === 'fileChange') {
        options.changeSets?.capture({
          conversation,
          turn,
          providerItemId,
          changes: itemPayload.changes,
          phase: 'pre',
          timestamp: event.receivedAt,
        });
      }
      const durableClientMessageId =
        item.itemType === 'userMessage' && userMessageProjection ? persistProviderUserMessage(conversation, presentedItemPayload, userMessageProjection, providerTurnId, threadId, providerItemId, event.receivedAt) : null;
      const itemResources = syncItemResources(conversation, turn, item, presentedItemPayload, item.textContent, event.receivedAt);
      broadcast = {
        type: 'conversation.item.started',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: { ...parseJsonRecord(item.payloadJson), ...(item.itemType === 'userMessage' ? { clientId: durableClientMessageId } : {}) },
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
          itemResources,
        },
      };
    } else if (event.method === 'item/fileChange/patchUpdated' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn || !Array.isArray(params.changes)) return;
      const existing = options.items.getByProvider(threadId, providerItemId);
      const item = options.items.appendDelta({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: 'fileChange',
        phase: 'prework',
        payload: { ...(existing ? parseJsonRecord(existing.payloadJson) : {}), ...params, changes: params.changes },
        delta: '',
        startedAt: existing?.startedAt ?? event.receivedAt,
        updatedAt: event.receivedAt,
      });
      options.changeSets?.capture({
        conversation,
        turn,
        providerItemId,
        changes: params.changes,
        phase: 'pre',
        timestamp: event.receivedAt,
      });
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: parseJsonRecord(item.payloadJson),
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if ((event.method === 'item/reasoning/summaryTextDelta' || event.method === 'item/reasoning/summaryPartAdded') && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      const summaryIndex = integerValue(params.summaryIndex);
      if (!providerTurnId || !providerItemId || !turn || summaryIndex === null || (event.method === 'item/reasoning/summaryTextDelta' && typeof params.delta !== 'string')) return;
      const existing = options.items.getByProvider(threadId, providerItemId);
      const projection = reasoningSummaryProjection(existing, params, summaryIndex);
      const item = options.items.upsertProgress({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: 'reasoning',
        phase: 'prework',
        payload: projection.payload,
        textContent: projection.textContent,
        startedAt: existing?.startedAt ?? event.receivedAt,
        updatedAt: event.receivedAt,
      });
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: parseJsonRecord(item.payloadJson),
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (event.method === 'item/commandExecution/outputDelta' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn || typeof params.delta !== 'string') return;
      const existing = options.items.getByProvider(threadId, providerItemId);
      const projection = liveProgressProjection(existing, 'command_output', params.delta, true);
      const item = options.items.upsertProgress({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: 'commandExecution',
        phase: 'prework',
        payload: projection.payload,
        textContent: existing?.textContent ?? '',
        startedAt: existing?.startedAt ?? event.receivedAt,
        updatedAt: event.receivedAt,
      });
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: parseJsonRecord(item.payloadJson),
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (event.method === 'item/mcpToolCall/progress' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn || typeof params.message !== 'string') return;
      const existing = options.items.getByProvider(threadId, providerItemId);
      const projection = liveProgressProjection(existing, 'tool_progress', params.message, false);
      const item = options.items.upsertProgress({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: 'mcpToolCall',
        phase: 'prework',
        payload: projection.payload,
        textContent: existing?.textContent ?? '',
        startedAt: existing?.startedAt ?? event.receivedAt,
        updatedAt: event.receivedAt,
      });
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: parseJsonRecord(item.payloadJson),
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (isReadableItemTextDeltaEvent(event.method) && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn || typeof params.delta !== 'string') return;
      const item = options.items.appendDelta({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: itemTypeFromMethod(event.method),
        phase: 'prework',
        payload: params,
        delta: params.delta,
        updatedAt: event.receivedAt,
      });
      // 目标存在期间，普通中间回复只更新会话进度；关注状态只由目标关键终态统一产生。
      if (event.method === 'item/agentMessage/delta' && params.delta.trim() && !goals.get(conversation.id)) {
        const previousRevision = options.conversations.getById(conversation.id)?.attentionRevision ?? 0;
        const attention = options.conversations.markAttentionUnread(conversation.id, {
          kind: 'unread',
          turnId: providerTurnId,
          occurredAt: event.receivedAt,
        });
        if (attention.attentionRevision !== previousRevision) {
          options.broadcast('conversation.attention.changed', {
            conversationId: conversation.id,
            providerThreadId: threadId,
            providerTurnId,
            attentionKind: attention.attentionKind,
            attentionRevision: attention.attentionRevision,
          });
        }
      }
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: parseJsonRecord(item.payloadJson),
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (event.method === 'item/completed' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const itemPayload = isRecord(params.item) ? params.item : {};
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn) return;
      const presentedItemPayload = sanitizeConversationItemPayload(itemPayload.type === 'userMessage' ? { ...itemPayload, ...submissionPresentation(conversation.id, turn, itemPayload) } : itemPayload);
      const itemType = itemTypeFromValue(itemPayload.type);
      const existing = options.items.getByProvider(threadId, providerItemId);
      const userMessageProjection = itemType === 'userMessage' ? projectProviderUserMessage(conversation, turn, presentedItemPayload, itemText(itemPayload), providerItemId) : null;
      if (itemType === 'userMessage' && !userMessageProjection) return;
      const completedProjection = userMessageProjection
        ? { ...completedItemProjection(existing, presentedItemPayload, itemType), textContent: userMessageProjection.content }
        : completedItemProjection(existing, presentedItemPayload, itemType);
      const item = options.items.upsertCompleted({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType,
        phase: phaseFromItem(itemPayload),
        payload: completedProjection.payload,
        textContent: completedProjection.textContent,
        status: itemPayload.status === 'failed' ? 'failed' : 'completed',
        startedAt: typeof itemPayload.startedAt === 'string' ? itemPayload.startedAt : null,
        completedAt: event.receivedAt,
        updatedAt: event.receivedAt,
      });
      let durableClientMessageId: string | null = null;
      if (item.itemType === 'userMessage' && userMessageProjection) {
        durableClientMessageId = persistProviderUserMessage(conversation, presentedItemPayload, userMessageProjection, providerTurnId, threadId, providerItemId, event.receivedAt);
      } else if (item.itemType === 'agentMessage') {
        options.conversations.appendMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: item.textContent,
          source: 'codex_native',
          metadata: { phase: item.phase },
          createdAt: event.receivedAt,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
        });
        if (item.textContent.trim() && !goals.get(conversation.id)) {
          const previousRevision = options.conversations.getById(conversation.id)?.attentionRevision ?? 0;
          const attention = options.conversations.markAttentionUnread(conversation.id, {
            kind: 'unread',
            turnId: providerTurnId,
            occurredAt: event.receivedAt,
          });
          if (attention.attentionRevision !== previousRevision) {
            options.broadcast('conversation.attention.changed', {
              conversationId: conversation.id,
              providerThreadId: threadId,
              providerTurnId,
              attentionKind: attention.attentionKind,
              attentionRevision: attention.attentionRevision,
            });
          }
        }
      }
      if (item.itemType === 'fileChange') {
        options.changeSets?.capture({
          conversation,
          turn,
          providerItemId,
          changes: itemPayload.changes,
          phase: 'post',
          timestamp: event.receivedAt,
        });
      }
      if (item.phase === 'final_answer') runStates.set(conversation.id, { type: 'active', turnId: providerTurnId, phase: 'final_answer' });
      const itemResources = syncItemResources(conversation, turn, item, presentedItemPayload, item.textContent, event.receivedAt);
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: { ...parseJsonRecord(item.payloadJson), ...(item.itemType === 'userMessage' ? { clientId: durableClientMessageId } : {}) },
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
          itemResources,
        },
      };
    } else if (event.method === 'thread/settings/updated' && conversation) {
      const settings = isRecord(params.threadSettings) ? params.threadSettings : params;
      const snapshot = {
        generationId: event.generationId,
        sequence: event.sequence,
        model: requireString(settings.model, 'provider settings model'),
        ...(typeof settings.effort === 'string' ? { effort: settings.effort } : {}),
        ...(Object.prototype.hasOwnProperty.call(settings, 'serviceTier') && (settings.serviceTier === null || typeof settings.serviceTier === 'string') ? { serviceTier: settings.serviceTier } : {}),
      };
      options.conversations.upsertProviderSettingsSnapshot(conversation.id, snapshot);
      broadcast = { type: 'conversation.provider.settings.updated', payload: { conversationId: conversation.id, ...snapshot } };
    } else if (event.method === 'thread/tokenUsage/updated' && conversation) {
      const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : params;
      const total = tokenUsageBreakdown(isRecord(tokenUsage.total) ? tokenUsage.total : tokenUsage);
      const last = tokenUsageBreakdown(isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage);
      const providerTurnId = requireString(providerTurnIdFrom(params), 'provider turn id');
      const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
      const submission = turn?.clientSubmissionId ? options.submissions.getById(turn.clientSubmissionId) : undefined;
      let context: ConversationDispatchContext | null = null;
      if (submission) {
        try {
          context = contextFromSubmission(submission);
        } catch {
          context = null;
        }
      }
      const settings = options.conversations.getProviderSettingsSnapshot(conversation.id);
      const model = context?.model ?? settings?.model ?? conversation.providerModel;
      if (!model) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Token usage event cannot resolve its model.');
      const modelContextWindow = tokenUsage.modelContextWindow === null || tokenUsage.modelContextWindow === undefined ? null : requireNumber(tokenUsage.modelContextWindow, 'modelContextWindow');
      const snapshot: NativeTokenUsageSnapshot = options.usage
        ? await options.usage.recordTurn({
            generationId: event.generationId,
            sequence: event.sequence,
            projectId: conversation.projectId,
            conversationId: conversation.id,
            providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
            providerTurnId,
            model,
            serviceTier: context?.serviceTier ?? settings?.serviceTier ?? null,
            total,
            last,
            modelContextWindow,
            occurredAt: turn?.completedAt ?? event.receivedAt,
          })
        : {
            generationId: event.generationId,
            sequence: event.sequence,
            total,
            last,
            modelContextWindow,
            cacheHitRate: calculateCacheHitRate(total),
            estimatedCredits: null,
            apiEquivalentUsd: null,
            cacheSavingsUsd: null,
            priceCoverage: null,
            pricingCatalogDate: null,
            pricingSourceUrls: [],
            historyComplete: false,
          };
      options.conversations.upsertProviderTokenUsageSnapshot(conversation.id, snapshot);
      broadcast = { type: 'conversation.provider.token_usage.updated', payload: { conversationId: conversation.id, ...snapshot } };
    } else if (event.method === 'account/rateLimits/updated') {
      // 官方协议明确这是稀疏更新；只把它当作重读信号，不用不完整包覆盖快照。
      options.usage?.handleSparseRateLimitUpdate();
    } else if (event.method === 'account/updated') {
      options.usage?.handleAccountChanged();
    } else if (event.method === 'mcpServer/startupStatus/updated') {
      const legacyStatuses = isRecord(params.statuses) ? normalizeMcpStartupStatusMap(params.statuses) : null;
      const currentStatus = legacyStatuses ? null : normalizeSingleMcpStartupStatus(params);
      const currentSnapshot = options.settings.getCodexMcpStartupStatusSnapshot();
      const value = legacyStatuses ?? Object.fromEntries([...(currentSnapshot?.generationId === event.generationId ? Object.entries(currentSnapshot.value) : []), [currentStatus!.serverId, currentStatus!.state]]);
      const snapshot = { generationId: event.generationId, sequence: event.sequence, value };
      const stored = options.settings.upsertCodexMcpStartupStatusSnapshot(snapshot);
      if (stored?.generationId === snapshot.generationId && stored.sequence === snapshot.sequence) {
        broadcast = { type: 'codex.mcp_startup_status.updated', payload: snapshot };
      }
    } else if (event.requestId !== undefined && conversation && threadId) {
      const requestKind = requestKindFromMethod(event.method);
      if (requestKind) {
        const providerTurnId = providerTurnIdFrom(params);
        const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
        const request = options.requests.upsert({
          conversationId: conversation.id,
          turnId: turn?.id,
          ...(typeof params.itemId === 'string' && params.itemId.trim() ? { itemId: params.itemId } : {}),
          transportGenerationId: event.generationId,
          providerRequestId: event.requestId,
          requestKind,
          payload: params,
          status: 'pending',
          containsSecret: requestKind === 'request_user_input' && hasSecretQuestion(params),
          ...(requestKind === 'request_user_input' && typeof params.autoResolutionMs === 'number' && Number.isFinite(params.autoResolutionMs) && params.autoResolutionMs >= 0
            ? {
                expiresAt: new Date(Date.parse(event.receivedAt) + params.autoResolutionMs).toISOString(),
                autoResolutionState: 'scheduled' as const,
              }
            : {}),
          createdAt: event.receivedAt,
        });
        const currentGenerationId = readyGenerationId();
        const canonicalRui = requestKind === 'request_user_input' ? parseCanonicalRequestUserInputQuestions(params) : null;
        if (canonicalRui && !canonicalRui.ok) {
          const recoveryError = await failInvalidInteractionAuthority({
            conversation,
            threadId,
            providerTurnId,
            turn,
            request,
            error: {
              error: 'ZEUS_CODEX_REQUEST_USER_INPUT_ENVELOPE_INVALID',
              message: canonicalRui.message,
              recoveryRequired: false,
              generationId: event.generationId,
              providerRequestId: event.requestId,
            },
            timestamp: event.receivedAt,
          });
          broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
        } else if (!options.manager.hasGeneration(event.generationId)) {
          const recoveryError = {
            error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
            message: 'The provider request arrived from a retired app-server generation and cannot become interaction authority.',
            recoveryRequired: true,
            requestGenerationId: event.generationId,
            currentGenerationId,
          };
          if (request.status === 'pending') options.requests.fail(request.id, { error: recoveryError, resolvedAt: event.receivedAt });
          broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
        } else if (request.status === 'resolved') {
          const replay = replayResolvedRequest(request, event.requestId);
          if (replay) {
            await options.manager.respondToServerRequest(replay);
          } else if (request.containsSecret) {
            const recoveryError: Record<string, unknown> = {
              error: 'ZEUS_CODEX_SECRET_REQUEST_REPLAY_UNAVAILABLE',
              message: 'A resolved secret request was delivered again, but its redacted answer cannot be replayed safely.',
              recoveryRequired: true,
              generationId: event.generationId,
              providerRequestId: event.requestId,
            };
            if (providerTurnId && conversation.providerThreadId) {
              try {
                await options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId });
              } catch (error) {
                recoveryError.interruptError = serializeError(error);
              }
            }
            options.requests.fail(request.id, { error: recoveryError, resolvedAt: event.receivedAt });
            if (turn) {
              options.turns.upsert({ ...turn, status: 'paused', error: recoveryError, updatedAt: event.receivedAt });
              const submission = options.submissions.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
              if (submission && (submission.status === 'active' || submission.status === 'dispatching')) {
                options.submissions.updateStatus(submission.id, 'paused', {
                  providerTurnId,
                  pausedReason: 'recovery_required',
                  error: recoveryError,
                  updatedAt: event.receivedAt,
                });
              }
            }
            options.conversations.bindProvider(conversation.id, {
              providerId: 'codex',
              providerThreadId: threadId,
              providerModel: conversation.providerModel,
              providerState: 'paused',
            });
            runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
            broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
          }
        } else if (request.status === 'pending') {
          const sessionFileEditGrantApplies =
            requestKind === 'file' &&
            options.conversations.hasSessionFileEditGrant(conversation.id) &&
            hasAuditableFileApprovalTarget(params, conversation, contexts.get(conversation.id) ?? contextFromConversation(conversation), options.items);
          let automaticallyApproved = false;
          if (sessionFileEditGrantApplies) {
            try {
              await respondToRequest({ requestId: request.id, response: { type: 'file', decision: 'accept' } });
              automaticallyApproved = true;
            } catch {
              // Provider 拒绝自动答复时保留真实待授权弹窗，禁止伪造已允许状态。
            }
          }
          if (!automaticallyApproved && !goals.get(conversation.id)) {
            options.conversations.markAttentionUnread(conversation.id, {
              kind: 'unread',
              turnId: providerTurnId,
              occurredAt: event.receivedAt,
            });
          }
          if (!automaticallyApproved && providerTurnId && turn) {
            options.turns.upsert({ ...turn, status: 'waiting', updatedAt: event.receivedAt });
            options.conversations.bindProvider(conversation.id, {
              providerId: 'codex',
              providerThreadId: threadId,
              providerModel: conversation.providerModel,
              providerState: 'waiting',
            });
            runStates.set(conversation.id, { type: 'waiting', turnId: providerTurnId, requestId: request.id, reason: requestKind === 'request_user_input' ? 'user_input' : 'approval' });
          }
          if (!automaticallyApproved) {
            broadcast = {
              type: 'conversation.request.created',
              payload: {
                conversationId: conversation.id,
                requestId: request.id,
                requestKind,
                providerTurnId,
                request: nativePendingRequestProjection(request),
                notificationEligible: !goals.get(conversation.id),
              },
            };
            scheduleAutoResolution(request);
          }
        }
      }
    }

    for (const receiptEvent of receiptEvents) {
      const receiptIdentity = eventIdentity(receiptEvent);
      receipts.record(providerEventReceipt(receiptEvent, receiptIdentity));
      maintainProviderReceiptGenerations(receiptEvent.generationId);
      rememberProcessedProviderEvent(receiptEvent, receiptIdentity);
    }
    if (requiresImmediatePersist(event, createdPlanImplementationRequest)) {
      scheduledPersistDirty = true;
      await flushScheduledPersist();
    } else {
      schedulePersist();
    }
    if (broadcast) {
      options.broadcast(broadcast.type, {
        ...broadcast.payload,
        generationId: event.generationId,
        sequence: event.sequence,
      });
    }
    if (queueChangedAfterTurn && conversation) {
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId,
      });
    }
    if (createdPlanImplementationRequest) {
      options.broadcast('conversation.plan_implementation_request.changed', {
        conversationId: createdPlanImplementationRequest.conversationId,
        requestId: createdPlanImplementationRequest.id,
        status: createdPlanImplementationRequest.status,
        turnId: createdPlanImplementationRequest.turnId,
        planItemId: createdPlanImplementationRequest.planItemId,
      });
    }
    if (drainAfterTurn && conversation) await drainQueuedSubmissions();
  }

  function persistThreadProviderSettings(conversationId: string, thread: CodexThreadSnapshot): void {
    const providerThreadPath = threadPath(thread);
    if (providerThreadPath) {
      options.conversations.updateProviderThreadPath(conversationId, {
        providerThreadId: thread.id,
        providerThreadPath,
      });
    }
    const settings = thread.providerSettings;
    if (!settings) return;
    options.conversations.upsertProviderSettingsSnapshot(conversationId, {
      generationId: settings.generationId,
      sequence: settings.sequence,
      model: settings.model,
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(settings, 'serviceTier') ? { serviceTier: settings.serviceTier } : {}),
    });
  }

  async function safelyHandleProviderEventError(event: CodexAppServerEvent, error: unknown, receiptEvents: readonly CodexAppServerEvent[] = [event]): Promise<void> {
    try {
      const params = isRecord(event.params) ? event.params : {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : null;
      const conversation = threadId ? options.conversations.getByProviderThreadId(threadId) : undefined;
      const serialized = serializeError(error);
      const errorEntry = {
        generationId: event.generationId,
        sequence: event.sequence,
        method: event.method,
        receivedAt: event.receivedAt,
        error: serialized,
        ...(conversation ? { conversationId: conversation.id } : {}),
        ...(threadId ? { providerThreadId: threadId } : {}),
      };
      const currentErrors = options.settings.getJson<Array<typeof errorEntry>>(providerEventErrorsSettingKey) ?? [];
      options.settings.setJson(providerEventErrorsSettingKey, [...currentErrors, errorEntry].slice(-1_000));
      if (conversation && threadId) {
        const providerTurnId = providerTurnIdFrom(params) ?? [...options.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting')?.providerTurnId ?? null;
        const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
        if (providerTurnId && turn) {
          options.items.upsertCompleted({
            conversationId: conversation.id,
            turnId: turn.id,
            providerThreadId: threadId,
            providerTurnId,
            providerItemId: `native-provider-event-error-${event.generationId}-${event.sequence}`,
            itemType: 'error',
            phase: 'prework',
            payload: errorEntry,
            textContent: `${serialized.code ? `${serialized.code}: ` : ''}${serialized.message}`,
            status: 'failed',
            completedAt: event.receivedAt,
            updatedAt: event.receivedAt,
          });
        }
      }
      for (const receiptEvent of receiptEvents) {
        const identity = eventIdentity(receiptEvent);
        receipts.record(providerEventReceipt(receiptEvent, identity));
        maintainProviderReceiptGenerations(receiptEvent.generationId);
        rememberProcessedProviderEvent(receiptEvent, identity);
      }
      await persist();
      options.broadcast(conversation ? 'conversation.native.error' : 'codex.native.error', errorEntry);
    } catch (diagnosticError) {
      try {
        options.broadcast('codex.native.error', {
          generationId: event.generationId,
          sequence: event.sequence,
          method: event.method,
          error: serializeError(error),
          diagnosticError: serializeError(diagnosticError),
        });
      } catch {
        // Provider 监听器异常不得污染 manager 的后续事件链。
      }
    }
  }

  function hasProcessedProviderEvent(event: CodexAppServerEvent, identity: string): boolean {
    if (hotReceiptGenerationId === event.generationId && hotReceiptIdentities.has(identity)) return true;
    if (!receipts.has(identity)) return false;
    rememberProcessedProviderEvent(event, identity);
    return true;
  }

  function rememberProcessedProviderEvent(event: CodexAppServerEvent, identity: string): void {
    if (hotReceiptGenerationId !== event.generationId) {
      hotReceiptGenerationId = event.generationId;
      hotReceiptIdentities.clear();
    }
    hotReceiptIdentities.add(identity);
    while (hotReceiptIdentities.size > providerEventHotReceiptLimit) {
      const oldestIdentity = hotReceiptIdentities.values().next().value;
      if (typeof oldestIdentity !== 'string') break;
      hotReceiptIdentities.delete(oldestIdentity);
    }
  }

  function maintainProviderReceiptGenerations(generationId: string): void {
    if (maintainedReceiptGenerations.has(generationId)) return;
    maintainedReceiptGenerations.add(generationId);
    const retiredGenerationIds = receipts.listGenerationIds().filter((candidate) => candidate !== generationId && !options.manager.hasGeneration(candidate));
    receipts.deleteGenerations(retiredGenerationIds);
  }

  function beginHandoff(waiterError: Error): Promise<void> {
    if (handoffPromise) return handoffPromise;
    closing = true;
    for (const requestId of [...autoResolutionTimers.keys()]) clearAutoResolutionTimer(requestId);
    unsubscribe();
    flushReadableDeltas();
    // unsubscribe 后冻结已接收链；这些 handler 仍可完整持久化和广播，closed 只能在 drain 之后设置。
    const acceptedProviderEventChain = providerEventChain;
    const activeQueueDrain = queueDrainPromise;
    handoffPromise = (async () => {
      await Promise.all([acceptedProviderEventChain, activeQueueDrain]);
      await flushScheduledPersist();
      closed = true;
      for (const key of [...turnResultWaiters.keys()]) rejectTurnResultWaiters(key, waiterError);
    })();
    return handoffPromise;
  }

  return {
    startTaskConversation,
    startProjectConversation,
    startEphemeralConversation,
    waitForTurnResult,
    submitMessage,
    steerMessage,
    editQueuedSubmission,
    deleteQueuedSubmission,
    reorderQueue,
    sendQueuedNow,
    resumeInterruptedQueue,
    recoverQueue,
    archiveConversation,
    restoreArchivedConversation,
    interruptTurn,
    respondToRequest,
    snoozeRequest,
    respondToPlanImplementationRequest,
    reconcilePersistedTerminalSubmissions,
    setGoal,
    readGoal,
    pauseGoal,
    resumeGoal,
    clearGoal,
    recover,
    capacityChanged,
    close(input = { mode: 'final' }) {
      if (input.mode === 'handoff') {
        if (finalizationPromise) return finalizationPromise;
        return beginHandoff(coordinatorError('ZEUS_CODEX_SERVER_RESTARTING', 'The local server is restarting; retry the Graph request after reconnecting.'));
      }
      if (finalizationPromise) return finalizationPromise;
      finalizationPromise = (async () => {
        const error = coordinatorError('ZEUS_CODEX_COORDINATOR_CLOSED', 'Codex native conversation coordinator is closed.');
        for (const requestId of [...autoResolutionTimers.keys()]) clearAutoResolutionTimer(requestId);
        await beginHandoff(error);
        const interrupts: Promise<void>[] = [];
        const interruptedTurns = new Set<string>();
        // Ephemeral terminalization moves providerState to closed, so snapshot bound conversations before that transition.
        const nativeBoundConversations = options.conversations.listNativeBound('codex');

        for (const [conversationId, context] of [...contexts]) {
          if (!context.ephemeral) continue;
          const conversation = options.conversations.getById(conversationId);
          if (!conversation) continue;
          const state = runStates.get(conversationId);
          const providerTurnId = state?.type === 'active' || state?.type === 'waiting' ? state.turnId : null;
          markEphemeralConversationClosed(conversationId, providerTurnId, 'failed', serializeError(error));
          if (providerTurnId && conversation.providerThreadId) {
            const interruptKey = `${conversation.providerThreadId}\0${providerTurnId}`;
            if (interruptedTurns.has(interruptKey)) continue;
            interruptedTurns.add(interruptKey);
            try {
              interrupts.push(
                options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId }).catch((interruptError) => {
                  options.broadcast('conversation.native.ephemeral_interrupt_failed', {
                    conversationId,
                    providerThreadId: conversation.providerThreadId,
                    providerTurnId,
                    error: serializeError(interruptError),
                  });
                }),
              );
            } catch (interruptError) {
              options.broadcast('conversation.native.ephemeral_interrupt_failed', {
                conversationId,
                providerThreadId: conversation.providerThreadId,
                providerTurnId,
                error: serializeError(interruptError),
              });
            }
          }
        }
        for (const key of [...turnResultWaiters.keys()]) rejectTurnResultWaiters(key, error);

        for (const conversation of nativeBoundConversations) {
          for (const request of options.requests.listByConversation(conversation.id)) {
            if (request.status !== 'pending') continue;
            const providerRequestId = JSON.parse(request.providerRequestIdJson) as string | number;
            if (request.requestKind === 'command' || request.requestKind === 'file') {
              const response = {
                type: request.requestKind,
                decision: 'cancel',
                generationId: request.transportGenerationId,
                requestId: providerRequestId,
              } as CodexServerRequestResponse;
              try {
                await options.manager.respondToServerRequest(response);
                options.requests.resolve(request.id, {
                  response: { type: request.requestKind, decision: 'cancel' },
                  resolvedAt: now(),
                });
              } catch (cancelError) {
                options.requests.fail(request.id, {
                  error: {
                    error: 'ZEUS_CODEX_SHUTDOWN_CANCEL_FAILED',
                    message: 'Pending Codex approval could not be cancelled during shutdown.',
                    cause: serializeError(cancelError),
                  },
                  resolvedAt: now(),
                });
              }
              continue;
            }

            options.requests.fail(request.id, {
              error: {
                error: 'ZEUS_CODEX_SHUTDOWN_INTERRUPTED',
                message: 'The unresolved Codex request was interrupted during shutdown.',
                requestKind: request.requestKind,
              },
              resolvedAt: now(),
            });
            const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
            if (!turn?.providerTurnId || !conversation.providerThreadId) continue;
            const interruptKey = `${conversation.providerThreadId}\0${turn.providerTurnId}`;
            if (interruptedTurns.has(interruptKey)) continue;
            interruptedTurns.add(interruptKey);
            interrupts.push(
              options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: turn.providerTurnId }).catch((interruptError) => {
                options.broadcast('conversation.native.shutdown_interrupt_failed', {
                  conversationId: conversation.id,
                  providerThreadId: conversation.providerThreadId,
                  providerTurnId: turn.providerTurnId,
                  error: serializeError(interruptError),
                });
              }),
            );
          }
        }
        await persist();
        await Promise.all(interrupts);
      })();
      return finalizationPromise;
    },
  };

  function requireConversation(conversationId: string): ZeusConversationWithMessagesRecord {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.transportKind !== 'codex_native' || conversation.agentKind !== 'codex') {
      throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Codex native conversation was not found.');
    }
    return conversation;
  }

  function requireOwnedSubmission(conversationId: string, submissionId: string): ZeusConversationSubmissionRecord {
    const submission = options.submissions.getById(submissionId);
    if (!submission || submission.conversationId !== conversationId) throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_FOUND', 'Native submission was not found.');
    return submission;
  }

  function accepted(submission: ZeusConversationSubmissionRecord, status: NativeAcceptedOperation['status'], providerThreadId: string | null, providerTurnId: string | null): NativeAcceptedOperation {
    return { operationId: operationId(), conversationId: submission.conversationId, submissionId: submission.id, status, providerThreadId, providerTurnId };
  }
}

function providerPermissionProfile(context: ConversationDispatchContext): { sandbox: CodexSandboxPolicy; approvalPolicy: 'on-request' | 'never'; approvalsReviewer: 'user' } {
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

function stripRequestTransport(response: CodexServerRequestResponse): RespondNativeRequestInput['response'] {
  const effectiveResponse = { ...response } as Record<string, unknown>;
  delete effectiveResponse.generationId;
  delete effectiveResponse.requestId;
  return effectiveResponse as RespondNativeRequestInput['response'];
}

function nativePendingRequestProjection(request: ZeusConversationServerRequestRecord): Record<string, unknown> {
  return {
    id: request.id,
    conversationId: request.conversationId,
    turnId: request.turnId,
    itemId: request.itemId,
    generationId: request.transportGenerationId,
    type: request.requestKind === 'request_user_input' ? 'userInput' : request.requestKind === 'mcp' ? 'MCP' : request.requestKind,
    status: request.status,
    payload: parseJsonRecord(request.payloadJson),
    response: request.responseJson ? parseJsonRecord(request.responseJson) : null,
    containsSecret: request.containsSecret,
    expiresAt: request.expiresAt,
    autoResolutionState: request.autoResolutionState,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
  };
}

function buildInteractionRecoveryContinuation(request: ZeusConversationServerRequestRecord, response: RespondNativeRequestInput['response'], privacyNote?: string): string {
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

function buildInteractionRecoveryDisplayText(request: ZeusConversationServerRequestRecord, response: RespondNativeRequestInput['response']): string {
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

function replayResolvedRequest(request: NonNullable<ReturnType<ConversationServerRequestRepository['getById']>>, providerRequestId: string | number): CodexServerRequestResponse | null {
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

function developerInstructionsFor(context: ConversationDispatchContext, browserToolsAvailable: boolean): string {
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

function permissionModeFromValue(value: unknown, fallback: ConversationPermissionMode): ConversationPermissionMode {
  return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : fallback;
}

function eventIdentity(event: CodexAppServerEvent): string {
  const params = isRecord(event.params) ? event.params : {};
  return [event.generationId, event.sequence, event.method, params.threadId ?? '', providerTurnIdFrom(params) ?? '', providerItemIdFrom(params) ?? '', event.requestId ?? ''].join('|');
}

function providerEventReceipt(event: CodexAppServerEvent, identity: string): ProviderEventReceiptInput {
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

function providerTurnIdFrom(params: Record<string, unknown>): string | null {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof params.turnId === 'string' ? params.turnId : typeof turn.id === 'string' ? turn.id : null;
}

function providerTurnUserClientId(turn: Record<string, unknown>): string | null {
  if (!Array.isArray(turn.items)) return null;
  for (const candidate of turn.items) {
    if (!isRecord(candidate) || candidate.type !== 'userMessage') continue;
    if (typeof candidate.clientId === 'string' && candidate.clientId.trim()) return candidate.clientId;
  }
  return null;
}

function providerTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return new Date(value * 1_000).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function providerTurnStatus(params: Record<string, unknown>): string {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof turn.status === 'string' ? turn.status : typeof params.status === 'string' ? params.status : 'unknown';
}

function providerTurnTerminalStatus(params: Record<string, unknown>): 'completed' | 'interrupted' | 'failed' {
  const status = providerTurnStatus(params);
  return status === 'completed' || status === 'interrupted' || status === 'failed' ? status : 'failed';
}

function normalizeTurnPlan(params: Record<string, unknown>): {
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

function providerTurnFailure(params: Record<string, unknown>, providerTurnId: string): Error & { code: string } {
  const turn = isRecord(params.turn) ? params.turn : {};
  const providerError = isRecord(turn.error) ? turn.error : isRecord(params.error) ? params.error : null;
  const providerStatus = providerTurnStatus(params);
  const message =
    typeof providerError?.message === 'string' && providerError.message.trim() ? providerError.message : providerStatus === 'failed' ? 'Codex provider turn failed.' : `Codex provider emitted unsupported terminal status: ${providerStatus}.`;
  return Object.assign(coordinatorError('ZEUS_CODEX_TURN_FAILED', message), { providerTurnId, providerStatus });
}

function providerTurnFailureRecord(params: Record<string, unknown>, failure: Error & { code: string }): Record<string, unknown> {
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

function failedTurnErrorFromRecord(turn: ZeusConversationTurnRecord): Error & { code: string } {
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

function findSnapshotTurn(snapshot: CodexThreadSnapshot, submission: ZeusConversationSubmissionRecord): Record<string, unknown> | null {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  if (submission.providerTurnId) {
    const byProviderId = turns.find((turn) => turn.id === submission.providerTurnId);
    if (byProviderId) return byProviderId;
  }
  return turns.find((turn) => turn.clientUserMessageId === submission.clientMessageId || turn.clientMessageId === submission.clientMessageId) ?? null;
}

function snapshotConfirmsIdleProviderThread(snapshot: CodexThreadSnapshot): boolean {
  const snapshotTurns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  return snapshotTurns.every((turn) => {
    const classification = classifySnapshotTurn(turn);
    return classification === 'completed' || classification === 'interrupted' || classification === 'failed';
  });
}

function snapshotConfirmsSafeResumeBoundary(snapshot: CodexThreadSnapshot, localTurns: readonly ZeusConversationTurnRecord[]): boolean {
  const snapshotTurns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  const terminalLocalIds = new Set(localTurns.filter((turn) => turn.providerTurnId && (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed')).map((turn) => turn.providerTurnId as string));
  if (terminalLocalIds.size === 0) return snapshotTurns.length === 0;
  return snapshotTurns.some((turn) => typeof turn.id === 'string' && terminalLocalIds.has(turn.id) && ['completed', 'interrupted', 'failed'].includes(classifySnapshotTurn(turn)));
}

function classifySnapshotTurn(turn: Record<string, unknown> | null): 'active' | 'completed' | 'interrupted' | 'failed' | 'unknown' {
  if (!turn) return 'unknown';
  const rawStatus = typeof turn.status === 'string' ? turn.status : isRecord(turn.state) && typeof turn.state.type === 'string' ? turn.state.type : '';
  const status = rawStatus.toLowerCase().replaceAll(/[^a-z]/gu, '');
  if (['active', 'running', 'started', 'inprogress', 'waiting', 'pending'].includes(status)) return 'active';
  if (['completed', 'complete', 'succeeded', 'success'].includes(status)) return 'completed';
  if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
  if (['failed', 'error'].includes(status)) return 'failed';
  return 'unknown';
}

function providerItemIdFrom(params: Record<string, unknown>): string | null {
  const item = isRecord(params.item) ? params.item : {};
  return typeof params.itemId === 'string' ? params.itemId : typeof item.id === 'string' ? item.id : null;
}

function isReadableItemTextDeltaEvent(method: string): boolean {
  return method === 'item/agentMessage/delta' || method === 'item/plan/delta';
}

function readableDeltaKey(event: CodexAppServerEvent): string | null {
  if (!isReadableItemTextDeltaEvent(event.method) || !isRecord(event.params)) return null;
  const threadId = typeof event.params.threadId === 'string' ? event.params.threadId : null;
  const turnId = providerTurnIdFrom(event.params);
  const itemId = providerItemIdFrom(event.params);
  if (!threadId || !turnId || !itemId) return null;
  return [event.generationId, threadId, turnId, itemId, event.method].join(':');
}

function readableDeltaText(event: CodexAppServerEvent): string | null {
  if (!isRecord(event.params) || typeof event.params.delta !== 'string') return null;
  return event.params.delta;
}

function itemTypeFromMethod(method: string): ConversationItemType {
  return itemTypeFromValue(method.split('/')[1]);
}

function itemTypeFromValue(value: unknown): ConversationItemType {
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

function phaseFromItem(item: Record<string, unknown>): ConversationItemPhase {
  if (item.phase === 'final_answer' || item.phase === 'finalAnswer') return 'final_answer';
  if (typeof item.phase === 'string' && item.phase.trim().length > 0) return 'prework';
  return item.type === 'agentMessage' ? 'final_answer' : 'prework';
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  return '';
}

function reasoningSummaryProjection(existing: { payloadJson: string; textContent: string } | undefined, params: Record<string, unknown>, summaryIndex: number): { payload: Record<string, unknown>; textContent: string } {
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

function liveProgressProjection(existing: { payloadJson: string } | undefined, kind: 'command_output' | 'tool_progress', value: string, append: boolean): { payload: Record<string, unknown> } {
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

function completedItemProjection(existing: { payloadJson: string; textContent: string } | undefined, completedPayload: Record<string, unknown>, itemType: ConversationItemType): { payload: Record<string, unknown>; textContent: string } {
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

function readableReasoningSummary(item: Record<string, unknown>): string[] {
  if (!Array.isArray(item.summary)) return [];
  return item.summary.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requestKindFromMethod(method: string): ConversationServerRequestKind | null {
  if (method === 'item/commandExecution/requestApproval') return 'command';
  if (method === 'item/fileChange/requestApproval') return 'file';
  if (method === 'item/permissions/requestApproval') return 'permissions';
  if (method === 'item/tool/requestUserInput') return 'request_user_input';
  if (method === 'mcpServer/elicitation/request') return 'mcp';
  return null;
}

function hasSecretQuestion(params: Record<string, unknown>): boolean {
  return Array.isArray(params.questions) && params.questions.some((question) => isRecord(question) && (question.isSecret === true || question.secret === true));
}

function invalidServerRequestResponse(message: string): Error & { code: string } {
  return coordinatorError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', message);
}

function isGrantDecision(decision: unknown): boolean {
  return decision === 'accept' || decision === 'acceptForSession';
}

function isExecpolicyAmendmentDecision(value: unknown): value is Exclude<CodexCommandApprovalDecision, string> {
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

function isAdvertisedCommandDecision(payload: Record<string, unknown>, decision: CodexCommandApprovalDecision): boolean {
  if (!Array.isArray(payload.availableDecisions)) return false;
  if (isExecpolicyAmendmentDecision(decision)) return payload.availableDecisions.some((entry) => jsonValuesEqual(entry, decision));
  return payload.availableDecisions.some((entry) => entry === decision || (isRecord(entry) && [entry.decision, entry.id, entry.value, entry.name].includes(decision)));
}

function hasAuditableFileApprovalTarget(payload: Record<string, unknown>, conversation: ZeusConversationWithMessagesRecord, context: ConversationDispatchContext, items: ConversationItemRepository): boolean {
  const directTargetKeys = ['path', 'filePath', 'targetPath'] as const;
  const directTargets: string[] = [];
  for (const key of directTargetKeys) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) return false;
    directTargets.push(value.trim());
  }
  if (directTargets.length > 0) return directTargets.every((target) => isAuditableProjectTarget(target, context.projectLocalPath));

  if (typeof payload.itemId !== 'string' || !payload.itemId || !conversation.providerThreadId) return false;
  const item = items.getByProvider(conversation.providerThreadId, payload.itemId);
  if (!item || item.conversationId !== conversation.id || item.itemType !== 'fileChange') return false;
  const itemPayload = parseJsonRecord(item.payloadJson);
  if (!Array.isArray(itemPayload.changes) || itemPayload.changes.length === 0) return false;
  const linkedTargets = itemPayload.changes.map((change) => (isRecord(change) && typeof change.path === 'string' && change.path.trim() ? change.path.trim() : null));
  return linkedTargets.every((target): target is string => target !== null) && linkedTargets.every((target) => isAuditableProjectTarget(target, context.projectLocalPath));
}

function isAuditableProjectTarget(value: string, projectRoot: string): boolean {
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

function isValidMcpElicitationResponse(payload: Record<string, unknown>, response: Extract<RespondNativeRequestInput['response'], { type: 'mcp' }>): boolean {
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

function hasCanonicalMcpElicitationEnvelope(payload: Record<string, unknown>): boolean {
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

function matchesCanonicalMcpFormSchema(schemaValue: unknown, value: unknown): boolean {
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

function isSupportedMcpPrimitiveSchema(schemaValue: unknown): schemaValue is Record<string, unknown> {
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

function matchesSupportedMcpPrimitiveSchema(schemaValue: unknown, value: unknown): boolean {
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

function supportedStringChoices(schema: Record<string, unknown>): string[] | null {
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

function matchesCanonicalStringValue(value: string, schema: Record<string, unknown>): boolean {
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

function matchesCanonicalNumberValue(value: unknown, schema: Record<string, unknown>): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return false;
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  return typeof schema.maximum !== 'number' || value <= schema.maximum;
}

function matchesCanonicalArrayValue(value: unknown, schema: Record<string, unknown>, choices: readonly string[]): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string') || new Set(value).size !== value.length) return false;
  if (!value.every((entry) => choices.includes(entry))) return false;
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
  return typeof schema.maxItems !== 'number' || value.length <= schema.maxItems;
}

function isValidCanonicalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidCanonicalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !isValidCanonicalDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

function supportedArrayChoices(itemsValue: unknown): string[] | null {
  if (!isRecord(itemsValue)) return null;
  if (itemsValue.type === 'string' && hasOnlyKeys(itemsValue, ['type', 'enum'])) {
    return Array.isArray(itemsValue.enum) && itemsValue.enum.length > 0 && itemsValue.enum.every((entry) => typeof entry === 'string') && new Set(itemsValue.enum).size === itemsValue.enum.length ? itemsValue.enum : null;
  }
  if (hasOnlyKeys(itemsValue, ['anyOf'])) return supportedConstOptions(itemsValue.anyOf);
  return null;
}

function supportedConstOptions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const choices: string[] = [];
  for (const option of value) {
    if (!isRecord(option) || !hasOnlyKeys(option, ['const', 'title']) || typeof option.const !== 'string' || typeof option.title !== 'string') return null;
    choices.push(option.const);
  }
  return new Set(choices).size === choices.length ? choices : null;
}

function matchesSupportedJsonSchema(schemaValue: unknown, value: unknown): boolean {
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

function isSupportedJsonSchemaDefinition(schemaValue: unknown): schemaValue is Record<string, unknown> {
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function evaluateCommandApproval(payload: Record<string, unknown>, context: ConversationDispatchContext): { allowed: boolean; reason: string | null } {
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

function directCommandArgv(payload: Record<string, unknown>): string[] | null {
  const item = isRecord(payload.item) ? payload.item : {};
  if ([payload.commandText, payload.cmd, payload.argv, item.command, item.commandText, item.argv].some((candidate) => candidate !== undefined)) return null;
  if (Array.isArray(payload.command)) return payload.command.length > 0 && payload.command.every((entry) => typeof entry === 'string' && entry.length > 0) ? payload.command : null;
  if (typeof payload.command !== 'string') return null;
  return strictSimpleCommandArgv(payload.command);
}

function strictSimpleCommandArgv(command: string): string[] | null {
  if (command.length === 0 || command.trim() !== command || /[^\S ]/u.test(command)) return null;
  const argv = command.split(/ +/u);
  return argv.every((token) => token.length > 0 && !hasShellMetaOrVariable(token)) ? argv : null;
}

const shellMetaOrVariableCharacters = new Set(`;&|<>\`$\\\n\r*?[]{}()'"~!#`);

function hasShellMetaOrVariable(value: string): boolean {
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

function isSupportedCommandApprovalPolicy(payload: Record<string, unknown>, context: ConversationDispatchContext, projectRealPath: string): boolean {
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

function isSupportedCommandSandbox(value: unknown, context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'readOnly') return Object.keys(value).every((key) => key === 'type' || key === 'networkAccess') && value.networkAccess === false;
  if (value.type !== 'workspaceWrite') return false;
  if (Object.keys(value).some((key) => key !== 'type' && key !== 'writableRoots' && key !== 'networkAccess')) return false;
  return value.networkAccess === false && areProjectWritableRoots(value.writableRoots, context, projectRealPath);
}

function areProjectWritableRoots(value: unknown, context: ConversationDispatchContext, projectRealPath: string): boolean {
  return context.permissionMode !== 'read-only' && Array.isArray(value) && value.every((entry) => typeof entry === 'string' && isExistingProjectDirectory(entry, context, projectRealPath));
}

function isExistingProjectDirectory(value: string, context: ConversationDispatchContext, projectRealPath: string): boolean {
  const targetRealPath = existingDirectoryRealpath(isAbsolute(value) ? value : resolve(context.projectLocalPath, value));
  if (targetRealPath === null) return false;
  const allowedRoots = [projectRealPath, ...(context.writableRoots ?? []).map(existingDirectoryRealpath).filter((entry): entry is string => entry !== null)];
  return allowedRoots.some((root) => isInsideRoot(targetRealPath, root));
}

function existingDirectoryRealpath(value: string): string | null {
  try {
    const realPath = realpathSync(resolve(value));
    return statSync(realPath).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

function trustedExecutableRealpath(value: string, allowlist: ReadonlySet<string>): boolean {
  if (!isAbsolute(value)) return false;
  try {
    const realPath = realpathSync(value);
    return statSync(realPath).isFile() && allowlist.has(realPath);
  } catch {
    return false;
  }
}

function isDirectPwd(argv: readonly string[]): boolean {
  return argv.length === 1 && trustedExecutableRealpath(argv[0] ?? '', trustedPwdExecutableRealpaths);
}

function isSupportedPermissionRequest(payload: Record<string, unknown>): boolean {
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

function isSupportedPermissionGrant(value: unknown): value is Extract<CodexServerRequestResponse, { type: 'permissions' }>['permissions'] {
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

function validatePermissionGrant(requestPayload: Record<string, unknown>, grant: Extract<CodexServerRequestResponse, { type: 'permissions' }>['permissions'], context: ConversationDispatchContext): void {
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

function existingPermissionRealpath(value: string, projectRoot: string, projectRealPath: string): string | null {
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

function isSupportedLocalImageAttachment(attachment: NativeConversationAttachmentInput, canonicalPath: string): boolean {
  return supportedLocalImageExtensions[attachment.mime.toLowerCase()]?.includes(extname(canonicalPath).toLowerCase()) === true;
}

function isNonNegativeInteger(value: unknown): value is number {
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

function isDirectGitStatus(argv: readonly string[], context: ConversationDispatchContext, projectRealPath: string): boolean {
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

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

function requestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted native conversation state is invalid.');
  return parsed;
}

function submissionErrorSnapshot(errorJson: string | null): NativeSubmissionError | null {
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Missing ${label}.`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid ${label}.`);
  return value;
}

function tokenUsageBreakdown(value: Record<string, unknown>): TokenUsageBreakdown {
  return {
    totalTokens: requireSafeInteger(value.totalTokens, 'totalTokens'),
    inputTokens: requireSafeInteger(value.inputTokens, 'inputTokens'),
    cachedInputTokens: requireSafeInteger(value.cachedInputTokens ?? 0, 'cachedInputTokens'),
    cacheWriteInputTokens: requireSafeInteger(value.cacheWriteInputTokens ?? 0, 'cacheWriteInputTokens'),
    outputTokens: requireSafeInteger(value.outputTokens, 'outputTokens'),
    reasoningOutputTokens: requireSafeInteger(value.reasoningOutputTokens ?? 0, 'reasoningOutputTokens'),
  };
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid ${label}.`);
  return value;
}

function normalizeMcpStartupStatusMap(value: Record<string, unknown>): Record<string, CodexMcpServerStartupState> {
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

function normalizeSingleMcpStartupStatus(params: Record<string, unknown>): { serverId: string; state: CodexMcpServerStartupState } {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeError(error: unknown): { message: string; code?: string } {
  return { message: error instanceof Error ? error.message : String(error), ...(isRecord(error) && typeof error.code === 'string' ? { code: error.code } : {}) };
}

function toRecoverySubmissionError(error: unknown): { message: string; code: string; recoveryRequired: true } {
  const serialized = serializeError(error);
  return {
    message: serialized.message,
    code: serialized.code ?? 'ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW',
    recoveryRequired: true,
  };
}

function isProviderThreadArchivedError(error: unknown): boolean {
  return /\bis archived\b[\s\S]*\bunarchive\b/i.test(error instanceof Error ? error.message : String(error));
}

function isProviderTurnAlreadyEndedSteerError(error: unknown): boolean {
  return /\bno active turn to steer\b/i.test(error instanceof Error ? error.message : String(error));
}

function coordinatorError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
