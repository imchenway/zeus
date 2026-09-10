import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAccountSnapshot, CodexAppServerEvent, CodexAppServerManager, CodexCapabilitiesSnapshot, CodexThreadSnapshot, CodexTurnSnapshot, CodexTurnStartInput, CodexTurnSteerInput } from '@zeus/ai-runtime';
import { ConversationRepository, ConversationSubmissionRepository, ConversationTurnRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import { conversationDispatchInputSha256 } from '../packages/local-server/src/conversationDispatchCommandApplication.js';
import { conversationStartInputSha256 } from '../packages/local-server/src/conversationStartCommandApplication.js';
import { createZeusDataLayout, startZeusLocalServer, type RunningZeusLocalServer } from '../packages/local-server/src/index.js';
import { workManagementInputSha256 } from '../packages/local-server/src/workManagementCommandApplication.js';
import { ContextDispatchApplicationService } from '../packages/local-server/src/contextDispatchService.js';

type JsonObject = Record<string, unknown>;

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-conversation-queue-restart-'));
const dataRoot = join(probeRoot, 'data-root');
const projectRoot = join(probeRoot, 'project');
const databasePath = join(dataRoot, 'data', 'zeus.db');
const apiToken = 'conversation-queue-restart-probe-token';
const projectId = `project_${randomUUID().replaceAll('-', '')}`;
const providerThreadId = `thread_${randomUUID().replaceAll('-', '')}`;
const firstProviderTurnId = `turn_${randomUUID().replaceAll('-', '')}`;
const secondProviderTurnId = `turn_${randomUUID().replaceAll('-', '')}`;
/** 额度故障恢复后必须在同一线程建立的新轮次。 */
const quotaRecoveryTurnId = `turn_${randomUUID().replaceAll('-', '')}`;
/** Pi 写前拒绝只使用独立临时会话，不需要连接真实模型。 */
const piConversationId = `conversation_pi_${randomUUID()}`;
/** 暂停队首与后续请求用于覆盖真实 Pi 入口校验。 */
const piSubmissionIds = [randomUUID(), randomUUID()];
let runningServer: RunningZeusLocalServer | null = null;
/** 在真实上下文准备完成、尚未写出时插入一次页面状态核对。 */
let inspectPreparingDispatch: (() => Promise<void>) | null = null;
/** 保留真实上下文编译，只控制探针中的并发时机。 */
const originalCompileForDispatch = ContextDispatchApplicationService.prototype.compileForDispatch;
ContextDispatchApplicationService.prototype.compileForDispatch = async function (input) {
  /** 真实编译与审计完成后仍处于 Provider 写前窗口。 */
  const result = await originalCompileForDispatch.call(this, input);
  /** 每次并发核对只触发一次，后续编译不递归执行探针。 */
  const inspect = inspectPreparingDispatch;
  inspectPreparingDispatch = null;
  await inspect?.();
  return result;
};

try {
  await mkdir(projectRoot, { recursive: true });
  const firstProvider = createRestartProbeManager({
    providerThreadId,
    turnIds: [firstProviderTurnId],
    initialTurns: [],
  });
  runningServer = await startProbeServer(firstProvider.manager, 'before-restart');

  const projectInput = {
    name: 'ZEUS-0387 队列重启恢复探针',
    localPath: projectRoot,
    description: '只在临时 SQLite 和可控 Provider 桩中验证重启后的统一队列自动唤醒。',
  };
  const projectCreate = await requestJson(runningServer, '/api/projects', {
    method: 'POST',
    body: commandRequest({
      commandType: 'work_management.project.create',
      scopeKind: 'project',
      scopeId: projectId,
      operationIdentity: projectId,
      input: projectInput,
      inputSha256: workManagementInputSha256(projectInput),
    }),
  });
  assertBehavior(projectCreate.status === 201, `临时项目创建失败：${projectCreate.status} ${JSON.stringify(projectCreate.body)}`);

  const firstClientMessageId = `message_${randomUUID().replaceAll('-', '')}`;
  const firstConversationInput = {
    mode: 'create',
    agentKind: 'codex',
    content: '第一轮只用于形成重启前的 Provider 活动态。',
    model: 'gpt-5.6-sol',
    effort: 'low',
    permissionMode: 'read-only',
    collaborationMode: 'default',
    clientUserMessageId: firstClientMessageId,
  };
  const firstConversation = await requestJson(runningServer, `/api/projects/${projectId}/conversations`, {
    method: 'POST',
    body: commandRequest({
      commandType: 'conversation.project.create',
      scopeKind: 'project',
      scopeId: projectId,
      operationIdentity: `conversation_${randomUUID().replaceAll('-', '')}`,
      input: firstConversationInput,
      inputSha256: conversationStartInputSha256(firstConversationInput),
    }),
  });
  assertBehavior(firstConversation.status === 202, `首轮会话接纳失败：${firstConversation.status} ${JSON.stringify(firstConversation.body)}`);
  const conversationId = requiredResultString(firstConversation.body, ['conversation', 'id']);
  try {
    await waitFor(() => firstProvider.startTurnInputs.length === 1, '首轮 turn/start 未发生。');
  } catch (error) {
    const [snapshot, queueState] = await Promise.all([
      requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/snapshot-v2`),
      requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/queue-state`),
    ]);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nsnapshot=${JSON.stringify(snapshot.body, null, 2)}\nqueue=${JSON.stringify(queueState.body, null, 2)}`);
  }

  await runningServer.prepareForShutdown();
  await runningServer.close();
  runningServer = null;

  // 精确复现升级/Host 重启窗口：Provider 已结束上一轮，但 Core 的 durable projection 仍是 running。
  const database = await createZeusDatabase(databasePath);
  try {
    const conversations = new ConversationRepository(database);
    const submissions = new ConversationSubmissionRepository(database);
    const turns = new ConversationTurnRepository(database);
    const firstSubmission = submissions.listByConversation(conversationId).find((submission) => submission.clientMessageId === firstClientMessageId);
    const firstTurn = turns.listByConversation(conversationId).find((turn) => turn.providerTurnId === firstProviderTurnId);
    assertBehavior(firstSubmission, '重启前缺少首轮 submission。');
    assertBehavior(firstTurn, '重启前缺少首轮 turn。');
    submissions.updateStatus(firstSubmission.id, 'active', {
      providerTurnId: firstProviderTurnId,
      acceptedAt: firstSubmission.acceptedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    turns.upsert({ ...firstTurn, status: 'running', completedAt: null, updatedAt: new Date().toISOString() });
    conversations.bindProvider(conversationId, {
      providerId: 'codex',
      providerThreadId,
      providerModel: 'gpt-5.6-sol',
      providerState: 'active',
    });
    // 放宽首次目标绑定不能放宽原始请求或已派发消息的保护。
    for (const column of ['target_provider_turn_id', 'input_json']) {
      let rejected = false;
      try {
        database.execute(`UPDATE conversation_submissions SET ${column} = ? WHERE id = ?`, ['changed', firstSubmission.id]);
      } catch (error) {
        rejected = String(error).includes('ZEUS_IMMUTABLE_SUBMISSION_PAYLOAD');
      }
      assertBehavior(rejected, `存储层允许改写已派发消息的 ${column}`);
    }
    conversations.create({ id: piConversationId, projectId, title: 'Pi 引导写前边界', transportKind: 'codex_native', agentKind: 'pi' });
    for (const [index, id] of piSubmissionIds.entries()) {
      submissions.createOrGet({
        id,
        conversationId: piConversationId,
        idempotencyKey: id,
        requestHash: 'pi-local-boundary',
        clientMessageId: id,
        kind: 'message',
        requestedDelivery: 'queue',
        status: index === 0 ? 'paused' : 'queued',
        queuePosition: index + 1,
        input: { text: 'Pi 写前边界' },
        ...(index === 0 ? { pausedReason: 'outcome_unknown' } : {}),
        createdAt: new Date().toISOString(),
      });
    }
    await database.save();
  } finally {
    await database.close();
  }

  const completedFirstTurn: CodexTurnSnapshot = {
    id: firstProviderTurnId,
    threadId: providerThreadId,
    status: 'completed',
    completedAt: new Date().toISOString(),
    items: [],
  };
  /** 为正常续发、额度恢复和两种回显顺序分别预留轮次。 */
  const restartedProvider = createRestartProbeManager({
    providerThreadId,
    turnIds: [secondProviderTurnId, quotaRecoveryTurnId, ...Array.from({ length: 8 }, () => `turn_${randomUUID().replaceAll('-', '')}`)],
    initialTurns: [completedFirstTurn],
  });
  runningServer = await startProbeServer(restartedProvider.manager, 'after-restart');
  /** 路由真正进入 Pi 校验后，原始队首错误和写前回执必须保留。 */
  const piRequest = commandRequest({ commandType: 'conversation.queue.send_now', scopeKind: 'submission', scopeId: piSubmissionIds[1]!, operationIdentity: randomUUID(), input: {}, inputSha256: conversationDispatchInputSha256({}) });
  /** Pi 不需要启动模型就能验证本地写前拒绝。 */
  const piRejected = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${piConversationId}/queue/${piSubmissionIds[1]}/send-now`, { method: 'POST', body: piRequest });
  assertBehavior(piRejected.body.error === 'ZEUS_NATIVE_QUEUE_HEAD_REQUIRED', `Pi 队首拒绝被错误包装：${JSON.stringify(piRejected)}`);
  /** 只读查询真实路由落下的回执，不能以错误文案代替写入证据。 */
  const piDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const attempt = piDatabase.prepare('SELECT outcome, provider_write_started_at FROM command_outbox WHERE command_id = ?').get((piRequest.command as JsonObject).commandId as string);
    assertBehavior(attempt?.outcome === 'failed_before_write' && attempt.provider_write_started_at === null, 'Pi 写前拒绝产生了写出后未知回执');
  } finally {
    piDatabase.close();
  }

  const secondClientMessageId = `message_${randomUUID().replaceAll('-', '')}`;
  const secondMessageInput = {
    content: '第二轮必须在 Provider 权威确认 idle 后自动离开排队态。',
    idempotencyKey: `queue_${randomUUID().replaceAll('-', '')}`,
    clientUserMessageId: secondClientMessageId,
    delivery: 'queue',
  };
  const secondMessage = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: commandRequest({
      commandType: 'conversation.message.submit',
      scopeKind: 'product_conversation',
      scopeId: conversationId,
      operationIdentity: `message_${randomUUID().replaceAll('-', '')}`,
      input: secondMessageInput,
      inputSha256: conversationDispatchInputSha256(secondMessageInput),
    }),
  });
  assertBehavior(secondMessage.status === 202, `重启后消息接纳失败：${secondMessage.status} ${JSON.stringify(secondMessage.body)}`);

  await waitFor(() => restartedProvider.readThreadCalls > 0, '重启后的旧 active 投影没有进入 Provider thread authority。', 8_000);
  await waitFor(() => restartedProvider.startTurnInputs.length === 1, 'Provider 已确认 idle，但统一队列没有被 queue.changed 再次唤醒。', 8_000);
  const secondStart = restartedProvider.startTurnInputs[0];
  assertBehavior(secondStart?.clientUserMessageId === secondClientMessageId, '重启后 turn/start 没有消费新消息的稳定 clientUserMessageId。');

  const snapshot = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/snapshot-v2`);
  const snapshotBody = snapshot.body;
  const queue = Array.isArray(snapshotBody.queue) ? snapshotBody.queue : [];
  const secondQueueEntry = queue.find((entry) => isRecord(entry) && entry.clientMessageId === secondClientMessageId);
  assertBehavior(!secondQueueEntry || secondQueueEntry.status !== 'queued', '新消息仍停留在 queued，未真正进入 Provider。');

  // 复现额度耗尽后线程保留 systemError；恢复额度不应要求重建产品会话或重发失败轮次。
  await waitFor(async () => {
    /** Provider 接收请求早于服务落库，必须等第二轮的接纳事实已可查询。 */
    const activeQueue = await requestJson(runningServer!, `/api/projects/${projectId}/conversations/${conversationId}/queue-state`);
    return isRecord(activeQueue.body.state) && activeQueue.body.state.type === 'active' && activeQueue.body.state.turnId === secondProviderTurnId;
  }, '第二轮尚未持久接纳。');
  await restartedProvider.failLatestTurn();
  // 用户是在界面显示本轮失败后恢复额度，先等待真实服务处理完失败通知。
  await waitFor(async () => {
    /** 队列查询使用服务的实际运行投影，不用固定延迟猜测事件处理完成。 */
    const failedQueue = await requestJson(runningServer!, `/api/projects/${projectId}/conversations/${conversationId}/queue-state`);
    return isRecord(failedQueue.body.state) && (failedQueue.body.state.type === 'idle' || failedQueue.body.state.type === 'paused');
  }, '服务尚未收口额度失败轮次。');
  /** 用户额度恢复后明确提交的下一条消息。 */
  const continueClientMessageId = `message_${randomUUID().replaceAll('-', '')}`;
  /** 沿用正常消息入口及真实统一队列，只控制外部 Provider 回执。 */
  const continueInput = { content: '额度已恢复，继续', idempotencyKey: `queue_${randomUUID().replaceAll('-', '')}`, clientUserMessageId: continueClientMessageId, delivery: 'queue' };
  /** 原会话中的新消息接纳结果。 */
  const continued = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: commandRequest({
      commandType: 'conversation.message.submit',
      scopeKind: 'product_conversation',
      scopeId: conversationId,
      operationIdentity: continueClientMessageId,
      input: continueInput,
      inputSha256: conversationDispatchInputSha256(continueInput),
    }),
  });
  assertBehavior(continued.status === 202, `额度恢复后的继续消息接纳失败：${continued.status}`);
  try {
    await waitFor(() => restartedProvider.startTurnInputs.length === 2, '上一轮已失败结束，但 systemError 仍阻止新消息发起下一轮。', 8_000);
  } catch (error) {
    /** 失败时保留真实队列原因，避免把探针超时混同为具体产品根因。 */
    const currentQueue = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/queue-state`);
    /** 快照用于定位旧失败轮次与新提交之间的持久关联。 */
    const currentSnapshot = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/snapshot-v2`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ queue: currentQueue.body, snapshot: currentSnapshot.body })}`);
  }
  assertBehavior(restartedProvider.startTurnInputs[1]?.clientUserMessageId === continueClientMessageId, '额度恢复后重发了旧消息。');
  assertBehavior(restartedProvider.startTurnInputs[1]?.threadId === providerThreadId, '额度恢复后丢失了原线程身份。');

  /** 连续排队的附件始终使用本探针项目中的原资源。 */
  const queuedAttachmentPath = join(projectRoot, '排队附件.md');
  await writeFile(queuedAttachmentPath, '连续排队附件');
  // 两种到达顺序都走真实消息命令、事件投影和队列调度；未知请求不能被重发。
  for (const echoOrder of ['before', 'after'] as const) {
    /** 当前活动轮结束前连续排入三条相同正文的补充。 */
    const activeIndex = restartedProvider.startTurnInputs.length - 1;
    /** 相同正文依靠独立客户端身份保留，最后一条附带资源。 */
    const clients = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, clientUserMessageId] of clients.entries()) {
      /** 由应用消息入口持久保存原始提交。 */
      const input = {
        content: `连续排队，相同正文，回显顺序 ${echoOrder}`,
        clientUserMessageId,
        idempotencyKey: randomUUID(),
        delivery: 'queue',
        ...(index === 2 ? { attachments: [{ name: '排队附件.md', localPath: queuedAttachmentPath, mime: 'text/markdown', size: Buffer.byteLength('连续排队附件') }] } : {}),
      };
      /** 接纳到本地队列不代表模型已收到。 */
      const result = await requestJson(runningServer, `/api/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: commandRequest({ commandType: 'conversation.message.submit', scopeKind: 'product_conversation', scopeId: conversationId, operationIdentity: randomUUID(), input, inputSha256: conversationDispatchInputSha256(input) }),
      });
      assertBehavior(result.status === 202, `补充消息入队失败：${JSON.stringify(result.body)}`);
    }
    restartedProvider.loseNextReceipt(echoOrder);
    inspectPreparingDispatch = async () => {
      /** 页面刷新通过既有只读核对命令，不直接改写探针数据。 */
      const input = { intent: 'check' };
      /** 检查期间保留真实 dispatching 状态，而不是改成恢复或伪造模型接纳。 */
      const result = await requestJson(runningServer!, `/api/projects/${projectId}/conversations/${conversationId}/queue/recover`, {
        method: 'POST',
        body: commandRequest({ commandType: 'conversation.queue.recover', scopeKind: 'product_conversation', scopeId: conversationId, operationIdentity: randomUUID(), input, inputSha256: conversationDispatchInputSha256(input) }),
      });
      assertBehavior(result.status === 202 && isRecord(result.body.state) && result.body.state.type === 'dispatching', `准备发送被历史核对暂停：${JSON.stringify(result)}`);
    };
    await restartedProvider.completeTurn(activeIndex);
    await waitFor(() => restartedProvider.startTurnInputs.length === activeIndex + 2, '上一轮结束后没有发送队首补充。');
    if (echoOrder === 'after') {
      await waitFor(async () => {
        /** 错误回执已落库后才投递用户回显。 */
        const response = await requestJson(runningServer!, `/api/projects/${projectId}/conversations/${conversationId}/queue-state`);
        return JSON.stringify(response.body).includes('outcome_unknown');
      }, '回执丢失没有保留结果待确认状态。');
      await restartedProvider.publishUserMessage(activeIndex + 1);
    }
    await restartedProvider.completeTurn(activeIndex + 1);
    await waitFor(() => restartedProvider.startTurnInputs.length === activeIndex + 3, `回显 ${echoOrder} 后第二条补充没有自动发送。`);
    await restartedProvider.completeTurn(activeIndex + 2);
    await waitFor(() => restartedProvider.startTurnInputs.length === activeIndex + 4, `回显 ${echoOrder} 后第三条补充没有自动发送。`);
    for (const client of clients) assertBehavior(restartedProvider.startTurnInputs.filter((entry) => entry.clientUserMessageId === client).length === 1, '补充消息必须按原身份恰好发送一次。');
    assertBehavior(JSON.stringify(restartedProvider.startTurnInputs.slice(activeIndex + 1).map((entry) => entry.clientUserMessageId)) === JSON.stringify(clients), '连续排队改变了原消息顺序');
    assertBehavior(JSON.stringify(restartedProvider.startTurnInputs.at(-1)!.input).includes(queuedAttachmentPath), '连续排队丢失了附件原路径');
  }

  /** 完整本地服务上复现引导已接纳但回显延迟的连续发送。 */
  const steering = await verifyContinuousSteering(runningServer, conversationId, restartedProvider);

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        steering,
        piPrewriteRejection: true,
        immutablePayloadProtected: true,
        restartCount: 1,
        staleLocalTurnReconciled: true,
        providerAuthorityReads: restartedProvider.readThreadCalls,
        queueChangedRedispatch: true,
        secondProviderTurnId,
        secondClientMessageIdPreserved: true,
        manualRetryRequired: false,
        lostReceiptEchoOrders: ['before', 'after'],
        queuedFollowupsSentOnce: true,
        preparingDispatchSurvivesHistoryCheck: true,
        threeIdenticalQueuedMessagesWithAttachment: true,
        quotaFailureCanContinue: true,
        temporaryDatabaseCleanup: 'finally',
      },
      null,
      2,
    ),
  );
} finally {
  ContextDispatchApplicationService.prototype.compileForDispatch = originalCompileForDispatch;
  if (runningServer) {
    await runningServer.prepareForShutdown().catch(() => undefined);
    await runningServer.close().catch(() => undefined);
  }
  await rm(probeRoot, { recursive: true, force: true });
}

/** 从真实 HTTP 入口检查连续引导、回显、队首保护与写入边界，只写临时数据。 */
async function verifyContinuousSteering(server: RunningZeusLocalServer, conversationId: string, provider: ReturnType<typeof createRestartProbeManager>) {
  /** 只读查看本探针数据库，不绕过产品命令修改提交。 */
  const db = new DatabaseSync(databasePath, { readOnly: true });
  /** 路径和原资源都位于临时项目。 */
  const attachmentPath = join(projectRoot, '引导附件.md');
  await writeFile(attachmentPath, '引导附件保持原样');
  /** 所有 HTTP 操作均绑定当前临时会话。 */
  const base = `/api/projects/${projectId}/conversations/${conversationId}`;
  /** 提交内容相同但身份各异，不能被按正文合并。 */
  const enqueue = async (attachments = false, delivery = 'queue', expectedTurnId?: string) => {
    const input = {
      content: '连续引导，保留这条独立消息',
      delivery,
      expectedTurnId,
      idempotencyKey: randomUUID(),
      clientUserMessageId: randomUUID(),
      ...(attachments ? { attachments: [{ name: '引导附件.md', localPath: attachmentPath, mime: 'text/markdown', size: Buffer.byteLength('引导附件保持原样') }] } : {}),
    };
    const response = await requestJson(server, `${base}/messages`, {
      method: 'POST',
      body: commandRequest({ commandType: 'conversation.message.submit', scopeKind: 'product_conversation', scopeId: conversationId, operationIdentity: randomUUID(), input, inputSha256: conversationDispatchInputSha256(input) }),
    });
    assertBehavior(response.status === 202, `连续消息接纳失败：${JSON.stringify(response.body)}`);
    return requiredResultString(response.body, ['submission', 'id']);
  };
  /** 持久正文、摘要与客户端编号必须在引导前后保持一致。 */
  const submission = (id: string) => db.prepare('SELECT * FROM conversation_submissions WHERE id = ?').get(id)!;
  /** 相同请求体可重复点击，经过真实命令去重。 */
  const steerRequest = (id: string) => commandRequest({ commandType: 'conversation.queue.send_now', scopeKind: 'submission', scopeId: id, operationIdentity: randomUUID(), input: {}, inputSha256: conversationDispatchInputSha256({}) });
  /** 模拟页面检查处理状态，引发真实历史核对而不派发新消息。 */
  const inspect = () =>
    requestJson(server, `${base}/queue/recover`, {
      method: 'POST',
      body: commandRequest({
        commandType: 'conversation.queue.recover',
        scopeKind: 'product_conversation',
        scopeId: conversationId,
        operationIdentity: randomUUID(),
        input: { intent: 'check' },
        inputSha256: conversationDispatchInputSha256({ intent: 'check' }),
      }),
    });
  try {
    /** 先排入三条，前两条引导回显持续延迟。 */
    const ids = [await enqueue(), await enqueue(), await enqueue(true)];
    /** 非队首请求必须在写入前被拒绝。 */
    const early = await requestJson(server, `${base}/queue/${ids[1]}/send-now`, { method: 'POST', body: steerRequest(ids[1]!) });
    assertBehavior(early.status === 400 && early.body.error === 'ZEUS_NATIVE_QUEUE_HEAD_REQUIRED' && provider.steerTurnInputs.length === 0, `非队首引导不应写出或误报未知：${JSON.stringify(early)}`);
    for (const id of ids) {
      const before = submission(id);
      const body = steerRequest(id);
      const results = await Promise.all([requestJson(server, `${base}/queue/${id}/send-now`, { method: 'POST', body }), requestJson(server, `${base}/queue/${id}/send-now`, { method: 'POST', body })]);
      assertBehavior(
        results.every((result) => result.status === 202 && (result.body.submission as JsonObject)?.delivery === 'steer_now'),
        `原队列转引导必须返回一致的引导投影：${JSON.stringify(results)}`,
      );
      /** 下一次点击使用新的操作身份，原提交状态仍必须阻止重复写出。 */
      const repeated = await requestJson(server, `${base}/queue/${id}/send-now`, { method: 'POST', body: steerRequest(id) });
      assertBehavior(repeated.status === 409 && repeated.body.error === 'ZEUS_NATIVE_SUBMISSION_NOT_QUEUED', `新的重复点击绕过了提交派发保护：${JSON.stringify(repeated)}`);
      assertBehavior((await inspect()).status === 202, '活动轮次检查失败');
      const after = submission(id);
      assertBehavior(after.status === 'dispatching' && after.target_provider_turn_id === after.provider_turn_id, '无回显的活动引导必须保持等待处理');
      for (const field of ['id', 'input_json', 'request_hash', 'client_message_id']) assertBehavior(before[field] === after[field], `引导修改了原始 ${field}`);
      assertBehavior(provider.steerTurnInputs.filter((entry) => entry.clientUserMessageId === after.client_message_id).length === 1, '重复点击造成重复引导');
    }
    assertBehavior(provider.steerTurnInputs.length === 3 && JSON.stringify(provider.steerTurnInputs[2]!.input).includes(attachmentPath), '连续引导顺序或附件丢失');
    for (let index = 0; index < 3; index += 1) await provider.publishSteeringMessage(index);
    await waitFor(() => ids.every((id) => submission(id).status === 'resolved'), '延迟回显没有确认全部原引导');
    /** 直接引导也经过相同发送与精确回显路径。 */
    const directId = await enqueue(false, 'steer_now', provider.steerTurnInputs[0]!.turnId);
    await inspect();
    assertBehavior(submission(directId).status === 'dispatching', '直接引导无回显时被误暂停');
    await provider.publishSteeringMessage(3);
    await waitFor(() => submission(directId).status === 'resolved', '直接引导未按精确身份确认');
    /** 本地仍认为活动，但 Provider 在引导到达前结束目标轮次。 */
    const endedId = await enqueue(true);
    provider.rejectNextSteer('ended');
    const startsBefore = provider.startTurnInputs.length;
    const ended = await requestJson(server, `${base}/queue/${endedId}/send-now`, { method: 'POST', body: steerRequest(endedId) });
    assertBehavior(ended.status === 202 && requiredResultString(ended.body, ['submission', 'id']) !== endedId, '明确拒绝必须返回实际下一轮替代提交');
    await waitFor(() => provider.startTurnInputs.length === startsBefore + 1, '明确拒绝没有进入下一轮').catch(async (error) => {
      throw new Error(
        `${String(error)}：${JSON.stringify({ queue: await requestJson(server, `${base}/queue-state`), submissions: db.prepare('SELECT id, status, paused_reason, error_json FROM conversation_submissions WHERE conversation_id = ?').all(conversationId) })}`,
      );
    });
    assertBehavior(JSON.stringify(provider.startTurnInputs.at(-1)!.input).includes(attachmentPath), '明确回队丢失附件');
    /** 最后制造真正未知，后续队首必须被保护且在查询中可见。 */
    const unknownId = await enqueue();
    const blockedId = await enqueue();
    provider.rejectNextSteer('unknown');
    const unknownBody = steerRequest(unknownId);
    const unknown = await requestJson(server, `${base}/queue/${unknownId}/send-now`, { method: 'POST', body: unknownBody });
    assertBehavior(unknown.status === 409 && unknown.body.error === 'ZEUS_CONVERSATION_DISPATCH_COMMAND_OUTCOME_UNKNOWN', '真正未知缺少恢复保护');
    await inspect();
    const queue = await requestJson(server, `${base}/queue-state`);
    assertBehavior(
      (queue.body.submissions as JsonObject[]).some((entry) => entry.id === unknownId && entry.status === 'paused' && entry.providerTurnId),
      '有目标轮次的暂停消息被界面队列隐藏',
    );
    const callsBefore = provider.steerTurnInputs.length;
    await requestJson(server, `${base}/queue/${unknownId}/send-now`, { method: 'POST', body: unknownBody });
    const blocked = await requestJson(server, `${base}/queue/${blockedId}/send-now`, { method: 'POST', body: steerRequest(blockedId) });
    assertBehavior(blocked.status === 400 && blocked.body.error === 'ZEUS_NATIVE_QUEUE_HEAD_REQUIRED' && provider.steerTurnInputs.length === callsBefore, '真正未知或后续消息被重发');
    await provider.completeTurn(provider.startTurnInputs.length - 1);
    await inspect();
    assertBehavior(submission(unknownId).status === 'paused' && provider.steerTurnInputs.length === callsBefore, '轮次结束但无回显的未知引导被自动重发或确认');
    return {
      consecutiveQueuedSteers: 3,
      directSteer: true,
      duplicateClicksSentOnce: true,
      delayedEchoAcrossRefresh: true,
      attachmentPreserved: true,
      endedTurnRequeued: true,
      unknownVisibleAndNotReplayed: true,
      terminalWithoutEchoProtected: true,
    };
  } finally {
    db.close();
  }
}

async function startProbeServer(manager: CodexAppServerManager, instanceId: string): Promise<RunningZeusLocalServer> {
  return startZeusLocalServer({
    dbPath: databasePath,
    dataLayout: createZeusDataLayout(dataRoot),
    apiToken,
    keychainService: 'dev.hypha.zeus.test.conversation-queue-restart',
    projectRoot: probeRoot,
    currentAppVersion: '0.3.82',
    codexAppServerManager: manager,
    codexNativeEnabled: true,
    codexRuntimeCommandPath: '/usr/bin/true',
    codexHome: join(dataRoot, 'providers', 'codex'),
    telegramToken: '',
    executionHost: {
      instanceId: `conversation-queue-restart-${instanceId}`,
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
      mode: 'embedded',
    },
  });
}

function createRestartProbeManager(input: { providerThreadId: string; turnIds: string[]; initialTurns: CodexTurnSnapshot[] }): {
  manager: CodexAppServerManager;
  startTurnInputs: CodexTurnStartInput[];
  /** 记录所有引导请求，回显独立投递以覆盖延迟窗口。 */
  steerTurnInputs: CodexTurnSteerInput[];
  /** 模拟明确结束轮次与写出后未知，不触碰外部 Provider。 */
  rejectNextSteer(mode: 'ended' | 'unknown'): void;
  /** 从原引导请求投递精确回显。 */
  publishSteeringMessage(index: number): Promise<void>;
  readonly readThreadCalls: number;
  /** 控制下一次发送的回显与错误回执顺序。 */
  loseNextReceipt(order: 'before' | 'after'): void;
  /** 投递带有原客户端身份的模型回显。 */
  publishUserMessage(index: number): Promise<void>;
  /** 结束活动轮以唤醒下一条消息。 */
  completeTurn(index: number): Promise<void>;
  /** 控制真实服务收到的失败终态通知，不调用付费模型。 */
  failLatestTurn(): Promise<void>;
} {
  const generationId = `generation_${randomUUID().replaceAll('-', '')}`;
  const capabilities: CodexCapabilitiesSnapshot = {
    generationId,
    initializedAt: new Date().toISOString(),
    providerVersion: 'restart-probe',
    protocolVersion: 'codex-app-server-v2',
    models: [
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol Probe',
        supportedReasoningEfforts: ['low'],
        defaultReasoningEffort: 'low',
        serviceTiers: [],
        defaultServiceTier: null,
        raw: {},
      },
    ],
    supportedModels: ['gpt-5.6-sol'],
    modelBudgets: {
      'gpt-5.6-sol': {
        contextWindowTokens: 258_000,
        reservedOutputTokens: 32_000,
        contextWindowSource: `conversation_queue_restart_probe:${generationId}`,
        reservedOutputSource: `conversation_queue_restart_probe:${generationId}`,
        checkedAt: new Date().toISOString(),
      },
    },
    preflightTokenCount: { state: 'unavailable', exact: false, reason: 'deterministic restart probe' },
    goals: { supported: false, enabled: false, stage: null },
  };
  const account: CodexAccountSnapshot = {
    generationId,
    requiresOpenaiAuth: true,
    signedIn: true,
    accountType: 'chatgpt',
    planType: 'probe',
    accountScopeId: 'conversation-queue-restart-probe',
  };
  const listeners = new Set<(event: CodexAppServerEvent) => void | Promise<void>>();
  const startTurnInputs: CodexTurnStartInput[] = [];
  /** 引导接纳与历史回显分开，复现真实 Provider 的输入缓冲。 */
  const steerTurnInputs: CodexTurnSteerInput[] = [];
  /** 故障只影响下一次引导。 */
  let nextSteerFailure: 'ended' | 'unknown' | null = null;
  const turns = [...input.initialTurns];
  let readThreadCalls = 0;
  /** 只丢失下一次成功回执，实际用户输入仍被模型接收。 */
  let lostReceiptOrder: 'before' | 'after' | null = null;
  /** 同一实例的事件序号持续推进。 */
  let eventSequence = 0;
  /** 通过应用真实订阅入口推进事件。 */
  const emit = async (method: string, params: JsonObject): Promise<void> => {
    /** 保留独立事件身份以通过幂等摄取。 */
    const event = { generationId, sequence: ++eventSequence, method, params, receivedAt: new Date().toISOString() };
    await Promise.all([...listeners].map((listener) => listener(event)));
  };
  /** 从原请求还原用户回显，不制造另一个客户端编号。 */
  const publishUserMessage = async (index: number): Promise<void> => {
    /** 初始旧历史不计入本实例的新请求编号。 */
    const turn = turns[input.initialTurns.length + index]!;
    /** 条目编号在重复历史读取中保持一致。 */
    const item = { type: 'userMessage', id: `user_${turn.id}`, clientId: startTurnInputs[index]!.clientUserMessageId, content: startTurnInputs[index]!.input };
    turn.items = [item];
    await emit('item/completed', { threadId: input.providerThreadId, turnId: turn.id, item });
  };
  /** 完成事实同时供实时事件和权威历史读取使用。 */
  const completeTurn = async (index: number): Promise<void> => {
    /** 按本实例的派发顺序找到真实活动轮。 */
    const turn = turns[input.initialTurns.length + index]!;
    turn.status = 'completed';
    turn.completedAt = new Date().toISOString();
    await emit('turn/completed', { threadId: input.providerThreadId, turn });
  };
  const threadSnapshot = (): CodexThreadSnapshot => ({
    id: input.providerThreadId,
    status: {
      type: turns.some((turn) => String(turn.status).toLowerCase() === 'active') ? 'active' : turns.at(-1)?.status === 'failed' ? 'systemError' : 'idle',
      ...(turns.some((turn) => String(turn.status).toLowerCase() === 'active') ? { activeFlags: [] } : {}),
    },
    turns: [...turns],
    providerSettings: { generationId, sequence: 1, model: 'gpt-5.6-sol', effort: 'low', serviceTier: null },
  });
  const implementation = {
    ensureReady: async () => capabilities,
    readAccount: async () => account,
    readAccountRateLimits: async () => ({ generationId, rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null, planType: null }, rateLimitsByLimitId: null }),
    readAccountUsage: async () => ({ generationId, summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null }),
    startThread: async () => threadSnapshot(),
    resumeThread: async () => threadSnapshot(),
    readThread: async () => {
      readThreadCalls += 1;
      return threadSnapshot();
    },
    listThreadTurns: async () => ({ data: [...turns].reverse(), nextCursor: null }),
    listThreads: async () => ({ data: [threadSnapshot()], nextCursor: null }),
    listSkills: async ({ cwds }: { cwds?: string[] }) => (cwds ?? []).map((cwd) => ({ cwd, skills: [], errors: [] })),
    startTurn: async (turnInput: CodexTurnStartInput) => {
      turnInput.requestWritten?.();
      startTurnInputs.push(turnInput);
      const turnId = input.turnIds[startTurnInputs.length - 1];
      if (!turnId) throw new Error('重启探针没有为 turn/start 预留 Provider turn id。');
      const turn: CodexTurnSnapshot = { id: turnId, threadId: input.providerThreadId, status: 'active', items: [] };
      turns.push(turn);
      if (lostReceiptOrder) {
        /** 故障只影响本次回执，后续消息使用正常响应。 */
        const order = lostReceiptOrder;
        lostReceiptOrder = null;
        await emit('turn/started', { threadId: input.providerThreadId, turn });
        if (order === 'before') await publishUserMessage(startTurnInputs.length - 1);
        throw Object.assign(new Error('已写出的成功回执无法读取'), { code: 'ZEUS_CODEX_RPC_PROTOCOL_ERROR' });
      }
      return turn;
    },
    /** 先接纳输入，不提前伪造用户消息回显。 */
    steerTurn: async (steerInput: CodexTurnSteerInput) => {
      steerTurnInputs.push(steerInput);
      const failure = nextSteerFailure;
      nextSteerFailure = null;
      if (failure === 'ended') {
        const turn = turns.find((entry) => entry.id === steerInput.turnId)!;
        turn.status = 'completed';
        turn.completedAt = new Date().toISOString();
        throw new Error('no active turn to steer');
      }
      if (failure === 'unknown') throw Object.assign(new Error('引导写出后连接断开'), { code: 'ZEUS_CODEX_RPC_PROTOCOL_ERROR' });
      return { turnId: steerInput.turnId };
    },
    detectExternalAgentConfig: async () => ({ status: 'not_found', sourceRoot: null, candidates: [], warnings: [] }),
    readExternalAgentImportHistories: async () => [],
    subscribeExternalAgentImport: () => () => undefined,
    subscribeRpcRetries: () => () => undefined,
    subscribe: (listener: (event: CodexAppServerEvent) => void | Promise<void>) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => ({ type: 'ready' as const, generationId, capabilities }),
    hasGeneration: (candidate: string) => candidate === generationId,
    capabilitiesForGeneration: (candidate: string) => (candidate === generationId ? capabilities : null),
    generationForThread: (threadId: string) => (threadId === input.providerThreadId ? generationId : null),
    listRuntimeGenerations: () => [{ generationId, commandPath: '/usr/bin/true', state: 'ready' as const, active: true, activeThreadCount: 1, pendingRequestCount: 0 }],
    prepareForShutdown: async () => undefined,
    close: async () => undefined,
  };
  const manager = new Proxy(implementation as unknown as CodexAppServerManager, {
    get(target, property, receiver) {
      if (Reflect.has(target as object, property)) return Reflect.get(target as object, property, receiver) as unknown;
      return () => {
        throw new Error(`重启探针尚未实现 Provider 方法：${String(property)}`);
      };
    },
  });
  return {
    manager,
    startTurnInputs,
    steerTurnInputs,
    rejectNextSteer(mode) {
      nextSteerFailure = mode;
    },
    async publishSteeringMessage(index) {
      /** 按原始客户端身份附加到对应活动轮，不合并相同正文。 */
      const sent = steerTurnInputs[index]!;
      /** 原生项目身份在快照和事件中保持相同。 */
      const item = { type: 'userMessage', id: `steer_${sent.clientUserMessageId}`, clientId: sent.clientUserMessageId, content: sent.input };
      /** 保留同轮已存在的消息。 */
      const turn = turns.find((entry) => entry.id === sent.turnId)!;
      turn.items = [...(turn.items ?? []), item];
      await emit('item/completed', { threadId: input.providerThreadId, turnId: turn.id, item });
    },
    loseNextReceipt(order) {
      lostReceiptOrder = order;
    },
    publishUserMessage,
    completeTurn,
    /** 失败与回显共用递增序号，避免后续事件被当作重复通知。 */
    async failLatestTurn() {
      /** 故障只结束最新轮次，旧历史和线程身份保持真实关联。 */
      const turn = turns.at(-1);
      assertBehavior(turn, '没有可结束的 Provider 轮次。');
      turn.status = 'failed';
      turn.completedAt = new Date().toISOString();
      turn.error = { message: '账户额度已用尽', codexErrorInfo: 'usageLimitExceeded' };
      await emit('turn/completed', { threadId: input.providerThreadId, turn });
    },
    get readThreadCalls() {
      return readThreadCalls;
    },
  };
}

function commandRequest(input: { commandType: string; scopeKind: 'project' | 'product_conversation' | 'submission'; scopeId: string; operationIdentity: string; input: JsonObject; inputSha256: string }): JsonObject {
  return {
    command: {
      schemaGeneration: 'zeus-command-envelope-v1',
      commandId: randomUUID(),
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'conversation-queue-restart-probe' },
      scope: { kind: input.scopeKind, id: input.scopeId },
      expectedRevision: null,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
    },
    input: input.input,
  };
}

async function requestJson(server: RunningZeusLocalServer, path: string, input: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: { origin: 'app://zeus', authorization: `Bearer ${apiToken}`, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as JsonObject) : {} };
}

/** 等待同步或真实 HTTP 状态，避免固定延迟掩盖恢复竞态。 */
async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function requiredResultString(value: unknown, path: string[]): string {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  if (typeof current !== 'string' || !current) throw new Error(`响应缺少 ${path.join('.')}：${JSON.stringify(value)}`);
  return current;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`会话队列重启恢复探针失败：${message}`);
}
