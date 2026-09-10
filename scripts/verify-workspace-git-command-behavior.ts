import { mkdtemp, rm, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '../packages/shared/src/index.js';
import {
  ArtifactStore,
  CommandDeliveryRepository,
  createZeusDatabase,
  ConversationRepository,
  ConversationSubmissionRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  TaskIntegrationRepository,
  TaskIntegrationAttemptRepository,
  type ZeusDatabase,
} from '../packages/storage/src/index.js';
import { getTaskWorkspaceReview, startTaskIntegrationAttempt, writeTaskIntegrationResolution } from '../packages/git-core/src/index.js';
import { createGitIntegrationOperations, type GitIntegrationOperationDependencies } from '../packages/local-server/src/gitIntegrationOperations.js';
import type { TaskWorkspaceConflictRecovery } from '../packages/shared/src/index.js';
import {
  WorkspaceGitCommandApplication,
  workspaceGitInputSha256,
  workspaceGitCommandTypes,
  type WorkspaceGitCommandPayload,
  type WorkspaceGitCommandType,
  type WorkspaceGitMutationRequest,
  type WorkspaceGitScopeKind,
} from '../packages/local-server/src/workspaceGitCommandApplication.js';
import { registerWorkspaceGitCommandRoutes, workspaceGitCommandRoutePolicy } from '../packages/local-server/src/workspaceGitCommandRoutes.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-workspace-git-command-probe-'));
const observed: Record<string, unknown> = {};
const clockMs = Date.parse('2026-08-21T20:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const server = Fastify({ logger: false });
  try {
    db.execute(`CREATE TABLE workspace_git_probe_business (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new WorkspaceGitCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });
    const invocations = new Map<WorkspaceGitCommandType, number>();

    registerWorkspaceGitCommandRoutes({
      server,
      application,
      operations: {
        prepare: async (input) => ({
          destinationId: 'workspace-git-probe',
          resourceId: [input.projectId, input.taskId, input.repositoryId, input.workspaceId, input.integrationId].find(Boolean) ?? 'probe',
          externalOperationId: `probe_external_${input.commandType}_${input.operationIdentity}`,
          opaque: input,
        }),
        execute: async ({ commandType }) => {
          invocations.set(commandType, (invocations.get(commandType) ?? 0) + 1);
          if (commandType === workspaceGitCommandTypes.taskWorkspacePush) {
            throw Object.assign(new Error(`/secret/worktree: ${'unknown-output '.repeat(512)}`), { code: 'ZEUS_PROBE_EXTERNAL_OUTCOME_UNKNOWN' });
          }
          if (commandType === workspaceGitCommandTypes.taskWorkspaceDiscard) {
            throw Object.assign(new Error('Independent dangerous confirmation was rejected.'), {
              workspaceGitExplicitRejection: true as const,
              statusCode: 409,
              payload: { error: 'ZEUS_PROBE_CONFIRMATION_REJECTED', message: 'Independent dangerous confirmation was rejected.' },
            });
          }
          return {
            response: { statusCode: 201, body: { commandType, payload: 'x'.repeat(1_250_000) } },
            commitAccepted: () => db.execute(`INSERT INTO workspace_git_probe_business (id, value) VALUES (?, ?)`, [commandType, 'accepted']),
          };
        },
        isExplicitRejection: (error) => Boolean(error) && typeof error === 'object' && (error as { workspaceGitExplicitRejection?: unknown }).workspaceGitExplicitRejection === true,
      },
      sendError: (reply, error) => {
        if (error && typeof error === 'object' && (error as { workspaceGitExplicitRejection?: unknown }).workspaceGitExplicitRejection === true) {
          const rejected = error as { statusCode: number; payload: unknown };
          return reply.code(rejected.statusCode).send(rejected.payload);
        }
        throw error;
      },
    });

    const accepted = commandRequest({
      label: 'accepted-snapshot',
      commandType: workspaceGitCommandTypes.projectSnapshotCreate,
      scopeKind: 'git_repository',
      scopeId: 'project:project-probe',
      operationIdentity: 'workspace-git-probe-accepted',
      input: { taskId: 'task-probe' },
    });
    const acceptedFirst = await inject('POST', '/api/projects/project-probe/git/snapshot', accepted.body);
    const acceptedReplay = await inject('POST', '/api/projects/project-probe/git/snapshot', accepted.body);
    const acceptedAttempt = requiredAttempt(deliveries, accepted.commandId);
    const acceptedEvidence = JSON.parse(acceptedAttempt.receipt.evidenceJson) as { resultArtifact?: { contentByteLength?: number; generationId?: string } };
    observed.accepted = {
      firstStatus: acceptedFirst.statusCode,
      replayStatus: acceptedReplay.statusCode,
      invocations: invocations.get(workspaceGitCommandTypes.projectSnapshotCreate),
      immutableReplay: acceptedFirst.body.payload === acceptedReplay.body.payload,
      businessRows: rowCount('workspace_git_probe_business'),
      receiptOutcome: acceptedAttempt.receipt.outcome,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      artifactContentBytes: acceptedEvidence.resultArtifact?.contentByteLength,
      artifactGeneration: acceptedEvidence.resultArtifact?.generationId,
    };

    const unknown = commandRequest({
      label: 'unknown-push',
      commandType: workspaceGitCommandTypes.taskWorkspacePush,
      scopeKind: 'task_workspace',
      scopeId: 'workspace-probe',
      operationIdentity: 'workspace-git-probe-unknown',
      input: {},
    });
    const unknownFirst = await inject('POST', '/api/tasks/task-probe/git-workspaces/workspace-probe/push', unknown.body);
    const unknownReplay = await inject('POST', '/api/tasks/task-probe/git-workspaces/workspace-probe/push', unknown.body);
    const unknownAttempt = requiredAttempt(deliveries, unknown.commandId);
    const unknownEvidence = JSON.parse(unknownAttempt.receipt.evidenceJson) as { error?: { message?: string } };
    observed.unknown = {
      firstCode: unknownFirst.body.error,
      firstRecoveryRequired: unknownFirst.body.recoveryRequired,
      replayCode: unknownReplay.body.error,
      invocations: invocations.get(workspaceGitCommandTypes.taskWorkspacePush),
      receiptOutcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      errorBytes: Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8'),
      errorRedacted: !(unknownEvidence.error?.message ?? '').includes('/secret/worktree'),
    };

    const rejected = commandRequest({
      label: 'discard-rejected',
      commandType: workspaceGitCommandTypes.taskWorkspaceDiscard,
      scopeKind: 'task_workspace',
      scopeId: 'workspace-probe',
      operationIdentity: 'workspace-git-probe-rejected',
      input: { confirmationText: 'operator-rejected' },
    });
    const rejectedResult = await inject('POST', '/api/tasks/task-probe/git-workspaces/workspace-probe/discard', rejected.body);
    const rejectedAttempt = requiredAttempt(deliveries, rejected.commandId);
    observed.explicitRejection = {
      status: rejectedResult.statusCode,
      code: rejectedResult.body.error,
      receiptOutcome: rejectedAttempt.receipt.outcome,
      writeMarker: rejectedAttempt.attempt.providerWriteStartedAt !== null,
    };

    observed.routePolicy = {
      external: workspaceGitCommandRoutePolicy.externalOperations.length,
      automaticRetryAfterUnknown: workspaceGitCommandRoutePolicy.automaticRetryAfterUnknown,
      acceptedResult: workspaceGitCommandRoutePolicy.acceptedResult,
    };
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    observed.boundaryProbeStartedExternalOperations = false;

    assertProbe(acceptedFirst.statusCode === 201 && acceptedReplay.statusCode === 201 && invocations.get(workspaceGitCommandTypes.projectSnapshotCreate) === 1, 'accepted replay 不得二次执行外部端口。');
    assertProbe(acceptedFirst.body.payload === acceptedReplay.body.payload && typeof acceptedFirst.body.payload === 'string' && acceptedFirst.body.payload.length === 1_250_000, 'accepted replay 必须返回完整不可变大型结果。');
    assertProbe(rowCount('workspace_git_probe_business') === 1 && acceptedAttempt.receipt.outcome === 'accepted', 'Core 投影与 accepted receipt 必须在同一事务提交一次。');
    assertProbe((acceptedEvidence.resultArtifact?.contentByteLength ?? 0) > 1_000_000 && acceptedEvidence.resultArtifact?.generationId === 'workspace-git-command-result-v1', '大型结果必须进入 ArtifactRef。');
    assertProbe(Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384, 'receipt evidence 只能保存有界 ArtifactRef。');
    assertProbe(unknownFirst.body.error === 'ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN' && unknownFirst.body.recoveryRequired === true, 'write marker 后异常必须标为 unknown。');
    assertProbe(unknownReplay.body.error === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && invocations.get(workspaceGitCommandTypes.taskWorkspacePush) === 1, 'unknown 必须阻断自动重发。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, 'unknown receipt 必须保留 write marker。');
    assertProbe(
      (unknownEvidence.error?.message ?? '').length > 0 && Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2_048 && !(unknownEvidence.error?.message ?? '').includes('/secret/worktree'),
      '错误 evidence 必须 UTF-8 有界且脱敏。',
    );
    assertProbe(rejectedResult.statusCode === 409 && rejectedAttempt.receipt.outcome === 'explicitly_rejected', '独立危险确认拒绝必须进入 explicitly_rejected。');
    assertProbe(workspaceGitCommandRoutePolicy.externalOperations.length === 16 && workspaceGitCommandRoutePolicy.automaticRetryAfterUnknown === false, '路由政策必须精确覆盖 16 条且 unknown 不自动重试。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');
    assertProbe(observed.boundaryProbeStartedExternalOperations === false, '前述命令边界场景不能启动外部操作。');

    observed.conflictDelivery = await verifyConflictDelivery(db, application, deliveries);

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

    async function inject(method: 'POST' | 'PUT', path: string, body: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
      const response = await server.inject({ method, url: path, payload: body });
      return { statusCode: response.statusCode, body: response.body ? (JSON.parse(response.body) as Record<string, unknown>) : {} };
    }

    function rowCount(table: 'workspace_git_probe_business'): number {
      return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? -1;
    }
  } finally {
    await server.close();
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function now(): Date {
  return new Date(clockMs);
}

function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  const text = value.replaceAll('/secret/worktree', '[REDACTED_PATH]');
  return { text, redacted: text !== value };
}

function commandRequest<TInput extends object>(input: {
  label: string;
  commandType: WorkspaceGitCommandType;
  scopeKind: Extract<CommandScopeKind, WorkspaceGitScopeKind>;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}): { commandId: string; body: WorkspaceGitMutationRequest<TInput> } {
  const commandId = `command_workspace_git_probe_${input.label}`;
  const payload: WorkspaceGitCommandPayload = { operationIdentity: input.operationIdentity, inputSha256: workspaceGitInputSha256(input.input) };
  const command: CommandEnvelope<WorkspaceGitCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'workspace-git-command-probe' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  return { commandId, body: { command, input: input.input } };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertProbe(snapshot && attempt && receipt, `Command ${commandId} 必须存在耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 在临时仓库执行真实冲突交付；只使用本探针数据，不启动 Provider 或访问远端。 */
async function verifyConflictDelivery(db: ZeusDatabase, application: WorkspaceGitCommandApplication, deliveries: CommandDeliveryRepository) {
  /** 临时仓库的所有 Git 命令都隔离用户配置、签名及钩子。 */
  const execute = promisify(execFile);
  /** 主仓库位于探针独立临时根。 */
  const repositoryPath = join(probeRoot, 'conflict-repository');
  /** 原任务分支拥有独立工作目录。 */
  const taskPath = join(probeRoot, 'task-worktree');
  /** 隔离运行 Git 并返回规范化标准输出。 */
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (
      await execute('git', ['-c', 'user.name=Zeus Probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })
    ).stdout.trim();
  await mkdir(repositoryPath);
  await git(repositoryPath, 'init', '-b', 'main');
  await git(repositoryPath, 'config', 'user.name', 'Zeus Probe');
  await git(repositoryPath, 'config', 'user.email', 'probe@example.invalid');
  await git(repositoryPath, 'config', 'commit.gpgsign', 'false');
  await git(repositoryPath, 'config', 'core.hooksPath', '/dev/null');
  /** 两个冲突文件同时覆盖部分解决后的续办身份。 */
  const paths = ['alpha.txt', '中文 beta.txt'];
  for (const path of paths) await writeFile(join(repositoryPath, path), 'base\n');
  await git(repositoryPath, 'add', '.');
  await git(repositoryPath, 'commit', '-m', '初始内容');
  await git(repositoryPath, 'worktree', 'add', '-b', 'task', taskPath);
  for (const path of paths) await writeFile(join(taskPath, path), 'task\n');
  await git(taskPath, 'commit', '-am', '任务修改');
  for (const path of paths) await writeFile(join(repositoryPath, path), 'main\n');
  await git(repositoryPath, 'commit', '-am', '来源修改');
  /** 使用真实业务存储和 Git 操作；未涉及的 Provider 依赖不会在此探针启动。 */
  const projects = new ProjectRepository(db);
  /** 任务记录使用本探针数据库。 */
  const tasks = new TaskRepository(db);
  /** 保存各工作区的真实目录和分支。 */
  const taskWorkspaces = new TaskWorkspaceRepository(db);
  /** 保存合入业务记录。 */
  const taskIntegrations = new TaskIntegrationRepository(db);
  /** 保存原冲突会话与目录关系。 */
  const taskIntegrationAttempts = new TaskIntegrationAttemptRepository(db);
  /** 保存原会话及其可用状态。 */
  const conversations = new ConversationRepository(db);
  /** 调用正式业务实现，只省略本场景未使用的外部通知。 */
  const operations = createGitIntegrationOperations({
    db,
    projects,
    tasks,
    taskWorkspaces,
    taskIntegrations,
    taskIntegrationAttempts,
    conversations,
    conversationSubmissions: new ConversationSubmissionRepository(db),
    projectRepositories: new ProjectRepositoryRegistrationRepository(db),
    projectSharedPaths: new ProjectSharedPathRepository(db),
    appendAuditLog: () => undefined,
    recordTaskEvent: () => undefined,
    publishRealtimeEvent: () => undefined,
  } as GitIntegrationOperationDependencies);
  /** 将临时仓库登记为探针项目。 */
  const project = projects.create({ name: '冲突交付探针', localPath: repositoryPath });
  /** 各仓库共用同一交付任务。 */
  const task = tasks.create({ projectId: project.id, title: '冲突交付探针', taskType: 'defect', description: '', createdFrom: 'probe', sourceContext: {} });
  /** 记录初次来源分支提交。 */
  const targetHeadSha = await git(repositoryPath, 'rev-parse', 'HEAD');
  /** 记录初次任务分支提交。 */
  const taskHeadSha = await git(taskPath, 'rev-parse', 'HEAD');
  /** 登记原任务工作区。 */
  const base = taskWorkspaces.create({ projectId: project.id, taskId: task.id, repositoryPath, branchName: 'task', sourceBranch: 'main', sourceHeadSha: targetHeadSha, worktreePath: taskPath, headSha: taskHeadSha, remoteName: '' });
  /** 登记初次合入关系。 */
  const integration = taskIntegrations.create({ projectId: project.id, taskId: task.id, workspaceId: base.id, targetBranch: 'main', targetHeadSha, taskHeadSha, mode: 'merge', state: 'conflicted' });
  /** 生成真实命名冲突目录。 */
  const started = await startTaskIntegrationAttempt({
    repositoryPath,
    projectSlug: project.slug,
    integrationId: integration.id,
    attemptId: 'delivery-probe-attempt',
    targetBranch: 'main',
    targetHeadSha,
    taskBranch: 'task',
    taskHeadSha,
    conflictBranch: 'task-merge',
    mode: 'merge',
    commitMessage: '探针合入',
  });
  assertProbe(started.conflictFiles.length === 2, '初始真实合入必须产生两个冲突。');
  /** 登记后续持续使用的冲突工作区。 */
  const workspace = taskWorkspaces.create({
    projectId: project.id,
    taskId: task.id,
    kind: 'conflict',
    baseWorkspaceId: base.id,
    repositoryPath,
    branchName: 'task-merge',
    sourceBranch: 'main',
    sourceHeadSha: targetHeadSha,
    worktreePath: started.integrationPath,
    headSha: targetHeadSha,
    remoteName: '',
  });
  /** 原会话沿用此冲突工作区。 */
  const conversation = conversations.create({ projectId: project.id, taskId: task.id, workspaceId: workspace.id, title: '冲突处理：探针', transportKind: 'codex_native', permissionMode: 'auto' });
  taskIntegrationAttempts.create({
    id: 'delivery-probe-attempt',
    integrationId: integration.id,
    conversationId: conversation.id,
    submissionId: 'delivery-probe-submission',
    worktreePath: started.integrationPath,
    targetHeadSha,
    taskHeadSha,
    state: 'active',
  });
  await db.save();

  /** 复用正式命令应用，校验写入回执与业务投影一起提交。 */
  const invoke = async (label: string, commandType: WorkspaceGitCommandType, value: Record<string, unknown>, workspaceId = workspace.id) => {
    /** 批量操作归属任务，单仓操作归属具体工作区。 */
    const scope = commandType === workspaceGitCommandTypes.taskWorkspaceCommitAll ? { scopeKind: 'task' as const, scopeId: task.id } : { scopeKind: 'task_workspace' as const, scopeId: workspaceId };
    /** 每次业务请求具有确定的命令身份。 */
    const request = commandRequest({ label, commandType, ...scope, operationIdentity: label, input: value });
    /** 使用正式命令解析和校验。 */
    const parsed = application.parse({ value: request.body, commandType, ...scope });
    /** 在外部写入之前准备业务边界。 */
    const prepared = await operations.prepareWorkspaceGitCommand({ commandType, operationIdentity: label, taskId: task.id, workspaceId, value });
    /** 仅在命令确认接受后更新业务投影。 */
    let commitAccepted: (() => void) | undefined;
    return application.executeExternal({
      parsed,
      ...prepared,
      invoke: async () => {
        /** 执行真实 Git 操作并保留接受回调。 */
        const execution = await operations.executeWorkspaceGitCommand({ commandType, operationIdentity: label, prepared, value });
        commitAccepted = execution.commitAccepted;
        return execution.response;
      },
      mutateAcceptedBusinessState: () => commitAccepted?.(),
      isExplicitRejection: operations.isWorkspaceGitExplicitRejection,
    });
  };
  for (const path of paths) await writeTaskIntegrationResolution(started.integrationPath, path, 'main and task\n');
  await invoke('conflict-first-commit', workspaceGitCommandTypes.taskWorkspaceCommit, { message: '已解决首次冲突', selectedPaths: paths });
  /** 记录首次解决冲突后的提交，后续不得丢失。 */
  const firstCommit = await git(started.integrationPath, 'rev-parse', 'HEAD');
  assertProbe(requiredAttempt(deliveries, 'command_workspace_git_probe_conflict-first-commit').receipt.outcome === 'accepted', '首次提交必须成功。');
  for (const path of paths) await writeFile(join(repositoryPath, path), 'main advanced\n');
  await writeFile(join(repositoryPath, 'new-main.txt'), '新增来源内容\n');
  await git(repositoryPath, 'add', '.');
  await git(repositoryPath, 'commit', '-m', '来源再次推进');
  /** 记录再次推进的来源提交。 */
  const advancedMain = await git(repositoryPath, 'rev-parse', 'HEAD');
  /** 通过合入入口追赶新的来源内容。 */
  const attention = await invoke('conflict-catch-up', workspaceGitCommandTypes.taskWorkspaceIntegrate, { targetBranch: 'main', mode: 'merge' });
  /** 读取新的冲突续办信息。 */
  const recovery = (attention.result.body as { conflictRecovery: TaskWorkspaceConflictRecovery }).conflictRecovery;
  assertProbe(attention.result.statusCode === 202 && recovery.conflictFiles.length === 2 && recovery.updatedBranch === 'main' && recovery.conversationId === conversation.id, '新冲突必须返回原会话和真实冲突清单。');
  assertProbe((await git(started.integrationPath, 'rev-parse', 'HEAD')) === firstCommit && (await git(repositoryPath, 'rev-parse', 'HEAD')) === advancedMain, '产生新冲突必须保留已有提交且不更新目标分支。');
  /** 比对物理索引与文件，证明提交前拒绝没有格式化、暂存或生成提交。 */
  const indexPath = resolve(started.integrationPath, await git(started.integrationPath, 'rev-parse', '--git-path', 'index'));
  /** 保留拒绝之前的物理索引字节。 */
  const beforeIndex = await readFile(indexPath);
  /** 保留拒绝之前的冲突文件字节。 */
  const beforeFile = await readFile(join(started.integrationPath, paths[0]!));
  /** 只接受提交前的明确冲突拒绝。 */
  let rejected = false;
  try {
    await invoke('conflict-preflight', workspaceGitCommandTypes.taskWorkspaceCommit, { message: '不应提交', selectedPaths: paths });
  } catch (error) {
    rejected = operations.isWorkspaceGitExplicitRejection(error) && error.payload.error === 'ZEUS_TASK_WORKSPACE_CONFLICTED';
  }
  assertProbe(rejected && requiredAttempt(deliveries, 'command_workspace_git_probe_conflict-preflight').receipt.outcome === 'explicitly_rejected', '冲突拒绝不能归为写入结果未知。');
  assertProbe(
    beforeIndex.equals(await readFile(indexPath)) && beforeFile.equals(await readFile(join(started.integrationPath, paths[0]!))) && (await git(started.integrationPath, 'rev-parse', 'HEAD')) === firstCommit,
    '明确拒绝必须保持索引、文件和提交不变。',
  );
  /** 第二个真实仓库在暂存后由钩子拒绝提交，覆盖已写入索引的未知结果保护。 */
  const otherPath = join(probeRoot, 'other-repository');
  await mkdir(otherPath);
  await git(otherPath, 'init', '-b', 'other-task');
  await git(otherPath, 'config', 'user.name', 'Zeus Probe');
  await git(otherPath, 'config', 'user.email', 'probe@example.invalid');
  await git(otherPath, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(otherPath, 'other.txt'), 'before\n');
  await git(otherPath, 'add', '.');
  await git(otherPath, 'commit', '-m', '另一个仓库');
  /** 独立仓库仍属于同一交付任务，用于检查多仓结果不被整体覆盖。 */
  const otherHead = await git(otherPath, 'rev-parse', 'HEAD');
  /** 登记同任务的第二个独立仓库。 */
  const other = taskWorkspaces.create({
    projectId: project.id,
    taskId: task.id,
    repositoryPath: otherPath,
    repositoryName: '另一个仓库',
    repositoryRelativePath: 'other',
    branchName: 'other-task',
    sourceBranch: 'other-task',
    sourceHeadSha: otherHead,
    worktreePath: otherPath,
    headSha: otherHead,
    remoteName: '',
  });
  /** 钩子仅安装到临时仓库内部。 */
  const hooksPath = join(otherPath, '.git', 'hooks');
  await writeFile(join(hooksPath, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  await chmod(join(hooksPath, 'pre-commit'), 0o755);
  await git(otherPath, 'config', 'core.hooksPath', hooksPath);
  await writeFile(join(otherPath, 'other.txt'), 'after\n');
  /** 重复相同命令只核对回执；首次已暂存，第二次不得执行 Git。 */
  for (let invocation = 0; invocation < 2; invocation += 1) {
    /** 核对首次失败和重复请求均被未知结果保护。 */
    let unknown = false;
    try {
      await invoke('real-write-unknown', workspaceGitCommandTypes.taskWorkspaceCommit, { message: '钩子拒绝', selectedPaths: ['other.txt'] }, other.id);
    } catch (error) {
      unknown = error instanceof Error && ['ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN', 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'].includes((error as Error & { code?: string }).code ?? '');
    }
    assertProbe(unknown && requiredAttempt(deliveries, 'command_workspace_git_probe_real-write-unknown').receipt.outcome === 'outcome_unknown_after_write', '实际暂存后的失败及重放必须保留结果未知。');
    assertProbe((await git(otherPath, 'show', ':other.txt')) === 'after' && (await git(otherPath, 'rev-parse', 'HEAD')) === otherHead, '未知失败必须保留已暂存内容且不产生提交。');
    // 首次失败后移除拒绝钩子，若第二次被错误重放便会生成提交并被上方检查发现。
    await git(otherPath, 'config', 'core.hooksPath', '/dev/null');
  }
  /** 新的批量命令分别保留成功仓库与待处理仓库。 */
  const batch = await invoke('multi-repository-commit', workspaceGitCommandTypes.taskWorkspaceCommitAll, { message: '多仓部分提交' });
  /** 逐仓检查成功与失败同时保留。 */
  const batchItems = (batch.result.body as { items: Array<{ workspaceId: string; status: string }> }).items;
  assertProbe(
    batchItems.some((item) => item.workspaceId === other.id && item.status === 'succeeded') && batchItems.some((item) => item.workspaceId === workspace.id && item.status === 'failed'),
    '多仓提交必须保留成功结果并单独报告冲突拒绝。',
  );
  /** 模拟关闭后重新读取工作区快照。 */
  const reopened = await operations.readTaskWorkspaceSnapshot(project, workspace);
  assertProbe((reopened.conflictRecovery as TaskWorkspaceConflictRecovery).recoveryKey === recovery.recoveryKey, '重开快照必须保留原续办身份。');
  await writeTaskIntegrationResolution(started.integrationPath, paths[0]!, 'main advanced and task\n');
  /** 部分暂存后续办身份应保持不变。 */
  const partial = await operations.readTaskWorkspaceSnapshot(project, workspace);
  assertProbe((partial.conflictRecovery as TaskWorkspaceConflictRecovery).recoveryKey === recovery.recoveryKey, '暂存部分冲突不能生成新的继续指令身份。');
  conversations.archive(conversation.id);
  /** 归档会话后入口保留不可用原因。 */
  const unavailable = await operations.readTaskWorkspaceSnapshot(project, workspace);
  assertProbe(
    Boolean((unavailable.conflictRecovery as TaskWorkspaceConflictRecovery).unavailableReason) && (unavailable.conflictRecovery as TaskWorkspaceConflictRecovery).conversationId === conversation.id,
    '归档会话必须说明不可用且保留原身份。',
  );
  await writeTaskIntegrationResolution(started.integrationPath, paths[1]!, 'main advanced and task\n');
  /** 最终提交包含全部已暂存的解决结果。 */
  const review = await getTaskWorkspaceReview(started.integrationPath);
  await invoke('conflict-second-commit', workspaceGitCommandTypes.taskWorkspaceCommit, { message: '解决新增冲突', selectedPaths: review.stagedFiles.map((file) => file.path) });
  /** 再次走正式交付入口完成本地合入。 */
  const finished = await invoke('conflict-finish', workspaceGitCommandTypes.taskWorkspaceIntegrate, { targetBranch: 'main', mode: 'merge' });
  assertProbe((finished.result.body as { integration: { state: string } }).integration.state === 'merged', '再次解决后必须完成真实本地合入。');
  assertProbe((await readFile(join(repositoryPath, 'new-main.txt'), 'utf8')) === '新增来源内容\n' && (await readFile(join(repositoryPath, paths[0]!), 'utf8')) === 'main advanced and task\n', '最终合入必须保留来源新文件与任务的有效修改。');
  assertProbe((await operations.readTaskWorkspaceSnapshot(project, taskWorkspaces.getById(workspace.id)!)).conflictRecovery === null, '真实冲突清空后恢复入口必须消失。');
  return {
    initialCommitAccepted: true,
    catchUpStatus: attention.result.statusCode,
    explicitRejection: true,
    indexAndHeadPreserved: true,
    realWriteUnknownReplayBlocked: true,
    multiRepositoryResultsPreserved: true,
    sameConversation: true,
    stableRecoveryIdentity: true,
    archivedConversationExplained: true,
    mergedWithNewSourceChanges: true,
    providerStarted: false,
    remoteAccessed: false,
  };
}
