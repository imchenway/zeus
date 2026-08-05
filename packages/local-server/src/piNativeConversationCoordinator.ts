import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createPiSdkRuntimeDriver, modelRef, type AgentModelIdentity, type AgentRuntimeEvent, type AgentSessionIdentity, type PiZeusToolBroker, type PiZeusToolRequest, type PiZeusToolResult } from '@zeus/ai-runtime';
import type { ConversationItemRepository, ConversationRepository, ConversationServerRequestRepository, ConversationSubmissionRepository, ConversationTurnRepository, ZeusConversationWithMessagesRecord, ZeusDatabase } from '@zeus/storage';
import type { ModelConnectionService } from './modelConnectionService.js';

const execFileAsync = promisify(execFile);

interface PiConversationContext {
  conversationId: string;
  projectId: string;
  taskId: string | null;
  cwd: string;
  permissionMode: 'read-only' | 'auto' | 'full-access';
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
  cwd: string;
  prompt: string;
  model: AgentModelIdentity;
  thinkingLevel?: string;
  permissionMode: 'read-only' | 'auto' | 'full-access';
  idempotencyKey: string;
  clientUserMessageId: string;
  workspaceId?: string;
  environmentId?: string;
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

  async function startConversation(input: StartPiConversationInput) {
    const session = await driver.openSession({ cwd: input.cwd, model: input.model });
    const createdAt = options.now();
    options.conversations.create({
      id: input.conversationId,
      projectId: input.projectId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      title: input.taskTitle ?? (input.prompt.slice(0, 80) || 'Pi 会话'),
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
    contexts.set(session.nativeSessionId, { conversationId: input.conversationId, projectId: input.projectId, taskId: input.taskId ?? null, cwd: input.cwd, permissionMode: input.permissionMode, session });
    const submission = options.submissions.createOrGet({
      id: input.submissionId,
      conversationId: input.conversationId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.idempotencyKey,
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'dispatching',
      input: { text: input.prompt, context: { projectLocalPath: input.cwd, model: input.model.modelId, modelSourceId: input.model.sourceId, agentKind: 'pi', thinkingLevel: input.thinkingLevel } },
      createdAt,
      dispatchedAt: createdAt,
    });
    const run = await driver.startRun({ session, content: input.prompt, clientRequestId: input.clientUserMessageId, model: input.model, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}) });
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
    appendUserProjection(input.conversationId, session.nativeSessionId, turn.id, run.nativeRunId, input.prompt, input.clientUserMessageId, createdAt);
    options.submissions.updateStatus(submission.id, 'active', { providerTurnId: run.nativeRunId, updatedAt: run.acceptedAt });
    runs.set(run.nativeRunId, { conversationId: input.conversationId, submissionId: submission.id, turnId: turn.id, providerTurnId: run.nativeRunId });
    await options.db.save();
    publish('conversation.turn.started', input.conversationId, { turnId: run.nativeRunId, submissionId: submission.id, status: 'running' });
    return { conversationId: input.conversationId, submissionId: submission.id, providerThreadId: session.nativeSessionId, providerTurnId: run.nativeRunId, status: 'active' as const };
  }

  async function submitMessage(input: { conversation: ZeusConversationWithMessagesRecord; submissionId: string; content: string; model: AgentModelIdentity; thinkingLevel?: string; idempotencyKey: string; clientUserMessageId: string }) {
    let context = input.conversation.nativeSessionId ? contexts.get(input.conversation.nativeSessionId) : undefined;
    if (!context) {
      if (!input.conversation.nativeSessionId || !input.conversation.nativeSessionPath) throw piError('ZEUS_PI_SESSION_UNAVAILABLE', 'Pi 会话缺少可恢复的会话文件。');
      const cwd = resolveConversationCwd(input.conversation);
      const session = await driver.resumeSession({ nativeSessionId: input.conversation.nativeSessionId, nativeSessionPath: input.conversation.nativeSessionPath, cwd });
      context = { conversationId: input.conversation.id, projectId: input.conversation.projectId, taskId: input.conversation.taskId, cwd, permissionMode: input.conversation.permissionMode, session };
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
    publish('conversation.turn.started', input.conversation.id, { turnId: run.nativeRunId, submissionId: submission.id, status: 'running' });
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
      options.items.upsertCompleted({
        conversationId: run.conversationId,
        turnId: run.turnId,
        providerThreadId: event.nativeSessionId ?? '',
        providerTurnId: run.providerTurnId,
        providerItemId: itemId,
        itemType: 'agentMessage',
        phase: 'final_answer',
        payload: { agentKind: 'pi' },
        textContent: text,
        completedAt: event.createdAt,
        updatedAt: event.createdAt,
        agentKind: 'pi',
        nativeItemId: itemId,
      });
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
      publish('conversation.item.completed', run.conversationId, { turnId: run.providerTurnId, itemId, itemType: 'agentMessage', status: 'completed', phase: 'final_answer', textContent: text });
    }
    if (event.type === 'agent_settled' || event.type === 'runtime_error') {
      const failed = event.type === 'runtime_error';
      const interrupted = interruptedRuns.delete(event.nativeRunId);
      const status = interrupted ? 'interrupted' : failed ? 'failed' : 'completed';
      options.turns.upsert({
        id: run.turnId,
        conversationId: run.conversationId,
        providerThreadId: event.nativeSessionId ?? '',
        providerTurnId: run.providerTurnId,
        clientSubmissionId: run.submissionId,
        status,
        startedAt: null,
        completedAt: event.createdAt,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        ...(failed ? { error: payload } : {}),
        agentKind: 'pi',
        nativeRunId: run.providerTurnId,
      });
      if (interrupted) {
        options.submissions.updateStatus(run.submissionId, 'paused', { pausedReason: 'interrupted', resolvedAt: event.createdAt, updatedAt: event.createdAt });
      } else {
        options.submissions.updateStatus(run.submissionId, failed ? 'failed' : 'completed', { ...(failed ? { error: payload } : {}), resolvedAt: event.createdAt, updatedAt: event.createdAt });
      }
      options.conversations.updateAgentRuntime(run.conversationId, { providerState: interrupted ? 'paused' : failed ? 'failed' : 'ready', status: failed ? 'failed' : 'open' });
      runs.delete(event.nativeRunId);
      await options.db.save();
      publish('conversation.turn.completed', run.conversationId, { turnId: run.providerTurnId, submissionId: run.submissionId, status });
    }
  }

  function appendUserProjection(conversationId: string, threadId: string, turnId: string, providerTurnId: string, content: string, clientMessageId: string, createdAt: string): void {
    const itemId = `pi_user_${clientMessageId}`;
    options.items.upsertCompleted({
      conversationId,
      turnId,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId: itemId,
      itemType: 'userMessage',
      phase: 'prework',
      payload: { clientUserMessageId: clientMessageId, agentKind: 'pi' },
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
      metadata: { clientUserMessageId: clientMessageId, agentKind: 'pi', cwd: contexts.get(threadId)?.cwd },
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
    const path = safePath(context.cwd, typeof request.args.path === 'string' ? request.args.path : '.');
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
    publish('conversation.request.created', context.conversationId, { requestId: persisted.id, requestKind: kind });
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
        options.submissions.updateStatus(run.submissionId, 'paused', { pausedReason: 'interrupted', resolvedAt: timestamp, updatedAt: timestamp });
        options.conversations.updateAgentRuntime(run.conversationId, { providerState: 'paused', status: 'open' });
        runs.delete(input.providerTurnId);
        interruptedRuns.delete(input.providerTurnId);
        await options.db.save();
        publish('conversation.turn.completed', run.conversationId, { turnId: run.providerTurnId, submissionId: run.submissionId, status: 'interrupted' });
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

function safePath(cwd: string, value: string): string {
  const candidate = resolve(cwd, value);
  const rel = relative(resolve(cwd), candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw piError('ZEUS_PI_PATH_OUTSIDE_WORKSPACE', 'Pi 工具不能访问当前工作区之外的路径。');
  return candidate;
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
