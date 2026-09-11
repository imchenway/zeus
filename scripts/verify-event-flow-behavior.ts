import { mkdtemp, rm, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodexAppServerEvent, CodexAppServerManager } from '../packages/ai-runtime/src/index.js';
import type { TranscriptTurnWorkRow } from '../apps/desktop/src/renderer/session/ConversationTranscript.js';
import type { NativeSessionItemBuffer } from '../apps/desktop/src/renderer/session/sessionTypes.js';
import type { TurnChangeSet } from '../packages/shared/src/conversationResources.js';
import { createCodexProviderEventFlow } from '../packages/local-server/src/codexProviderEventFlow.js';
import { filterCompatibilitySnapshotItemAliases } from '../packages/local-server/src/codexProviderHistoryProjection.js';
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
  createZeusDatabase,
  resolveSnapshotProviderItemId,
  scopedSnapshotProviderItemId,
} from '../packages/storage/src/index.js';

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
    /** 验证对象就是线上文件变更服务。 */
    const service = createTurnChangeSetService({
      db,
      projects,
      changeSets: new TurnChangeSetRepository(db),
      files: new TurnChangeFileRepository(db),
      auditLogs: new AuditLogRepository(db),
      idempotency: new IdempotencyRequestRepository(db),
      recoveryRoot: join(root, 'recovery'),
    });
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
    return { files: changeSet.fileCount, scriptAndPatchMerged: true, dirtyBaselinePreserved: true, undoReapply: true, concurrentUndoBlocked: true };
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
const { coalesceSupersededInterruptedQueuedUserMessages, projectTranscriptRows, projectTranscriptTurnRows } = await import('../apps/desktop/src/renderer/session/ConversationTranscript.js');

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

/** 真实转录投影同时核对单轮过程分组和用户补充始终位于主会话流。 */
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
  assertBehavior(workRows.length === 1, '单轮过程必须只有一个顶层折叠入口。');
  const stages = workRows[0]?.segments ?? [];
  assertBehavior(stages.length === 3, 'A/B/C 三条摘要必须生成三个独立过程阶段。');
  assertBehavior(stages.map((stage) => (stage.summary?.kind === 'item' ? stage.summary.item.text : null)).join('|') === 'A 摘要|B 摘要|C 摘要', '阶段摘要顺序必须保持 A/B/C，不得被整轮活动组吞并。');
  assertBehavior(!stages.some((stage) => stage.summary === null), '首条摘要之前的准备过程必须归入 A 阶段，不能生成无摘要的孤立过程入口。');
  assertBehavior(
    stages.every((stage) => !stage.rows.some((row) => row.kind === 'item' && row.item.type === 'reasoning')),
    '已完成轮次的 reasoning 摘要不得重新混入正文阶段。',
  );
  assertBehavior(
    stages.every((stage) => stage.rows.filter((row) => row.kind === 'activity').length === 1),
    '每个阶段的命令、工具或文件操作必须各自合并为一组。',
  );
  assertBehavior(workRows[0]?.loadMore === true, '单轮过程入口必须负责继续加载本轮后续过程。');
  // 活动、结束两种状态均保留三条用户输入；相同正文但不同身份的补充不能合并。
  for (const activeTurnId of [turnId, null]) {
    /** 复用实际投影入口，只切换同一轮的活动与终态。 */
    const projected = projectTranscriptTurnRows(rows, activeTurnId, activeTurnId ? {} : { [turnId]: 'completed' });
    assertBehavior(
      projected
        .filter((row) => row.kind === 'item' && row.item.type === 'userMessage')
        .map((row) => row.key)
        .join('|') === 'opening-user|mid-user-a|mid-user-b',
      '用户开场与同轮补充必须按原顺序保留在主会话流。',
    );
    assertBehavior(
      projected.every((row) => row.kind !== 'turn_work' || row.segments.every((segment) => ![segment.summary, ...segment.rows].some((detail) => detail?.kind === 'item' && detail.item.type === 'userMessage'))),
      '处理过程不得收起或重复展示用户输入。',
    );
  }
  return {
    mainStreamUserMessages: 3,
    stages: stages.map((stage) => ({
      summary: stage.summary?.kind === 'item' ? stage.summary.item.text : null,
      detailGroups: stage.rows.length,
      activityGroups: stage.rows.filter((row) => row.kind === 'activity').length,
    })),
    live: workRows[0]?.live ?? false,
    loadMore: workRows[0]?.loadMore ?? false,
  };
}

function verifyInterruptedQueueTakeoverProjection(): Record<string, unknown> {
  const userItem = (input: { id: string; clientId: string; optimistic: boolean; status: string; timelineAt: string; updatedAt: string; pausedReason?: string; providerItemId?: string }): NativeSessionItemBuffer => ({
    key: input.id,
    conversationId: 'queue-takeover-conversation',
    threadId: 'queue-takeover-thread',
    turnId: input.providerItemId ? 'provider-turn' : `pending:${input.id}`,
    itemId: input.id,
    localItemId: input.id,
    type: 'userMessage',
    status: input.status,
    phase: 'user',
    text: '第二条引导消息',
    payload: {
      role: 'user',
      content: '第二条引导消息',
      delivery: 'queue',
      ...(input.pausedReason ? { pausedReason: input.pausedReason } : {}),
    },
    resources: [],
    optimistic: input.optimistic,
    clientUserMessageId: input.clientId,
    durableClientUserMessageId: input.clientId,
    ...(input.providerItemId ? { providerItemId: input.providerItemId } : {}),
    timelineAt: input.timelineAt,
    updatedAt: input.updatedAt,
  });
  const interrupted = userItem({
    id: 'legacy-interrupted',
    clientId: 'legacy-client',
    optimistic: true,
    status: 'paused',
    pausedReason: 'interrupted',
    timelineAt: '2026-08-25T09:48:45.131Z',
    updatedAt: '2026-08-25T10:28:09.901Z',
  });
  const accepted = userItem({
    id: 'provider-accepted',
    clientId: 'provider-client',
    optimistic: false,
    status: 'completed',
    providerItemId: 'provider-item',
    timelineAt: '2026-08-25T10:28:09.615Z',
    updatedAt: '2026-08-25T10:28:09.615Z',
  });
  const projected = coalesceSupersededInterruptedQueuedUserMessages([interrupted, accepted]);
  assertBehavior(projected.length === 1 && projected[0]?.key === accepted.key, '旧 interrupted 气泡必须与 5 秒内同正文 Provider 接管项合并。');

  const deliberateRepeat = userItem({
    id: 'deliberate-repeat',
    clientId: 'deliberate-client',
    optimistic: false,
    status: 'completed',
    providerItemId: 'provider-item-2',
    timelineAt: '2026-08-25T10:29:00.000Z',
    updatedAt: '2026-08-25T10:29:00.000Z',
  });
  assertBehavior(coalesceSupersededInterruptedQueuedUserMessages([accepted, deliberateRepeat]).length === 2, '两条成功且正文相同的用户消息必须保留，不能用正文启发式吞掉真实重复发送。');
  return { legacyProjectionCount: projected.length, preservedDeliberateRepeats: 2 };
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

const provider = await verifyCodexProviderEventFlow();
const sync = await verifyConversationSyncFlow();
const compatibilityItems = await verifyCompatibilityItemIdentity();
const automaticQueueDispatch = verifyAutomaticQueueDispatchSelection();
const stageSummaryGrouping = verifyStageSummaryProcessGrouping();
const interruptedQueueTakeover = verifyInterruptedQueueTakeoverProjection();
const realtimeChangeSetProjection = verifyRealtimeChangeSetProjection();
/** 同一事件流探针同时检查文件变化的真实捕获链路。 */
const workspaceTurnChanges = await verifyWorkspaceTurnChanges();

console.log(JSON.stringify({ status: 'passed', provider, sync, compatibilityItems, automaticQueueDispatch, stageSummaryGrouping, interruptedQueueTakeover, realtimeChangeSetProjection, workspaceTurnChanges }, null, 2));
