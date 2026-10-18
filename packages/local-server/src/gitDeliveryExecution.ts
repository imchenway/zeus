import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { commandEnvelopeSchemaGeneration, canonicalCommandInputJson, type CommandScopeKind, type GitDeliveryInput, type GitDeliverySelection, type GitDeliveryRun } from '@zeus/shared';
import {
  GitDeliveryRepository,
  type GitDeliveryRunRecord,
  type GitDeliveryStepRecord,
  type GitDeliveryMergeResult,
  type ZeusDatabase,
  type ProjectRepositoryRegistrationRepository,
  type ProjectRepository,
  type TaskRepository,
  type TaskWorkspaceRepository,
  type TaskIntegrationRepository,
  type TaskIntegrationAttemptRepository,
  type ConversationRepository,
  type ConversationSubmissionRepository,
} from '@zeus/storage';
import {
  discoverGitRepositories,
  executeProjectGitAction,
  getProjectGitRepositorySnapshot,
  getGitBranchHead,
  startTaskBranchIntegration,
  completeTaskIntegrationCommit,
  finalizeTaskBranchIntegration,
  readTaskIntegrationConflictPaths,
  readTaskIntegrationConflict,
  writeTaskIntegrationResolution,
  writeTaskIntegrationDraft,
  withGitRepositoryOperation,
  withGitOperationSignal,
  type ProjectGitAction,
} from '@zeus/git-core';
import { AutomationMutationApplication } from './automationMutationApplication.js';
import { resolveConversationGitWorkspace } from './conversationGitWorkspace.js';
import { readCommitFingerprint } from './gitCommitContext.js';
import { workspaceGitCommandTypes, type WorkspaceGitCommandApplication } from './workspaceGitCommandApplication.js';

/** 只读核对远端结果，绝不通过恢复路径推送。 */
const readGit = promisify(execFile);

/** 所有目录均由项目、任务或会话身份解析，不接收外部绝对路径。 */
interface DeliveryExecutionDependencies {
  /** 已认证服务和内部命令入口。 */
  server: FastifyInstance;
  /** 内部请求沿用当前宿主认证。 */
  apiToken: string;
  /** 唯一耐久数据库。 */
  db: ZeusDatabase;
  /** 只读诊断禁止运行。 */
  readOnly: boolean;
  /** 原有项目仓库。 */
  projects: ProjectRepository;
  /** 只接受项目已登记且仍在真实发现范围内的仓库。 */
  projectRepositories: ProjectRepositoryRegistrationRepository;
  /** 原有任务仓库。 */
  tasks: TaskRepository;
  /** 原有任务工作区。 */
  taskWorkspaces: TaskWorkspaceRepository;
  /** 原有合入记录。 */
  taskIntegrations: TaskIntegrationRepository;
  /** AI 冲突会话的当前隔离现场，人工处理不回写旧候选。 */
  taskIntegrationAttempts: TaskIntegrationAttemptRepository;
  /** 真实会话与首发工作目录。 */
  conversations: ConversationRepository;
  /** 会话归属和执行目录来源。 */
  conversationSubmissions: ConversationSubmissionRepository;
  /** Git 写操作复用现有命令回执。 */
  commands: WorkspaceGitCommandApplication;
  /** 当前项目可选管理状态。 */
  statusOptions(projectId: string): import('@zeus/shared').TaskManagementStatusDefinition[];
  /** 组合已授权合入时，复用原任务冲突结果落地流程。 */
  finalizeTaskConflict(integrationId: string, conversationId: string): Promise<Record<string, unknown>>;
  /** AI 的真实等待、完成与错误状态。 */
  conversationState(id: string): 'running' | 'waiting' | 'completed' | 'failed';
  /** 进度和通知共用现有实时连接。 */
  publish(type: string, payload: Record<string, unknown>): void;
}

/** 内部解析出的单仓操作边界。 */
interface DeliveryRepositoryContext {
  /** 可修改的真实目录。 */
  path: string;
  /** 显示名。 */
  name: string;
  /** 同一仓库公共写锁使用来源目录，不随任务工作树回收变化。 */
  repositoryPath?: string;
}

/** 对参数或已知前置条件失败给出明确拒绝，不误报未知写入。 */
function deliveryError(message: string, code = 'ZEUS_GIT_DELIVERY_INVALID', statusCode = 409): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

/** 稳定身份不含目录、正文或密钥。 */
function deliveryIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** 内部调用和 Renderer 使用同一命令信封协议。 */
export function gitDeliveryCommand(commandType: string, scopeKind: CommandScopeKind, scopeId: string, operationIdentity: string, input: object) {
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_delivery_${deliveryIdentity(operationIdentity)}`,
      commandType,
      actor: { kind: 'system' as const, id: 'git-delivery' },
      scope: { kind: scopeKind, id: scopeId },
      expectedRevision: null,
      idempotencyKey: `${commandType}:${operationIdentity}`,
      issuedAt: '2026-10-15T00:00:00.000Z',
      payload: { operationIdentity, inputSha256: createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex') },
    },
    input,
  };
}

/** 输入边界严格校验固定能力，不将任意 JSON 当作工作流执行。 */
export function parseGitDeliveryInput(value: unknown): GitDeliveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw deliveryError('交付配置无效。', undefined, 400);
  /** 逐项验证后才作为类型化请求使用。 */
  const input = value as GitDeliveryInput;
  if (!input.scope || !['task', 'conversation'].includes(input.scope.kind)) throw deliveryError('交付入口无效。', undefined, 400);
  /** 所有身份仅是查找键，绝不作为目录使用。 */
  const scopeId = input.scope.kind === 'task' ? input.scope.taskId : input.scope.conversationId;
  if (typeof scopeId !== 'string' || !scopeId || scopeId.length > 256) throw deliveryError('缺少有效交付对象。', undefined, 400);
  if (!input.settings || ['commit', 'merge', 'push', 'resolveConflicts'].some((key) => typeof input.settings[key as 'commit'] !== 'boolean')) throw deliveryError('组合操作必须明确勾选。', undefined, 400);
  if (input.settings.generateCommitMessage !== undefined && typeof input.settings.generateCommitMessage !== 'boolean') throw deliveryError('AI 提交信息选项无效。', undefined, 400);
  /** 已保存的旧运行未启用 AI；新运行必须明确携带可核验的模型快照。 */
  const generation = input.commitMessageGeneration;
  if (
    generation !== undefined &&
    (!generation ||
      !['zh-CN', 'en'].includes(generation.language) ||
      typeof generation.modelRef !== 'string' ||
      !generation.modelRef.trim() ||
      generation.modelRef.length > 2000 ||
      typeof generation.effort !== 'string' ||
      generation.effort.length > 100 ||
      (generation.serviceTier !== null && generation.serviceTier !== 'priority'))
  )
    throw deliveryError('AI 提交信息模型设置无效。', undefined, 400);
  if (!input.settings.commit && !input.settings.merge && !input.settings.push) throw deliveryError('至少选择一个 Git 操作。', undefined, 400);
  if (!['auto', 'full-access'].includes(input.settings.permissionMode)) throw deliveryError('冲突 AI 权限无效。', undefined, 400);
  if (
    (input.settings.skillId !== null && (typeof input.settings.skillId !== 'string' || input.settings.skillId.length > 512)) ||
    (input.settings.finalTaskStatus !== null && (typeof input.settings.finalTaskStatus !== 'string' || !input.settings.finalTaskStatus || input.settings.finalTaskStatus.length > 128))
  )
    throw deliveryError('Skill 或任务状态无效。', undefined, 400);
  if (input.scope.kind === 'conversation' && input.settings.finalTaskStatus !== null) throw deliveryError('普通会话不能变更任务状态。', undefined, 400);
  if (typeof input.message !== 'string' || input.message.length > 100_000 || !['merge', 'squash'].includes(input.mode)) throw deliveryError('提交说明或合入方式无效。', undefined, 400);
  if (!Array.isArray(input.repositories) || input.repositories.length === 0 || input.repositories.length > 200) throw deliveryError('请选择交付仓库。', undefined, 400);
  /** 重复仓库不能造成相同步骤运行两次。 */
  const ids = new Set<string>();
  for (const repository of input.repositories) {
    if (!repository || typeof repository.repositoryId !== 'string' || !repository.repositoryId || repository.repositoryId.length > 256 || ids.has(repository.repositoryId)) throw deliveryError('仓库身份无效或重复。', undefined, 400);
    ids.add(repository.repositoryId);
    if (
      typeof repository.expectedBranch !== 'string' ||
      !repository.expectedBranch ||
      typeof repository.expectedHeadSha !== 'string' ||
      (repository.expectedHeadSha && !/^[a-f0-9]{40,64}$/u.test(repository.expectedHeadSha)) ||
      typeof repository.mergeBranch !== 'string'
    )
      throw deliveryError('仓库分支快照无效。', undefined, 400);
    if (input.settings.merge && !repository.mergeBranch) throw deliveryError('请选择要合入的分支。', undefined, 400);
    if (
      !Array.isArray(repository.paths) ||
      repository.paths.length > 100_000 ||
      repository.paths.some((path) => typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === '..' || part === '.git'))
    )
      throw deliveryError('提交文件必须属于选中仓库。', undefined, 400);
  }
  if (input.settings.commit && input.repositories.some((repository) => repository.paths.length > 0)) {
    if (input.settings.generateCommitMessage) {
      if (!generation) throw deliveryError('请先选择 AI 提交信息使用的模型。', undefined, 400);
    } else if (!input.message.trim()) throw deliveryError('请先填写提交说明。', undefined, 400);
  }
  return {
    scope: input.scope.kind === 'task' ? { kind: 'task', taskId: scopeId } : { kind: 'conversation', conversationId: scopeId },
    settings: {
      commit: input.settings.commit,
      generateCommitMessage: input.settings.generateCommitMessage ?? false,
      merge: input.settings.merge,
      push: input.settings.push,
      resolveConflicts: input.settings.resolveConflicts,
      permissionMode: input.settings.permissionMode,
      skillId: input.settings.skillId,
      finalTaskStatus: input.settings.finalTaskStatus,
    },
    message: input.message,
    ...(generation ? { commitMessageGeneration: { language: generation.language, modelRef: generation.modelRef, effort: generation.effort, serviceTier: generation.serviceTier } } : {}),
    mode: input.mode,
    repositories: input.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      expectedBranch: repository.expectedBranch,
      expectedHeadSha: repository.expectedHeadSha,
      mergeBranch: repository.mergeBranch,
      paths: [...new Set(repository.paths)],
    })),
  };
}

/** 项目冲突会话只能使用已接纳步骤拥有的隔离目录。 */
export function resolveGitDeliveryConflictWorkspace(db: ZeusDatabase, projectId: string, stepId: unknown): { localPath: string; workspaceMode: 'worktree'; permissionMode: 'auto' | 'full-access'; skillId: string | null } {
  if (typeof stepId !== 'string') throw deliveryError('缺少冲突步骤身份。');
  /** 数据库身份来自先前经过范围校验的接纳记录。 */
  const row = db.get<{ runId: string }>('SELECT run_id AS runId FROM git_delivery_steps WHERE id = ?', [stepId]);
  const run = row ? new GitDeliveryRepository(db).get(row.runId) : undefined;
  const step = run?.steps.find((item) => item.id === stepId);
  const merge = step?.result?.merge as GitDeliveryMergeResult | undefined;
  if (!run || run.projectId !== projectId || run.scope.kind !== 'conversation' || step?.action !== 'merge' || (!run.input.settings.resolveConflicts && !step.result?.aiAuthorization) || step.state === 'succeeded' || !merge?.integrationPath)
    throw deliveryError('冲突步骤已失效或不属于当前项目。');
  /** 复用本次已接纳的权限和 Skill 选择，不允许另一个首发请求扩大权限。 */
  const settings = (step.result?.aiAuthorization ?? run.input.settings) as { permissionMode: 'auto' | 'full-access'; skillId?: string | null };
  return { localPath: merge.integrationPath, workspaceMode: 'worktree', permissionMode: settings.permissionMode, skillId: settings.skillId ?? null };
}

/** 执行器只编排现有交付能力，窗口关闭后仍由宿主持有运行。 */
export class GitDeliveryExecution {
  /** 交付事实与通知查询共用同一仓库。 */
  readonly repository: GitDeliveryRepository;
  /** 正在推进的运行防止定时唤醒重复执行。 */
  private readonly active = new Map<string, Promise<void>>();
  /** 只自动推进本次进程已接纳的运行；重启后的运行等待手动核对。 */
  private readonly authorized = new Set<string>();
  /** 服务退出后不能开始新步骤。 */
  private stopped = false;
  /** 退出时终止当前 Git 进程组，未确认写入由重启恢复核对。 */
  private readonly shutdown = new AbortController();
  /** 仅唤醒等待 AI 的运行，进度仍由真实状态决定。 */
  private timer: ReturnType<typeof setInterval> | undefined;

  /** 注入现有命令与查询能力，不启动额外服务。 */
  constructor(private readonly options: DeliveryExecutionDependencies) {
    this.repository = new GitDeliveryRepository(options.db);
  }

  /** 注册窄接口；接纳与副作用执行分离。 */
  register(): void {
    const { server, db } = this.options;
    /** 复用现有 HTTP 幂等事务实现接纳和手动继续。 */
    const mutations = new AutomationMutationApplication(db);
    /** 所有入口都保持真实项目归属。 */
    const requireRun = (projectId: string, id: string) => {
      const run = this.repository.get(id);
      if (!run || run.projectId !== projectId) throw deliveryError('交付记录不存在。', 'ZEUS_GIT_DELIVERY_NOT_FOUND', 404);
      return run;
    };
    /** 共享错误映射，不把接纳失败显示为后台运行。 */
    const fail = (reply: import('fastify').FastifyReply, error: unknown) =>
      reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as { code?: string }).code ?? 'ZEUS_GIT_DELIVERY_FAILED', message: error instanceof Error ? error.message : '交付失败。' });
    server.get<{ Params: { projectId: string } }>('/api/projects/:projectId/git-delivery-options', async (request, reply) => {
      if (!this.options.projects.getById(request.params.projectId)) return reply.code(404).send({ message: '项目不存在。' });
      return { statuses: this.options.statusOptions(request.params.projectId) };
    });
    server.get<{ Params: { projectId: string }; Querystring: { scopeId?: string } }>('/api/projects/:projectId/git-delivery-runs', async (request, reply) => {
      try {
        if (!this.options.projects.getById(request.params.projectId)) throw deliveryError('项目不存在。', undefined, 404);
        return { items: this.repository.list(request.params.projectId, request.query.scopeId).map((run) => this.repository.view(run)) };
      } catch (error) {
        return fail(reply, error);
      }
    });
    server.post<{ Params: { projectId: string }; Body: GitDeliveryInput }>('/api/projects/:projectId/git-delivery-runs', async (request, reply) => {
      try {
        this.assertWritable();
        const input = parseGitDeliveryInput(request.body);
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/u.test(key)) throw deliveryError('运行身份无效。', undefined, 400);
        const stableId = `delivery_${deliveryIdentity(`${request.params.projectId}\0${String(key)}`)}`;
        const previous = this.repository.get(stableId);
        if (previous) {
          if (canonicalCommandInputJson(previous.input) !== canonicalCommandInputJson(input)) throw deliveryError('同一次运行身份不能用于不同输入。');
          return reply.code(202).send(this.repository.view(previous));
        }
        const names: Record<string, string> = {};
        for (const selection of input.repositories) names[selection.repositoryId] = (await this.resolve(request.params.projectId, input, selection)).name;
        const task = input.scope.kind === 'task' ? this.options.tasks.getById(input.scope.taskId) : null;
        if (input.settings.finalTaskStatus && !this.options.statusOptions(request.params.projectId).some((status) => status.id === input.settings.finalTaskStatus)) throw deliveryError('所选任务状态已不存在，请重新设置。');
        const result = mutations.execute({ method: 'POST', url: request.url, body: input, key }, () => ({
          statusCode: 202,
          body: this.repository.view(this.repository.create(stableId, request.params.projectId, input, names, task?.managementStatus ?? null)),
        }));
        const run = result.body as GitDeliveryRun;
        this.authorized.add(run.id);
        setImmediate(() => this.kick(run.id));
        return reply.code(result.statusCode).send(this.repository.view(requireRun(request.params.projectId, run.id)));
      } catch (error) {
        return fail(reply, error);
      }
    });
    server.post<{ Params: { projectId: string; runId: string }; Body: { confirmWorktreeCleanup?: boolean } }>('/api/projects/:projectId/git-delivery-runs/:runId/resume', async (request, reply) => {
      try {
        this.assertWritable();
        const run = requireRun(request.params.projectId, request.params.runId);
        if (this.active.has(run.id)) return reply.code(202).send(this.repository.view(run));
        const result = mutations.execute({ method: 'POST', url: request.url, body: request.body, key: request.headers['idempotency-key'] }, () => {
          for (const step of run.steps) {
            if (step.state === 'attention') {
              /** 只有明确未完成的同步阶段可以重做，其余成功回执保持不变。 */
              const phases = { ...((step.result?.phases as Record<string, Record<string, unknown>>) ?? {}) };
              const final = phases.finalize;
              const aiFinal = phases.ai_finalize;
              if (aiFinal && (aiFinal.integration as { state?: string } | undefined)?.state !== 'merged') delete phases.ai_finalize;
              if (final && final.localSyncStatus !== 'synced' && (final.integration as { state?: string } | undefined)?.state !== 'merged') delete phases.finalize;
              this.repository.updateStep(step, {
                state: 'pending',
                attempt: step.attempt + 1,
                message: null,
                result: { ...step.result, phases, ...(step.action === 'task_status' && step.result?.cleanupConfirmation && request.body?.confirmWorktreeCleanup === true ? { confirmWorktreeCleanup: true } : {}) },
              });
            }
          }
          this.repository.updateState(run.id, 'queued');
          return { statusCode: 202, body: this.repository.view(this.repository.get(run.id)!) };
        });
        this.authorized.add(run.id);
        setImmediate(() => this.kick(run.id));
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        return fail(reply, error);
      }
    });
    server.get<{ Params: { projectId: string; runId: string; stepId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/git-delivery-runs/:runId/steps/:stepId/conflict', async (request, reply) => {
      try {
        const run = requireRun(request.params.projectId, request.params.runId);
        const step = run.steps.find((item) => item.id === request.params.stepId);
        if (!step) throw deliveryError('冲突步骤不存在。');
        if (step.integrationId && run.scope.kind === 'task') {
          const integration = this.options.taskIntegrations.getById(step.integrationId);
          const attempt = step.conversationId ? this.options.taskIntegrationAttempts.getByConversationId(step.conversationId) : undefined;
          const path = attempt?.integrationId === integration?.id && attempt?.state !== 'stale' ? attempt?.worktreePath : integration?.integrationPath;
          if (!integration || !path) throw deliveryError('原冲突现场不可用。');
          return {
            files: await readTaskIntegrationConflictPaths(path),
            sourceBranch: this.options.taskWorkspaces.getById(integration.workspaceId)?.branchName ?? '',
            targetBranch: integration.targetBranch,
            file: request.query.path ? await readTaskIntegrationConflict(path, request.query.path) : null,
          };
        }
        const merge = step.result?.merge as GitDeliveryMergeResult | undefined;
        if (!merge) throw deliveryError('冲突现场不存在。');
        const files = await readTaskIntegrationConflictPaths(merge.integrationPath);
        return { files, sourceBranch: merge.sourceBranch, targetBranch: merge.targetBranch, file: request.query.path ? await readTaskIntegrationConflict(merge.integrationPath, request.query.path) : null };
      } catch (error) {
        return fail(reply, error);
      }
    });
    server.put<{ Params: { projectId: string; runId: string; stepId: string }; Body: { path: string; content: string; fingerprint: string } }>(
      '/api/projects/:projectId/git-delivery-runs/:runId/steps/:stepId/conflict',
      async (request, reply) => {
        try {
          this.assertWritable();
          const run = requireRun(request.params.projectId, request.params.runId);
          const step = run.steps.find((item) => item.id === request.params.stepId);
          const merge = step?.result?.merge as GitDeliveryMergeResult | undefined;
          const taskIntegration = step?.integrationId ? this.options.taskIntegrations.getById(step.integrationId) : undefined;
          const attempt = step?.conversationId ? this.options.taskIntegrationAttempts.getByConversationId(step.conversationId) : undefined;
          const integrationPath = merge?.integrationPath ?? (attempt && attempt.integrationId === taskIntegration?.id && attempt.state !== 'stale' ? attempt.worktreePath : taskIntegration?.integrationPath);
          if (!step || step.action !== 'merge' || !['attention', 'waiting'].includes(step.state) || !integrationPath || (step.conversationId && ['running', 'waiting'].includes(this.options.conversationState(step.conversationId))))
            throw deliveryError('请先在原冲突会话停止 AI，再进行人工处理；也请确认冲突现场仍然存在。');
          return await withGitRepositoryOperation(integrationPath, async () => {
            const current = await readTaskIntegrationConflict(integrationPath, request.body.path);
            if (current.fingerprint !== request.body.fingerprint) throw deliveryError('冲突现场已变化，请重新读取。');
            if (typeof request.body.content !== 'string') throw deliveryError('冲突内容无效。', undefined, 400);
            const result = await this.external(run, step, `resolve:${request.body.fingerprint}`, request.body, () => writeTaskIntegrationResolution(integrationPath, request.body.path, request.body.content));
            this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, manualResolution: true } });
            return result;
          });
        } catch (error) {
          return fail(reply, error);
        }
      },
    );
    server.post<{ Params: { projectId: string; runId: string; stepId: string }; Body: { path: string; content: string; fingerprint: string; permissionMode: 'auto' | 'full-access'; skillId?: string } }>(
      '/api/projects/:projectId/git-delivery-runs/:runId/steps/:stepId/ai',
      async (request, reply) => {
        try {
          this.assertWritable();
          const run = requireRun(request.params.projectId, request.params.runId);
          const step = run.steps.find((item) => item.id === request.params.stepId);
          if (!step || step.action !== 'merge' || step.state !== 'attention' || this.active.has(run.id) || step.conversationId) throw deliveryError('请打开已有冲突会话，或等待当前操作完成。');
          if (!['auto', 'full-access'].includes(request.body.permissionMode) || typeof request.body.path !== 'string' || typeof request.body.content !== 'string' || typeof request.body.fingerprint !== 'string')
            throw deliveryError('冲突 AI 请求无效。', undefined, 400);
          const result = mutations.execute({ method: 'POST', url: request.url, body: request.body, key: request.headers['idempotency-key'] }, () => {
            this.repository.updateStep(step, { state: 'pending', message: null, result: { ...step.result, aiAuthorization: request.body, manualResolution: false } });
            this.repository.updateState(run.id, 'queued');
            return { statusCode: 202, body: this.repository.view(this.repository.get(run.id)!) };
          });
          this.authorized.add(run.id);
          setImmediate(() => this.kick(run.id));
          return reply.code(result.statusCode).send(result.body);
        } catch (error) {
          return fail(reply, error);
        }
      },
    );
  }

  /** 恢复只读取已保存事实，未知步骤不盲目重放。 */
  recover(): void {
    if (this.options.readOnly) return;
    for (const run of this.repository.unfinished()) {
      for (const step of run.steps) if (step.state === 'running') this.repository.updateStep(step, { state: 'unknown', message: '宿主已重启，请继续以核对原命令结果。' });
      this.repository.updateState(run.id, 'attention');
    }
    this.timer ??= setInterval(() => {
      for (const id of this.authorized) this.kick(id);
    }, 1500);
    this.timer.unref();
  }

  /** 退出时等待已开始的有界操作落盘，不能在数据库关闭后继续下一步。 */
  async close(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
  }

  /** 同一运行最多一轮推进，仓库之间保留独立结果。 */
  private kick(id: string): void {
    if (this.stopped || this.active.has(id)) return;
    const run = this.repository.get(id);
    if (!run || run.state === 'succeeded') {
      this.authorized.delete(id);
      return;
    }
    const work = withGitOperationSignal(this.shutdown.signal, () => this.advance(run))
      .catch((error) => {
        this.authorized.delete(id);
        for (const step of this.repository.get(id)?.steps ?? []) if (step.state === 'running') this.repository.updateStep(step, { state: 'unknown', message: error instanceof Error ? error.message : '结果需要核对。' });
        this.repository.updateState(id, 'attention');
      })
      .finally(() => {
        this.active.delete(id);
        this.changed(id);
      });
    this.active.set(id, work);
  }

  /** 每仓依次推进，失败仓库不阻塞其他仓库。 */
  private async advance(run: GitDeliveryRunRecord): Promise<void> {
    this.repository.updateState(run.id, 'running');
    await Promise.all(
      run.input.repositories.map(async (selection) => {
        try {
          const context = await this.resolve(run.projectId, run.input, selection);
          await withGitRepositoryOperation(context.repositoryPath ?? context.path, async () => {
            for (const original of this.repository.get(run.id)!.steps.filter((step) => step.repositoryId === selection.repositoryId)) {
              if (this.stopped) return;
              if (original.state === 'succeeded') continue;
              if (original.state === 'attention') return;
              try {
                if (!(await this.executeStep(run, original, selection, context))) return;
                this.changed(run.id);
              } catch (error) {
                const step = this.step(original);
                const message = error instanceof Error ? error.message : '交付操作失败。';
                const unknown = step.state === 'unknown' || /OUTCOME_UNKNOWN|RESULT_MISSING|结果未知/u.test(`${(error as { code?: string }).code ?? ''} ${message}`);
                this.repository.updateStep(step, { state: unknown ? 'unknown' : 'attention', message });
                return;
              }
            }
          });
        } catch (error) {
          const first = this.repository.get(run.id)!.steps.find((step) => step.repositoryId === selection.repositoryId && step.state !== 'succeeded');
          if (first) this.repository.updateStep(first, { state: first.state === 'unknown' ? 'unknown' : 'attention', message: error instanceof Error ? error.message : '仓库不可用。' });
        }
      }),
    );
    let current = this.repository.get(run.id)!;
    if (!this.stopped && current.steps.filter((step) => step.action !== 'task_status').every((step) => step.state === 'succeeded')) {
      const status = current.steps.find((step) => step.action === 'task_status');
      if (status && status.state !== 'succeeded' && status.state !== 'attention') {
        try {
          await this.changeTaskStatus(current, status);
        } catch (error) {
          const latest = this.step(status);
          const details = (error as { details?: Record<string, unknown> }).details;
          this.repository.updateStep(latest, {
            state: /OUTCOME_UNKNOWN|RESULT_MISSING/u.test(String((error as { code?: string }).code)) ? 'unknown' : 'attention',
            message: error instanceof Error ? error.message : '任务状态变更失败。',
            ...(details?.error === 'ZEUS_TASK_WORKTREE_CLEANUP_CONFIRMATION_REQUIRED'
              ? {
                  result: {
                    ...latest.result,
                    cleanupConfirmation: { dirtyWorkspaceCount: details.dirtyWorkspaceCount, activeConversationCount: details.activeConversationCount, activeRuntimeSessionCount: details.activeRuntimeSessionCount },
                  },
                }
              : {}),
          });
        }
      }
    }
    current = this.repository.get(run.id)!;
    const state = current.steps.every((step) => step.state === 'succeeded') ? 'succeeded' : current.steps.some((step) => step.state === 'waiting') ? 'running' : 'attention';
    this.repository.updateState(run.id, state);
    if (state !== 'running') this.authorized.delete(run.id);
  }

  /** 重启后仅恢复已经存在的命令结果；没有写出标记才允许重新进入步骤。 */
  private async reconcile(original: GitDeliveryStepRecord, context?: DeliveryRepositoryContext): Promise<void> {
    const step = this.step(original);
    if (!step.commandId) {
      this.repository.updateStep(step, { state: 'pending' });
      return;
    }
    const snapshot = this.options.commands.inspectOutcome(step.commandId);
    const latest = snapshot?.attempts.at(-1);
    if (!snapshot || latest?.receipt?.outcome === 'failed_before_write' || latest?.receipt?.outcome === 'explicitly_rejected') {
      this.repository.updateStep(step, { state: 'pending', attempt: step.attempt + 1, message: null });
      return;
    }
    if (latest?.receipt?.outcome !== 'accepted') {
      /** 仅推送具有可直接核验的远端提交事实，不能按本地 ahead 缓存猜测。 */
      const proof = step.result?.pushProof as { remote: string; branch: string; headSha: string } | undefined;
      if (step.action === 'push' && proof && context) {
        const remote = await readGit('git', ['ls-remote', '--heads', '--', proof.remote, `refs/heads/${proof.branch}`], { cwd: context.repositoryPath ?? context.path, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        if (remote.stdout.split(/\r?\n/u).some((line) => line === `${proof.headSha}\trefs/heads/${proof.branch}`)) {
          this.repository.updateStep(step, { state: 'pending', message: null, result: { ...step.result, phases: { ...((step.result?.phases as object) ?? {}), push: { verifiedRemoteHeadSha: proof.headSha } } } });
          return;
        }
      }
      /** 核对当前 Git 事实并保存观察，不把状态干净误认为原写入成功。 */
      const observed = context
        ? await getProjectGitRepositorySnapshot(context.path)
            .catch(() => getProjectGitRepositorySnapshot(context.repositoryPath ?? context.path))
            .then((current) => ({ branch: current.branch, headSha: current.headSha, clean: current.clean, conflictFiles: current.conflictFiles }))
            .catch(() => null)
        : null;
      this.repository.updateStep(step, {
        state: 'unknown',
        message: observed ? `已核对分支 ${observed.branch}（${observed.headSha.slice(0, 12)}），仍无法确认原命令结果；已保留现场，不会重复写入。` : '原命令没有确定回执，当前现场也不可读；已保留记录，等待人工处理。',
        result: { ...step.result, reconciliation: { observed, checkedAt: new Date().toISOString() } },
      });
      return;
    }
    const pending = step.result?.pendingCommand as { phase: string; kind: 'http' | 'git'; url: string; method: 'POST' | 'PATCH'; body: object } | undefined;
    if (!pending) throw deliveryError('缺少原命令请求，不能重建执行。', 'ZEUS_GIT_DELIVERY_OUTCOME_UNKNOWN');
    const value = (pending.kind === 'http' ? await this.http(pending.method, pending.url, pending.body) : await this.options.commands.readAcceptedCommand(step.commandId)) as Record<string, unknown>;
    this.repository.updateStep(step, { state: 'pending', message: null, result: { ...step.result, phases: { ...((step.result?.phases as object) ?? {}), [pending.phase]: value } } });
  }

  /** 每步都读取新事实，后续步骤不沿用 Renderer 的按钮计数。 */
  private async executeStep(run: GitDeliveryRunRecord, step: GitDeliveryStepRecord, selection: GitDeliverySelection, context: DeliveryRepositoryContext): Promise<boolean> {
    const scope = run.scope;
    if (step.state === 'unknown') {
      await this.reconcile(step, context);
      step = this.step(step);
      if (step.state === 'unknown') return false;
    }
    const phases = (step.result?.phases ?? {}) as Record<string, Record<string, unknown>>;
    if ((step.action === 'commit' && phases.commit) || (step.action === 'push' && phases.push)) {
      this.succeed(step);
      return true;
    }
    if (step.action === 'merge' && phases.merge && !step.result?.merge && !step.integrationId) {
      if (scope.kind === 'task') {
        const integration = phases.merge.integration as { id?: string } | undefined;
        if (integration?.id) this.repository.updateStep(step, { integrationId: integration.id });
      } else {
        const saved = phases.merge;
        this.repository.updateStep(step, {
          result: {
            ...step.result,
            merge: {
              integrationPath: saved.integrationPath,
              sourceBranch: selection.mergeBranch,
              targetBranch: selection.expectedBranch,
              sourceHeadSha: saved.taskHeadSha,
              targetHeadSha: saved.targetHeadSha,
              conflictFiles: saved.conflictFiles,
              resultHeadSha: saved.resultHeadSha,
            },
          },
        });
      }
      step = this.step(step);
    }
    if (step.action === 'merge' && (step.integrationId || step.result?.merge)) return this.finishMerge(run, step, selection, context);
    const taskSnapshot =
      scope.kind === 'task'
        ? ((await this.http('GET', `/api/tasks/${scope.taskId}/git-workspaces/${selection.repositoryId}/snapshot`)).workspace as {
            branchName: string;
            headSha: string | null;
            worktreePath: string | null;
            state: string;
            review: { clean: boolean; headSha: string; conflictFiles: string[] } | null;
            branchComparison: { taskHeadSha: string } | null;
          })
        : null;
    const actualPath = taskSnapshot?.worktreePath && !['merged', 'reclaimed'].includes(taskSnapshot.state) ? taskSnapshot.worktreePath : taskSnapshot ? context.repositoryPath! : context.path;
    const actual = await getProjectGitRepositorySnapshot(actualPath);
    const snapshot = taskSnapshot
      ? {
          ...actual,
          branch: taskSnapshot.branchName,
          headSha: taskSnapshot.branchComparison?.taskHeadSha ?? taskSnapshot.review?.headSha ?? taskSnapshot.headSha ?? '',
          clean: taskSnapshot.review?.clean ?? true,
          conflictFiles: taskSnapshot.review?.conflictFiles ?? [],
          detached: false,
          integrationState: null,
        }
      : actual;
    if (snapshot.branch !== selection.expectedBranch || snapshot.detached) throw deliveryError('当前分支已变化，请重新审阅交付范围。');
    const previousSteps = this.repository.get(run.id)!.steps.filter((item) => item.repositoryId === selection.repositoryId && item.state === 'succeeded');
    const committed = previousSteps.find((item) => item.action === 'commit')?.result?.phases as Record<string, Record<string, unknown>> | undefined;
    const committedResult = committed?.commit;
    const committedHead = (committedResult?.result as { headSha?: string } | undefined)?.headSha ?? committedResult?.headSha;
    const mergedStep = previousSteps.find((item) => item.action === 'merge');
    const mergedHead = scope.kind === 'task' && mergedStep?.integrationId ? this.options.taskIntegrations.getById(mergedStep.integrationId)?.taskHeadSha : (mergedStep?.result?.merge as GitDeliveryMergeResult | undefined)?.resultHeadSha;
    const expectedHead = mergedHead ?? (typeof committedHead === 'string' ? committedHead : selection.expectedHeadSha);
    if (snapshot.headSha !== expectedHead) throw deliveryError('运行范围之外出现了新提交，请重新审阅后运行。');
    if (step.action === 'merge' && (step.integrationId || step.result?.merge)) return this.finishMerge(run, step, selection, context);
    if (step.state === 'unknown') throw deliveryError('上次写入结果尚未确定，请核对原命令回执和仓库状态；不会重复执行。', 'ZEUS_GIT_DELIVERY_OUTCOME_UNKNOWN');
    this.repository.updateStep(step, { state: 'running', message: null });
    if (step.action === 'commit') {
      if (!selection.paths.length) {
        if (!snapshot.clean) throw deliveryError('仓库有未提交修改，但本次没有勾选文件。');
        this.succeed(step);
        return true;
      }
      if (snapshot.headSha !== selection.expectedHeadSha) throw deliveryError('提交前 HEAD 已变化，请重新审阅文件。');
      /** AI 生成成功后才执行原提交命令；失败不会使用旧草稿继续提交。 */
      const message = run.input.settings.generateCommitMessage ? await this.generateCommitMessage(run, step, selection, context) : run.input.message;
      if (scope.kind === 'task')
        await this.command(run, step, 'commit', `/api/tasks/${scope.taskId}/git-workspaces/${selection.repositoryId}/commit`, workspaceGitCommandTypes.taskWorkspaceCommit, 'task_workspace', selection.repositoryId, {
          message,
          selectedPaths: selection.paths,
        });
      else
        await this.external(run, step, 'commit', { type: 'commit', message, paths: selection.paths, expectedBranch: selection.expectedBranch, expectedHeadSha: selection.expectedHeadSha }, () =>
          executeProjectGitAction(context.path, { type: 'commit', message, paths: selection.paths, expectedBranch: selection.expectedBranch, expectedHeadSha: selection.expectedHeadSha }),
        );
      this.succeed(this.step(step));
      return true;
    }
    if (step.action === 'merge') {
      if (!snapshot.clean || snapshot.conflictFiles.length) throw deliveryError('合入前仍有未提交文件或原仓库冲突，请先处理。');
      if (scope.kind === 'task') {
        const existing = this.options.taskIntegrations
          .listByTask(scope.taskId)
          .find(
            (item) =>
              item.workspaceId === selection.repositoryId &&
              item.targetBranch === selection.mergeBranch &&
              (['preparing', 'conflicted', 'pending_local_sync'].includes(item.state) || (item.state === 'merged' && item.taskHeadSha === snapshot.headSha)),
          );
        if (existing) this.repository.updateStep(this.step(step), { integrationId: existing.id });
        else {
          const response = await this.command(run, step, 'merge', `/api/tasks/${scope.taskId}/git-workspaces/${selection.repositoryId}/integrate`, workspaceGitCommandTypes.taskWorkspaceIntegrate, 'task_workspace', selection.repositoryId, {
            targetBranch: selection.mergeBranch,
            mode: run.input.mode,
          });
          const integration = response.integration as { id?: string } | undefined;
          if (!integration?.id) throw deliveryError('合入仍需处理原工作区冲突。');
          this.repository.updateStep(this.step(step), { integrationId: integration.id });
        }
      } else {
        const result = await this.external(run, step, 'merge', { source: selection.mergeBranch, target: selection.expectedBranch, head: snapshot.headSha }, () =>
          startTaskBranchIntegration({
            repositoryPath: context.path,
            projectSlug: run.projectId,
            integrationId: `${step.id}_${step.attempt}`,
            targetBranch: selection.expectedBranch,
            taskBranch: selection.mergeBranch,
            mode: 'merge',
            commitMessage: run.input.message || `Merge ${selection.mergeBranch}`,
          }),
        );
        const merge: GitDeliveryMergeResult = {
          integrationPath: result.integrationPath as string,
          sourceBranch: selection.mergeBranch,
          targetBranch: selection.expectedBranch,
          sourceHeadSha: result.taskHeadSha as string,
          targetHeadSha: result.targetHeadSha as string,
          conflictFiles: result.conflictFiles as string[],
          resultHeadSha: result.resultHeadSha as string | null,
        };
        this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, merge } });
      }
      return this.finishMerge(run, this.step(step), selection, context);
    }
    if (step.action === 'push') {
      if (snapshot.conflictFiles.length || snapshot.integrationState) throw deliveryError('合入尚未完成，不能推送。');
      if (scope.kind === 'task') {
        const integration = this.options.taskIntegrations
          .listByTask(scope.taskId)
          .find((item) => item.workspaceId === selection.repositoryId && item.targetBranch === selection.mergeBranch && item.state === 'merged' && item.taskHeadSha === snapshot.headSha);
        if (!integration) throw deliveryError('请先完成对应目标的本地合入。');
        const targetHead = await getGitBranchHead(context.repositoryPath!, integration.targetBranch);
        if (targetHead !== integration.resultHeadSha) throw deliveryError('合入目标出现了新的提交，请重新审阅推送范围。');
        const workspace = this.options.taskWorkspaces.getById(selection.repositoryId)!;
        this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, pushProof: { remote: workspace.remoteName, branch: integration.targetBranch, headSha: targetHead } } });
        await this.command(run, step, 'push', `/api/tasks/${scope.taskId}/integrations/${integration.id}/push`, workspaceGitCommandTypes.taskIntegrationPush, 'task_integration', integration.id, {});
      } else {
        if (!snapshot.remotes.length) throw deliveryError('仓库未配置远端。');

        const action: ProjectGitAction = {
          type: 'push',
          remote: snapshot.upstream?.split('/')[0] ?? snapshot.remotes[0]!,
          sourceBranch: snapshot.branch,
          targetBranch: snapshot.upstream?.split('/').slice(1).join('/') || snapshot.branch,
          setUpstream: !snapshot.upstream,
        };
        this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, pushProof: { remote: action.remote, branch: action.targetBranch, headSha: snapshot.headSha } } });
        await this.external(run, step, 'push', action, () => executeProjectGitAction(context.path, action, this.shutdown.signal));
      }
      this.succeed(this.step(step));
      return true;
    }
    return false;
  }

  /** 只有真实合入终态允许继续推送，不把 AI 轮次结束等同于成功。 */
  private async finishMerge(run: GitDeliveryRunRecord, original: GitDeliveryStepRecord, selection: GitDeliverySelection, context: DeliveryRepositoryContext): Promise<boolean> {
    let step = this.step(original);
    const acceptedAi = (step.result?.phases as Record<string, Record<string, unknown>> | undefined)?.ai;
    if (!step.conversationId && acceptedAi) {
      const id = acceptedAi.conversationId ?? (acceptedAi.conversation as { id?: string } | undefined)?.id;
      if (typeof id === 'string') {
        this.repository.updateStep(step, { conversationId: id });
        step = this.step(step);
      }
    }
    /** 用户在冲突页单独确认的 AI 权限不覆盖原组合配置。 */
    const ai = step.result?.aiAuthorization as { permissionMode: 'auto' | 'full-access'; skillId?: string; path: string; content: string; fingerprint: string } | undefined;
    const aiSettings = ai ?? run.input.settings;
    if (step.conversationId) {
      const state = this.options.conversationState(step.conversationId);
      if (state === 'running') {
        this.repository.updateStep(step, { state: 'waiting' });
        return false;
      }
      if (state !== 'completed' && (state !== 'failed' || !step.result?.manualResolution)) {
        this.repository.updateStep(step, { state: 'attention', message: state === 'waiting' ? 'AI 正在等待输入或权限确认，请打开冲突会话。' : 'AI 处理未完成，请打开原会话处理后继续。' });
        return false;
      }
    }
    if (run.scope.kind === 'task') {
      if (step.conversationId && step.integrationId && this.options.taskIntegrations.getById(step.integrationId)?.state !== 'merged') {
        const result = await this.external(run, step, 'ai_finalize', { integrationId: step.integrationId, conversationId: step.conversationId }, () => this.options.finalizeTaskConflict(step.integrationId!, step.conversationId!));
        if ((result.integration as { state?: string } | undefined)?.state !== 'merged') throw deliveryError(typeof result.message === 'string' ? result.message : 'AI 结果仍需处理，请打开原冲突会话后继续。');
        step = this.step(step);
      }
      const integration = step.integrationId ? this.options.taskIntegrations.getById(step.integrationId) : undefined;
      if (!integration) throw deliveryError('原合入记录不存在。');
      if (integration.state === 'merged') {
        this.succeed(step);
        return true;
      }
      if (integration.state === 'conflicted' && integration.integrationPath) {
        const files = await readTaskIntegrationConflictPaths(integration.integrationPath);
        if (files.length) {
          if ((!run.input.settings.resolveConflicts && !ai) || step.conversationId) throw deliveryError('仍有合入冲突，请打开冲突页或原 AI 会话处理。');
          const conflict = await readTaskIntegrationConflict(integration.integrationPath, files[0]!);
          const startedAi = await this.command(
            run,
            step,
            'ai',
            `/api/tasks/${run.scope.taskId}/integrations/${integration.id}/conflict/ai-session`,
            workspaceGitCommandTypes.taskIntegrationConflictAiSession,
            'task_integration',
            integration.id,
            {
              path: files[0],
              content: ai?.path === conflict.path && ai.fingerprint === conflict.fingerprint ? ai.content : conflict.result,
              fingerprint: conflict.fingerprint,
              permissionMode: aiSettings.permissionMode,
              ...(aiSettings.skillId ? { skillId: aiSettings.skillId } : {}),
            },
          );
          this.repository.updateStep(this.step(step), { state: 'waiting', conversationId: startedAi.conversationId as string, result: { ...this.step(step).result, manualResolution: false } });
          return false;
        }
      }
      const result = await this.command(run, step, 'finalize', `/api/tasks/${run.scope.taskId}/integrations/${integration.id}/finalize`, workspaceGitCommandTypes.taskIntegrationFinalize, 'task_integration', integration.id, {});
      if ((result.integration as { state?: string } | undefined)?.state !== 'merged') throw deliveryError('本地合入仍未完成，请处理原现场后继续。');
      this.succeed(this.step(step));
      return true;
    }
    const merge = step.result?.merge as GitDeliveryMergeResult;
    const target = await getProjectGitRepositorySnapshot(context.path);
    const finalizedBefore = (step.result?.phases as Record<string, Record<string, unknown>> | undefined)?.finalize;
    if (finalizedBefore?.localSyncStatus === 'synced' && target.branch === merge.targetBranch && target.headSha === merge.resultHeadSha) {
      this.succeed(step);
      return true;
    }
    if ((await getGitBranchHead(context.path, merge.sourceBranch)) !== merge.sourceHeadSha) throw deliveryError('合入来源分支已推进，请重新审阅后运行；隔离结果已保留。');
    const files = await readTaskIntegrationConflictPaths(merge.integrationPath);
    if (files.length) {
      if ((!run.input.settings.resolveConflicts && !ai) || step.conversationId) throw deliveryError('仍有合入冲突，请打开冲突页处理后继续。');
      if (ai) {
        const current = await readTaskIntegrationConflict(merge.integrationPath, ai.path);
        if (current.fingerprint !== ai.fingerprint) throw deliveryError('冲突草稿已过期，请重新读取。');
        await this.external(run, step, 'ai_draft', { path: ai.path, content: ai.content, fingerprint: ai.fingerprint }, () => writeTaskIntegrationDraft(merge.integrationPath, ai.path, ai.content));
      }
      const body = {
        mode: 'create',
        source: 'delivery_conflict',
        deliveryStepId: step.id,
        permissionMode: aiSettings.permissionMode,
        collaborationMode: 'default',
        content: `处理代码交付的合入冲突：${merge.sourceBranch} → ${merge.targetBranch}。仅在当前隔离工作目录内解决冲突，保留双方有效业务修改。解决后保存并暂存文件。不要自行提交、合入目标分支或推送；后续操作由交付执行器按用户选择完成。无法确定业务语义时询问用户。`,
        ...(aiSettings.skillId ? { skillReferences: [{ id: aiSettings.skillId }] } : {}),
      };
      const response = await this.command(run, step, 'ai', `/api/projects/${run.projectId}/conversations`, 'conversation.project.create', 'project', run.projectId, body);
      const conversationId = (response.conversation as { id?: string } | undefined)?.id;
      if (!conversationId) throw deliveryError('冲突会话未返回持久身份。');
      this.repository.updateStep(this.step(step), { state: 'waiting', conversationId, result: { ...this.step(step).result, manualResolution: false } });
      return false;
    }
    if (target.branch !== merge.targetBranch || target.headSha !== merge.targetHeadSha || !target.clean) throw deliveryError('原目标分支或工作目录已变化，已保留隔离结果，请核对后继续。');
    if (!merge.resultHeadSha) {
      const completed = await this.external(run, step, 'complete', { sourceHeadSha: merge.sourceHeadSha, targetHeadSha: merge.targetHeadSha }, () =>
        completeTaskIntegrationCommit({ integrationPath: merge.integrationPath, mode: 'merge', commitMessage: run.input.message || `Merge ${merge.sourceBranch}` }),
      );
      merge.resultHeadSha = completed.resultHeadSha as string;
      this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, merge } });
    }
    const finalized = await this.external(run, step, 'finalize', { targetBranch: merge.targetBranch, targetHeadSha: merge.targetHeadSha, resultHeadSha: merge.resultHeadSha }, () =>
      finalizeTaskBranchIntegration({ repositoryPath: context.path, integrationPath: merge.integrationPath, targetBranch: merge.targetBranch, targetHeadSha: merge.targetHeadSha, resultHeadSha: merge.resultHeadSha! }),
    );
    if (finalized.localSyncStatus !== 'synced') throw deliveryError('隔离合入已保留，原工作目录尚未安全同步。');
    this.succeed(this.step(step));
    return true;
  }

  /** 管理状态只在全部仓库完成后使用现有业务命令更新。 */
  private async changeTaskStatus(run: GitDeliveryRunRecord, step: GitDeliveryStepRecord): Promise<void> {
    if (run.scope.kind !== 'task' || !run.input.settings.finalTaskStatus) throw deliveryError('任务状态步骤归属无效。');
    if (step.state === 'unknown') {
      await this.reconcile(step);
      step = this.step(step);
      if (step.state === 'unknown') return;
    }
    const task = this.options.tasks.getById(run.scope.taskId);
    if (!task) throw deliveryError('任务已不存在。');
    if (task.managementStatus === run.input.settings.finalTaskStatus) {
      this.succeed(step);
      return;
    }
    const latestStatusEvent = this.options.db.get<{ id: string }>("SELECT id FROM task_events WHERE task_id=? AND event_type='task.management_status.changed' ORDER BY rowid DESC LIMIT 1", [task.id])?.id ?? null;
    if ((step.result?.phases as Record<string, unknown> | undefined)?.status || latestStatusEvent !== run.initialTaskStatusEventId || task.managementStatus !== run.initialTaskStatus)
      throw deliveryError('运行期间任务状态已被修改，请核对后手动处理。');
    this.repository.updateStep(step, { state: 'running' });
    await this.command(
      run,
      step,
      'status',
      `/api/tasks/${task.id}/management-status`,
      'work_management.task.management_status.update',
      'task',
      task.id,
      { status: run.input.settings.finalTaskStatus, expectedUpdatedAt: task.updatedAt, ...(step.result?.confirmWorktreeCleanup === true ? { confirmWorktreeCleanup: true } : {}) },
      'PATCH',
    );
    this.succeed(this.step(step));
  }

  /** 内部请求仍经过认证、命令幂等和现有业务校验。 */
  private async command(
    run: GitDeliveryRunRecord,
    original: GitDeliveryStepRecord,
    phase: string,
    url: string,
    type: string,
    scopeKind: CommandScopeKind,
    scopeId: string,
    value: object,
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<Record<string, unknown>> {
    this.shutdown.signal.throwIfAborted();
    const step = this.step(original);
    const results = (step.result?.phases ?? {}) as Record<string, Record<string, unknown>>;
    if (results[phase]) return results[phase]!;
    const operation = `${step.id}:${step.attempt}:${phase}`;
    const body = gitDeliveryCommand(type, scopeKind, scopeId, operation, value);
    this.repository.updateStep(step, { commandId: body.command.commandId, result: { ...step.result, pendingCommand: { phase, kind: 'http', url, method, body } } });
    const result = await this.http(method, url, body);
    this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, phases: { ...results, [phase]: result } } });
    return result;
  }

  /** 普通目录使用相同 Git 回执应用层包装隔离操作。 */
  private async external<T extends object>(run: GitDeliveryRunRecord, original: GitDeliveryStepRecord, phase: string, input: object, invoke: () => Promise<T>): Promise<Record<string, unknown>> {
    this.shutdown.signal.throwIfAborted();
    const step = this.step(original);
    const results = (step.result?.phases ?? {}) as Record<string, Record<string, unknown>>;
    if (results[phase]) return results[phase]!;
    const operation = `${step.id}:${step.attempt}:${phase}`;
    const body = gitDeliveryCommand(workspaceGitCommandTypes.deliveryRepositoryAction, 'git_repository', step.repositoryId!, operation, input);
    this.repository.updateStep(step, { commandId: body.command.commandId, result: { ...step.result, pendingCommand: { phase, kind: 'git', input } } });
    const parsed = this.options.commands.parse({ value: body, commandType: workspaceGitCommandTypes.deliveryRepositoryAction, scopeKind: 'git_repository', scopeId: step.repositoryId! });
    const result = await this.options.commands.executeExternal({
      parsed,
      destinationId: 'git-delivery-repository',
      resourceId: `git_repository:${step.repositoryId}`,
      externalOperationId: operation,
      invoke,
      isExplicitRejection: (error) =>
        ['ZEUS_GIT_BUSY', 'ZEUS_GIT_DIRTY', 'ZEUS_TARGET_HEAD_CHANGED', 'ZEUS_GIT_SELECTION_CHANGED', 'ZEUS_GIT_INTEGRATION_ACTIVE', 'ZEUS_GIT_CONFLICTS_REMAIN'].includes(String((error as { code?: string }).code)),
    });
    const value = result.result as Record<string, unknown>;
    this.repository.updateStep(this.step(step), { result: { ...this.step(step).result, phases: { ...results, [phase]: value } } });
    return value;
  }

  /** 后台复用原生成接口的模型、脱敏和内容校验；已生成文本随步骤保存。 */
  private async generateCommitMessage(run: GitDeliveryRunRecord, original: GitDeliveryStepRecord, selection: GitDeliverySelection, context: DeliveryRepositoryContext): Promise<string> {
    this.shutdown.signal.throwIfAborted();
    /** 恢复时仍核对同一组文件，不能让旧说明用于新的内容。 */
    const fingerprint = await readCommitFingerprint(context.path, selection.paths);
    /** 成功生成后手动继续复用原文本，不重复调用模型。 */
    const step = this.step(original);
    /** 只有生成结果已持久保存且内容指纹一致时才能复用。 */
    const saved = step.result?.generatedCommitMessage as { message: string; fingerprint: string } | undefined;
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw deliveryError('生成提交信息后所选内容已变化，请重新审阅后运行。');
      return saved.message;
    }
    /** 模型由点击运行时的设置确定，服务端生成入口再次核对当前可用性。 */
    const generation = run.input.commitMessageGeneration;
    if (!generation) throw deliveryError('本次运行缺少 AI 提交信息模型设置，请重新运行。');
    /** 普通项目仓库转换为原生成接口的稳定身份；任务与会话工作树沿用自身身份。 */
    const isolated = run.scope.kind === 'task' || selection.repositoryId === `conversation:${run.scope.conversationId}`;
    /** 目录来自本次已经核验的仓库，客户端不能指定任意绝对路径。 */
    const relativePath = isolated
      ? '.'
      : relative(await realpath(this.options.projects.getById(run.projectId)!.localPath), await realpath(context.path))
          .split(sep)
          .join('/') || '.';
    /** 项目登记身份和桌面发现身份统一交给原接口再次验证。 */
    const repositoryId = isolated ? selection.repositoryId : `project_git_repository_${createHash('sha256').update(`${run.projectId}\0${relativePath}`).digest('hex').slice(0, 24)}`;
    this.repository.updateStep(step, { message: '正在 AI 生成提交信息…' });
    this.changed(run.id);
    /** 只为本仓库冻结的勾选文件生成，关闭交付窗口不影响请求。 */
    const result = await this.http(
      'POST',
      `/api/projects/${run.projectId}/git/commit-message`,
      {
        ...generation,
        repositoryId,
        ...(run.scope.kind === 'task' ? { taskId: run.scope.taskId } : {}),
        selection: [{ repositoryId, relativePath, paths: selection.paths }],
      },
      this.shutdown.signal,
    );
    this.shutdown.signal.throwIfAborted();
    /** 生成接口已限制标题格式，这里只接受实际成功返回的非空说明。 */
    const message = typeof result.message === 'string' ? result.message.trim() : '';
    if (!message) throw deliveryError('AI 未返回有效提交信息，请手动继续。');
    if (fingerprint !== (await readCommitFingerprint(context.path, selection.paths))) throw deliveryError('生成期间所选内容已变化，请重新审阅后运行。');
    this.repository.updateStep(this.step(step), { message: null, result: { ...this.step(step).result, generatedCommitMessage: { message, fingerprint, model: result.model, truncated: result.truncated === true } } });
    return message;
  }

  /** 仅本机服务内注入，不发送凭据到任何远端；生成请求随宿主退出取消。 */
  private async http(method: 'GET' | 'POST' | 'PATCH', url: string, body?: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.options.server.inject({ method, url, headers: { authorization: `Bearer ${this.options.apiToken}` }, ...(body ? { payload: body } : {}), ...(signal ? { signal } : {}) });
    const value = response.json() as Record<string, unknown>;
    if (response.statusCode >= 400)
      throw Object.assign(deliveryError(typeof value.message === 'string' ? value.message : '交付接口失败。', typeof value.error === 'string' ? value.error : 'ZEUS_GIT_DELIVERY_FAILED', response.statusCode), { details: value });
    return value;
  }

  /** 项目根目录重新发现仓库，会话工作树只允许自己的持久目录。 */
  private async resolve(projectId: string, input: GitDeliveryInput, selection: GitDeliverySelection): Promise<DeliveryRepositoryContext> {
    const project = this.options.projects.getById(projectId);
    if (!project) throw deliveryError('项目不存在。', undefined, 404);
    if (input.scope.kind === 'task') {
      const task = this.options.tasks.getById(input.scope.taskId);
      const workspace = this.options.taskWorkspaces.getById(selection.repositoryId);
      if (!task || task.projectId !== projectId || !workspace || workspace.taskId !== task.id || workspace.projectId !== projectId || workspace.state === 'discarded') throw deliveryError('工作区不属于当前任务。');
      return {
        path: workspace.worktreePath || workspace.repositoryPath || project.localPath,
        repositoryPath: workspace.repositoryPath || project.localPath,
        name: workspace.repositoryName || workspace.repositoryRelativePath || project.name,
      };
    }
    const workspace = await resolveConversationGitWorkspace(project, input.scope.conversationId, this.options.conversations, this.options.conversationSubmissions);
    if (selection.repositoryId === workspace.id) return { path: workspace.localPath, name: workspace.name };
    if (workspace.workspaceMode !== 'direct') throw deliveryError('不能扩大会话工作树的交付范围。');
    const repositories = await discoverGitRepositories(workspace.localPath);
    const registered = this.options.projectRepositories.getById(selection.repositoryId);
    const registeredPath = registered?.projectId === projectId ? await realpath(registered.localPath).catch(() => null) : null;
    const repository = repositories.find((item) => registeredPath === item.localPath || `project_git_repository_${createHash('sha256').update(`${projectId}\0${item.relativePath}`).digest('hex').slice(0, 24)}` === selection.repositoryId);
    if (!repository) throw deliveryError('仓库已不存在或不属于当前会话。');
    return { path: repository.localPath, name: repository.name };
  }

  /** 防止存储故障或只读诊断变成后台写入。 */
  private assertWritable(): void {
    if (this.options.readOnly || this.stopped) throw deliveryError('当前宿主不接受交付操作。');
  }
  /** 每次更新前读取最新事实，避免旧对象覆盖 AI 身份。 */
  private step(step: GitDeliveryStepRecord): GitDeliveryStepRecord {
    return this.repository.get(step.runId)!.steps.find((item) => item.id === step.id)!;
  }
  /** 成功结果保留回执，不清理后续恢复所需信息。 */
  private succeed(step: GitDeliveryStepRecord): void {
    this.repository.updateStep(step, { state: 'succeeded', message: null });
  }
  /** 主窗口、交付窗口与通知列表读取同一事件。 */
  private changed(id: string): void {
    const run = this.repository.get(id);
    if (run) this.options.publish('project.git_delivery.changed', { projectId: run.projectId, runId: run.id, ...(run.scope.kind === 'task' ? { taskId: run.scope.taskId } : { conversationId: run.scope.conversationId }) });
  }
}
