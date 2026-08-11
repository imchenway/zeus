import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { type AgentImageInput, type AgentModelIdentity, type AgentRuntimeEvent, type AgentSessionIdentity, createPiSdkRuntimeDriver, modelRef, type PiZeusToolBroker, type PiZeusToolRequest, type PiZeusToolResult } from '@zeus/ai-runtime';
import { buildTaskPushInputParts, type TaskPushMessageLayout } from '@zeus/shared';
import type {
  ConversationItemRepository,
  ConversationRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ZeusConversationServerRequestRecord,
  ZeusConversationWithMessagesRecord,
  ZeusDatabase,
} from '@zeus/storage';
import type { ModelConnectionService } from './modelConnectionService.js';
import type { NativeConversationAttachmentInput } from './codexNativeConversationContracts.js';

const execFileAsync = promisify(execFile);

interface PiConversationContext {
  conversationId: string;
  projectId: string;
  taskId: string | null;
  cwd: string;
  permissionMode: 'read-only' | 'auto' | 'full-access';
  attachmentRoots: string[];
  session: AgentSessionIdentity;
}

interface PiRunContext {
  conversationId: string;
  submissionId: string;
  turnId: string;
  providerTurnId: string;
}

export interface CreatePiNativeConversationCoordinatorOptions {
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  items: ConversationItemRepository;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
  modelConnections: ModelConnectionService;
  agentDirectory: string;
  sessionDirectory: string;
  now: () => string;
  publish: (type: string, payload: Record<string, unknown>) => void;
}

export interface StartPiConversationInput {
  conversationId: string;
  submissionId: string;
  projectId: string;
  taskId?: string;
  taskTitle?: string;
  conversationTitle?: string;
  cwd: string;
  prompt: string;
  displayText?: string;
  model: AgentModelIdentity;
  thinkingLevel?: string;
  permissionMode: 'read-only' | 'auto' | 'full-access';
  idempotencyKey: string;
  clientUserMessageId: string;
  workspaceId?: string;
  environmentId?: string;
  attachments?: NativeConversationAttachmentInput[];
  allowedAttachmentRoots?: string[];
  taskPushLayout?: TaskPushMessageLayout;
  providerWriteLifecycle?: {
    markPrepared(submissionId: string): Promise<void>;
    markRpcStarted(submissionId: string): void;
  };
}

interface PiAttachmentResolution {
  attachments: NativeConversationAttachmentInput[];
  images: AgentImageInput[];
  pathReferences: Array<{ name: string; path: string }>;
  allowedRoots: string[];
}

/** Pi SDK 会话的 Zeus 宿主：会话、消息、工具和审批都以 Zeus 为权威状态。 */
export function createPiNativeConversationCoordinator(options: CreatePiNativeConversationCoordinatorOptions) {
  const contexts = new Map<string, PiConversationContext>();
  const runs = new Map<string, PiRunContext>();
  const interruptedRuns = new Set<string>();
  const pendingApprovals = new Map<string, { resolve: (allowed: boolean) => void; session: AgentSessionIdentity; conversationId: string }>();
  let eventSequence = 0;

  const broker: PiZeusToolBroker = {
    execute: async (request) => executeTool(request),
    respond: async (input) => {
      const pending = pendingApprovals.get(input.requestId);
      if (!pending || pending.session.nativeSessionId !== input.session.nativeSessionId) throw piError('ZEUS_PI_APPROVAL_NOT_PENDING', 'Pi 工具审批已不在等待。');
      pendingApprovals.delete(input.requestId);
      pending.resolve(readApprovalDecision(input.response));
    },
  };
  const driver = createPiSdkRuntimeDriver({
    adapterVersion: 'zeus-pi-sdk',
    agentDirectory: options.agentDirectory,
    sessionDirectory: options.sessionDirectory,
    loadConnections: () => options.modelConnections.loadRuntimeConnections(),
    toolBroker: broker,
    now: options.now,
  });
  const unsubscribe = driver.subscribe((event) => void handleRuntimeEvent(event));

  function settleInterruptedRun(run: PiRunContext, timestamp: string): void {
    const submissions = options.submissions.listByConversation(run.conversationId);
    const unsent = submissions.filter((submission) => !submission.providerTurnId && (submission.status === 'queued' || submission.status === 'paused'));
    for (const submission of unsent) {
      if (submission.status === 'queued') options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'interrupted', updatedAt: timestamp });
    }
    const blocksResume = unsent.some((submission) => submission.status === 'queued' || submission.pausedReason !== 'user_confirmation');
    options.submissions.updateStatus(run.submissionId, 'completed', {
      providerTurnId: run.providerTurnId,
      resolvedAt: timestamp,
      updatedAt: timestamp,
    });
    options.conversations.updateAgentRuntime(run.conversationId, {
      providerState: blocksResume ? 'paused' : 'ready',
      status: 'open',
    });
  }

  async function startConversation(input: StartPiConversationInput) {
    const orderedAttachments = input.taskPushLayout ? orderPiTaskPushAttachments(input.taskPushLayout, input.attachments ?? []) : (input.attachments ?? []);
    const attachmentInput = await resolvePiAttachmentInput(orderedAttachments, input.allowedAttachmentRoots ?? []);
    const providerPrompt = input.taskPushLayout ? renderPiTaskPushPrompt(input.taskPushLayout, attachmentInput.attachments) : appendPiAttachmentReferences(input.prompt, attachmentInput.pathReferences);
    await input.providerWriteLifecycle?.markPrepared(input.submissionId);
    input.providerWriteLifecycle?.markRpcStarted(input.submissionId);
    const session = await driver.openSession({ cwd: input.cwd, model: input.model });
    const createdAt = options.now();
    options.conversations.create({
      id: input.conversationId,
      projectId: input.projectId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      title: input.conversationTitle?.trim().slice(0, 80) || input.taskTitle || input.prompt.slice(0, 80) || 'Pi 会话',
      status: 'running',
      transportKind: 'codex_native',
      providerId: `pi:${input.model.sourceId ?? 'custom'}`,
      providerThreadId: session.nativeSessionId,
      ...(session.nativeSessionPath ? { providerThreadPath: session.nativeSessionPath } : {}),
      providerModel: input.model.sourceId ? modelRef(input.model.sourceId, input.model.modelId) : input.model.modelId,
      providerState: 'active',
      providerProtocolVersion: 'sdk',
      providerBinaryVersion: 'pi-sdk-0.83.0',
      permissionMode: input.permissionMode,
      collaborationMode: 'default',
      agentKind: 'pi',
      agentTransport: 'sdk',
      modelSourceId: input.model.sourceId ?? undefined,
      modelId: input.model.modelId,
      nativeSessionId: session.nativeSessionId,
      nativeSessionPath: session.nativeSessionPath ?? undefined,
    });
    options.conversations.updateNextTurnSettings(input.conversationId, {
      model: input.model.sourceId ? modelRef(input.model.sourceId, input.model.modelId) : input.model.modelId,
      ...(input.thinkingLevel ? { effort: input.thinkingLevel } : {}),
      permissionMode: input.permissionMode,
      collaborationMode: 'default',
    });
    contexts.set(session.nativeSessionId, {
      conversationId: input.conversationId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      attachmentRoots: attachmentInput.allowedRoots,
      session,
    });
    const submission = options.submissions.createOrGet({
      id: input.submissionId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.idempotencyKey,
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'dispatching',
      input: {
        text: providerPrompt,
        ...(input.displayText ? { displayText: input.displayText } : {}),
        ...(attachmentInput.attachments.length > 0 ? { attachments: attachmentInput.attachments } : {}),
        ...(input.taskPushLayout ? { taskPushLayout: input.taskPushLayout } : {}),
        context: {
          projectLocalPath: input.cwd,
          model: input.model.modelId,
          modelSourceId: input.model.sourceId,
          agentKind: 'pi',
          thinkingLevel: input.thinkingLevel,
          ...(attachmentInput.allowedRoots.length > 0 ? { allowedAttachmentRoots: attachmentInput.allowedRoots } : {}),
        },
      },
      createdAt,
      dispatchedAt: createdAt,
    });
    const run = await driver.startRun({
      session,
      content: providerPrompt,
      clientRequestId: input.clientUserMessageId,
      model: input.model,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(attachmentInput.images.length > 0 ? { images: attachmentInput.images } : {}),
    });
    const turn = options.turns.upsert({
      conversationId: input.conversationId,
      providerThreadId: session.nativeSessionId,
      providerTurnId: run.nativeRunId,
      clientSubmissionId: submission.id,
      status: 'running',
      startedAt: run.acceptedAt,
      completedAt: null,
      createdAt,
      updatedAt: run.acceptedAt,
      agentKind: 'pi',
      nativeRunId: run.nativeRunId,
    });
    appendUserProjection(input.conversationId, session.nativeSessionId, turn.id, run.nativeRunId, input.prompt, input.clientUserMessageId, createdAt, attachmentInput.attachments, input.taskPushLayout);
    options.submissions.updateStatus(submission.id, 'active', { providerTurnId: run.nativeRunId, updatedAt: run.acceptedAt });
    runs.set(run.nativeRunId, { conversationId: input.conversationId, submissionId: submission.id, turnId: turn.id, providerTurnId: run.nativeRunId });
    await options.db.save();
    publish('conversation.turn.started', input.conversationId, { turnId: run.nativeRunId, submissionId: submission.id, status: 'running', startedAt: run.acceptedAt });
    return { conversationId: input.conversationId, submissionId: submission.id, providerThreadId: session.nativeSessionId, providerTurnId: run.nativeRunId, status: 'active' as const };
  }

  async function submitMessage(input: { conversation: ZeusConversationWithMessagesRecord; submissionId: string; content: string; model: AgentModelIdentity; thinkingLevel?: string; idempotencyKey: string; clientUserMessageId: string }) {
    let context = input.conversation.nativeSessionId ? contexts.get(input.conversation.nativeSessionId) : undefined;
    if (!context) {
      if (!input.conversation.nativeSessionId || !input.conversation.nativeSessionPath) throw piError('ZEUS_PI_SESSION_UNAVAILABLE', 'Pi 会话缺少可恢复的会话文件。');
      const cwd = resolveConversationCwd(input.conversation);
      const session = await driver.resumeSession({ nativeSessionId: input.conversation.nativeSessionId, nativeSessionPath: input.conversation.nativeSessionPath, cwd });
      context = { conversationId: input.conversation.id, projectId: input.conversation.projectId, taskId: input.conversation.taskId, cwd, permissionMode: input.conversation.permissionMode, attachmentRoots: [], session };
      contexts.set(session.nativeSessionId, context);
    }
    const createdAt = options.now();
    const submission = options.submissions.createOrGet({
      id: input.submissionId,
      conversationId: input.conversation.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.idempotencyKey,
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'dispatching',
      input: { text: input.content, context: { model: input.model.modelId, modelSourceId: input.model.sourceId, agentKind: 'pi', thinkingLevel: input.thinkingLevel, projectLocalPath: context.cwd } },
      createdAt,
      dispatchedAt: createdAt,
    });
    const run = await driver.startRun({ session: context.session, content: input.content, clientRequestId: input.clientUserMessageId, model: input.model, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}) });
    const turn = options.turns.upsert({
      conversationId: input.conversation.id,
      providerThreadId: context.session.nativeSessionId,
      providerTurnId: run.nativeRunId,
      clientSubmissionId: submission.id,
      status: 'running',
      startedAt: run.acceptedAt,
      completedAt: null,
      createdAt,
      updatedAt: run.acceptedAt,
      agentKind: 'pi',
      nativeRunId: run.nativeRunId,
    });
    appendUserProjection(input.conversation.id, context.session.nativeSessionId, turn.id, run.nativeRunId, input.content, input.clientUserMessageId, createdAt);
    options.submissions.updateStatus(submission.id, 'active', { providerTurnId: run.nativeRunId, updatedAt: run.acceptedAt });
    options.conversations.updateAgentRuntime(input.conversation.id, {
      providerState: 'active',
      status: 'running',
      modelSourceId: input.model.sourceId,
      modelId: input.model.modelId,
      providerModel: input.model.sourceId ? modelRef(input.model.sourceId, input.model.modelId) : input.model.modelId,
    });
    runs.set(run.nativeRunId, { conversationId: input.conversation.id, submissionId: submission.id, turnId: turn.id, providerTurnId: run.nativeRunId });
    await options.db.save();
    publish('conversation.turn.started', input.conversation.id, { turnId: run.nativeRunId, submissionId: submission.id, status: 'running', startedAt: run.acceptedAt });
    return { conversationId: input.conversation.id, submissionId: submission.id, providerThreadId: context.session.nativeSessionId, providerTurnId: run.nativeRunId, status: 'active' as const };
  }

  async function steerMessage(input: { conversation: ZeusConversationWithMessagesRecord; submissionId: string; content: string; expectedTurnId: string; idempotencyKey: string; clientUserMessageId: string }) {
    const run = runs.get(input.expectedTurnId);
    if (!run || run.conversationId !== input.conversation.id) throw piError('ZEUS_PI_RUN_NOT_ACTIVE', 'Pi 插话目标不是当前执行轮次。');
    const context = input.conversation.nativeSessionId ? contexts.get(input.conversation.nativeSessionId) : undefined;
    if (!context) throw piError('ZEUS_PI_SESSION_NOT_LOADED', 'Pi 会话当前未载入运行内核。');
    const createdAt = options.now();
    const submission = options.submissions.createOrGet({
      id: input.submissionId,
      conversationId: input.conversation.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.idempotencyKey,
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'send_now',
      status: 'dispatching',
      input: { text: input.content, context: { agentKind: 'pi', projectLocalPath: context.cwd }, delivery: 'steer_now', expectedTurnId: input.expectedTurnId },
      createdAt,
      dispatchedAt: createdAt,
    });
    const accepted = await driver.steerRun({ session: context.session, nativeRunId: input.expectedTurnId, content: input.content, clientRequestId: input.clientUserMessageId });
    appendUserProjection(input.conversation.id, context.session.nativeSessionId, run.turnId, run.providerTurnId, input.content, input.clientUserMessageId, createdAt);
    options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId: accepted.nativeRunId, resolvedAt: accepted.acceptedAt, updatedAt: accepted.acceptedAt });
    await options.db.save();
    publish('conversation.queue.changed', input.conversation.id, { turnId: run.providerTurnId, submissionId: submission.id });
    return { conversationId: input.conversation.id, submissionId: submission.id, providerThreadId: context.session.nativeSessionId, providerTurnId: accepted.nativeRunId, status: 'active' as const };
  }

  async function handleRuntimeEvent(event: AgentRuntimeEvent): Promise<void> {
    if (!event.nativeRunId) return;
    const run = runs.get(event.nativeRunId);
    if (!run) return;
    const payload = asRecord(event.payload);
    if (event.type === 'message_end') {
      const message = asRecord(payload.message);
      if (message.role !== 'assistant') return;
      const text = messageText(message);
      if (!text) return;
      const itemId = `pi_message_${event.nativeRunId}`;
      const isToolUseStage = message.stopReason === 'toolUse';
      const itemInput = {
        conversationId: run.conversationId,
        turnId: run.turnId,
        providerThreadId: event.nativeSessionId ?? '',
        providerTurnId: run.providerTurnId,
        providerItemId: itemId,
        itemType: 'agentMessage' as const,
        phase: isToolUseStage ? ('prework' as const) : ('final_answer' as const),
        payload: { agentKind: 'pi', stopReason: message.stopReason },
        textContent: text,
        updatedAt: event.createdAt,
        agentKind: 'pi' as const,
        nativeItemId: itemId,
      };
      if (isToolUseStage) options.items.upsertProgress({ ...itemInput, status: 'in_progress' });
      else options.items.upsertCompleted({ ...itemInput, status: 'completed', completedAt: event.createdAt });
      options.conversations.appendMessage({
        conversationId: run.conversationId,
        role: 'assistant',
        content: text,
        source: 'pi_sdk',
        metadata: { agentKind: 'pi' },
        createdAt: event.createdAt,
        providerThreadId: event.nativeSessionId ?? undefined,
        providerTurnId: run.providerTurnId,
        providerItemId: itemId,
      });
      publish(isToolUseStage ? 'conversation.item.started' : 'conversation.item.completed', run.conversationId, {
        turnId: run.providerTurnId,
        itemId,
        itemType: 'agentMessage',
        itemPayload: { agentKind: 'pi', stopReason: message.stopReason },
        status: isToolUseStage ? 'in_progress' : 'completed',
        phase: isToolUseStage ? 'prework' : 'final_answer',
        textContent: text,
      });
    }
    if (event.type === 'agent_settled' || event.type === 'runtime_error') {
      const failed = event.type === 'runtime_error';
      const interrupted = interruptedRuns.delete(event.nativeRunId);
      const status = interrupted ? 'interrupted' : failed ? 'failed' : 'completed';
      const existingTurn = options.turns.getById(run.turnId);
      options.turns.upsert({
        id: run.turnId,
        conversationId: run.conversationId,
        providerThreadId: event.nativeSessionId ?? '',
        providerTurnId: run.providerTurnId,
        clientSubmissionId: run.submissionId,
        status,
        startedAt: existingTurn?.startedAt ?? null,
        completedAt: event.createdAt,
        createdAt: existingTurn?.createdAt ?? event.createdAt,
        updatedAt: event.createdAt,
        ...(failed ? { error: payload } : {}),
        agentKind: 'pi',
        nativeRunId: run.providerTurnId,
      });
      if (interrupted) {
        settleInterruptedRun(run, event.createdAt);
      } else {
        options.submissions.updateStatus(run.submissionId, failed ? 'failed' : 'completed', { ...(failed ? { error: payload } : {}), resolvedAt: event.createdAt, updatedAt: event.createdAt });
        options.conversations.updateAgentRuntime(run.conversationId, { providerState: failed ? 'failed' : 'ready', status: failed ? 'failed' : 'open' });
      }
      runs.delete(event.nativeRunId);
      await options.db.save();
      publish('conversation.turn.completed', run.conversationId, { turnId: run.providerTurnId, submissionId: run.submissionId, status, completedAt: event.createdAt });
      if (interrupted) publish('conversation.queue.changed', run.conversationId, { turnId: run.providerTurnId, submissionId: run.submissionId });
    }
  }

  function appendUserProjection(
    conversationId: string,
    threadId: string,
    turnId: string,
    providerTurnId: string,
    content: string,
    clientMessageId: string,
    createdAt: string,
    attachments: NativeConversationAttachmentInput[] = [],
    taskPushLayout?: TaskPushMessageLayout,
  ): void {
    const itemId = `pi_user_${clientMessageId}`;
    const attachmentMetadata = persistedPiAttachmentMetadata(attachments);
    options.items.upsertCompleted({
      conversationId,
      turnId,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId: itemId,
      itemType: 'userMessage',
      phase: 'prework',
      payload: { clientUserMessageId: clientMessageId, agentKind: 'pi', ...(attachmentMetadata.length > 0 ? { attachments: attachmentMetadata } : {}), ...(taskPushLayout ? { taskPushLayout } : {}) },
      textContent: content,
      completedAt: createdAt,
      updatedAt: createdAt,
      agentKind: 'pi',
      nativeItemId: itemId,
    });
    options.conversations.appendMessage({
      conversationId,
      role: 'user',
      content,
      source: 'pi_sdk',
      metadata: { clientUserMessageId: clientMessageId, agentKind: 'pi', cwd: contexts.get(threadId)?.cwd, ...(attachmentMetadata.length > 0 ? { attachments: attachmentMetadata } : {}), ...(taskPushLayout ? { taskPushLayout } : {}) },
      createdAt,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId: itemId,
      clientMessageId,
    });
  }

  async function executeTool(request: PiZeusToolRequest): Promise<PiZeusToolResult> {
    const context = contexts.get(request.session.nativeSessionId);
    if (!context) throw piError('ZEUS_PI_TOOL_SESSION_UNBOUND', 'Pi 工具请求没有对应的 Zeus 会话。');
    const mutating = request.toolName === 'write' || request.toolName === 'edit' || request.toolName === 'bash';
    if (mutating && context.permissionMode === 'read-only') throw piError('ZEUS_PI_TOOL_READ_ONLY', '当前会话是只读模式，已拒绝 Pi 写入或命令。');
    if (mutating && context.permissionMode === 'auto') {
      const allowed = await requestApproval(context, request);
      if (!allowed) throw piError('ZEUS_PI_TOOL_DECLINED', '用户已拒绝 Pi 工具请求。');
    }
    if (request.toolName === 'bash') {
      const command = stringArg(request.args.command, '命令');
      const result = await execFileAsync('/bin/zsh', ['-lc', command], { cwd: context.cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      return { text: `${result.stdout}${result.stderr}`.trim() || '命令执行完成。' };
    }
    const readOnlyTool = request.toolName === 'read' || request.toolName === 'grep' || request.toolName === 'find' || request.toolName === 'ls';
    const path = safePath(context.cwd, typeof request.args.path === 'string' ? request.args.path : '.', readOnlyTool ? context.attachmentRoots : []);
    if (request.toolName === 'read') {
      const text = await readFile(path, 'utf8');
      const offset = numberArg(request.args.offset, 0);
      const limit = numberArg(request.args.limit, 2_000);
      return {
        text: text
          .split('\n')
          .slice(offset, offset + limit)
          .join('\n'),
      };
    }
    if (request.toolName === 'ls') return { text: (await readdir(path, { withFileTypes: true })).map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`).join('\n') };
    if (request.toolName === 'write') {
      await writeFile(path, stringArg(request.args.content, '文件内容'), 'utf8');
      return { text: `已写入 ${relative(context.cwd, path)}` };
    }
    if (request.toolName === 'edit') {
      const text = await readFile(path, 'utf8');
      const oldText = stringArg(request.args.oldText, '原文');
      if (!text.includes(oldText)) throw piError('ZEUS_PI_EDIT_TEXT_NOT_FOUND', '要替换的原文不存在。');
      await writeFile(path, text.replace(oldText, stringArg(request.args.newText, '新文')), 'utf8');
      return { text: `已编辑 ${relative(context.cwd, path)}` };
    }
    const pattern = stringArg(request.args.pattern, '搜索内容');
    const args = request.toolName === 'grep' ? ['-n', '--hidden', '--glob', '!.git', pattern, path] : ['--files', path, '-g', pattern];
    const result = await execFileAsync('rg', args, { cwd: context.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }).catch((error: unknown) => ({ stdout: readExitStdout(error), stderr: '' }));
    return { text: result.stdout.trim() || '没有匹配结果。' };
  }

  function repairPersistedAgentMessageProjections(): number {
    let repaired = 0;
    for (const conversation of options.conversations.listNativeBound()) {
      for (const message of conversation.messages) {
        if (message.role !== 'assistant' || message.source !== 'pi_sdk' || !message.providerThreadId || !message.providerItemId) continue;
        const item = options.items.getByProvider(message.providerThreadId, message.providerItemId);
        if (!item || item.agentKind !== 'pi' || item.itemType !== 'agentMessage' || item.status !== 'completed' || item.textContent === message.content) continue;
        options.items.replaceCompletedPiAgentMessage({
          providerThreadId: message.providerThreadId,
          providerItemId: message.providerItemId,
          textContent: message.content,
          updatedAt: options.now(),
        });
        repaired += 1;
      }
    }
    return repaired;
  }

  function repairPersistedConversationIdentities(): number {
    let repaired = 0;
    const sessionRoot = resolve(options.sessionDirectory);
    for (const conversation of options.conversations.listNativeIdentityCandidates()) {
      if (
        conversation.agentKind === 'pi' ||
        !conversation.providerThreadId ||
        !conversation.providerThreadPath ||
        !conversation.nativeSessionId ||
        !conversation.nativeSessionPath ||
        !conversation.modelSourceId ||
        conversation.providerThreadId !== conversation.nativeSessionId ||
        conversation.providerThreadPath !== conversation.nativeSessionPath ||
        !isPathInsideDirectory(conversation.nativeSessionPath, sessionRoot) ||
        !conversation.messages.some((message) => isPersistedPiMessageEvidence(message, conversation.nativeSessionId!))
      ) {
        continue;
      }
      if (
        options.conversations.repairPiAgentIdentity({
          conversationId: conversation.id,
          nativeSessionId: conversation.nativeSessionId,
          nativeSessionPath: conversation.nativeSessionPath,
          modelSourceId: conversation.modelSourceId,
        })
      ) {
        repaired += 1;
      }
    }
    return repaired;
  }

  async function requestApproval(context: PiConversationContext, request: PiZeusToolRequest): Promise<boolean> {
    const kind = request.toolName === 'bash' ? 'command' : 'file';
    const activeRun = [...runs.values()].reverse().find((candidate) => candidate.conversationId === context.conversationId);
    if (!activeRun) throw piError('ZEUS_PI_RUN_NOT_ACTIVE', 'Pi 工具审批没有对应的活动轮次。');
    const timestamp = options.now();
    const activeTurn = options.turns.getById(activeRun.turnId);
    if (activeTurn) options.turns.upsert({ ...activeTurn, status: 'waiting', completedAt: null, updatedAt: timestamp, agentKind: 'pi', nativeRunId: activeRun.providerTurnId });
    options.conversations.updateAgentRuntime(context.conversationId, { providerState: 'waiting', status: 'running' });
    const persisted = options.requests.upsert({
      conversationId: context.conversationId,
      turnId: activeRun.turnId,
      transportGenerationId: request.session.runtimeInstanceId,
      providerRequestId: request.requestId,
      requestKind: kind,
      payload: { agentKind: 'pi', toolName: request.toolName, args: redactArgs(request.args), reason: 'Pi 工具请求需要 Zeus 审批。' },
      status: 'pending',
      createdAt: timestamp,
    });
    await options.db.save();
    publish('conversation.request.created', context.conversationId, {
      requestId: persisted.id,
      requestKind: kind,
      request: nativePendingRequestProjection(persisted),
    });
    return new Promise<boolean>((resolveApproval, reject) => {
      const finish = (allowed: boolean) => {
        request.signal?.removeEventListener('abort', abort);
        resolveApproval(allowed);
      };
      const abort = () => {
        pendingApprovals.delete(persisted.id);
        reject(piError('ZEUS_PI_TOOL_ABORTED', 'Pi 工具请求已中止。'));
      };
      pendingApprovals.set(persisted.id, { resolve: finish, session: context.session, conversationId: context.conversationId });
      request.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  function publish(type: string, conversationId: string, extra: Record<string, unknown>): void {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    options.publish(type, { projectId: conversation.projectId, conversationId, threadId: conversation.providerThreadId ?? undefined, generationId: conversation.nativeSessionId ?? 'pi-sdk', sequence: (eventSequence += 1), ...extra });
  }

  return {
    repairPersistedConversationIdentities,
    repairPersistedAgentMessageProjections,
    startConversation,
    submitMessage,
    steerMessage,
    async interruptTurn(input: { conversation: ZeusConversationWithMessagesRecord; providerTurnId: string }): Promise<{ submissionId: string | null }> {
      const run = runs.get(input.providerTurnId);
      if (!run || run.conversationId !== input.conversation.id) throw piError('ZEUS_PI_RUN_NOT_ACTIVE', '目标 Pi 轮次当前未在执行。');
      const context = input.conversation.nativeSessionId ? contexts.get(input.conversation.nativeSessionId) : undefined;
      if (!context) throw piError('ZEUS_PI_SESSION_NOT_LOADED', '目标 Pi 会话当前未载入运行内核。');
      interruptedRuns.add(input.providerTurnId);
      for (const [requestId, pending] of pendingApprovals) {
        if (pending.conversationId !== input.conversation.id) continue;
        pendingApprovals.delete(requestId);
        pending.resolve(false);
      }
      await driver.interruptRun({ session: context.session, nativeRunId: input.providerTurnId });
      if (runs.has(input.providerTurnId)) {
        const timestamp = options.now();
        const turn = options.turns.getById(run.turnId);
        if (turn) options.turns.upsert({ ...turn, status: 'interrupted', completedAt: timestamp, updatedAt: timestamp, agentKind: 'pi', nativeRunId: input.providerTurnId });
        settleInterruptedRun(run, timestamp);
        runs.delete(input.providerTurnId);
        interruptedRuns.delete(input.providerTurnId);
        await options.db.save();
        publish('conversation.turn.completed', run.conversationId, { turnId: run.providerTurnId, submissionId: run.submissionId, status: 'interrupted', completedAt: timestamp });
        publish('conversation.queue.changed', run.conversationId, { turnId: run.providerTurnId, submissionId: run.submissionId });
      }
      return { submissionId: run.submissionId };
    },
    async respondToRequest(input: { requestId: string; response: unknown }): Promise<void> {
      const request = options.requests.getById(input.requestId);
      if (!request || request.status !== 'pending') throw piError('ZEUS_PI_APPROVAL_NOT_PENDING', 'Pi 工具审批已不在等待。');
      const pending = pendingApprovals.get(request.id);
      if (!pending) throw piError('ZEUS_PI_APPROVAL_CHANNEL_UNAVAILABLE', 'Pi 工具审批通道已断开。');
      const activeRun = [...runs.values()].reverse().find((candidate) => candidate.conversationId === request.conversationId);
      const activeTurn = activeRun ? options.turns.getById(activeRun.turnId) : undefined;
      const timestamp = options.now();
      if (activeTurn) options.turns.upsert({ ...activeTurn, status: 'running', completedAt: null, updatedAt: timestamp, agentKind: 'pi', nativeRunId: activeRun?.providerTurnId ?? null });
      options.conversations.updateAgentRuntime(request.conversationId, { providerState: 'active', status: 'running' });
      options.requests.resolve(request.id, { response: input.response, resolvedAt: options.now() });
      await driver.respondToInteraction({ session: pending.session, requestId: request.id, response: input.response });
      await options.db.save();
      publish('conversation.request.resolved', request.conversationId, { requestId: request.id, requestKind: request.requestKind });
    },
    async close(): Promise<void> {
      unsubscribe();
      for (const pending of pendingApprovals.values()) pending.resolve(false);
      pendingApprovals.clear();
      await driver.close({ mode: 'final' });
    },
  };
}

const supportedPiImageMimeExtensions: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/bmp': ['.bmp'],
  'image/heic': ['.heic', '.heif'],
  'image/tiff': ['.tif', '.tiff'],
};

async function resolvePiAttachmentInput(attachments: NativeConversationAttachmentInput[], allowedAttachmentRoots: string[]): Promise<PiAttachmentResolution> {
  const allowedRoots = [...new Set(allowedAttachmentRoots.map(existingDirectoryRealpath).filter((root): root is string => root !== null))];
  const normalizedAttachments: NativeConversationAttachmentInput[] = [];
  const images: AgentImageInput[] = [];
  const pathReferences: Array<{ name: string; path: string }> = [];

  for (const attachment of attachments) {
    if (attachment.uploadRef) throw piError('ZEUS_PI_ATTACHMENT_UPLOAD_UNSUPPORTED', 'Pi 图片输入暂不支持未解析的上传引用。');
    if (!attachment.localPath || !isAbsolute(attachment.localPath)) throw piError('ZEUS_PI_ATTACHMENT_INPUT_INVALID', 'Pi 附件必须是服务端确认的绝对本机路径。');

    let canonicalPath: string;
    let pathStat: ReturnType<typeof statSync>;
    try {
      canonicalPath = realpathSync(attachment.localPath);
      pathStat = statSync(canonicalPath);
      const exactlyAuthorized = Boolean(attachment.authorizedPath) && realpathSync(attachment.authorizedPath!) === canonicalPath;
      if ((!exactlyAuthorized && !allowedRoots.some((root) => isInsideRoot(canonicalPath, root))) || (!pathStat.isFile() && !pathStat.isDirectory())) {
        throw new Error('附件不在可信目录内或不是可读取资源。');
      }
    } catch {
      throw piError('ZEUS_PI_ATTACHMENT_PATH_UNAVAILABLE', 'Pi 附件必须解析为可信目录内的文件或目录。');
    }

    const normalizedAttachment: NativeConversationAttachmentInput = {
      ...attachment,
      localPath: canonicalPath,
      ...(attachment.authorizedPath ? { authorizedPath: canonicalPath } : {}),
    };
    normalizedAttachments.push(normalizedAttachment);

    const imageMime = pathStat.isFile() ? resolvePiImageMime(attachment.mime, canonicalPath) : null;
    if (imageMime) {
      try {
        images.push({ data: (await readFile(canonicalPath)).toString('base64'), mimeType: imageMime });
      } catch {
        throw piError('ZEUS_PI_ATTACHMENT_READ_FAILED', `Pi 附件“${attachment.name}”当前无法读取。`);
      }
    } else {
      pathReferences.push({ name: attachment.name, path: canonicalPath });
    }
  }

  return { attachments: normalizedAttachments, images, pathReferences, allowedRoots };
}

function resolvePiImageMime(mime: string, canonicalPath: string): string | null {
  const normalizedMime = mime.trim().toLowerCase();
  if (normalizedMime === 'image/*') {
    const extension = extname(canonicalPath).toLowerCase();
    return Object.entries(supportedPiImageMimeExtensions).find(([, extensions]) => extensions.includes(extension))?.[0] ?? null;
  }
  return normalizedMime.startsWith('image/') ? normalizedMime : null;
}

function appendPiAttachmentReferences(prompt: string, pathReferences: Array<{ name: string; path: string }>): string {
  if (pathReferences.length === 0) return prompt;
  return `${prompt}\n\n附件路径（请按需读取）：\n${pathReferences.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n')}`;
}

function orderPiTaskPushAttachments(layout: TaskPushMessageLayout, attachments: NativeConversationAttachmentInput[]): NativeConversationAttachmentInput[] {
  const byKey = new Map(attachments.flatMap((attachment) => (attachment.taskPushAttachmentKey ? [[attachment.taskPushAttachmentKey, attachment] as const] : [])));
  return buildTaskPushInputParts(layout).flatMap((part) => (part.type === 'attachment' && byKey.has(part.attachmentKey) ? [byKey.get(part.attachmentKey)!] : []));
}

/** Pi SDK 图片字节通过独立数组传入；文字中的同序标记保留字段语义与资源对应。 */
function renderPiTaskPushPrompt(layout: TaskPushMessageLayout, attachments: NativeConversationAttachmentInput[]): string {
  const byKey = new Map(attachments.flatMap((attachment) => (attachment.taskPushAttachmentKey ? [[attachment.taskPushAttachmentKey, attachment] as const] : [])));
  return buildTaskPushInputParts(layout)
    .map((part) => {
      if (part.type === 'text') return part.text;
      const attachment = byKey.get(part.attachmentKey);
      if (!attachment) throw piError('ZEUS_PI_ATTACHMENT_INPUT_INVALID', `Pi 任务首发缺少附件位置：${part.attachmentKey}`);
      const imageMime = attachment.localPath ? resolvePiImageMime(attachment.mime, attachment.localPath) : null;
      return imageMime ? `[图片：${attachment.name}]\n` : `[附件：${attachment.name} · ${attachment.localPath ?? ''}]\n`;
    })
    .join('');
}

function persistedPiAttachmentMetadata(attachments: NativeConversationAttachmentInput[]): Array<Record<string, unknown>> {
  return attachments.map((attachment) => ({
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
    ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}),
    ...(attachment.taskPushAttachmentKey ? { taskPushAttachmentKey: attachment.taskPushAttachmentKey } : {}),
  }));
}

function existingDirectoryRealpath(value: string): string | null {
  try {
    const realPath = realpathSync(resolve(value));
    return statSync(realPath).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && rel !== '..' && !isAbsolute(rel));
}

function safePath(cwd: string, value: string, attachmentRoots: readonly string[] = []): string {
  const candidate = resolve(cwd, value);
  const rel = relative(resolve(cwd), candidate);
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return candidate;
  try {
    const canonicalPath = realpathSync(candidate);
    if (attachmentRoots.some((root) => isInsideRoot(canonicalPath, root))) return canonicalPath;
  } catch {
    // 外部附件路径不存在时仍然拒绝，不能用未经确认的路径扩大读取范围。
  }
  throw piError('ZEUS_PI_PATH_OUTSIDE_WORKSPACE', 'Pi 工具不能访问当前工作区之外的路径。');
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  try {
    const candidate = relative(realpathSync(directory), realpathSync(path));
    return candidate !== '' && candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate);
  } catch {
    return false;
  }
}

function isPersistedPiMessageEvidence(message: { source: string; providerThreadId: string | null; metadataJson: string }, nativeSessionId: string): boolean {
  if (message.source !== 'pi_sdk' || message.providerThreadId !== nativeSessionId) return false;
  try {
    return asRecord(JSON.parse(message.metadataJson)).agentKind === 'pi';
  } catch {
    return false;
  }
}

function resolveConversationCwd(conversation: ZeusConversationWithMessagesRecord): string {
  const first = conversation.messages.find((message) => message.role === 'user');
  const metadata = first ? asRecord(JSON.parse(first.metadataJson || '{}')) : {};
  return typeof metadata.cwd === 'string' ? metadata.cwd : process.cwd();
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap((item) => {
      const part = asRecord(item);
      return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n')
    .trim();
}

function readApprovalDecision(value: unknown): boolean {
  const record = asRecord(value);
  return record.decision === 'accept' || record.decision === 'acceptForSession' || record.action === 'accept';
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
    payload: asRecord(JSON.parse(request.payloadJson) as unknown),
    response: request.responseJson ? asRecord(JSON.parse(request.responseJson) as unknown) : null,
    containsSecret: request.containsSecret,
    expiresAt: request.expiresAt,
    autoResolutionState: request.autoResolutionState,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
  };
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, key.toLowerCase().includes('content') || key === 'newText' || key === 'oldText' ? '[内容已隐藏]' : value]));
}

function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string') throw piError('ZEUS_PI_TOOL_ARGUMENT_INVALID', `${label}必须是字符串。`);
  return value;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readExitStdout(error: unknown): string {
  const record = asRecord(error);
  return typeof record.stdout === 'string' ? record.stdout : '';
}

function piError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
