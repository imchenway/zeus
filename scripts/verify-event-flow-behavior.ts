import { createInitialSessionState, sessionReducer } from '../apps/desktop/src/renderer/session/sessionReducer.js';
import { composerQueuedSubmissions, visibleQueuedSubmissions } from '../apps/desktop/src/renderer/session/conversationQueuePresentation.js';
import { mkdtemp, rm, mkdir, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodexAppServerEvent, CodexAppServerManager } from '../packages/ai-runtime/src/index.js';
import type { TranscriptTurnWorkRow } from '../apps/desktop/src/renderer/session/ConversationTranscript.js';
import type { NativeConversationSnapshot, NativeSessionItemBuffer, NativeQueueSnapshot, NativeSessionState } from '../apps/desktop/src/renderer/session/sessionTypes.js';
import { reconcileConversationHistoryCache } from '../apps/desktop/src/renderer/session/conversationSnapshotV2Adapter.js';
import type { TurnChangeSet } from '../packages/shared/src/conversationResources.js';
import { describeUserFacingError } from '../packages/shared/src/userFacingError.js';
import { isProviderBlockingTurnFailure, projectConversationTurnFailure } from '../packages/storage/src/conversationSnapshotV2.js';
import { createCodexProviderEventFlow } from '../packages/local-server/src/codexProviderEventFlow.js';
import { projectCodexProviderEvent, type CodexProviderEventProjectionDependencies } from '../packages/local-server/src/codexProviderEventProjection.js';
import { isProviderResponseStreamDisconnected } from '../packages/local-server/src/codexNativeConversationPolicy.js';
import { filterCompatibilitySnapshotItemAliases } from '../packages/local-server/src/codexProviderHistoryProjection.js';
import { conversationWorkExecutionState } from '../packages/local-server/src/conversationWorkExecutionState.js';
import { selectAutomaticQueueDispatchCandidate } from '../packages/local-server/src/conversationQueueCoreMutationApplication.js';
import { ConversationEventFlowControl } from '../packages/local-server/src/eventFlowControl.js';
import { ConversationSyncProtocol } from '../packages/local-server/src/conversationSyncProtocol.js';
import { type ConversationRealtimeSocket, registerConversationSyncRoutes } from '../packages/local-server/src/conversationSyncRoutes.js';
import { createTurnChangeSetService, toRealtimeChangeSet } from '../packages/local-server/src/turnChangeSets.js';
import {
  AuditLogRepository,
  ConversationRepository,
  ConversationTurnRepository,
  IdempotencyRequestRepository,
  ProjectRepository,
  TurnChangeFileRepository,
  TurnChangeSetRepository,
  ConversationProviderItemRepository,
  ConversationSyncEventRepository,
  type ZeusConversationTurnRecord,
  createZeusDatabase,
  resolveSnapshotProviderItemId,
  scopedSnapshotProviderItemId,
} from '../packages/storage/src/index.js';

/** 验证字符串与对象形式的官方错误共用脱敏投影，并只按结构化字段决定新事件语义。 */
function verifyProviderStreamFailurePresentation(): Record<string, unknown> {
  /** 使用真实故障文案，覆盖 request ID 存在时的完整匹配。 */
  const rawMessage =
    'stream disconnected before completion: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 5a794051-cd4c-45b3-8f47-8187e7cd7a75 in your message.';
  /** 生产投影必须把模糊的 other 收窄为稳定断流身份。 */
  const failure = projectConversationTurnFailure({
    code: 'ZEUS_CODEX_TURN_FAILED',
    message: rawMessage,
    providerStatus: 'failed',
    providerError: { codexErrorInfo: 'other' },
  });
  /** 中文展示必须复用统一错误目录，不能裸露英文 Provider 文案。 */
  const explanation = describeUserFacingError(failure, 'zh-CN');
  assertBehavior(failure.category === 'network', '回复流断开必须归类为网络连接问题。');
  assertBehavior(failure.cause?.code === 'responseStreamDisconnected', 'other 必须收窄为 responseStreamDisconnected。');
  assertBehavior(isProviderResponseStreamDisconnected(Object.assign(new Error(rawMessage), { code: 'ZEUS_CODEX_TURN_FAILED' })), '只有明确的回复流断开才应启动后台权威状态核对。');
  assertBehavior(!isProviderResponseStreamDisconnected(Object.assign(new Error('Rate limit reached'), { code: 'ZEUS_CODEX_TURN_FAILED' })), '非连接故障不得进入回复流恢复重试。');
  assertBehavior(explanation.message === 'AI 服务在回复结束前断开了连接，因此没有收到完整回复。', '断流必须显示明确的本地化说明。');
  assertBehavior(explanation.details?.includes('5a794051-cd4c-45b3-8f47-8187e7cd7a75'), '诊断详情必须保留可提交给服务方的 request ID。');
  assertBehavior(isProviderBlockingTurnFailure({ code: 'ZEUS_CODEX_TURN_FAILED', message: rawMessage, providerError: { codexErrorInfo: 'other' } }), '已确认的历史断流必须暂停后续执行。');

  /** 对象形式错误保留官方判别字段和 HTTP 状态，但敏感信息不得进入会话。 */
  const objectFailureRecord = {
    code: 'ZEUS_CODEX_TURN_FAILED',
    message: 'OpenAI request failed. Request ID req_official_503. api_key=sk-object-secret /Users/private/workspace\n    at provider.ts:42:1',
    providerStatus: 'failed',
    providerError: {
      codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
      additionalDetails: 'Request ID req_official_503\nAuthorization: Bearer sk-additional-secret\n/Users/private/log.txt',
    },
  };
  const objectFailure = projectConversationTurnFailure(objectFailureRecord);
  const objectExplanation = describeUserFacingError(objectFailure, 'zh-CN');
  assertBehavior(objectFailure.category === 'network', 'HTTP 503 的响应流错误必须归类为连接故障。');
  assertBehavior(objectFailure.cause?.code === 'responseStreamConnectionFailed', '对象形式错误必须保留官方判别字段。');
  assertBehavior(objectFailure.additionalDetails.includes('HTTP 状态：503'), '对象形式错误必须展示 HTTP 状态。');
  assertBehavior(objectExplanation.details.includes('responseStreamConnectionFailed'), '展开详情必须展示官方错误码。');
  assertBehavior(objectExplanation.details.includes('req_official_503'), '展开详情必须保留官方请求标识。');
  assertBehavior(!/sk-object-secret|sk-additional-secret|\/Users\/private|provider\.ts:42/iu.test(objectExplanation.details), '错误详情不得暴露凭据、本机路径或堆栈。');
  assertBehavior(isProviderBlockingTurnFailure(objectFailureRecord), '服务端 503 错误必须暂停会话。');

  /** 字符串形式限流错误直接命中现有错误目录。 */
  const rateLimitRecord = { code: 'ZEUS_CODEX_TURN_FAILED', message: 'Too many requests.', providerStatus: 'failed', providerError: { codexErrorInfo: 'rateLimitExceeded' } };
  const rateLimitFailure = projectConversationTurnFailure(rateLimitRecord);
  assertBehavior(rateLimitFailure.category === 'rate_limit', '字符串形式官方限流错误必须准确分类。');
  assertBehavior(describeUserFacingError(rateLimitFailure, 'zh-CN').message === 'AI 服务收到的请求过多，暂时限制了使用。请等待限制解除后再继续。', '限流错误必须复用现有可读说明。');
  assertBehavior(isProviderBlockingTurnFailure(rateLimitRecord), '官方限流错误必须暂停会话。');

  /** 沙箱错误即使正文包含限流字样，也必须按真实 Runtime 失败处理。 */
  const sandboxRecord = { code: 'ZEUS_CODEX_TURN_FAILED', message: 'rate limit text from a local tool', providerStatus: 'failed', providerError: { codexErrorInfo: 'sandboxError' } };
  const sandboxFailure = projectConversationTurnFailure(sandboxRecord);
  assertBehavior(sandboxFailure.category === 'permission', '结构化沙箱错误不得被宽泛正文正则误判为限流。');
  assertBehavior(!isProviderBlockingTurnFailure(sandboxRecord), '沙箱或本地 Runtime 错误必须保持真实失败。');
  /** 工作编排消费同一错误判断，服务类错误阻塞，Runtime 错误失败。 */
  const workConversation = { stage: 'failed', providerState: 'paused' } as Parameters<typeof conversationWorkExecutionState>[0];
  const submission = (error: Record<string, unknown>) =>
    [{ status: 'failed', pausedReason: null, errorJson: JSON.stringify(error), updatedAt: '2026-09-28T00:00:00.000Z', createdAt: '2026-09-28T00:00:00.000Z', id: 'probe-submission' }] as Parameters<typeof conversationWorkExecutionState>[1];
  const providerWorkState = conversationWorkExecutionState(workConversation, submission(rateLimitRecord));
  const runtimeWorkState = conversationWorkExecutionState({ ...workConversation, providerState: 'failed' }, submission(sandboxRecord));
  assertBehavior(providerWorkState.type === 'blocked', '服务类官方错误必须让任务工作保持阻塞。');
  assertBehavior(runtimeWorkState.type === 'failed', '沙箱或 Runtime 错误必须让任务工作正常失败。');
  return {
    legacyDisconnect: { category: failure.category, cause: failure.cause?.code ?? null, message: explanation.message },
    objectFailure: { category: objectFailure.category, cause: objectFailure.cause?.code ?? null, httpStatus: objectFailure.additionalDetails[0] ?? null },
    rateLimit: rateLimitFailure.category,
    sandbox: sandboxFailure.category,
    workStates: { provider: providerWorkState.type, runtime: runtimeWorkState.type },
  };
}

/** 用真实临时目录与数据库验证脚本修改、原有脏内容和恢复保护，不调用外部模型。 */
async function verifyWorkspaceTurnChanges(): Promise<Record<string, unknown>> {
  /** 探针不使用用户工作区，也不创建提交。 */
  const root = await mkdtemp(join(tmpdir(), 'zeus-workspace-turn-'));
  /** 数据库与恢复文件放在仓库外，避免被当成待记录内容。 */
  const workspace = join(root, 'project');
  await mkdir(workspace);
  /** 真实仓储验证持久化、去重和恢复前置条件。 */
  const db = await createZeusDatabase(join(root, 'probe.db'));
  try {
    execFileSync('git', ['init', '--quiet', workspace]);
    await writeFile(join(workspace, '.gitignore'), 'docs/\n');
    /** 包含空格和中文路径，确认枚举不会拆分文件名。 */
    const paths = Array.from({ length: 12 }, (_, index) => (index === 0 ? '中文 file.txt' : `file-${index}.txt`));
    for (const path of [...paths, 'unrelated.txt', 'reverted.txt']) await writeFile(join(workspace, path), 'original\n');
    execFileSync('git', ['-C', workspace, 'add', '.']);
    await writeFile(join(workspace, paths[0]!), 'user-dirty\n');
    await writeFile(join(workspace, 'unrelated.txt'), 'prior-user-change\n');
    /** 使用生产仓储构造最小实际会话。 */
    const projects = new ProjectRepository(db);
    /** 项目根与运行目录保持一致。 */
    const project = projects.create({ name: '快照验证', localPath: workspace });
    /** 主会话和并发会话共用同一目录以验证归属保护。 */
    const conversations = new ConversationRepository(db);
    /** 唯一 Provider 身份隔离每个探针轮次。 */
    const conversation = conversations.getById(conversations.create({ projectId: project.id, title: '快照验证', transportKind: 'codex_native', providerId: 'codex', providerThreadId: 'snapshot-thread' }).id)!;
    /** 既有恢复链路消费实际轮次身份。 */
    const turns = new ConversationTurnRepository(db);
    /** 探针不依赖时间推进。 */
    const timestamp = new Date().toISOString();
    /** 固定创建方式避免构造不完整的数据库记录。 */
    const newTurn = (id: string) =>
      turns.upsert({
        conversationId: conversation.id,
        providerThreadId: 'snapshot-thread',
        providerTurnId: id,
        clientSubmissionId: null,
        status: 'running',
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    /** 共用真实仓储，后续重建服务以检查拒绝原因不会随内存丢失。 */
    const serviceOptions = {
      db,
      projects,
      changeSets: new TurnChangeSetRepository(db),
      files: new TurnChangeFileRepository(db),
      auditLogs: new AuditLogRepository(db),
      idempotency: new IdempotencyRequestRepository(db),
      recoveryRoot: join(root, 'recovery'),
    };
    /** 验证对象就是线上文件变更服务。 */
    const service = createTurnChangeSetService(serviceOptions);
    /** 本轮开始前的用户修改必须成为恢复起点。 */
    const turn = newTurn('mixed-edits');
    await service.beginWorkspace(conversation, 'mixed-submission');
    service.bindWorkspace(conversation.id, 'mixed-submission', turn.providerTurnId!);
    /** 同一路径先补丁再脚本，只能算一个文件。 */
    const changes = [{ path: paths[0]!, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-user-dirty\n+patched\n' }];
    service.capture({ conversation, turn, providerItemId: 'patch', changes, phase: 'pre', timestamp });
    await writeFile(join(workspace, paths[0]!), 'patched\n');
    service.capture({ conversation, turn, providerItemId: 'patch', changes, phase: 'post', timestamp });
    for (const path of paths.slice(0, 10)) await writeFile(join(workspace, path), 'script-final\n');
    for (const path of paths.slice(10)) await unlink(join(workspace, path));
    await writeFile(join(workspace, 'created.txt'), 'new-script-file\n');
    /** 被忽略的文档保留 Provider 已明确记录的变化。 */
    const documentChanges = [{ path: 'docs/task.md', kind: { type: 'add' }, diff: '本地文档\n' }];
    service.capture({ conversation, turn, providerItemId: 'document', changes: documentChanges, phase: 'pre', timestamp });
    await mkdir(join(workspace, 'docs'));
    await writeFile(join(workspace, 'docs/task.md'), '本地文档\n');
    service.capture({ conversation, turn, providerItemId: 'document', changes: documentChanges, phase: 'post', timestamp });
    /** 补丁改动后恢复原值应被净变化过滤。 */
    const reverted = [{ path: 'reverted.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-original\n+temporary\n' }];
    service.capture({ conversation, turn, providerItemId: 'reverted', changes: reverted, phase: 'pre', timestamp });
    await writeFile(join(workspace, 'reverted.txt'), 'temporary\n');
    service.capture({ conversation, turn, providerItemId: 'reverted', changes: reverted, phase: 'post', timestamp });
    await writeFile(join(workspace, 'reverted.txt'), 'original\n');
    await service.finishWorkspace({ conversation, turn, timestamp });
    /** 12 个原文件、1 个新文件、1 个明确记录的忽略文档。 */
    const changeSet = service.seal({ conversation, turn, timestamp });
    assertBehavior(changeSet?.fileCount === 14, '脚本与补丁必须完整合并，且不计入轮次前的其他脏文件或已还原文件。');
    assertBehavior(changeSet.state === 'applied' && changeSet.files.every((file) => file.reversible), '完整首末快照必须可恢复。');
    assertBehavior(changeSet.files.filter((file) => file.newPath === paths[0]).length === 1, '同路径补丁与脚本不能重复计数。');
    assertBehavior(changeSet.addedLines === 12 && changeSet.deletedLines === 12, '行数必须使用首末净变化，不能累计中间补丁。');
    await service.operate({ projectId: project.id, conversationId: conversation.id, turnId: turn.id, action: 'undo', request: { changeSetId: changeSet.id, expectedState: 'applied', idempotencyKey: 'undo-mixed' } });
    assertBehavior((await readFile(join(workspace, paths[0]!), 'utf8')) === 'user-dirty\n', '撤销必须保留本轮前的脏内容。');
    assertBehavior((await readFile(join(workspace, 'unrelated.txt'), 'utf8')) === 'prior-user-change\n', '撤销不能触碰其他已有修改。');
    assertBehavior((await readFile(join(workspace, paths[11]!), 'utf8')) === 'original\n', '脚本删除的文件必须可恢复。');
    assertBehavior(
      await readFile(join(workspace, 'created.txt')).then(
        () => false,
        () => true,
      ),
      '撤销必须移除脚本新增文件。',
    );
    await service.operate({ projectId: project.id, conversationId: conversation.id, turnId: turn.id, action: 'reapply', request: { changeSetId: changeSet.id, expectedState: 'undone', idempotencyKey: 'reapply-mixed' } });
    assertBehavior((await readFile(join(workspace, paths[0]!), 'utf8')) === 'script-final\n', '重新应用必须恢复脚本最终内容。');
    await writeFile(join(workspace, paths[0]!), 'later-user-change\n');
    /** 后续写入必须触发明确冲突，且不执行任何文件恢复。 */
    const conflicted = await service
      .operate({ projectId: project.id, conversationId: conversation.id, turnId: turn.id, action: 'undo', request: { changeSetId: changeSet.id, expectedState: 'applied', idempotencyKey: 'undo-after-user-edit' } })
      .then(
        () => false,
        (error) => error.code === 'ZEUS_TURN_CHANGE_SET_CONTENT_CONFLICT',
      );
    assertBehavior(conflicted, '后续修改必须拒绝整轮撤销。');
    assertBehavior((await readFile(join(workspace, paths[0]!), 'utf8')) === 'later-user-change\n', '撤销冲突不能覆盖后续用户修改。');
    /** 重叠轮次只开放审阅，不猜测哪个会话拥有文件变化。 */
    const overlapping = conversations.getById(conversations.create({ projectId: project.id, title: '并发验证', transportKind: 'codex_native', providerId: 'codex', providerThreadId: 'other-thread' }).id)!;
    /** 第二轮复用真实目录，检验跨会话保护。 */
    const overlapTurn = newTurn('overlap');
    await service.beginWorkspace(conversation, 'overlap-main');
    service.bindWorkspace(conversation.id, 'overlap-main', overlapTurn.providerTurnId!);
    await service.beginWorkspace(overlapping, 'overlap-other');
    await writeFile(join(workspace, paths[1]!), 'concurrent\n');
    await service.finishWorkspace({ conversation, turn: overlapTurn, timestamp });
    assertBehavior(service.seal({ conversation, turn: overlapTurn, timestamp })?.state === 'unavailable', '重叠目录变化不得自动撤销。');

    /** 独立执行目录位于项目目录之外；授权必须以会话目录为准。 */
    const executionRoot = join(root, 'execution');
    await mkdir(executionRoot);
    execFileSync('git', ['init', '--quiet', executionRoot]);
    /** 越界文件始终保持原样，链接也不能放宽授权范围。 */
    const outsidePath = join(root, 'outside.txt');
    await writeFile(outsidePath, 'outside-original\n');
    await symlink(outsidePath, join(executionRoot, 'linked.txt'));
    /** 复用正式根目录解析入口，不能回退到项目根来放行路径。 */
    const scopedOptions = { ...serviceOptions, getConversationRoot: () => executionRoot };
    /** 实时记录、整轮补齐及封存共用同一实例。 */
    const scopedService = createTurnChangeSetService(scopedOptions);
    /** 共享目录名称不限于文档，目标内容始终留在工作目录外。 */
    const sharedDirectory = join(root, 'shared-content');
    await mkdir(sharedDirectory);
    await symlink(sharedDirectory, join(executionRoot, 'shared-assets'));
    await symlink(join(root, 'missing-target'), join(executionRoot, 'disconnected'));
    execFileSync('git', ['-C', executionRoot, 'add', 'linked.txt', 'shared-assets', 'disconnected']);
    /** 文件链接、目录子路径、失效链接及链接目标重命名均不进入代码撤销。 */
    const sharedChanges = [
      { path: join(executionRoot, 'linked.txt'), kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-outside-original\n+shared-edit\n' },
      { path: 'shared-assets/new/note.txt', kind: { type: 'add' }, diff: 'shared-note\n' },
      { path: 'disconnected/note.txt', kind: { type: 'add' }, diff: 'unavailable-target\n' },
      { path: 'shared-assets/old.txt', kind: { type: 'update', move_path: 'local-copy.txt' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
      { path: 'local-move.txt', kind: { type: 'update', move_path: 'shared-assets/new.txt' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    ];
    /** 纯共享变更不创建空卡片，已跟踪链接也不会使自动快照失败。 */
    const sharedTurn = newTurn('shared-only');
    await scopedService.beginWorkspace(conversation, 'shared-only');
    scopedService.bindWorkspace(conversation.id, 'shared-only', sharedTurn.providerTurnId!);
    assertBehavior(scopedService.capture({ conversation, turn: sharedTurn, providerItemId: 'shared-only', changes: sharedChanges, phase: 'pre', timestamp }) === null, '纯共享链接事件不应创建变更集。');
    await writeFile(join(executionRoot, 'linked.txt'), 'shared-edit\n');
    await mkdir(join(sharedDirectory, 'new'));
    await writeFile(join(executionRoot, 'shared-assets/new/note.txt'), 'shared-note\n');
    scopedService.capture({ conversation, turn: sharedTurn, providerItemId: 'shared-only', changes: sharedChanges, phase: 'post', timestamp });
    await scopedService.finishWorkspace({ conversation, turn: sharedTurn, timestamp });
    assertBehavior(scopedService.seal({ conversation, turn: sharedTurn, timestamp }) === null && scopedService.getByTurn(conversation.id, sharedTurn.id) === null, '共享目标的真实写入不应产生警告或零文件卡片。');
    /** 共享事件排在代码事件之前，仍须保留代码事件的原始文件索引。 */
    const sharedCodeTurn = newTurn('shared-with-code');
    /** 普通代码文件沿用原来的撤销快照。 */
    const sharedCodeChanges = [...sharedChanges, { path: 'code.txt', kind: { type: 'add' }, diff: 'code\n' }];
    await scopedService.beginWorkspace(conversation, 'shared-with-code');
    scopedService.bindWorkspace(conversation.id, 'shared-with-code', sharedCodeTurn.providerTurnId!);
    scopedService.capture({ conversation, turn: sharedCodeTurn, providerItemId: 'shared-with-code', changes: sharedCodeChanges, phase: 'pre', timestamp });
    await writeFile(join(executionRoot, 'code.txt'), 'code\n');
    scopedService.capture({ conversation, turn: sharedCodeTurn, providerItemId: 'shared-with-code', changes: sharedCodeChanges, phase: 'post', timestamp });
    await scopedService.finishWorkspace({ conversation, turn: sharedCodeTurn, timestamp });
    /** 链接只影响记录范围，不影响代码的实际恢复资格。 */
    const sharedCodeSet = scopedService.seal({ conversation, turn: sharedCodeTurn, timestamp });
    assertBehavior(sharedCodeSet?.state === 'applied' && !sharedCodeSet.conflict && sharedCodeSet.fileCount === 1 && sharedCodeSet.files[0]?.newPath === 'code.txt', '共享链接不能禁用同轮代码撤销。');
    assertBehavior(serviceOptions.files.listByChangeSet(sharedCodeSet.id).find((file) => file.sourceItemId === 'shared-with-code')?.sourceIndex === sharedChanges.length, '排除共享事件后必须保留原始索引。');
    /** 使用真实仓储重现已经保存的共享路径误报，读取过程不改写历史数据。 */
    const sharedRecorded = serviceOptions.changeSets.getById(sharedCodeSet.id)!;
    /** 旧诊断包含文件及目录链接，以及重命名时被同时列出的合法另一端。 */
    const sharedConflict = { code: 'ZEUS_TURN_CHANGE_SET_PATH_FORBIDDEN', message: '旧共享链接拒绝', paths: [join(executionRoot, 'linked.txt'), join(executionRoot, 'shared-assets/new/note.txt'), 'local-move.txt'] };
    serviceOptions.changeSets.upsert({ ...sharedRecorded, state: 'unavailable', conflictJson: JSON.stringify(sharedConflict), unavailableReason: '旧共享链接拒绝' });
    assertBehavior(
      scopedService.getById(sharedCodeSet.id)?.state === 'applied' &&
        !scopedService.getByTurn(conversation.id, sharedCodeTurn.id)?.conflict &&
        !scopedService.listByConversation(conversation.id).find((set) => set.id === sharedCodeSet.id)?.conflict,
      '已有共享链接误报在各读取入口都应消除。',
    );
    assertBehavior(serviceOptions.changeSets.getById(sharedCodeSet.id)?.state === 'unavailable', '读取范围判断不能改写已保存的历史记录。');
    await scopedService.operate({
      projectId: project.id,
      conversationId: conversation.id,
      turnId: sharedCodeTurn.id,
      action: 'undo',
      request: { changeSetId: sharedCodeSet.id, expectedState: 'applied', idempotencyKey: 'undo-shared-code' },
    });
    assertBehavior(
      await readFile(join(executionRoot, 'code.txt')).then(
        () => false,
        () => true,
      ),
      '共享链接旧误报不应阻止实际代码撤销。',
    );
    await scopedService.operate({
      projectId: project.id,
      conversationId: conversation.id,
      turnId: sharedCodeTurn.id,
      action: 'reapply',
      request: { changeSetId: sharedCodeSet.id, expectedState: 'undone', idempotencyKey: 'reapply-shared-code' },
    });
    assertBehavior((await readFile(outsidePath, 'utf8')) === 'shared-edit\n' && (await readFile(join(sharedDirectory, 'new/note.txt'), 'utf8')) === 'shared-note\n', '代码撤销和重新应用均不得改动共享目标。');
    /** 已保存的纯共享误报也不再展示为错误卡片。 */
    const oldSharedTurn = newTurn('old-shared-only');
    /** 空记录不生成恢复数据，只消除共享路径拒绝。 */
    const oldSharedSet = serviceOptions.changeSets.upsert({
      ...sharedRecorded,
      id: undefined,
      turnId: oldSharedTurn.id,
      providerTurnId: oldSharedTurn.providerTurnId!,
      state: 'unavailable',
      unifiedDiff: '',
      preImageDigest: null,
      postImageDigest: null,
      conflictJson: JSON.stringify(sharedConflict),
      unavailableReason: '旧共享链接拒绝',
    });
    assertBehavior(
      scopedService.getById(oldSharedSet.id)?.fileCount === 0 && scopedService.getById(oldSharedSet.id)?.conflict === null && scopedService.getById(oldSharedSet.id)?.unavailableReason === null,
      '历史纯共享错误不应继续展示警告。',
    );
    serviceOptions.changeSets.upsert({
      ...serviceOptions.changeSets.getById(sharedCodeSet.id)!,
      state: 'unavailable',
      conflictJson: JSON.stringify({ ...sharedConflict, paths: [...sharedConflict.paths, outsidePath] }),
      unavailableReason: '混合路径拒绝',
    });
    assertBehavior(scopedService.getById(sharedCodeSet.id)?.state === 'unavailable' && scopedService.getById(sharedCodeSet.id)?.conflict?.paths.length === 1, '共享旧误报消除后，真正越界的拒绝仍应保留。');
    await writeFile(outsidePath, 'outside-original\n');
    /** 同批拒绝绝对越界、上级目录、非法路径与越界重命名；链接单独排除。 */
    const rejectedChanges = [
      ...[outsidePath, '../outside.txt', 'linked.txt', 'invalid\0.txt'].map((path) => ({ path, kind: { type: 'add' }, diff: 'untrusted\n' })),
      { path: 'rename.txt', kind: { type: 'update', move_path: outsidePath }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    ];
    /** 合法项即便排在被拒绝的项后面也应正常记录。 */
    const mixedChanges = [...rejectedChanges, { path: 'inside.txt', kind: { type: 'add' }, diff: 'inside\n' }];
    /** 路径拒绝只标记本轮记录不可恢复，不抛出会话级异常。 */
    const rejectedTurn = newTurn('rejected-paths');
    await scopedService.beginWorkspace(conversation, 'rejected-paths');
    scopedService.bindWorkspace(conversation.id, 'rejected-paths', rejectedTurn.providerTurnId!);
    scopedService.capture({ conversation, turn: rejectedTurn, providerItemId: 'mixed-paths', changes: mixedChanges, phase: 'pre', timestamp });
    await writeFile(join(executionRoot, 'inside.txt'), 'inside\n');
    scopedService.capture({ conversation, turn: rejectedTurn, providerItemId: 'mixed-paths', changes: mixedChanges, phase: 'post', timestamp });
    await scopedService.finishWorkspace({ conversation, turn: rejectedTurn, timestamp });
    /** 正常快照不能清除路径拒绝原因或生成越界文件恢复记录。 */
    const rejectedSet = scopedService.seal({ conversation, turn: rejectedTurn, timestamp });
    assertBehavior(rejectedSet?.state === 'unavailable' && rejectedSet.fileCount === 1 && rejectedSet.files[0]?.newPath === 'inside.txt', '混合事件应只记录合法文件，并禁止整轮恢复。');
    assertBehavior(
      rejectedSet.conflict?.paths.length === 4 && !rejectedSet.conflict.paths.includes('linked.txt') && rejectedSet.conflict.message.includes(executionRoot) && rejectedSet.conflict.message.includes(outsidePath),
      '重复事件诊断应排除共享链接，并保留真正越界的具体路径。',
    );
    /** 摘要只说明对操作的影响，具体目录留在用户主动打开的详情中。 */
    const explanation = describeUserFacingError(rejectedSet.conflict);
    assertBehavior(
      explanation.message.includes('本轮修改') && !explanation.message.includes(executionRoot) && explanation.details.includes(executionRoot) && explanation.details.includes(outsidePath),
      '局部说明应使用中文并保留可诊断的具体路径。',
    );
    await db.save();
    /** 新实例从真实仓储读取拒绝状态，随后合法事件也不能恢复整轮撤销。 */
    const restartedService = createTurnChangeSetService(scopedOptions);
    restartedService.capture({ conversation, turn: rejectedTurn, providerItemId: 'later-valid-event', changes: [{ path: 'inside.txt', kind: { type: 'add' }, diff: 'inside\n' }], phase: 'post', timestamp });
    assertBehavior(restartedService.seal({ conversation, turn: rejectedTurn, timestamp })?.state === 'unavailable', '服务重建与后续事件不能清除持久化的路径拒绝。');
    /** 即便旧界面继续发出操作请求，服务端也必须保持拒绝。 */
    const unavailableUndo = await restartedService
      .operate({ projectId: project.id, conversationId: conversation.id, turnId: rejectedTurn.id, action: 'undo', request: { changeSetId: rejectedSet.id, expectedState: 'applied', idempotencyKey: 'undo-rejected' } })
      .then(
        () => false,
        (error) => error.code === 'ZEUS_TURN_CHANGE_SET_UNAVAILABLE',
      );
    assertBehavior(unavailableUndo, '不完整变更集不能通过旧请求撤销。');
    /** 全部被拒绝时也必须保存可在本轮展示的原因，不能静默丢失。 */
    const emptyTurn = newTurn('all-paths-rejected');
    restartedService.capture({ conversation, turn: emptyTurn, providerItemId: 'rejected-only', changes: rejectedChanges, phase: 'post', timestamp });
    /** 零文件不是成功空结果，而是带详情的局部不可恢复状态。 */
    const emptySet = restartedService.seal({ conversation, turn: emptyTurn, timestamp });
    assertBehavior(emptySet?.state === 'unavailable' && emptySet.fileCount === 0 && Boolean(emptySet.conflict), '全部拒绝的路径仍应保留局部原因。');
    /** 未受影响的其他轮次仍可记录会话执行目录中的文件。 */
    const validTurn = newTurn('valid-execution-path');
    /** 使用绝对路径确认合法执行目录不因位于主项目外被误拒绝。 */
    const validChanges = [{ path: join(executionRoot, 'valid.txt'), kind: { type: 'add' }, diff: 'valid\n' }];
    restartedService.capture({ conversation, turn: validTurn, providerItemId: 'valid', changes: validChanges, phase: 'pre', timestamp });
    await writeFile(join(executionRoot, 'valid.txt'), 'valid\n');
    restartedService.capture({ conversation, turn: validTurn, providerItemId: 'valid', changes: validChanges, phase: 'post', timestamp });
    /** 有完整记录的正常轮次继续支持原恢复流程。 */
    const validSet = restartedService.seal({ conversation, turn: validTurn, timestamp });
    assertBehavior(validSet?.state === 'applied' && validSet.files[0]?.reversible, '合法会话目录必须继续支持恢复。');
    await unlink(join(executionRoot, 'valid.txt'));
    await symlink(outsidePath, join(executionRoot, 'valid.txt'));
    /** 主动恢复重新检查当前路径，不信任捕获时的历史授权结果。 */
    const outsideUndo = await restartedService
      .operate({ projectId: project.id, conversationId: conversation.id, turnId: validTurn.id, action: 'undo', request: { changeSetId: validSet.id, expectedState: 'applied', idempotencyKey: 'undo-outside-link' } })
      .then(
        () => false,
        (error) => error.code === 'ZEUS_TURN_CHANGE_SET_PATH_FORBIDDEN',
      );
    assertBehavior(outsideUndo && (await readFile(outsidePath, 'utf8')) === 'outside-original\n', '主动恢复必须拒绝链接越界且不得修改目录外文件。');
    return {
      files: changeSet.fileCount,
      scriptAndPatchMerged: true,
      dirtyBaselinePreserved: true,
      undoReapply: true,
      concurrentUndoBlocked: true,
      sharedLinksExcluded: true,
      previousSharedWarningsRemoved: true,
      rejectedPathsLocalized: true,
      executionRootRespected: true,
      unsafeUndoBlocked: true,
    };
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}

// 行为探针只调用转录纯函数；Node 不需要加载渲染组件依赖的样式文件。
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
/** Node 探针不经过 Vite 自动 JSX 运行时，沿用现有转录探针的 React 注入。 */
(globalThis as typeof globalThis & { React: typeof import('react') }).React = await import('react');
const { projectQueuedSubmissionItems, projectTranscriptRows, projectTranscriptTurnRows } = await import('../apps/desktop/src/renderer/session/ConversationTranscript.js');

async function verifyCompatibilityItemIdentity(): Promise<Record<string, unknown>> {
  const firstScopedId = scopedSnapshotProviderItemId('turn-1', 'item-1');
  const secondScopedId = scopedSnapshotProviderItemId('turn-2', 'item-1');
  assertBehavior(firstScopedId !== secondScopedId, '兼容 item-N 必须按 Provider turn 定域。');
  assertBehavior(scopedSnapshotProviderItemId('turn-1', 'provider-item-stable') === 'provider-item-stable', '原生稳定 item 身份不得改写。');
  assertBehavior(resolveSnapshotProviderItemId('turn-1', 'item-1') === 'item-1', '首个历史兼容身份必须保持原值，避免重写既有历史引用。');

  const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-provider-item-identity-'));
  const database = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const repository = new ConversationProviderItemRepository(database);
  const completed = (providerItemId: string, turnId: string, providerTurnId: string, providerThreadId = 'thread-1') =>
    repository.upsertCompleted({
      conversationId: 'conversation-1',
      turnId,
      providerThreadId,
      providerTurnId,
      providerItemId,
      itemType: 'userMessage',
      phase: 'prework',
      payload: { type: 'userMessage' },
      textContent: `${providerTurnId}-text`,
      completedAt: '2026-08-25T10:00:00.000Z',
      updatedAt: '2026-08-25T10:00:00.000Z',
    });

  try {
    const first = completed('item-1', 'local-turn-1', 'turn-1');
    assertBehavior(resolveSnapshotProviderItemId('turn-1', 'item-1', first) === 'item-1', '同轮重新投影必须继续命中旧兼容身份。');
    const collisionScopedId = resolveSnapshotProviderItemId('turn-2', 'item-1', first);
    assertBehavior(collisionScopedId === secondScopedId, '跨轮复用 item-N 时必须切换到 turn-scoped 身份。');
    completed(collisionScopedId, 'local-turn-2', 'turn-2');
    completed('provider-item-collision', 'local-turn-1', 'turn-1');
    let collisionCode: string | null = null;
    try {
      completed('provider-item-collision', 'local-turn-2', 'turn-2');
    } catch (error) {
      collisionCode = isRecord(error) && typeof error.code === 'string' ? error.code : null;
    }
    assertBehavior(collisionCode === 'ZEUS_PROVIDER_ITEM_IDENTITY_CONFLICT', '跨轮复用同一 Provider item 必须失败关闭。');
    assertBehavior(repository.listByConversation('conversation-1').length === 3, '两个定域兼容项应分别持久化，冲突项不得覆盖旧轮。');
    const stable = completed('stable-message', 'alias-turn', 'alias-provider-turn', 'alias-thread');
    const compatibility = completed(scopedSnapshotProviderItemId('alias-provider-turn', 'item-9'), 'alias-turn', 'alias-provider-turn', 'alias-thread');
    database.execute(`UPDATE conversation_provider_item_states SET native_item_id = 'item-9', text_projection = ? WHERE id = ?`, [stable.textContent, compatibility.id]);
    const filtered = filterCompatibilitySnapshotItemAliases(repository.listByConversation('conversation-1'));
    assertBehavior(!filtered.items.some((candidate) => candidate.id === compatibility.id), 'turn-scoped 兼容项在存在真实稳定身份时仍必须被别名过滤。');
    assertBehavior(filtered.suppressedProviderItemIds.has(compatibility.providerItemId), '别名过滤必须记录被抑制的 scoped Provider item 身份。');
    return { firstLegacyId: first.providerItemId, secondScopedId: collisionScopedId, collisionCode, suppressedScopedAlias: compatibility.providerItemId };
  } finally {
    await database.close();
    await rm(probeRoot, { recursive: true, force: true });
  }
}

function verifyAutomaticQueueDispatchSelection(): Record<string, unknown> {
  const interruptedHistorical = { id: 'old-paused', status: 'paused', providerTurnId: null, executionSnapshotId: 'snapshot-old' };
  const queuedGuide = { id: 'queued-guide', status: 'queued', providerTurnId: null, executionSnapshotId: 'snapshot-guide' };
  const selected = selectAutomaticQueueDispatchCandidate([interruptedHistorical, queuedGuide]);
  assertBehavior(selected?.id === queuedGuide.id, '较早的暂停审计记录不得遮挡活动轮次中新增的 queued 消息。');

  const blockedBehindHead = selectAutomaticQueueDispatchCandidate([
    { id: 'failed-head', status: 'paused', providerTurnId: null, executionSnapshotId: 'snapshot-failed' },
    { id: 'blocked-tail', status: 'paused', providerTurnId: null, executionSnapshotId: 'snapshot-tail' },
  ]);
  assertBehavior(blockedBehindHead === undefined, '被队首暂停的后续项不得自动绕过阻塞。');

  const legacyQueued = { id: 'legacy-queued', status: 'queued', providerTurnId: null, executionSnapshotId: null };
  const newerQueued = { id: 'newer-queued', status: 'queued', providerTurnId: null, executionSnapshotId: 'snapshot-newer' };
  assertBehavior(selectAutomaticQueueDispatchCandidate([legacyQueued, newerQueued])?.id === legacyQueued.id, 'queued 消息之间仍必须保持原始队列顺序。');
  return { selectedId: selected.id, blockedSelection: null, legacyHeadId: legacyQueued.id };
}

/** 真实投影核对运行时进展可见、完成后单层收拢及模型正文始终外置。 */
function verifyStageSummaryProcessGrouping(): Record<string, unknown> {
  const turnId = 'stage-turn';
  let timelineOrdinal = 0;
  const item = (id: string, type: string, text: string, phase = 'prework'): NativeSessionItemBuffer => {
    const timelineAt = `2026-08-25T10:00:${String(timelineOrdinal++).padStart(2, '0')}.000Z`;
    return {
      key: id,
      conversationId: 'stage-conversation',
      threadId: 'stage-thread',
      turnId,
      itemId: id,
      type,
      status: 'completed',
      phase,
      text,
      payload: { phase },
      resources: [],
      optimistic: false,
      timelineAt,
      updatedAt: timelineAt,
    };
  };
  const items = [
    item('opening-user', 'userMessage', '请检查计划。'),
    item('bootstrap-reasoning-a', 'reasoning', 'A 摘要前的准备思考'),
    item('bootstrap-command-a', 'commandExecution', ''),
    item('summary-a', 'agentMessage', 'A 摘要', 'commentary'),
    item('command-a', 'commandExecution', ''),
    item('reasoning-a', 'reasoning', 'A 阶段思考'),
    item('mid-user-a', 'userMessage', '确定那是需要合入的内容吗？'),
    item('summary-b', 'agentMessage', 'B 摘要', 'commentary'),
    item('tool-b', 'dynamicToolCall', ''),
    item('mid-user-b', 'userMessage', '确定那是需要合入的内容吗？'),
    item('summary-c', 'agentMessage', 'C 摘要', 'commentary'),
    item('file-c', 'fileChange', ''),
    item('final', 'agentMessage', '最终正文', 'final_answer'),
  ];
  const rows = projectTranscriptRows(items);
  const turnRows = projectTranscriptTurnRows(rows, null, { [turnId]: 'completed' });
  const workRows = turnRows.filter((row): row is TranscriptTurnWorkRow => row.kind === 'turn_work');
  assertBehavior(workRows.length === 1, '完成轮次必须只有一个位于模型正文上方的过程入口。');
  /** 完成后的过程保留所有中途说明和操作的先后顺序。 */
  const stages = workRows.flatMap((row) => row.segments);
  assertBehavior(stages.length === 1, '完成过程直接展示明细，不恢复多余阶段分组。');
  assertBehavior(
    stages.every((stage) => stage.summary === null),
    '中途说明按原顺序进入过程明细，不提升为重复摘要。',
  );
  assertBehavior(
    stages.every((stage) => !stage.rows.some((row) => row.kind === 'item' && row.item.type === 'reasoning')),
    '已完成轮次的 reasoning 摘要不得重新混入正文阶段。',
  );
  assertBehavior(
    stages
      .flatMap((stage) => stage.rows)
      .flatMap((row) => (row.kind === 'activity' ? row.items.map((entry) => entry.key) : [row.key]))
      .join('|') === 'bootstrap-command-a|summary-a|command-a|summary-b|tool-b|summary-c|file-c',
    '收拢不能改变中途说明与操作的真实先后顺序。',
  );
  assertBehavior(
    workRows.every((row) => row.loadMore),
    '每段过程入口都能补齐本轮历史。',
  );
  // 活动、结束两种状态均保留三条用户输入；相同正文但不同身份的补充不能合并。
  /** 运行现场尚无最终正文，不能用已完成记录覆盖活动身份。 */
  const withoutReply = rows.filter((row) => row.key !== 'final');
  for (const activeTurnId of [turnId, null]) {
    /** 复用实际投影入口，只切换同一轮的活动与终态。 */
    const projected = projectTranscriptTurnRows(activeTurnId ? withoutReply : rows, activeTurnId, activeTurnId ? {} : { [turnId]: 'completed' });
    assertBehavior(
      projected
        .filter((row) => row.kind === 'item' && row.item.type === 'userMessage')
        .map((row) => row.key)
        .join('|') === 'opening-user|mid-user-a|mid-user-b',
      '用户开场与同轮补充必须按原顺序保留在主会话流。',
    );
    assertBehavior(
      projected
        .map((row) => (row.kind === 'turn_work' ? `process:${row.segments.flatMap((segment) => segment.rows.flatMap((detail) => (detail.kind === 'activity' ? detail.items.map((entry) => entry.key) : [])).join(','))}` : row.key))
        .join('|') ===
        (activeTurnId
          ? 'opening-user|process:bootstrap-command-a|summary-a|process:command-a|mid-user-a|summary-b|process:tool-b|mid-user-b|summary-c|process:file-c'
          : 'opening-user|mid-user-a|mid-user-b|process:bootstrap-command-a,command-a,tool-b,file-c|final'),
      '运行时保持沟通顺序，完成后保留用户输入并在最终正文上方统一收起过程。',
    );
    assertBehavior(new Set(projected.map((row) => row.key)).size === projected.length, '同轮多个过程段必须有独立稳定身份。');
    assertBehavior(
      projected.every((row) => row.kind !== 'turn_work' || row.segments.every((segment) => ![segment.summary, ...segment.rows].some((detail) => detail?.kind === 'item' && detail.item.type === 'userMessage'))),
      '处理过程不得收起或重复展示用户输入。',
    );
  }
  /** 完成态独立展开身份使运行中手动展开的过程在结束时回到收起状态。 */
  const liveWorkKeys = new Set(
    projectTranscriptTurnRows(withoutReply, turnId)
      .filter((row) => row.kind === 'turn_work')
      .map((row) => row.key),
  );
  assertBehavior(!liveWorkKeys.has(workRows[0]!.key), '完成态不能继承运行中的手动展开身份。');
  assertBehavior(turnRows.at(-1)?.kind === 'item' && turnRows.at(-1)?.key === 'final', '最终正文必须留在过程入口之外并位于入口下方。');
  /** 终态尚无正文时，继续显示已发生的进展，不能只剩耗时。 */
  assertBehavior(
    projectTranscriptTurnRows(withoutReply, null, { [turnId]: 'completed' }).some((row) => row.key === 'summary-c'),
    '正文缺失时不能收起最后的可读进展。',
  );
  for (const status of ['failed', 'interrupted'] as const) {
    assertBehavior(
      projectTranscriptTurnRows(withoutReply, null, { [turnId]: status }).some((row) => row.key === 'summary-c'),
      '失败或中断不能采用正常完成的收拢规则。',
    );
  }
  /** 历史首屏只加载开场和正文时，过程补页前后必须共用完成态入口。 */
  const deferredRows = projectTranscriptTurnRows(
    rows.filter((row) => row.key === 'opening-user' || row.key === 'final'),
    null,
    { [turnId]: 'completed' },
    new Set([turnId]),
  );
  assertBehavior(deferredRows[1]?.key === workRows[0]!.key && deferredRows[2]?.key === 'final', '按需加载的过程入口必须稳定地位于最终正文上方。');
  /** 同一原生阶段被中途说明切成多组，收拢后所有子行仍须有唯一身份。 */
  const sameStageItems = [
    item('same-user', 'userMessage', '检查过程归属。'),
    item('same-command-a', 'commandExecution', ''),
    { ...item('same-reasoning-a', 'reasoning', '第一段思考'), payload: { reasoningPresentation: 'process_text' } },
    item('same-command-b', 'commandExecution', ''),
    item('same-progress', 'agentMessage', '继续检查', 'commentary'),
    item('same-command-c', 'commandExecution', ''),
    { ...item('same-reasoning-b', 'reasoning', '第二段思考'), payload: { reasoningPresentation: 'process_text' } },
    item('same-command-d', 'commandExecution', ''),
    item('same-final', 'agentMessage', '检查完成', 'final_answer'),
  ].map((entry) => ({ ...entry, stageId: 'same-stage' }));
  /** 隐藏思考和协调事件即使更换持久阶段，也不能拆开同一输入的可见操作。 */
  const hiddenBoundaryItems = [
    item('hidden-user', 'userMessage', '核对隐藏事件分组。'),
    { ...item('hidden-command-a', 'commandExecution', ''), stageId: 'stage-a' },
    { ...item('hidden-reasoning', 'reasoning', '临时状态摘要'), stageId: 'stage-b' },
    { ...item('hidden-command-b', 'commandExecution', ''), stageId: 'stage-b' },
    { ...item('hidden-coordination', 'dynamicToolCall', ''), payload: { type: 'collabAgentToolCall' }, stageId: 'stage-c' },
    { ...item('hidden-command-c', 'commandExecution', ''), stageId: 'stage-c' },
    item('visible-progress', 'agentMessage', '已完成第一阶段。', 'commentary'),
    item('visible-command', 'commandExecution', ''),
  ];
  /** 两个操作组只由可见进度说明分隔，原始操作顺序保持完整。 */
  const hiddenBoundaryGroups = projectTranscriptRows(hiddenBoundaryItems).filter((row) => row.kind === 'activity');
  assertBehavior(hiddenBoundaryGroups.length === 2 && hiddenBoundaryGroups[0]!.items.map((entry) => entry.key).join('|') === 'hidden-command-a|hidden-command-b|hidden-command-c', '隐藏事件和持久阶段变化不能产生无说明的操作组。');
  /** 重读及补入更早的隐藏事件不改变首条真实操作确定的身份。 */
  const coldHiddenGroups = projectTranscriptRows([item('earlier-hidden', 'reasoning', '更早的临时摘要'), ...structuredClone(hiddenBoundaryItems)]).filter((row) => row.kind === 'activity');
  assertBehavior(hiddenBoundaryGroups.map((row) => row.key).join('|') === coldHiddenGroups.map((row) => row.key).join('|'), '冷读和补页不能按隐藏阶段重编号操作组。');
  /** 真实位置字段让开场消息尚未补入时也沿用同一个操作组身份。 */
  const persistentInputItems = hiddenBoundaryItems.map((entry, index) => ({
    ...entry,
    transcript: { placement: { entryId: entry.key, order: index + 1, orderEpoch: 1, placementRevision: 1, turnId, openingInputId: 'persisted-input', displayStageId: entry.stageId ?? null }, sources: [] },
  }));
  /** 补入开场消息或继续加载组尾，都不改变已知首条操作确定的身份。 */
  const persistentGroups = projectTranscriptRows(persistentInputItems).filter((row) => row.kind === 'activity');
  assertBehavior(
    projectTranscriptRows(persistentInputItems.slice(1))
      .filter((row) => row.kind === 'activity')
      .map((row) => row.key)
      .join('|') === persistentGroups.map((row) => row.key).join('|') && projectTranscriptRows(persistentInputItems.slice(1, 6)).find((row) => row.kind === 'activity')?.key === persistentGroups[0]!.key,
    '操作组必须用持久输入和首条操作身份，不能使用页面或片段编号。',
  );
  /** 使用真实两级投影覆盖阶段内操作合并，而非只检查原始消息编号。 */
  const sameStageChildren = projectTranscriptTurnRows(projectTranscriptRows(sameStageItems), null, { [turnId]: 'completed' }).flatMap((row) => (row.kind === 'turn_work' ? row.segments.flatMap((segment) => segment.rows) : []));
  assertBehavior(sameStageChildren.length > 0 && new Set(sameStageChildren.map((row) => row.key)).size === sameStageChildren.length, '完成态的同阶段操作组不能产生重复子行身份。');
  assertBehavior(
    sameStageChildren.flatMap((row) => (row.kind === 'activity' ? row.items.map((entry) => entry.key) : [row.key])).join('|') === 'same-command-a|same-reasoning-a|same-command-b|same-progress|same-command-c|same-reasoning-b|same-command-d',
    '同一阶段的操作不能越过夹在中间的思考和沟通，收拢必须完整保留持久顺序。',
  );
  /** 补入更早的沟通段后，已知边界后的过程组不能按当前片段重新编号。 */
  const tailRows = projectTranscriptTurnRows(projectTranscriptRows(sameStageItems.slice(4)), turnId);
  /** 冷读直接重建同一份完整历史，不复用上一轮投影缓存。 */
  const coldRows = projectTranscriptTurnRows(projectTranscriptRows(structuredClone(sameStageItems)), turnId);
  /** 以真实操作身份定位原有后半段，避免用数组位置自证分组稳定。 */
  const containingLaterCommand = (row: (typeof coldRows)[number]): boolean =>
    row.kind === 'turn_work' && row.segments.some((segment) => segment.rows.some((child) => child.kind === 'activity' && child.items.some((entry) => entry.key === 'same-command-c')));
  assertBehavior(tailRows.find(containingLaterCommand)?.key === coldRows.find(containingLaterCommand)?.key, '补入更早阶段或清除缓存重建不能改变已知沟通边界的过程身份。');
  /** 同一个显式阶段或缺少阶段身份时，都不能把引导后的活动归到引导前。 */
  for (const stageId of [undefined, 'same-stage']) {
    /** 此处不增加新摘要，直接覆盖工具在引导之后继续执行的情况。 */
    const boundaryItems = [items[0]!, items[4]!, items[6]!, items[8]!].map((entry) => ({ ...entry, stageId }));
    /** 复用完整两级生产投影，同时检查普通轮次与多输入轮次。 */
    const boundaryRows = projectTranscriptTurnRows(projectTranscriptRows(boundaryItems), turnId);
    assertBehavior(
      boundaryRows.flatMap((row) => (row.kind === 'turn_work' ? row.segments.flatMap((segment) => segment.rows.flatMap((detail) => (detail.kind === 'activity' ? detail.items.map((entry) => entry.key) : []))) : [row.key])).join('|') ===
        'opening-user|command-a|mid-user-a|tool-b',
      '工具活动不得跨用户消息合并。',
    );
  }
  /** 前置事件早于开场落库时仍放在用户消息后；助手沟通继续形成下一段操作边界。 */
  const ordinaryRows = projectTranscriptTurnRows(projectTranscriptRows([items[2]!, items[0]!, items[3]!, items[4]!]), turnId);
  assertBehavior(
    ordinaryRows.length === 4 && ordinaryRows[0]?.key === 'opening-user' && ordinaryRows[1]?.kind === 'turn_work' && ordinaryRows[2]?.key === 'summary-a' && ordinaryRows[3]?.kind === 'turn_work',
    '前置事件不能越过开场用户消息，后续操作也不能跨过助手沟通合并。',
  );
  return {
    hiddenBoundaryGroupSizes: hiddenBoundaryGroups.map((row) => row.items.length),
    mainStreamUserMessages: 3,
    mainStreamAssistantMessages: 1,
    stages: stages.map((stage) => ({
      summary: stage.summary?.kind === 'item' ? stage.summary.item.text : null,
      detailGroups: stage.rows.length,
      activityGroups: stage.rows.filter((row) => row.kind === 'activity').length,
    })),
    live: workRows[0]?.live ?? false,
    loadMore: workRows[0]?.loadMore ?? false,
  };
}

/** 回放同一身份在本地、队列、明确接纳之间的交接，正文不保存待发副本。 */
function verifyQueueMessageOwnership(): Record<string, unknown> {
  /** 原始创建时间早于重新排序的更新时间。 */
  const createdAt = '2026-09-28T10:04:10.104Z';
  /** 两条相同正文使用独立身份，附件只跟随第一条。 */
  const submissions = ['first', 'repeat'].map((id, position) => ({
    id,
    clientUserMessageId: id,
    conversationId: 'queue-owner',
    content: '继续',
    status: 'queued',
    delivery: 'queue' as const,
    position,
    providerTurnId: null,
    pausedReason: null,
    createdAt,
    updatedAt: '2026-09-28T10:43:42.246Z',
    ...(position === 0 ? { attachments: [{ id: 'attachment', kind: 'file', name: '证据.txt', path: '/probe/证据.txt' }] } : {}),
  }));
  /** 直接经过生产 reducer，而非重写另一套队列归属逻辑。 */
  let state: NativeSessionState = { ...createInitialSessionState(), conversationId: 'queue-owner', providerThreadId: 'thread', conversationState: 'active_prework' };
  /** 本地发出、服务端尚未确认。 */
  for (const submission of submissions)
    state = sessionReducer(state, {
      type: 'send_started',
      clientUserMessageId: submission.id,
      durableClientUserMessageId: submission.id,
      draft: submission.content,
      attachments: [],
      submittedAttachments: [],
      browserSubmission: null,
      contextDraft: state.contextDraft,
      browserComments: [],
      delivery: 'queue',
      previousConversationState: 'active_prework',
      startedAt: createdAt,
    });
  assertBehavior(state.itemOrder.length === 2, '相同文本的两次本地发送必须保留两个身份。');
  /** 队列接管后只展示权威提交，正文必须没有待发副本。 */
  const queued: NativeQueueSnapshot = { throughEventSeq: 10, state: { type: 'active', turnId: 'turn', phase: 'prework' }, submissions: submissions as NativeQueueSnapshot['submissions'] };
  state = sessionReducer(state, { type: 'queue_hydrated', queue: queued });
  assertBehavior(state.itemOrder.length === 0 && composerQueuedSubmissions(state).length === 2, '队列接管必须移除本地正文副本，且不按内容去重。');
  assertBehavior(composerQueuedSubmissions(state)[0]?.attachments?.length === 1, '附件必须随稳定提交身份保留。');
  /** 失败与结果未知同样直接从权威队列生成。 */
  const paused = { ...queued, throughEventSeq: 11, submissions: queued.submissions.map((submission) => ({ ...submission, status: 'paused', pausedReason: 'outcome_unknown' })) };
  state = sessionReducer(state, { type: 'queue_hydrated', queue: paused });
  assertBehavior(
    projectQueuedSubmissionItems(state, visibleQueuedSubmissions(state.queue), []).every((item) => item.messageCreatedAt === createdAt),
    '状态更新时间不能改变原始发送时间。',
  );
  /** 跨窗口删除后的队列先到，旧 HTTP 回执和旧队列读取后到。 */
  const deleted: NativeQueueSnapshot = { ...queued, throughEventSeq: 12, submissions: [] };
  state = sessionReducer(state, { type: 'queue_hydrated', queue: deleted });
  state = sessionReducer(state, { type: 'queue_hydrated', queue: queued });
  state = sessionReducer(state, { type: 'send_accepted', clientUserMessageId: 'first', status: 'queued', submissionId: 'first' });
  assertBehavior(
    state.queue?.throughEventSeq === 12 && state.itemOrder.length === 0 && composerQueuedSubmissions(state).length === 0 && projectQueuedSubmissionItems(state, visibleQueuedSubmissions(state.queue), []).length === 0,
    '删除后迟到的队列与发送回执不得复活消息。',
  );
  /** 插话必须有明确接纳证据；较新队列不能吞掉迟到的接纳事件。 */
  state = sessionReducer(state, { type: 'steering_submission_hydrated', submission: { ...queued.submissions[0]!, delivery: 'steer_now', status: 'steering', providerTurnId: 'turn' }, queue: { ...deleted, throughEventSeq: 11 } });
  assertBehavior(state.itemOrder.length === 1 && state.items[state.itemOrder[0]!]!.messageCreatedAt === createdAt && state.queue?.throughEventSeq === 12, '明确接纳的插话正文与队列水位必须分别收敛。');
  return { deletedVisibleMessages: 0, sameTextIdentities: 2, attachmentPreserved: true, lateReceiptRejected: true, originalCreatedAt: createdAt, steeringAccepted: true };
}

function verifyRealtimeChangeSetProjection(): Record<string, unknown> {
  const largeDiff = `${'diff --git a/large.ts b/large.ts\n'.repeat(2_048)}+full-content-must-not-enter-realtime-event`;
  const full: TurnChangeSet = {
    id: 'change-set-projection',
    projectId: 'project-projection',
    conversationId: 'conversation-projection',
    turnId: 'turn-projection',
    providerTurnId: 'provider-turn-projection',
    state: 'applied',
    files: [
      {
        id: 'file-projection',
        oldPath: 'large.ts',
        newPath: 'large.ts',
        changeType: 'modified',
        addedLines: 1,
        deletedLines: 0,
        unifiedDiff: largeDiff,
        preHash: 'sha256:pre',
        postHash: 'sha256:post',
        reversible: true,
        unavailableReason: null,
      },
    ],
    unifiedDiff: largeDiff,
    fileCount: 1,
    addedLines: 1,
    deletedLines: 0,
    preImageDigest: 'sha256:pre',
    postImageDigest: 'sha256:post',
    unavailableReason: null,
    conflict: null,
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:01.000Z',
    contentProjection: 'full',
  };
  const realtime = toRealtimeChangeSet(full);
  const encodedBytes = Buffer.byteLength(JSON.stringify(realtime), 'utf8');
  assertBehavior(realtime.contentProjection === 'summary', '变更集实时投影必须明确标记 summary。');
  assertBehavior(realtime.unifiedDiff === '' && realtime.files.every((file) => file.unifiedDiff === ''), '变更集实时投影不得复制完整 diff。');
  assertBehavior(!JSON.stringify(realtime).includes('full-content-must-not-enter-realtime-event'), '变更集实时投影仍泄漏了完整文件内容。');
  assertBehavior(encodedBytes <= 8 * 1024, `变更集实时投影超过 8 KiB 目标：${encodedBytes}`);
  return { encodedBytes, projection: realtime.contentProjection, fullDiffBytes: Buffer.byteLength(largeDiff, 'utf8') };
}

async function verifyCodexProviderEventFlow(): Promise<Record<string, unknown>> {
  let listener: ((event: CodexAppServerEvent) => void | Promise<void>) | null = null;
  let unsubscribed = 0;
  let dynamicCalls = 0;
  const handled: Array<{ method: string; delta: string | null; receiptCount: number }> = [];
  const handlerErrors: unknown[] = [];
  const flowControl = new ConversationEventFlowControl();
  const manager = {
    subscribe(next: (event: CodexAppServerEvent) => void | Promise<void>) {
      listener = next;
      return () => {
        unsubscribed += 1;
      };
    },
  } as unknown as CodexAppServerManager;
  const queue = createCodexProviderEventFlow({
    manager,
    flowControl,
    isKnown: (event) => event.sequence === 99,
    async handleEvent(event, receiptEvents) {
      const delta = isRecord(event.params) && typeof event.params.delta === 'string' ? event.params.delta : null;
      handled.push({ method: event.method, delta, receiptCount: receiptEvents?.length ?? 1 });
    },
    async handleEventError(_event, error) {
      handlerErrors.push(error);
    },
    async handleDynamicToolCall() {
      dynamicCalls += 1;
    },
  });
  const send = (event: CodexAppServerEvent): void | Promise<void> => {
    if (!listener) throw new Error('Codex Provider 行为核验未注册事件监听器。');
    return listener(event);
  };

  send(providerEvent(1, 'item/agentMessage/delta', { delta: 'hello ' }));
  send(providerEvent(2, 'item/agentMessage/delta', { delta: 'world' }));
  await send(providerEvent(3, 'turn/completed'));
  await queue.enqueueBarrier(async () => handled.push({ method: 'barrier', delta: null, receiptCount: 0 }));
  await send(providerEvent(99, 'item/agentMessage/delta', { delta: 'duplicate' }));
  const dynamicReturn = send(providerEvent(4, 'item/tool/call'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.beginHandoff();

  const expected = [
    ['item/agentMessage/delta', 'hello world', 2],
    ['turn/completed', null, 1],
    ['barrier', null, 0],
  ];
  assertBehavior(JSON.stringify(handled.map((entry) => [entry.method, entry.delta, entry.receiptCount])) === JSON.stringify(expected), 'Provider delta、终态与 barrier 顺序不正确。');
  const snapshot = flowControl.snapshot();
  assertBehavior(snapshot.coalescedProcessEvents === 1, 'Provider delta 未按稳定 item 身份合并。');
  assertBehavior(snapshot.highWater.provider.pendingEvents >= 2, 'Provider 高水位没有记录排队事件。');
  assertBehavior(dynamicCalls === 1 && dynamicReturn === undefined, '动态工具调用必须旁路 transport backpressure，避免等待自身 Provider RPC。');
  assertBehavior(unsubscribed === 1, 'Provider handoff 必须且只能取消一次订阅。');
  assertBehavior(handlerErrors.length === 0, 'Provider handler 不应出现异常。');
  return {
    handled,
    coalescedProcessEvents: snapshot.coalescedProcessEvents,
    dynamicBackpressureBypassed: dynamicReturn === undefined,
    providerHighWaterEvents: snapshot.highWater.provider.pendingEvents,
    unsubscribed,
  };
}

async function verifyConversationSyncFlow(): Promise<Record<string, unknown>> {
  const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-event-flow-behavior-'));
  const database = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const repository = new ConversationSyncEventRepository(database);
  const flowControl = new ConversationEventFlowControl();
  const broadcasts: number[] = [];
  let clock = 0;
  const protocol = new ConversationSyncProtocol({
    db: database,
    repository,
    flowControl,
    now: () => new Date(Date.UTC(2026, 7, 21, 12, 0, clock++)),
    broadcast: (event) => {
      broadcasts.push(event.payload.sequence);
    },
  });
  const append = (conversationId: string, type: string, revision: number) => database.durableTransactionSync(() => protocol.append({ conversationId, type, payload: { entityRevision: revision, value: revision } }));

  try {
    append('conversation-gap', 'conversation.created', 1);
    append('conversation-gap', 'conversation.item.delta', 2);
    append('conversation-gap', 'conversation.turn.completed', 3);
    const first = protocol.listPage({ conversationId: 'conversation-gap', afterSequence: 0, limit: 2, byteLimit: 1024 * 1024 });
    const second = protocol.listPage({ conversationId: 'conversation-gap', afterSequence: first.nextCursor, limit: 2, byteLimit: 1024 * 1024 });
    const cursorPages = [first.events.map((event) => event.payload.sequence), second.events.map((event) => event.payload.sequence)];
    assertBehavior(JSON.stringify(cursorPages) === '[[1,2],[3]]' && first.hasMore && !second.hasMore, '增量补页必须严格连续且正确发布 hasMore。');

    database.durableTransactionSync(() => {
      repository.openStream({ conversationId: 'conversation-baseline', generationId: 'zeus-conversation-sync-v2', baseSequence: 10, establishedAt: '2026-08-21T12:10:00.000Z' });
      protocol.append({ conversationId: 'conversation-baseline', type: 'conversation.created', payload: { entityRevision: 1 } });
    });
    const baseline = protocol.listPage({ conversationId: 'conversation-baseline', afterSequence: 0 });
    assertBehavior(baseline.requestedBeforeBaseline && baseline.baseSequence === 10 && baseline.events[0]?.payload.sequence === 10, '早于 baseline 的 cursor 必须明确要求权威恢复。');

    const unknownDynamic = database.durableTransactionSync(() => protocol.append({ conversationId: 'conversation-gap', type: 'conversation.future.unregistered', payload: { entityRevision: 4 } }));
    assertBehavior(unknownDynamic.payload.sequence === 4, '未登记动态事件必须保守进入关键事实耐久流，不能按前缀或后缀静默丢弃。');

    const broadcastsBeforeCriticalCommit = broadcasts.length;
    const critical = database.commitCriticalFactSync(() => protocol.append({ conversationId: 'conversation-gap', type: 'conversation.request.created', payload: { entityRevision: 5 } }));
    assertBehavior(critical.payload.sequence === 5, '关键事实同步提交必须分配连续 sequence。');
    assertBehavior(broadcasts.length === broadcastsBeforeCriticalCommit + 1 && broadcasts.at(-1) === 5, '关键事实返回调用方前必须完成 COMMIT 后广播。');
    const observer = new DatabaseSync(join(probeRoot, 'probe.db'), { readOnly: true });
    try {
      const observed = observer.prepare('SELECT COUNT(*) AS count FROM conversation_sync_events WHERE conversation_id = ? AND sequence = ?').get('conversation-gap', 5) as { count?: number } | undefined;
      assertBehavior(observed?.count === 1, '关键事实返回调用方前必须能被独立只读连接观察到。');
    } finally {
      observer.close();
    }
    const coreBroadcasts = [...broadcasts];
    const coreDurability = flowControl.snapshot().appendedByDurability;
    assertBehavior(coreDurability.critical_fact === 5 && coreDurability.coalescible_process === 1, '精确注册表与未知事件失败安全分类计数不正确。');
    assertBehavior(JSON.stringify(coreBroadcasts) === '[1,2,3,10,4,5]', 'afterCommit 广播必须与耐久 sequence 一致。');

    const changeSetBroadcastsBefore = broadcasts.length;
    const changeSetPayload = {
      changeSetId: 'change-set-idempotent',
      entityRevision: '2026-08-26T10:00:01.000Z',
      changeSet: { id: 'change-set-idempotent', contentProjection: 'summary' },
    };
    const firstChangeSetEvent = database.durableTransactionSync(() => protocol.append({ conversationId: 'conversation-change-set', type: 'conversation.turn.change_set.changed', payload: changeSetPayload }));
    const repeatedChangeSetEvent = database.durableTransactionSync(() => protocol.append({ conversationId: 'conversation-change-set', type: 'conversation.turn.change_set.changed', payload: changeSetPayload }));
    assertBehavior(firstChangeSetEvent.id === repeatedChangeSetEvent.id && firstChangeSetEvent.payload.sequence === repeatedChangeSetEvent.payload.sequence, '同一 change-set 修订重试必须命中同一耐久事件身份与 sequence。');
    assertBehavior(broadcasts.length === changeSetBroadcastsBefore + 1, '同一 change-set 修订重试不得再次广播。');

    database.durableTransactionSync(() => {
      for (let revision = 1; revision <= 4_352; revision += 1) {
        protocol.append({
          conversationId: 'conversation-bounded-tail',
          type: 'conversation.item.delta',
          payload: { entityRevision: revision, itemId: 'item-tail', delta: String(revision) },
        });
      }
    });
    const boundedStream = repository.currentStream('conversation-bounded-tail');
    const boundedRows = database.get<{ count: number; bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(payload_byte_length), 0) AS bytes
         FROM conversation_sync_events
        WHERE conversation_id = ? AND generation_id = ?`,
      ['conversation-bounded-tail', 'zeus-conversation-sync-v2'],
    );
    assertBehavior(boundedStream?.baseSequence === 321 && boundedStream.latestSequence === 4_352, 'V2 尾部压缩没有在安全水位把 4,352 条事件收敛到最后 4,032 条。');
    assertBehavior(boundedRows?.count === 4_032 && boundedRows.bytes <= 16 * 1024 * 1024, 'V2 尾部事件数量或字节预算失控。');
    const boundedBaseline = protocol.listPage({ conversationId: 'conversation-bounded-tail', afterSequence: 0, limit: 1 });
    assertBehavior(boundedBaseline.requestedBeforeBaseline && boundedBaseline.baseSequence === 321, '尾部压缩后旧 cursor 必须明确要求权威恢复。');

    const nearImmediateCompactionPayload = 'x'.repeat(60 * 1024);
    database.durableTransactionSync(() => {
      for (let revision = 1; revision <= 400; revision += 1) {
        protocol.append({
          conversationId: 'conversation-bounded-bytes',
          type: 'conversation.item.delta',
          payload: { entityRevision: revision, itemId: 'item-byte-tail', delta: nearImmediateCompactionPayload },
        });
      }
    });
    const boundedBytes = database.get<{ count: number; bytes: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(payload_byte_length), 0) AS bytes
         FROM conversation_sync_events
        WHERE conversation_id = ? AND generation_id = ?`,
      ['conversation-bounded-bytes', 'zeus-conversation-sync-v2'],
    );
    assertBehavior(Boolean(boundedBytes && boundedBytes.count <= 4_096 && boundedBytes.bytes <= 16 * 1024 * 1024), '接近即时修剪阈值的连续事件越过了 16 MiB 硬上限。');

    const routeHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const fakeServer = {
      get(path: string, ...arguments_: unknown[]) {
        const handler = arguments_.at(-1);
        if (typeof handler !== 'function') throw new Error(`同步路由 ${path} 缺少 handler。`);
        routeHandlers.set(path, handler as (...arguments_: unknown[]) => unknown);
        return fakeServer;
      },
    };
    const subscribers = new Set<ConversationRealtimeSocket>();
    registerConversationSyncRoutes({
      server: fakeServer as never,
      protocol,
      flowControl,
      subscribers,
      isAuthorizedRealtimeRequest: () => true,
      isNativeConversation: () => true,
      serverIdentity: () => ({ app: 'Zeus', host: '127.0.0.1', port: 12_345 }),
    });
    const websocketHandler = routeHandlers.get('/api/events');
    if (!websocketHandler) throw new Error('同步行为核验没有注册 /api/events。');

    const baselineSocket = new ProbeSocket();
    websocketHandler(baselineSocket, { query: { conversationId: 'conversation-baseline', afterSequence: '0', syncStreamGeneration: 'zeus-conversation-sync-v2' } });
    assertBehavior(baselineSocket.messages.at(-1)?.type === 'conversation.sync.baseline_required', 'WebSocket 必须发送 baseline_required 控制事件。');

    const slowSocket = new ProbeSocket((socket) => {
      if (socket.messages.length === 2) socket.bufferedAmount = 5 * 1024 * 1024;
    });
    websocketHandler(slowSocket, { query: { conversationId: 'conversation-gap', afterSequence: '0', syncStreamGeneration: 'zeus-conversation-sync-v2' } });
    assertBehavior(slowSocket.closed?.code === 1013, '超过 4 MiB 的慢消费者必须断开并按 cursor 恢复。');

    const snapshot = flowControl.snapshot();
    assertBehavior(snapshot.websocketSlowConsumerDisconnects === 1, '慢消费者断开必须进入诊断计数。');
    assertBehavior(snapshot.appendedByDurability.critical_fact === 5 && snapshot.appendedByDurability.coalescible_process === 4_754, 'V2 保留策略探针的耐久分类计数不正确。');
    assertBehavior(snapshot.droppedEphemeralEvents === 0, '当前 ephemeral 注册表为空，不应伪造临时事件丢弃计数。');
    const quickCheck = database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check;
    assertBehavior(quickCheck === 'ok', `临时数据库 quick_check 失败：${quickCheck ?? 'missing'}`);
    /** 队列快照与其耐久事件使用同一个序号，不借用发布前的水位。 */
    const queueEvent = database.durableTransactionSync(() =>
      protocol.append({ conversationId: 'queue-watermark', type: 'conversation.queue.changed', payload: { entityRevision: 1, queue: { throughEventSeq: 0, state: { type: 'idle' }, submissions: [] } } }),
    );
    assertBehavior((queueEvent.payload.queue as { throughEventSeq: number }).throughEventSeq === queueEvent.payload.sequence, '队列事件水位必须与持久同步序号相同。');
    assertBehavior((protocol.listPage({ conversationId: 'queue-watermark' }).events[0]!.payload.queue as { throughEventSeq: number }).throughEventSeq === queueEvent.payload.sequence, '重连回放必须保持原队列水位。');
    return {
      cursorPages,
      baseline: { baseSequence: baseline.baseSequence, control: baselineSocket.messages.at(-1)?.type ?? null },
      slowConsumerClose: slowSocket.closed?.code ?? null,
      durability: snapshot.appendedByDurability,
      droppedEphemeralEvents: snapshot.droppedEphemeralEvents,
      idempotentChangeSet: { id: firstChangeSetEvent.id, sequence: firstChangeSetEvent.payload.sequence },
      boundedTail: { baseSequence: boundedStream?.baseSequence ?? null, latestSequence: boundedStream?.latestSequence ?? null, events: boundedRows?.count ?? null, bytes: boundedRows?.bytes ?? null },
      broadcasts: { initial: coreBroadcasts, total: broadcasts.length, last: broadcasts.at(-1) ?? null },
      quickCheck,
    };
  } finally {
    await database.close();
    await rm(probeRoot, { recursive: true, force: true });
  }
}

class ProbeSocket implements ConversationRealtimeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly messages: Array<Record<string, unknown>> = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  private closeListener: (() => void) | null = null;

  constructor(private readonly afterSend?: (socket: ProbeSocket) => void) {}

  send(data: string): void {
    const value = JSON.parse(data) as unknown;
    if (!isRecord(value)) throw new Error('WebSocket 行为核验收到非对象事件。');
    this.messages.push(value);
    this.afterSend?.(this);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 0;
    this.closeListener?.();
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListener = listener;
  }
}

function providerEvent(sequence: number, method: string, params: Record<string, unknown> = {}): CodexAppServerEvent {
  return {
    generationId: 'generation-probe',
    sequence,
    method,
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', ...params },
    receivedAt: '2026-08-21T12:00:00.000Z',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ZARCH 事件流行为核验失败：${message}`);
}

/** 验证 sealed 分段只接纳旧轮次终态，且不夺回当前 thread 的运行控制权。 */
async function verifySealedSegmentTerminalProjection(): Promise<Record<string, unknown>> {
  /** 当前运行态必须在旧轮次终止后保持不变。 */
  const runStates = new Map([['conversation-sealed', { type: 'active' as const, turnId: 'turn-current', phase: 'prework' as const }]]);
  /** 探针记录持久化前后的公开事件，确保终态落盘后才广播。 */
  const effects: string[] = [];
  /** 旧分段只拥有这一条尚未收口的轮次。 */
  let sealedTurn: ZeusConversationTurnRecord = {
    id: 'local-turn-sealed',
    conversationId: 'conversation-sealed',
    providerThreadId: 'thread-1',
    providerTurnId: 'turn-1',
    clientSubmissionId: 'submission-sealed',
    status: 'running' as const,
    errorJson: null,
    planJson: null,
    startedAt: '2026-08-21T11:59:00.000Z',
    completedAt: null,
    createdAt: '2026-08-21T11:59:00.000Z',
    updatedAt: '2026-08-21T11:59:00.000Z',
    agentKind: 'codex' as const,
    nativeRunId: 'turn-1',
  };
  /** 这里只提供 sealed 分支会消费的依赖；误入普通完成链路会立即暴露缺失依赖。 */
  const dependencies = {
    options: {
      execution: {
        segmentByNativeSession: () => ({ id: 'segment-sealed', conversationId: 'conversation-sealed', state: 'sealed' }),
        persistWarning: () => effects.push('warning-persisted'),
      },
      conversations: {
        getByProviderThreadId: () => undefined,
        getById: () => ({ id: 'conversation-sealed', projectId: 'project-sealed', providerThreadId: 'thread-current', messages: [], attentionUnread: false }),
      },
      turns: {
        getByProvider: (providerThreadId: string, providerTurnId: string) => (providerThreadId === sealedTurn.providerThreadId && providerTurnId === sealedTurn.providerTurnId ? sealedTurn : undefined),
        upsert: (input: typeof sealedTurn) => {
          sealedTurn = input;
          effects.push('turn-persisted');
          return sealedTurn;
        },
      },
      receipts: { record: () => effects.push('receipt-recorded') },
      db: {
        save: async () => {
          effects.push('database-saved');
        },
      },
      broadcast: (type: string) => effects.push(`broadcast:${type}`),
    },
    closed: false,
    contexts: new Map(),
    failedTurnResults: new Map(),
    modelRequestTiming: { clear: () => effects.push('timing-cleared') },
    runStates,
    hasProcessedProviderEvent: () => false,
    maintainProviderReceiptGenerations: () => undefined,
    rememberProcessedProviderEvent: () => undefined,
    reconcileTerminalTurnSubmissions: () => ({ primarySubmission: undefined, recoveryRequired: [], reconciledCount: 1 }),
    resolveTurnResult: () => effects.push('waiter-resolved'),
    rejectTurnResultWaiters: () => effects.push('waiter-rejected'),
  } as unknown as CodexProviderEventProjectionDependencies;

  await projectCodexProviderEvent(dependencies, providerEvent(100, 'turn/completed', { turn: { status: 'completed' } }));
  assertBehavior(sealedTurn.status === 'completed' && sealedTurn.completedAt === '2026-08-21T12:00:00.000Z', 'sealed 分段的旧轮次终态没有持久化。');
  assertBehavior(runStates.get('conversation-sealed')?.turnId === 'turn-current', '旧分段终态覆盖了当前运行态。');
  assertBehavior(effects.indexOf('database-saved') < effects.indexOf('broadcast:conversation.turn.completed'), 'sealed 终态必须先落盘再广播。');
  assertBehavior(!effects.includes('warning-persisted'), '合法的 sealed 终态不应被归类为迟到活动警告。');

  await projectCodexProviderEvent(dependencies, providerEvent(101, 'item/started'));
  assertBehavior(effects.includes('warning-persisted'), 'sealed 分段的非终态活动仍必须被拒绝并记录警告。');
  return { status: sealedTurn.status, currentTurnId: runStates.get('conversation-sealed')?.turnId ?? null, effects };
}

/** 验证权威快照不再声明活动轮次时，深分页缓存不会复活旧分段的 running turn。 */
function verifyAuthoritativeTurnCacheReconciliation(): Record<string, unknown> {
  /** 两份快照使用连续的历史范围，确保探针进入缓存复用分支。 */
  const paging = {
    history: { loadedThroughSequence: 10, oldestLoadedSequence: 1, nextCursor: null, hasMore: false, loading: false, error: null },
    historyByTurn: {},
    processByTurn: {},
  };
  /** 只提供缓存协调器实际读取的 V2 结构身份。 */
  const snapshotV2 = { structureGeneration: '2026-09-16-transcript-placement', collections: { modelHistory: { throughSequence: 10 } } };
  /** 旧缓存同时包含已封存历史与错误残留的活动轮次。 */
  const previous = {
    id: 'conversation-cache',
    snapshotV2,
    v2Paging: paging,
    items: [],
    turns: [
      { id: 'turn-history', providerTurnId: 'provider-history', status: 'completed' },
      { id: 'turn-stale', providerTurnId: 'provider-stale', status: 'running' },
    ],
  } as unknown as NativeConversationSnapshot;
  /** 权威快照已进入空闲态，只保留刚完成的当前轮次。 */
  const authoritative = {
    ...previous,
    turns: [{ id: 'turn-current', providerTurnId: 'provider-current', status: 'completed' }],
  } as unknown as NativeConversationSnapshot;
  /** 协调后只允许终态历史与权威轮次继续存在。 */
  const reconciliation = reconcileConversationHistoryCache(previous, authoritative);
  const turnIds = reconciliation.snapshot.turns.map((turn) => turn.id);
  assertBehavior(reconciliation.preserveCachedHistory, '连续历史范围应继续复用深分页缓存。');
  assertBehavior(!turnIds.includes('turn-stale'), '权威快照移除的 running turn 不得从缓存复活。');
  assertBehavior(turnIds.includes('turn-history') && turnIds.includes('turn-current'), '终态历史与权威当前轮次都应保留。');
  return { preserveCachedHistory: reconciliation.preserveCachedHistory, turnIds };
}

const provider = await verifyCodexProviderEventFlow();
/** 真实投影入口核对 sealed 分段终态与迟到活动的不同处理。 */
const sealedSegmentTerminal = await verifySealedSegmentTerminalProjection();
/** Renderer 缓存核对旧非终态不会在权威空闲快照后复活。 */
const authoritativeTurnCache = verifyAuthoritativeTurnCacheReconciliation();
const sync = await verifyConversationSyncFlow();
const compatibilityItems = await verifyCompatibilityItemIdentity();
const automaticQueueDispatch = verifyAutomaticQueueDispatchSelection();
const stageSummaryGrouping = verifyStageSummaryProcessGrouping();
const queueMessageOwnership = verifyQueueMessageOwnership();
const realtimeChangeSetProjection = verifyRealtimeChangeSetProjection();
/** Provider 断流使用同一生产投影和用户可见错误目录验证。 */
const providerStreamFailure = verifyProviderStreamFailurePresentation();
/** 同一事件流探针同时检查文件变化的真实捕获链路。 */
const workspaceTurnChanges = await verifyWorkspaceTurnChanges();

console.log(
  JSON.stringify(
    {
      status: 'passed',
      provider,
      sealedSegmentTerminal,
      authoritativeTurnCache,
      sync,
      compatibilityItems,
      automaticQueueDispatch,
      stageSummaryGrouping,
      queueMessageOwnership,
      realtimeChangeSetProjection,
      providerStreamFailure,
      workspaceTurnChanges,
    },
    null,
    2,
  ),
);
