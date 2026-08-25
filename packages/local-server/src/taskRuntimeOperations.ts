import { type AiRuntimeLogEntry, type AiRuntimeSession, createNonCodexAiCliAdapterInvocation, isNonCodexAiCliAdapterId } from '@zeus/ai-runtime';
import {
  buildTaskPushLayout,
  isTaskAttachmentField,
  type TaskPushContextConversationOption,
  type TaskPushMessageLayout,
  type TaskPushParentAttachmentOption,
  type TaskPushParentContextOption,
  type TaskPushParentContextSelection,
  type TaskPushPromptAttachment,
  type TaskPushPromptParentContext,
  type TaskPushPromptRelatedContext,
  type TaskPushRelatedContextOption,
  type TaskPushRelatedContextSelection,
  type TaskPushSupplementalAttachment,
} from '@zeus/shared';
import { type ZeusConversationWithMessagesRecord, type ZeusProjectRecord, type ZeusTaskRecord, type ZeusTaskWorkspaceRecord } from '@zeus/storage';
import { getNextTaskStatus, type TaskStatus } from '@zeus/task-core';
import { createTelegramBotMessageClient, createTelegramLongPollingClient, createTelegramPollingService, getTelegramConfigurationState, type TelegramPollingService } from '@zeus/telegram-adapter';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { type GraphViewSnapshot } from './codeIntelligenceGraphStore.js';
import { isNativeApiRecord, nativeApiError } from './conversationApplicationOperations.js';
import type { NativeConversationAttachment } from './index.js';
import { sanitizeRuntimeFileName } from './runtimeLogRetention.js';
import { compactUtf8Tail, toAiRuntimeLogEntry, toAiRuntimeSession } from './runtimeQueryApplication.js';
import { hasTaskImageSignature, historicalTaskAttachmentField, resolveCurrentManagedTaskAttachmentPath } from './taskAttachmentLifecycle.js';
export { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor, type ReadOnlyValidationApplicationIdentity } from './readOnlyValidation.js';
// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TaskRuntimeOperationDependencies = Record<string, any>;

interface GraphQuestionAnswer {
  projectId: string;
  question: string;
  answer: string;
  sessionId: string | null;
  conversationId?: string | null;
  sources: {
    nodes: GraphViewSnapshot['nodes'];
    edges: GraphViewSnapshot['edges'];
  };
}

export interface InspectedTaskPushAttachment {
  option: TaskPushParentAttachmentOption;
  attachment?: NativeConversationAttachment;
}

export interface TaskPushCurrentConversationState {
  options: TaskPushContextConversationOption[];
  revision: string;
}

export interface TaskPushParentContextState {
  options: TaskPushParentContextOption[];
  revision: string;
  tasksById: Map<string, ZeusTaskRecord>;
  attachmentsByTaskId: Map<string, InspectedTaskPushAttachment[]>;
}

export interface TaskPushRelatedContextState {
  options: TaskPushRelatedContextOption[];
  revision: string;
  tasksById: Map<string, ZeusTaskRecord>;
  attachmentsByTaskId: Map<string, InspectedTaskPushAttachment[]>;
}

export interface TaskPushContextState {
  revision: string;
  current: TaskPushCurrentConversationState;
  parent: TaskPushParentContextState;
  related: TaskPushRelatedContextState;
}

export function createTaskRuntimeOperations(dependencies: TaskRuntimeOperationDependencies) {
  const {
    aiRuntimeManager,
    appendAuditLog,
    buildRuntimeProcessEnv,
    codexAppServerManager,
    codexExternalAgentHome,
    codexNativeCoordinator,
    codexNativeEnabled,
    conversationCapabilityQueries,
    conversations,
    createNonCodexTaskRuntimeInvocation,
    createTaskRuntimeConversation,
    createTaskRuntimePrompt,
    createTelegramRuntimeConfirmation,
    currentCodexRuntimeCommandPath,
    db,
    getProjectGitQueries,
    handleTelegramBusinessCommand,
    localLogDirectory,
    normalizeNativeConversationAttachments,
    now,
    platformMutableState,
    projects,
    publishRealtimeEvent,
    readCurrentGraphSummaryForProject,
    readGitDiff,
    readProjectConfig,
    readTelegramToken,
    recordTaskEvent,
    redactSensitiveText,
    resolveCodexModel,
    resolveResponsesRuntime,
    resolveTaskManagementStatusConfigForProject,
    runtimeSessions,
    searchCurrentGraphNodesForProject,
    taskAttachmentRoot,
    taskPushContentAttachmentFields,
    taskStatusEventTitle,
    tasks,
    telegramCommandRouteError,
    toGraphConversationHistoryItem,
    trustedConversationAttachmentRoots,
  } = dependencies;
  function resolveModelCapability<T extends { id: string; model: string }>(models: readonly T[], identity: string | null | undefined): T | null {
    const normalized = identity?.trim();
    if (!normalized) return null;
    const exact = models.find((candidate) => candidate.id === normalized);
    if (exact) return exact;
    const legacyMatches = models.filter((candidate) => candidate.model === normalized);
    return legacyMatches.length === 1 ? legacyMatches[0]! : null;
  }

  function positiveIntegerOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
  }

  async function resolveConversationCapabilities(
    project: ZeusProjectRecord,
    options: {
      refreshCodexAccount?: boolean;
      allowPiWhenCodexUnavailable?: boolean;
    } = {},
  ) {
    try {
      const codexCapabilities = codexNativeEnabled ? await codexAppServerManager.ensureReady({ commandPath: currentCodexRuntimeCommandPath(), ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) }) : null;
      const codexAccount = codexCapabilities
        ? await codexAppServerManager.readAccount({ refreshToken: options.refreshCodexAccount === true, allowCachedOnTransportFailure: options.refreshCodexAccount !== true })
        : conversationCapabilityQueries.unavailableCodexAccount();
      return conversationCapabilityQueries.buildConversationCapabilities(project, codexCapabilities, codexAccount);
    } catch (error) {
      if (!options.allowPiWhenCodexUnavailable) throw error;
      const capabilities = await conversationCapabilityQueries.buildConversationCapabilities(project, null, conversationCapabilityQueries.unavailableCodexAccount());
      if (!capabilities.models.some((model: { agentKind: string; available: boolean }) => model.agentKind === 'pi' && model.available !== false)) throw error;
      return capabilities;
    }
  }

  async function assertCodexAccountReady(modelSourceId: string | null = 'codex', model = ''): Promise<void> {
    if (model && (await resolveResponsesRuntime({ modelSourceId, model }))) return;
    const account = await codexAppServerManager.readAccount({ refreshToken: false, allowCachedOnTransportFailure: true, preferCached: true });
    if (!account.requiresOpenaiAuth || account.signedIn) return;
    throw nativeApiError('ZEUS_CODEX_LOGIN_REQUIRED', 'Zeus 专属 Codex 尚未登录。请先完成登录，再创建会话。');
  }

  function readServiceTierOverride(value: object): { present: false } | { present: true; value: string | null } {
    if (!Object.prototype.hasOwnProperty.call(value, 'serviceTier')) return { present: false };
    const serviceTier = (value as { serviceTier?: unknown }).serviceTier;
    if (serviceTier === null) return { present: true, value: null };
    if (typeof serviceTier === 'string' && serviceTier.trim()) return { present: true, value: serviceTier.trim() };
    throw nativeApiError('ZEUS_INVALID_CONVERSATION_SETTINGS', 'serviceTier must be null, a non-empty catalog id, or omitted.');
  }

  function normalizeServiceTierForCapability(requested: { present: false } | { present: true; value: string | null }, capability: { serviceTiers: Array<{ id: string }> }): string | null | undefined {
    if (!requested.present) return undefined;
    if (requested.value === null) return null;
    return capability.serviceTiers.some((tier) => tier.id === requested.value) ? requested.value : null;
  }

  /** 代码审查提示词由服务端基于冻结工作区生成，Renderer 不能扩大仓库或写操作范围。 */
  function createTaskCodeReviewPrompt(task: ZeusTaskRecord, workspace: ZeusTaskWorkspaceRecord): string {
    const repositoryRelativePath = workspace.repositoryRelativePath || '.';
    return [
      '# 代码审查任务',
      '',
      `任务：${task.taskCode} · ${task.title}`,
      `唯一审查仓库：${workspace.repositoryName}（执行环境内相对路径：${repositoryRelativePath}）`,
      `冻结来源基线：${workspace.sourceHeadSha}`,
      `来源分支：${workspace.sourceBranch}`,
      `任务分支：${workspace.branchName}`,
      '',
      '## 硬性边界',
      '',
      '- 只分析并报告，不修改、创建、删除或格式化任何文件。',
      '- 不执行提交、推送、合入、回退或其他会改变 Git 状态的动作。',
      `- 只审查 ${repositoryRelativePath} 这个仓库；同一执行环境中的其他仓库不属于本次范围。`,
      '- 开始前通读适用于该仓库的 AGENTS.md、PROJECT-STYLE.md、CODE-GUIDELINES.md、DESIGN.md 和当前任务文档。',
      '',
      '## 审查范围',
      '',
      `以冻结来源提交 ${workspace.sourceHeadSha} 为基准，覆盖到当前现场的全部变化：基准之后已经提交的变化、暂存区变化、未暂存变化和未跟踪文件。`,
      '使用只读 Git 命令核对真实差异和文件内容，不要只依赖摘要或当前会话描述。',
      '',
      '## 审查标准',
      '',
      '- 正确性与真实业务边界',
      '- 安全、权限与失败语义',
      '- 性能、并发与资源生命周期',
      '- 可维护性、重复实现与项目约定',
      '- 验证证据和仍未覆盖的风险',
      '',
      '## 输出要求',
      '',
      '先列问题，并按严重程度从高到低排序。每条问题必须包含严重程度、文件与行位置、直接证据、影响和建议修复方式。',
      '如果没有发现问题，明确写明审查范围、核对过的证据以及仍然存在的残余风险。',
    ].join('\n');
  }

  function taskPushPromptContent(task: ZeusTaskRecord) {
    return {
      taskTitle: task.title,
      taskType: task.taskType,
      taskDescription: task.description,
      defectCurrentState: task.defectCurrentState,
      defectExpectedOutcome: task.defectExpectedOutcome,
      defectReproductionSteps: task.defectReproductionSteps,
      optimizationCurrentState: task.optimizationCurrentState,
      optimizationExpectedOutcome: task.optimizationExpectedOutcome,
      tags: task.tags,
    };
  }

  function buildTaskPushLayoutForTask(
    task: ZeusTaskRecord,
    supplementalInfo: string,
    attachments: TaskPushPromptAttachment[],
    currentConversationPaths: string[] = [],
    parentContexts: TaskPushPromptParentContext[] = [],
    relatedContexts: TaskPushPromptRelatedContext[] = [],
    supplementalAttachments: TaskPushSupplementalAttachment[] = [],
  ): TaskPushMessageLayout {
    return buildTaskPushLayout({
      taskId: task.id,
      taskCode: task.taskCode,
      ...taskPushPromptContent(task),
      attachments,
      conversationPaths: currentConversationPaths,
      supplementalInfo,
      supplementalAttachments,
      parentContexts,
      relatedContexts,
    });
  }

  function taskPushTrustedAttachmentRoots(projectLocalPath: string): string[] {
    return [realpathSync(projectLocalPath), ...(taskAttachmentRoot ? [taskAttachmentRoot] : [])];
  }

  function inspectTaskPushAttachment(task: ZeusTaskRecord, rawAttachment: unknown, index: number, allowedRoots: string[]): InspectedTaskPushAttachment {
    const candidate = isNativeApiRecord(rawAttachment) ? rawAttachment : {};
    const storedPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    const path = resolveCurrentManagedTaskAttachmentPath(candidate, taskAttachmentRoot) ?? storedPath;
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : path ? parse(path).base : `附件 ${index + 1}`;
    const kind = candidate.kind === 'image' || candidate.kind === 'directory' || candidate.kind === 'pasted_text' ? candidate.kind : 'file';
    const field = isTaskAttachmentField(candidate.field) ? candidate.field : historicalTaskAttachmentField(task.taskType);
    const key = `task-attachment-${createHash('sha256').update(`${task.id}\0${index}\0${name}`).digest('hex').slice(0, 24)}`;
    const unavailable = (reason: string): InspectedTaskPushAttachment => ({
      option: { key, field, name, kind, available: false, unavailableReason: reason },
    });
    if (!path || !isAbsolute(path)) return unavailable('附件没有可验证的本机绝对路径。');
    try {
      const canonicalPath = realpathSync(path);
      const resource = statSync(canonicalPath);
      if (
        (!resource.isFile() && !resource.isDirectory()) ||
        !allowedRoots.some((root) => {
          const relativePath = relative(root, canonicalPath);
          return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
        })
      ) {
        return unavailable('附件不在服务端认可的托管资源目录内。');
      }
      const storedMime = typeof candidate.mimeType === 'string' && candidate.mimeType.trim() ? candidate.mimeType.trim() : '';
      const normalizedKind = resource.isDirectory() ? 'directory' : kind;
      const mime = resource.isDirectory() ? 'inode/directory' : storedMime || (normalizedKind === 'image' ? 'image/*' : normalizedKind === 'pasted_text' ? 'text/plain' : 'application/octet-stream');
      if (resource.isFile() && (resource.size === 0 || (normalizedKind === 'image' && !hasTaskImageSignature(mime.toLowerCase(), readFileSync(canonicalPath))))) {
        return unavailable('附件为空或图片签名不受支持。');
      }
      return {
        option: {
          key,
          field,
          name,
          kind: normalizedKind,
          ...(storedMime ? { mimeType: storedMime } : {}),
          size: resource.isDirectory() ? 0 : resource.size,
          available: true,
          unavailableReason: null,
        },
        attachment: { name, mime, size: resource.isDirectory() ? 0 : resource.size, localPath: canonicalPath, taskPushAttachmentKey: key },
      };
    } catch {
      return unavailable('附件已缺失或当前不可读取。');
    }
  }

  function inspectTaskPushAttachments(task: ZeusTaskRecord, projectLocalPath: string): { inspected: InspectedTaskPushAttachment[]; allowedRoots: string[] } {
    const sourceContext = parseTaskSourceContext(task);
    const rawAttachments = Array.isArray(sourceContext.attachments) ? sourceContext.attachments : [];
    const allowedRoots = taskPushTrustedAttachmentRoots(projectLocalPath);
    const activeFields = taskPushContentAttachmentFields(task.taskType);
    return {
      inspected: rawAttachments.map((attachment, index) => inspectTaskPushAttachment(task, attachment, index, allowedRoots)).filter((attachment) => activeFields.has(attachment.option.field)),
      allowedRoots,
    };
  }

  function normalizeTaskPushAttachments(task: ZeusTaskRecord, projectLocalPath: string): { attachments: NativeConversationAttachment[]; allowedRoots: string[]; promptAttachments: TaskPushPromptAttachment[] } {
    const { inspected, allowedRoots } = inspectTaskPushAttachments(task, projectLocalPath);
    const unavailable = inspected.filter((entry) => !entry.attachment).map((entry) => entry.option.name);
    if (unavailable.length > 0) {
      throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `以下附件不可用，未创建会话：${unavailable.join('、')}`);
    }
    return {
      attachments: inspected.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])),
      allowedRoots,
      promptAttachments: inspected.map((entry) => ({
        key: entry.option.key,
        field: entry.option.field,
        name: entry.option.name,
        kind: entry.option.kind,
        ...(entry.option.mimeType ? { mimeType: entry.option.mimeType } : {}),
        ...(entry.option.size !== undefined ? { size: entry.option.size } : {}),
      })),
    };
  }

  function normalizeTaskPushSupplementalAttachments(value: unknown, projectLocalPath: string): { attachments: NativeConversationAttachment[]; allowedRoots: string[]; promptAttachments: TaskPushSupplementalAttachment[] } {
    if (value === undefined) return { attachments: [], allowedRoots: [], promptAttachments: [] };
    if (!Array.isArray(value) || value.length > 100) {
      throw nativeApiError('ZEUS_INVALID_TASK_PUSH', 'Task push supplementalAttachments must be an array with no more than 100 entries.');
    }
    const normalized = normalizeNativeConversationAttachments(value, projectLocalPath);
    const keys = new Set<string>();
    const paths = new Set<string>();
    const attachments: NativeConversationAttachment[] = [];
    const promptAttachments: TaskPushSupplementalAttachment[] = [];
    for (const [index, attachment] of normalized.entries()) {
      const raw = isNativeApiRecord(value[index]) ? value[index] : {};
      const key = typeof raw.taskPushAttachmentKey === 'string' ? raw.taskPushAttachmentKey.trim() : '';
      if (!/^task-push-supplemental-[a-z0-9-]{8,80}$/iu.test(key) || keys.has(key)) {
        throw nativeApiError('ZEUS_INVALID_TASK_PUSH', `Supplemental attachment ${index} requires a unique task-push supplemental key.`);
      }
      keys.add(key);
      const localPath = attachment.localPath;
      if (!localPath || paths.has(localPath)) {
        throw nativeApiError('ZEUS_INVALID_TASK_PUSH', `Supplemental attachment ${index} must resolve to a unique real resource.`);
      }
      paths.add(localPath);
      const pathStat = statSync(localPath);
      const directory = pathStat.isDirectory();
      const requestedKind = raw.kind === 'image' || raw.kind === 'directory' || raw.kind === 'pasted_text' || raw.kind === 'file' ? raw.kind : attachment.mime.startsWith('image/') ? 'image' : 'file';
      if ((requestedKind === 'directory') !== directory) {
        throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `附件“${attachment.name}”的资源类型与真实文件不一致，未创建会话。`);
      }
      const kind = directory ? 'directory' : requestedKind;
      const actualSize = directory ? 0 : pathStat.size;
      if (actualSize !== attachment.size || (!directory && actualSize === 0)) {
        throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `附件“${attachment.name}”已在粘贴后发生变化，未创建会话。`);
      }
      if (kind === 'image' && (directory || !hasTaskImageSignature(attachment.mime.toLowerCase(), readFileSync(localPath)))) {
        throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `附件“${attachment.name}”不是受支持的真实图片，未创建会话。`);
      }
      const normalizedAttachment = { ...attachment, size: actualSize, taskPushAttachmentKey: key };
      attachments.push(normalizedAttachment);
      promptAttachments.push({ key, name: attachment.name, kind, mimeType: attachment.mime, size: actualSize });
    }
    const allowedRoots = [realpathSync(projectLocalPath), ...trustedConversationAttachmentRoots].filter((root, index, roots) => roots.indexOf(root) === index);
    return { attachments, allowedRoots: attachments.length > 0 ? allowedRoots : [], promptAttachments };
  }

  function listTaskPushAncestors(task: ZeusTaskRecord, projectId: string): ZeusTaskRecord[] {
    const ancestors: ZeusTaskRecord[] = [];
    const seen = new Set([task.id]);
    let parentTaskId = task.parentTaskId;
    while (parentTaskId) {
      if (seen.has(parentTaskId)) break;
      seen.add(parentTaskId);
      const parent = tasks.getById(parentTaskId);
      if (!parent || parent.projectId !== projectId) break;
      ancestors.push(parent);
      parentTaskId = parent.parentTaskId;
    }
    return ancestors.reverse();
  }

  function inspectTaskPushConversationPath(conversation: ZeusConversationWithMessagesRecord): { path: string | null; available: boolean; unavailableReason: string | null } {
    const storedPath = conversation.nativeSessionPath?.trim() ?? '';
    if (!storedPath) return { path: null, available: false, unavailableReason: 'app-server 未返回该会话的 JSONL 文件路径。' };
    if (!isAbsolute(storedPath) || !storedPath.toLowerCase().endsWith('.jsonl')) {
      return { path: null, available: false, unavailableReason: '会话路径不是绝对 JSONL 文件路径。' };
    }
    try {
      if (lstatSync(storedPath).isSymbolicLink()) return { path: null, available: false, unavailableReason: '会话路径是符号链接，不能作为普通 JSONL 文件发送。' };
      const canonicalPath = realpathSync(storedPath);
      if (!statSync(canonicalPath).isFile()) return { path: null, available: false, unavailableReason: '会话路径不是普通文件。' };
      return { path: canonicalPath, available: true, unavailableReason: null };
    } catch {
      return { path: null, available: false, unavailableReason: '会话 JSONL 文件已缺失或当前不可读取。' };
    }
  }

  function resolveTaskPushCurrentConversationState(task: ZeusTaskRecord): TaskPushCurrentConversationState {
    const revisionResources: unknown[] = [];
    const options = conversations.listAllByTask(task.id).map((conversation: ZeusConversationWithMessagesRecord): TaskPushContextConversationOption => {
      const availability = inspectTaskPushConversationPath(conversation);
      revisionResources.push({ id: conversation.id, path: availability.path, available: availability.available, archived: conversation.archived });
      return {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        archived: conversation.archived,
        ...availability,
      };
    });
    const revision = createHash('sha256').update(JSON.stringify({ options, revisionResources })).digest('hex');
    return { options, revision };
  }

  function resolveTaskPushParentContextState(project: ZeusProjectRecord, task: ZeusTaskRecord): TaskPushParentContextState {
    const ancestors = listTaskPushAncestors(task, project.id);
    const tasksById = new Map<string, ZeusTaskRecord>();
    const attachmentsByTaskId = new Map<string, InspectedTaskPushAttachment[]>();
    const revisionResources: unknown[] = [];
    const options = ancestors.map((ancestor, index): TaskPushParentContextOption => {
      tasksById.set(ancestor.id, ancestor);
      const inspectedAttachments = inspectTaskPushAttachments(ancestor, project.localPath).inspected;
      attachmentsByTaskId.set(ancestor.id, inspectedAttachments);
      const conversationOptions = conversations.listAllByTask(ancestor.id).map((conversation: ZeusConversationWithMessagesRecord) => {
        const availability = inspectTaskPushConversationPath(conversation);
        revisionResources.push({ type: 'conversation', taskId: ancestor.id, id: conversation.id, path: availability.path, available: availability.available, archived: conversation.archived });
        return {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          archived: conversation.archived,
          ...availability,
        };
      });
      for (const attachment of inspectedAttachments) {
        revisionResources.push({ type: 'attachment', taskId: ancestor.id, option: attachment.option, localPath: attachment.attachment?.localPath ?? null });
      }
      return {
        taskId: ancestor.id,
        taskCode: ancestor.taskCode,
        depth: index + 1,
        ...taskPushPromptContent(ancestor),
        conversations: conversationOptions,
        attachments: inspectedAttachments.map((entry) => entry.option),
      };
    });
    const revision = createHash('sha256').update(JSON.stringify({ options, revisionResources })).digest('hex');
    return { options, revision, tasksById, attachmentsByTaskId };
  }

  function resolveTaskPushRelatedContextState(project: ZeusProjectRecord, task: ZeusTaskRecord, ancestorTaskIds: ReadonlySet<string>): TaskPushRelatedContextState {
    const relatedTasks = (task.relatedTaskIds ?? [])
      .map((taskId) => tasks.getById(taskId))
      .filter((relatedTask): relatedTask is ZeusTaskRecord => relatedTask !== undefined)
      .filter((relatedTask) => relatedTask.projectId === project.id && !ancestorTaskIds.has(relatedTask.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const tasksById = new Map<string, ZeusTaskRecord>();
    const attachmentsByTaskId = new Map<string, InspectedTaskPushAttachment[]>();
    const revisionResources: unknown[] = [];
    const options = relatedTasks.map((relatedTask): TaskPushRelatedContextOption => {
      tasksById.set(relatedTask.id, relatedTask);
      const inspectedAttachments = inspectTaskPushAttachments(relatedTask, project.localPath).inspected;
      attachmentsByTaskId.set(relatedTask.id, inspectedAttachments);
      const conversationOptions = conversations.listAllByTask(relatedTask.id).map((conversation: ZeusConversationWithMessagesRecord) => {
        const availability = inspectTaskPushConversationPath(conversation);
        revisionResources.push({ type: 'conversation', taskId: relatedTask.id, id: conversation.id, path: availability.path, available: availability.available, archived: conversation.archived });
        return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, archived: conversation.archived, ...availability };
      });
      for (const attachment of inspectedAttachments) {
        revisionResources.push({ type: 'attachment', taskId: relatedTask.id, option: attachment.option, localPath: attachment.attachment?.localPath ?? null });
      }
      return {
        taskId: relatedTask.id,
        taskCode: relatedTask.taskCode,
        updatedAt: relatedTask.updatedAt,
        ...taskPushPromptContent(relatedTask),
        conversations: conversationOptions,
        attachments: inspectedAttachments.map((entry) => entry.option),
      };
    });
    const revision = createHash('sha256').update(JSON.stringify({ options, revisionResources })).digest('hex');
    return { options, revision, tasksById, attachmentsByTaskId };
  }

  function resolveTaskPushContextState(project: ZeusProjectRecord, task: ZeusTaskRecord): TaskPushContextState {
    const current = resolveTaskPushCurrentConversationState(task);
    const parent = resolveTaskPushParentContextState(project, task);
    const related = resolveTaskPushRelatedContextState(project, task, new Set(parent.options.map((option) => option.taskId)));
    const currentAttachments = inspectTaskPushAttachments(task, project.localPath).inspected.map((attachment) => ({ option: attachment.option, localPath: attachment.attachment?.localPath ?? null }));
    // 管理状态不属于首发正文；修订只绑定真实输入资源，避免推送确认时的状态同步使同一次首发失效。
    const revision = createHash('sha256')
      .update(JSON.stringify({ current: { content: taskPushPromptContent(task), attachments: currentAttachments, conversations: current.revision }, parent: parent.revision, related: related.revision }))
      .digest('hex');
    return { revision, current, parent, related };
  }

  function parseTaskPushSelectionStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim())) {
      throw nativeApiError('ZEUS_INVALID_TASK_PUSH_PARENT_CONTEXT', `${field} must be an array of non-empty strings.`);
    }
    const normalized = value.map((entry) => String(entry).trim());
    if (new Set(normalized).size !== normalized.length) throw nativeApiError('ZEUS_INVALID_TASK_PUSH_PARENT_CONTEXT', `${field} contains duplicate items.`);
    return normalized;
  }

  function parseTaskPushContextSelections(value: unknown, field: string): TaskPushParentContextSelection[] {
    if (!Array.isArray(value)) throw nativeApiError('ZEUS_INVALID_TASK_PUSH_CONTEXT', `${field} must be an array.`);
    const selections = value.map((rawSelection): TaskPushParentContextSelection => {
      if (!isNativeApiRecord(rawSelection) || typeof rawSelection.taskId !== 'string' || !rawSelection.taskId.trim()) {
        throw nativeApiError('ZEUS_INVALID_TASK_PUSH_CONTEXT', `Each ${field} selection requires taskId.`);
      }
      return {
        taskId: rawSelection.taskId.trim(),
        conversationIds: parseTaskPushSelectionStringArray(rawSelection.conversationIds, 'conversationIds'),
        attachmentKeys: parseTaskPushSelectionStringArray(rawSelection.attachmentKeys, 'attachmentKeys'),
      };
    });
    if (new Set(selections.map((selection) => selection.taskId)).size !== selections.length) {
      throw nativeApiError('ZEUS_INVALID_TASK_PUSH_CONTEXT', `${field} contains duplicate task selections.`);
    }
    return selections;
  }

  function resolveSelectedTaskPushContext(
    project: ZeusProjectRecord,
    task: ZeusTaskRecord,
    value: unknown,
  ): {
    currentConversationPaths: string[];
    parentContexts: TaskPushPromptParentContext[];
    relatedContexts: TaskPushPromptRelatedContext[];
    attachmentInput: { attachments: NativeConversationAttachment[]; allowedRoots: string[] };
  } {
    if (value === undefined) return { currentConversationPaths: [], parentContexts: [], relatedContexts: [], attachmentInput: { attachments: [], allowedRoots: [] } };
    if (!isNativeApiRecord(value) || typeof value.revision !== 'string') {
      throw nativeApiError('ZEUS_INVALID_TASK_PUSH_CONTEXT', 'taskContext must contain a revision.');
    }
    const currentConversationIds = value.currentConversationIds === undefined ? [] : parseTaskPushSelectionStringArray(value.currentConversationIds, 'currentConversationIds');
    const parentSelections = parseTaskPushContextSelections(value.parentSelections, 'parentSelections');
    const relatedSelections = parseTaskPushContextSelections(value.relatedSelections, 'relatedSelections');
    const state = resolveTaskPushContextState(project, task);
    if (value.revision !== state.revision) {
      throw nativeApiError('ZEUS_TASK_PUSH_CONTEXT_CHANGED', '任务上下文已变化，请刷新弹窗后重新确认。');
    }

    const selectedAttachments: NativeConversationAttachment[] = [];
    const allowedRoots = new Set<string>();
    const currentConversationById = new Map(state.current.options.map((conversation) => [conversation.id, conversation]));
    const currentConversationPaths = currentConversationIds.map((conversationId) => {
      const conversation = currentConversationById.get(conversationId);
      if (!conversation?.available || !conversation.path) {
        throw nativeApiError('ZEUS_TASK_PUSH_CONTEXT_CHANGED', '当前任务历史会话信息已变化，请刷新后重试。');
      }
      allowedRoots.add(dirname(conversation.path));
      return conversation.path;
    });
    const resolveSelections = <T extends TaskPushPromptParentContext | TaskPushPromptRelatedContext>(input: {
      kindLabel: string;
      options: Array<TaskPushParentContextOption | TaskPushRelatedContextOption>;
      tasksById: Map<string, ZeusTaskRecord>;
      attachmentsByTaskId: Map<string, InspectedTaskPushAttachment[]>;
      selections: Array<TaskPushParentContextSelection | TaskPushRelatedContextSelection>;
    }): T[] => {
      const selectionByTaskId = new Map(input.selections.map((selection) => [selection.taskId, selection]));
      for (const selection of input.selections) {
        if (!input.tasksById.has(selection.taskId)) throw nativeApiError('ZEUS_TASK_PUSH_CONTEXT_CHANGED', `${input.kindLabel}选项已变化，请刷新后重试。`);
      }
      const contexts: Array<TaskPushPromptParentContext | TaskPushPromptRelatedContext> = [];
      for (const option of input.options) {
        const selection = selectionByTaskId.get(option.taskId);
        if (!selection) continue;
        const conversationById = new Map(option.conversations.map((conversation) => [conversation.id, conversation]));
        const conversationPaths = selection.conversationIds.map((conversationId) => {
          const conversation = conversationById.get(conversationId);
          if (!conversation?.available || !conversation.path) {
            throw nativeApiError('ZEUS_TASK_PUSH_CONTEXT_CHANGED', `${input.kindLabel} ${option.taskCode} 的会话文件已变化，请刷新后重试。`);
          }
          allowedRoots.add(dirname(conversation.path));
          return conversation.path;
        });
        const attachmentByKey = new Map((input.attachmentsByTaskId.get(option.taskId) ?? []).map((attachment) => [attachment.option.key, attachment]));
        const promptAttachments: TaskPushPromptAttachment[] = [];
        for (const attachmentKey of selection.attachmentKeys) {
          const inspected = attachmentByKey.get(attachmentKey);
          if (!inspected?.attachment) {
            const name = inspected?.option.name ?? attachmentKey;
            throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `${input.kindLabel} ${option.taskCode} 的附件“${name}”已失效，未创建会话。`);
          }
          selectedAttachments.push(inspected.attachment);
          promptAttachments.push({
            key: inspected.option.key,
            field: inspected.option.field,
            name: inspected.option.name,
            kind: inspected.option.kind,
            ...(inspected.option.mimeType ? { mimeType: inspected.option.mimeType } : {}),
            ...(inspected.option.size !== undefined ? { size: inspected.option.size } : {}),
          });
        }
        const contextTask = input.tasksById.get(option.taskId)!;
        contexts.push({ taskId: option.taskId, taskCode: option.taskCode, ...taskPushPromptContent(contextTask), attachments: promptAttachments, conversationPaths });
      }
      return contexts as T[];
    };

    const parentContexts = resolveSelections<TaskPushPromptParentContext>({
      kindLabel: '父任务',
      options: state.parent.options,
      tasksById: state.parent.tasksById,
      attachmentsByTaskId: state.parent.attachmentsByTaskId,
      selections: parentSelections,
    });
    const relatedContexts = resolveSelections<TaskPushPromptRelatedContext>({
      kindLabel: '关联任务',
      options: state.related.options,
      tasksById: state.related.tasksById,
      attachmentsByTaskId: state.related.attachmentsByTaskId,
      selections: relatedSelections,
    });
    for (const root of selectedAttachments.length > 0 ? taskPushTrustedAttachmentRoots(project.localPath) : []) allowedRoots.add(root);
    return { currentConversationPaths, parentContexts, relatedContexts, attachmentInput: { attachments: selectedAttachments, allowedRoots: [...allowedRoots] } };
  }

  function mergeTaskPushAttachmentInputs(...inputs: Array<{ attachments: NativeConversationAttachment[]; allowedRoots: string[] }>) {
    const attachments = new Map<string, NativeConversationAttachment>();
    const allowedRoots = new Set<string>();
    for (const input of inputs) {
      for (const attachment of input.attachments) {
        if (!attachment.localPath) throw nativeApiError('ZEUS_TASK_PUSH_ATTACHMENT_UNAVAILABLE', `附件“${attachment.name}”缺少服务端确认的真实路径，未创建会话。`);
        const identity = attachment.taskPushAttachmentKey ?? attachment.localPath;
        const existing = attachments.get(identity);
        if (existing) {
          if (existing.localPath !== attachment.localPath) throw nativeApiError('ZEUS_INVALID_TASK_PUSH', `任务首发附件位置重复：${identity}`);
          continue;
        }
        attachments.set(identity, attachment);
      }
      for (const root of input.allowedRoots) allowedRoots.add(root);
    }
    return { attachments: [...attachments.values()], allowedRoots: [...allowedRoots] };
  }

  async function prepareWorkManagementRuntimeStart(action: 'run' | 'continue', project: ZeusProjectRecord, task: ZeusTaskRecord) {
    const eventType = action === 'run' ? 'task.runtime.run' : 'task.runtime.continue';
    const eventTitle = action === 'run' ? '任务已通过本地 API 启动 Runtime' : '任务已通过本地 API 继续 Runtime';
    const instruction = action === 'continue' ? '继续执行该任务，优先复用已有上下文并说明新的真实依据。' : undefined;
    const prompt = createTaskRuntimePrompt(task, instruction);
    if (platformMutableState.runtimeSettings.defaultAdapterId === 'codex') {
      const attachmentInput = normalizeTaskPushAttachments(task, project.localPath);
      return {
        kind: 'codex_native' as const,
        eventType,
        eventTitle,
        prompt,
        attachmentInput,
        model: await resolveCodexModel(project),
      };
    }
    if (!isNonCodexAiCliAdapterId(platformMutableState.runtimeSettings.defaultAdapterId)) {
      throw nativeApiError('ZEUS_AI_RUNTIME_ADAPTER_NOT_FOUND', `AI CLI adapter not found: ${String(platformMutableState.runtimeSettings.defaultAdapterId)}`);
    }
    return {
      kind: 'ai_cli' as const,
      eventType,
      eventTitle,
      prompt,
      invocation: createNonCodexTaskRuntimeInvocation(platformMutableState.runtimeSettings.defaultAdapterId, project, task, instruction, prompt),
    };
  }

  async function invokeWorkManagementRuntimeStart(action: 'run' | 'continue', task: ZeusTaskRecord, project: ZeusProjectRecord, operationIdentity: string, preflight: Awaited<ReturnType<typeof prepareWorkManagementRuntimeStart>>) {
    const operationHash = createHash('sha256').update(operationIdentity).digest('hex');
    if (preflight.kind === 'codex_native') {
      const operation = await codexNativeCoordinator.startTaskConversation({
        projectId: project.id,
        projectLocalPath: project.localPath,
        taskId: task.id,
        executionWorkspaceMode: 'direct',
        taskTitle: task.title,
        prompt: preflight.prompt,
        attachments: preflight.attachmentInput.attachments,
        allowedAttachmentRoots: preflight.attachmentInput.allowedRoots,
        model: preflight.model,
        allowCodeChanges: task.allowCodeChanges,
        allowTests: task.allowTests,
        allowGitCommit: task.allowGitCommit,
        idempotencyKey: `work-management-runtime:${operationHash}`,
        clientUserMessageId: `work-management-runtime-message:${operationHash}`,
      });
      return {
        kind: 'codex_native' as const,
        action,
        eventType: preflight.eventType,
        eventTitle: preflight.eventTitle,
        conversationId: operation.conversationId,
        providerThreadId: operation.providerThreadId,
        providerTurnId: operation.providerTurnId,
        operationStatus: operation.status,
      };
    }
    const session = await aiRuntimeManager.startSession({
      id: `ai-session-work-management-${operationHash}`,
      projectId: project.id,
      taskId: task.id,
      command: preflight.invocation.command,
      args: preflight.invocation.args,
      cwd: project.localPath,
      env: buildRuntimeProcessEnv(),
    });
    return {
      kind: 'ai_cli' as const,
      action,
      eventType: preflight.eventType,
      eventTitle: preflight.eventTitle,
      prompt: preflight.prompt,
      invocation: preflight.invocation,
      session,
    };
  }

  function finalizeWorkManagementRuntimeStart(action: 'run' | 'continue', task: ZeusTaskRecord, effect: Exclude<Awaited<ReturnType<typeof invokeWorkManagementRuntimeStart>>, { kind: 'stop' }>, commandId: string) {
    const project = projects.getById(task.projectId);
    if (!project) throw new Error(`Zeus project not found: ${task.projectId}`);
    const previousStatus = task.status;
    if (effect.kind === 'codex_native') {
      const conversation = conversations.getById(effect.conversationId);
      if (!conversation) throw new Error(`Zeus native conversation not found: ${effect.conversationId}`);
      let updated = task;
      if (effect.operationStatus === 'active') {
        updated = moveTaskTowardRunning(task.id, effect.eventType);
      } else if (task.status !== 'ready') {
        updated = tasks.updateStatus(task.id, getNextTaskStatus(task.status, 'ready'));
        recordTaskEvent({ taskId: updated.id, eventType: 'task.runtime.queued', title: 'Codex native 会话等待派发', payload: { from: task.status, to: updated.status, commandId } });
      }
      recordTaskEvent({
        taskId: updated.id,
        eventType: effect.operationStatus === 'active' ? effect.eventType : 'task.runtime.queued',
        title: effect.operationStatus === 'active' ? effect.eventTitle : 'Codex native 会话等待派发',
        payload: {
          conversationId: conversation.id,
          providerThreadId: effect.providerThreadId,
          providerTurnId: effect.providerTurnId,
          adapterId: 'codex',
          transportKind: 'codex_native',
          operationStatus: effect.operationStatus,
          commandId,
        },
      });
      appendAuditLog({
        actorType: 'local_api',
        action: effect.operationStatus === 'active' ? 'native.conversation.started' : 'native.conversation.queued',
        resourceType: 'conversation',
        resourceId: conversation.id,
        payload: { taskId: updated.id, projectId: project.id, providerThreadId: effect.providerThreadId, providerTurnId: effect.providerTurnId, source: effect.eventType, commandId },
      });
      if (updated.status !== previousStatus) {
        appendAuditLog({
          actorType: 'local_api',
          action: 'task.status.changed',
          resourceType: 'task',
          resourceId: updated.id,
          payload: { taskId: updated.id, projectId: updated.projectId, from: previousStatus, to: updated.status, source: effect.eventType, commandId },
        });
      }
      return {
        task: updated,
        conversation: toGraphConversationHistoryItem(conversation),
        ...(effect.operationStatus === 'queued' ? { queued: true as const, reason: 'Codex native dispatch is pending.' } : {}),
      };
    }

    const startingConversation = createTaskRuntimeConversation(effect.invocation.adapterId, effect.invocation.command, project, task, effect.prompt, effect.eventType);
    const runningConversation = conversations.updateRuntimeState(startingConversation.id, {
      sessionId: effect.session.id,
      status: 'running',
      summary: `Runtime 会话 ${effect.session.id}`,
    });
    const updated = moveTaskTowardRunning(task.id, effect.eventType);
    recordTaskEvent({
      taskId: updated.id,
      eventType: effect.eventType,
      title: effect.eventTitle,
      payload: {
        runtimeSessionId: effect.session.id,
        conversationId: runningConversation.id,
        projectId: project.id,
        adapterId: effect.invocation.adapterId,
        argCount: effect.invocation.args.length,
        commandId,
      },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'runtime.session.created',
      resourceType: 'runtime_session',
      resourceId: effect.session.id,
      payload: { sessionId: effect.session.id, projectId: project.id, taskId: updated.id, conversationId: runningConversation.id, command: effect.session.command, cwd: effect.session.cwd, source: effect.eventType, commandId },
    });
    if (updated.status !== previousStatus) {
      appendAuditLog({
        actorType: 'local_api',
        action: 'task.status.changed',
        resourceType: 'task',
        resourceId: updated.id,
        payload: { taskId: updated.id, projectId: updated.projectId, from: previousStatus, to: updated.status, source: effect.eventType, commandId },
      });
    }
    db.afterCommit(() => publishRuntimeSessionEvent('runtime.session.created', effect.session, { source: effect.eventType, conversationId: runningConversation.id }));
    return { task: updated, runtimeSession: effect.session, conversation: toGraphConversationHistoryItem(runningConversation) };
  }

  async function startTaskNativeConversation(project: ZeusProjectRecord, task: ZeusTaskRecord, eventType: string, eventTitle: string, instruction?: string, operationIdentity?: string) {
    const prompt = createTaskRuntimePrompt(task, instruction);
    const attachmentInput = normalizeTaskPushAttachments(task, project.localPath);
    const operation = await codexNativeCoordinator.startTaskConversation({
      projectId: project.id,
      projectLocalPath: project.localPath,
      taskId: task.id,
      executionWorkspaceMode: 'direct',
      taskTitle: task.title,
      prompt,
      attachments: attachmentInput.attachments,
      allowedAttachmentRoots: attachmentInput.allowedRoots,
      model: await resolveCodexModel(project),
      allowCodeChanges: task.allowCodeChanges,
      allowTests: task.allowTests,
      allowGitCommit: task.allowGitCommit,
      idempotencyKey: operationIdentity ? `work-management-runtime:${operationIdentity}` : randomUUID(),
      clientUserMessageId: operationIdentity ? `work-management-runtime-message:${operationIdentity}` : randomUUID(),
    });
    const conversation = conversations.getById(operation.conversationId);
    if (!conversation) throw new Error(`Zeus native conversation not found: ${operation.conversationId}`);
    const nextTask = operation.status === 'active' ? moveTaskTowardRunning(task.id, eventType) : task.status === 'ready' ? task : transitionTaskStatus(task, 'ready', `${eventType}.queued`);
    recordTaskEvent({
      taskId: nextTask.id,
      eventType: operation.status === 'active' ? eventType : 'task.runtime.queued',
      title: operation.status === 'active' ? eventTitle : 'Codex native 会话等待派发',
      payload: {
        conversationId: conversation.id,
        providerThreadId: operation.providerThreadId,
        providerTurnId: operation.providerTurnId,
        adapterId: 'codex',
        transportKind: 'codex_native',
        operationStatus: operation.status,
      },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: operation.status === 'active' ? 'native.conversation.started' : 'native.conversation.queued',
      resourceType: 'conversation',
      resourceId: conversation.id,
      payload: {
        taskId: nextTask.id,
        projectId: project.id,
        providerThreadId: operation.providerThreadId,
        providerTurnId: operation.providerTurnId,
        source: eventType,
      },
    });
    await db.save();
    return { task: nextTask, conversation: toGraphConversationHistoryItem(conversation), nativeOperation: operation, ...(operation.status === 'queued' ? { queued: true as const, reason: 'Codex native dispatch is pending.' } : {}) };
  }

  function stopRunningTaskRuntimeSessions(taskId: string): number {
    let stoppedSessionCount = 0;
    for (const session of aiRuntimeManager.listSessions().filter((item: AiRuntimeSession) => item.taskId === taskId && item.status === 'running')) {
      aiRuntimeManager.stopSession(session.id);
      stoppedSessionCount += 1;
    }
    return stoppedSessionCount;
  }

  function transitionTaskStatus(task: ZeusTaskRecord, target: TaskStatus, eventType: string): ZeusTaskRecord {
    const updated = tasks.updateStatus(task.id, getNextTaskStatus(task.status, target));
    recordTaskEvent({
      taskId: updated.id,
      eventType,
      title: taskStatusEventTitle(updated.status),
      payload: { from: task.status, to: updated.status },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'task.status.changed',
      resourceType: 'task',
      resourceId: updated.id,
      payload: {
        taskId: updated.id,
        projectId: updated.projectId,
        from: task.status,
        to: updated.status,
        source: eventType,
      },
    });
    publishTaskStatusChanged(updated, task.status, updated.status, eventType);
    return updated;
  }

  function publishTaskStatusChanged(task: ZeusTaskRecord, from: TaskStatus, to: TaskStatus, source: string): void {
    publishRealtimeEvent('task.status.changed', {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      from,
      to,
      status: task.status,
      source,
    });
  }

  function publishRuntimeSessionEvent(type: 'runtime.session.created' | 'runtime.session.stop_requested' | 'runtime.session.stopped', session: AiRuntimeSession, extra: Record<string, unknown> = {}): void {
    publishRealtimeEvent(type, {
      sessionId: session.id,
      projectId: session.projectId,
      taskId: session.taskId ?? null,
      command: session.command,
      status: session.status,
      cwd: session.cwd,
      ...extra,
    });
  }

  function publishRuntimeLogEvent(log: AiRuntimeLogEntry): void {
    if (log.stream !== 'stdout' && log.stream !== 'stderr') return;
    const realtimeByteBudget = 64 * 1024;
    const realtimeMarker = '[实时事件仅携带该日志块末尾，完整内容已写入 Runtime 日志]\n';
    const text = Buffer.byteLength(log.text) <= realtimeByteBudget ? log.text : `${realtimeMarker}${compactUtf8Tail(log.text, realtimeByteBudget - Buffer.byteLength(realtimeMarker))}`;
    publishRealtimeEvent(log.stream === 'stderr' ? 'runtime.session.error' : 'runtime.session.output', {
      sessionId: log.sessionId,
      logId: log.id,
      stream: log.stream,
      text,
      textTruncated: text !== log.text,
      createdAt: log.createdAt,
    });
  }

  function publishRuntimeSessionEnded(session: AiRuntimeSession): void {
    publishRealtimeEvent('runtime.session.ended', {
      sessionId: session.id,
      projectId: session.projectId,
      taskId: session.taskId ?? null,
      command: session.command,
      status: session.status,
      exitCode: session.exitCode ?? null,
      endedAt: session.endedAt ?? null,
    });
  }

  function parseTaskSourceContext(task: ZeusTaskRecord): Record<string, unknown> {
    try {
      const parsed = JSON.parse(task.sourceContextJson) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  function findProjectByRef(projectRef: string): ZeusProjectRecord | undefined {
    return projects.getById(projectRef) ?? projects.list().find((project: ZeusProjectRecord) => project.name === projectRef || project.localPath === projectRef);
  }

  function moveTaskTowardRunning(taskId: string, eventType = 'telegram.status.changed'): ZeusTaskRecord {
    const found: ZeusTaskRecord | undefined = tasks.getById(taskId);
    if (!found) throw new Error(`Task not found: ${taskId}`);
    let current: ZeusTaskRecord = found;
    if (current.status === 'completed') return current;
    if (current.status === 'running') return current;
    const path: Partial<Record<TaskStatus, TaskStatus[]>> = {
      draft: ['ready', 'running'],
      ready: ['running'],
      paused: ['running'],
      waiting_confirmation: ['running'],
      failed: ['ready', 'running'],
      cancelled: ['ready', 'running'],
    };
    for (const target of path[current.status] ?? []) {
      const nextStatus = getNextTaskStatus(current.status, target);
      current = tasks.updateStatus(current.id, nextStatus);
      recordTaskEvent({
        taskId: current.id,
        eventType,
        title: taskStatusEventTitle(nextStatus),
        payload: { to: nextStatus },
      });
    }
    return current;
  }

  function moveTaskToPushedManagementStatus(taskId: string): ZeusTaskRecord {
    const current = tasks.getById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    const statusConfig = resolveTaskManagementStatusConfigForProject(current.projectId);
    if (current.managementStatus !== statusConfig.roles.defaultStatusId || current.managementStatus === statusConfig.roles.pushedStatusId) return current;
    const updated = tasks.updateManagementStatus(current.id, statusConfig.roles.pushedStatusId, current.updatedAt);
    recordTaskEvent({
      taskId: updated.id,
      eventType: 'task.management_status.changed',
      title: '任务已进入推送后状态',
      payload: { from: current.managementStatus, to: updated.managementStatus, source: 'task_push' },
    });
    appendAuditLog({
      actorType: 'local_api',
      action: 'task.management_status.changed',
      resourceType: 'task',
      resourceId: updated.id,
      payload: {
        taskId: updated.id,
        projectId: updated.projectId,
        from: current.managementStatus,
        to: updated.managementStatus,
        source: 'task_push',
      },
    });
    publishRealtimeEvent('task.updated', {
      taskId: updated.id,
      projectId: updated.projectId,
      managementStatus: updated.managementStatus,
      changedFields: ['managementStatus'],
      updatedAt: updated.updatedAt,
    });
    return updated;
  }

  function moveTaskToWaitingConfirmation(taskId: string): ZeusTaskRecord {
    let current = moveTaskTowardRunning(taskId);
    if (current.status !== 'running') return current;
    const nextStatus = getNextTaskStatus(current.status, 'waiting_confirmation');
    current = tasks.updateStatus(current.id, nextStatus);
    recordTaskEvent({
      taskId: current.id,
      eventType: 'telegram.status.changed',
      title: taskStatusEventTitle(nextStatus),
      payload: { to: nextStatus },
    });
    return current;
  }

  function moveTaskToCancelled(taskId: string): ZeusTaskRecord {
    let current = tasks.getById(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (current.status === 'completed' || current.status === 'cancelled') return current;
    if (current.status === 'failed') {
      current = tasks.updateStatus(current.id, getNextTaskStatus(current.status, 'ready'));
    }
    const nextStatus = getNextTaskStatus(current.status, 'cancelled');
    current = tasks.updateStatus(current.id, nextStatus);
    recordTaskEvent({
      taskId: current.id,
      eventType: 'telegram.status.changed',
      title: taskStatusEventTitle(nextStatus),
      payload: { to: nextStatus },
    });
    return current;
  }

  function parseTelegramLogsArgs(args: string[]): {
    taskId: string | undefined;
    full: boolean;
  } {
    const full = args.includes('--full');
    return { taskId: args.find((arg) => arg !== '--full'), full };
  }

  function listTaskRuntimeSessions(task: ZeusTaskRecord): AiRuntimeSession[] {
    const memorySessions = aiRuntimeManager.listSessions().filter((session: AiRuntimeSession) => session.taskId === task.id);
    const persistedSessions = runtimeSessions.list({ taskId: task.id, archived: false }).map(toAiRuntimeSession);
    const sessionsById = new Map<string, AiRuntimeSession>();
    for (const session of [...persistedSessions, ...memorySessions]) sessionsById.set(session.id, session);
    return [...sessionsById.values()];
  }

  function collectRecentTaskRuntimeLogRows(task: ZeusTaskRecord): Array<{ session: AiRuntimeSession; log: AiRuntimeLogEntry }> {
    return listTaskRuntimeSessions(task)
      .flatMap((session) => runtimeSessions.listRecentLogs(session.id, 8).map((log: Parameters<typeof toAiRuntimeLogEntry>[0]) => ({ session, log: toAiRuntimeLogEntry(log) })))
      .sort((left, right) => left.log.createdAt.localeCompare(right.log.createdAt) || left.log.id.localeCompare(right.log.id));
  }

  async function formatTelegramTaskLogs(taskId: string | undefined, options: { full?: boolean } = {}): Promise<string> {
    if (!taskId) return '请提供任务 ID：/logs <taskId>';
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const rows = collectRecentTaskRuntimeLogRows(task);
    if (rows.length === 0) return `Runtime 日志为空：任务 ${task.title} (${task.id}) 暂无真实会话日志。`;
    if (options.full) {
      const project = projects.getById(task.projectId);
      if (!project) return `未找到任务所属项目：${task.projectId}`;
      return createTelegramRuntimeConfirmation(
        'logs_full',
        project,
        task,
        async () => {
          const currentTask = tasks.getById(task.id);
          if (!currentTask) return `未找到任务：${task.id}`;
          const currentSessions = listTaskRuntimeSessions(currentTask);
          if (currentSessions.length === 0 || currentSessions.every((session) => runtimeSessions.listRecentLogs(session.id, 1).length === 0)) {
            return `Runtime 日志为空：任务 ${currentTask.title} (${currentTask.id}) 暂无真实会话日志。`;
          }
          return exportTelegramTaskLogs(currentTask, currentSessions);
        },
        { affectsTaskStatus: false },
      );
    }
    const latestRows = rows.slice(-8);
    return [`Runtime 日志：${task.title} (${task.id})`, ...latestRows.map(({ session, log }) => `- ${session.command} · ${log.stream}: ${redactSensitiveText(log.text.trim()).text}`)].join('\n');
  }

  function exportTelegramTaskLogs(task: ZeusTaskRecord, sessions: readonly AiRuntimeSession[]): string {
    const exportDirectory = join(localLogDirectory, 'telegram-exports', sanitizeRuntimeFileName(task.id));
    mkdirSync(exportDirectory, { recursive: true });
    const exportFileName = `${now().toISOString().replace(/[:.]/gu, '-')}-${sanitizeRuntimeFileName(task.id)}.log`;
    const exportPath = join(exportDirectory, exportFileName);
    writeFileSync(exportPath, '', 'utf8');
    let logCount = 0;
    for (const session of sessions) {
      let afterSeq = 0;
      while (true) {
        const page = runtimeSessions.searchLogs(session.id, { afterSeq, limit: 1_000 });
        if (page.items.length === 0) break;
        const body = page.items
          .map((log: Parameters<typeof toAiRuntimeLogEntry>[0]) => {
            const text = redactSensitiveText(log.text.trimEnd()).text;
            return `${log.createdAt} ${session.id} ${session.command} [${log.stream}] ${text}`;
          })
          .join('\n');
        appendFileSync(exportPath, `${body}\n`, 'utf8');
        logCount += page.items.length;
        if (!page.hasMore || page.nextSeq <= afterSeq) break;
        afterSeq = page.nextSeq;
      }
    }
    return [`Runtime 日志已导出：${task.title} (${task.id})`, `会话 ${sessions.length} 个 · 日志 ${logCount} 行`, `文件：${exportPath}`].join('\n');
  }

  async function formatTelegramGraphAsk(projectRef: string | undefined, question: string): Promise<string> {
    if (!projectRef || !question.trim()) return '请提供项目和问题：/ask <project> <question>';
    const project = findProjectByRef(projectRef);
    if (!project) return `未找到项目：${projectRef}`;
    const answer = await answerProjectGraphQuestion(project, question.trim());
    const sourceLines = [
      ...answer.sources.nodes.slice(0, 5).map((node) => {
        const lineStart = typeof node.metadata.lineStart === 'number' ? `:${node.metadata.lineStart}` : '';
        return `- 节点 ${node.name} (${node.nodeType}) 来源 ${node.sourceRef}${lineStart}`;
      }),
      ...answer.sources.edges.slice(0, 3).map((edge) => `- 关系 ${edge.edgeType} 来源 ${edge.sourceRef} confidence ${edge.confidence}`),
    ];
    return [
      `图谱问答回答：${project.name}`,
      `问题：${answer.question}`,
      `回答：${answer.answer}`,
      answer.sessionId ? `Runtime 会话：${answer.sessionId}` : 'Runtime 会话：未启动，来源不足以判断。',
      '来源：',
      ...(sourceLines.length > 0 ? sourceLines : ['- 未命中真实图谱节点或边']),
    ].join('\n');
  }

  async function answerProjectGraphQuestion(project: ZeusProjectRecord, question: string, parentOperationIdentity?: string): Promise<GraphQuestionAnswer> {
    const childIdentity = parentOperationIdentity ? stableGraphQuestionChildIdentity(parentOperationIdentity) : null;
    const { summary } = readCurrentGraphSummaryForProject(project);
    if (summary.nodeCount === 0) {
      return createInsufficientGraphAnswer(project.id, question, `不足以判断：项目 ${project.name} 尚未扫描出真实代码图谱。`, childIdentity?.conversationId);
    }
    const { result } = searchCurrentGraphNodesForProject(project, question, undefined, undefined, '0');
    if (result.nodes.length === 0 && result.edges.length === 0) {
      return createInsufficientGraphAnswer(project.id, question, '不足以判断：未命中真实图谱节点或边，请换用源码文件名、模块名、函数名或接口名提问。', childIdentity?.conversationId);
    }
    const nodes = result.nodes.slice(0, 5);
    const edges = result.edges.slice(0, 3);
    const projectConfig = readProjectConfig(project.id);
    const prompt = buildGraphQuestionPrompt(project, question, nodes, edges, projectConfig);
    const adapterId = platformMutableState.runtimeSettings.defaultAdapterId;
    if (adapterId === 'codex') {
      const operation = await codexNativeCoordinator.startEphemeralConversation({
        ...(childIdentity ? { conversationId: childIdentity.conversationId, submissionId: childIdentity.submissionId } : {}),
        projectId: project.id,
        projectLocalPath: project.localPath,
        title: `图谱问答：${question.slice(0, 48)}`,
        prompt,
        model: await resolveCodexModel(project),
        idempotencyKey: childIdentity?.providerIdempotencyKey ?? randomUUID(),
        clientUserMessageId: childIdentity?.clientUserMessageId ?? randomUUID(),
      });
      if (operation.status !== 'active' || !operation.providerTurnId) {
        throw Object.assign(new Error('Codex native graph provider dispatch failed.'), { code: 'ZEUS_CODEX_EPHEMERAL_DISPATCH_FAILED' });
      }
      const completed = await codexNativeCoordinator.waitForTurnResult({
        conversationId: operation.conversationId,
        providerTurnId: operation.providerTurnId,
        timeoutMs: platformMutableState.runtimeSettings.executionTimeoutSeconds * 1_000,
      });
      return {
        projectId: project.id,
        question,
        answer: completed.answer || '不足以判断：Codex native turn 未返回可用回答。',
        sessionId: null,
        conversationId: operation.conversationId,
        sources: { nodes, edges },
      };
    }
    if (!isNonCodexAiCliAdapterId(adapterId)) {
      throw new Error(`AI CLI adapter not found: ${String(adapterId)}`);
    }
    const invocation = createNonCodexAiCliAdapterInvocation(adapterId, prompt, {
      // 图谱问答同样属于项目内 AI Runtime，优先使用项目默认模型。
      model: projectConfig.defaultModel ?? platformMutableState.runtimeSettings.adapterModels[adapterId],
      defaultArgs: platformMutableState.runtimeSettings.adapterDefaultArgs[adapterId] ?? [],
      commandPath: platformMutableState.runtimeSettings.adapterCliPaths[adapterId],
    });
    const session = await aiRuntimeManager.startSession({
      ...(childIdentity ? { id: childIdentity.runtimeSessionId } : {}),
      projectId: project.id,
      command: invocation.command,
      args: invocation.args,
      cwd: project.localPath,
      env: buildRuntimeProcessEnv(),
    });
    await waitForRuntimeSessionExit(session.id, platformMutableState.runtimeSettings.executionTimeoutSeconds * 1_000);
    await db.save();
    const answer = collectRuntimeAnswer(session.id);
    return {
      projectId: project.id,
      question,
      answer: answer || '不足以判断：AI Runtime 未返回可用回答。',
      sessionId: session.id,
      ...(childIdentity ? { conversationId: childIdentity.conversationId } : {}),
      sources: { nodes, edges },
    };
  }

  function createInsufficientGraphAnswer(projectId: string, question: string, answer: string, conversationId?: string): GraphQuestionAnswer {
    return {
      projectId,
      question,
      answer,
      sessionId: null,
      ...(conversationId ? { conversationId } : {}),
      sources: { nodes: [], edges: [] },
    };
  }

  function stableGraphQuestionChildIdentity(parentOperationIdentity: string): {
    conversationId: string;
    submissionId: string;
    runtimeSessionId: string;
    providerIdempotencyKey: string;
    clientUserMessageId: string;
  } {
    const derive = (kind: string): string => createHash('sha256').update(`${parentOperationIdentity}\0${kind}`).digest('hex').slice(0, 24);
    return {
      conversationId: `conversation_graph_${derive('conversation')}`,
      submissionId: `conversation_submission_graph_${derive('submission')}`,
      runtimeSessionId: `graph-session-${derive('runtime-session')}`,
      providerIdempotencyKey: `graph-question:${derive('provider-operation')}`,
      clientUserMessageId: `graph-client-${derive('client-message')}`,
    };
  }

  /** 将图谱问答沉淀为可追溯对话；只保存真实问题、真实回答和真实来源 ID，不生成任何伪上下文。 */
  function persistGraphQuestionConversation(answer: GraphQuestionAnswer): void {
    if (answer.conversationId) {
      const nativeConversation = conversations.getById(answer.conversationId);
      if (nativeConversation?.transportKind === 'codex_native') {
        conversations.updateRuntimeState(nativeConversation.id, { status: 'closed', summary: answer.answer.slice(0, 240) });
        return;
      }
    }
    const createdAt = new Date().toISOString();
    const conversation = conversations.create({
      ...(answer.conversationId ? { id: answer.conversationId } : {}),
      projectId: answer.projectId,
      sessionId: answer.sessionId ?? undefined,
      title: `图谱问答：${answer.question.slice(0, 48)}`,
      summary: answer.answer.slice(0, 240),
      status: 'closed',
    });
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: answer.question,
      source: 'graph_question',
      metadata: { projectId: answer.projectId },
      createdAt,
    });
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: answer.answer,
      source: 'graph_answer',
      metadata: {
        projectId: answer.projectId,
        sessionId: answer.sessionId,
        sourceNodeIds: answer.sources.nodes.map((node) => node.id),
        sourceEdgeIds: answer.sources.edges.map((edge) => edge.id),
      },
      createdAt: new Date(Date.parse(createdAt) + 1).toISOString(),
    });
  }

  function buildGraphQuestionPrompt(project: ZeusProjectRecord, question: string, nodes: GraphViewSnapshot['nodes'], edges: GraphViewSnapshot['edges'], projectConfig = readProjectConfig(project.id)): string {
    const sourceContext = {
      graphQuestion: question,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.nodeType,
        name: node.name,
        qualifiedName: node.qualifiedName,
        sourceRef: node.sourceRef,
        lineStart: node.metadata.lineStart,
        lineEnd: node.metadata.lineEnd,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        type: edge.edgeType,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        sourceRef: edge.sourceRef,
        confidence: edge.confidence,
      })),
    };
    return [
      '你是 Zeus 本地优先 AI 研发工作台中的 AI Runtime。',
      '只能基于真实仓库、真实日志、真实错误输出行动；信息不足时先说明缺口，不要编造结果。',
      `项目：${project.name}`,
      `项目路径：${project.localPath}`,
      `任务：图谱问答：${question}`,
      '任务描述：基于 Zeus 真实代码图谱回答用户问题。回答必须带来源；如果来源不足，明确说“不足以判断”。',
      `来源上下文：${JSON.stringify(sourceContext)}`,
      `项目默认工作模式：${projectConfig.defaultWorkMode}`,
      ...(projectConfig.defaultTaskPrompt.trim() ? [`项目默认任务提示词：${projectConfig.defaultTaskPrompt.trim()}`] : []),
      '执行要求：请仅基于 sourceContext 中的真实图谱节点和边回答，保留文件路径、行号、节点或关系来源；不要编造未出现的模块、接口、表或任务记录。',
    ].join('\n');
  }

  async function waitForRuntimeSessionExit(sessionId: string, timeoutMs: number): Promise<void> {
    if (await aiRuntimeManager.waitForSessionCompletion(sessionId, timeoutMs)) return;
    // 超时后必须先请求停止并等待 close 排空；仍不退出时再强制结束，禁止留下后台耗能进程。
    aiRuntimeManager.stopSession(sessionId);
    if (!(await aiRuntimeManager.waitForSessionCompletion(sessionId, 5_000))) {
      aiRuntimeManager.killSession(sessionId, 'SIGKILL');
      if (!(await aiRuntimeManager.waitForSessionCompletion(sessionId, 5_000))) {
        throw Object.assign(new Error('AI Runtime 超时且无法完成日志排空。'), { code: 'ZEUS_AI_RUNTIME_DRAIN_TIMEOUT' });
      }
    }
    throw Object.assign(new Error('AI Runtime 执行超时，已终止后台进程。'), { code: 'ZEUS_AI_RUNTIME_EXECUTION_TIMEOUT' });
  }

  function collectRuntimeAnswer(sessionId: string): string {
    // 自动收集答案也必须有内存上限，避免异常超长 stdout 一次性进入主进程。
    const page = runtimeSessions.searchLogs(sessionId, {
      stream: 'stdout',
      tail: true,
      limit: 2_000,
      byteBudget: 4 * 1024 * 1024,
    });
    const answer = page.items
      .filter((log: { stream: string }) => log.stream === 'stdout')
      .map((log: { text: string }) => log.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    return page.truncated ? `[Runtime 输出过长，仅采用最近 4MB；完整历史请查看 Runtime 日志。]\n${answer}`.trim() : answer;
  }

  async function formatTelegramTaskDiff(taskId: string | undefined): Promise<string> {
    if (!taskId) return '请提供任务 ID：/diff <taskId>';
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    return createTelegramRuntimeConfirmation('diff', project, task, async () => formatTelegramTaskDiffAfterConfirmation(task.id), { affectsTaskStatus: false });
  }

  async function formatTelegramTaskDiffAfterConfirmation(taskId: string): Promise<string> {
    const task = tasks.getById(taskId);
    if (!task) return `未找到任务：${taskId}`;
    const project = projects.getById(task.projectId);
    if (!project) return `未找到任务所属项目：${task.projectId}`;
    const gitScope = getProjectGitQueries().resolveProjectScope(project);
    if ('limitation' in gitScope) return `Git Diff：${gitScope.limitation}`;
    const diff = await readGitDiff(gitScope.path);
    if (!diff.isRepository) return `Git Diff：${project.localPath} 不是 Git 仓库。`;
    if (diff.files.length === 0) return `Git Diff：${project.localPath} 当前没有未提交变更。`;
    const diffText = redactSensitiveText(diff.diffText).text;
    if (diff.diffText.length > 1200 || diff.files.length > 12) {
      return [
        `Git Diff 摘要：${project.name} (${project.localPath})`,
        `变更文件 ${diff.files.length} 个，diffTextLength=${diff.diffText.length}`,
        ...diff.files.slice(0, 12).map((file: string) => `- ${file}`),
        diff.files.length > 12 ? `…另有 ${diff.files.length - 12} 个文件未在 Telegram 中展开` : '完整 diff 请在 Zeus 桌面端或补丁导出中查看。',
      ].join('\n');
    }
    return [`Git Diff：${project.name} (${project.localPath})`, `变更文件 ${diff.files.length} 个：`, ...diff.files.slice(0, 12).map((file: string) => `- ${file}`), diffText ? diffText.slice(0, 1200) : '无 diff 文本。'].join('\n');
  }

  async function requireTelegramPollingService(): Promise<TelegramPollingService> {
    const token = await readTelegramToken();
    const allowedUserIds = platformMutableState.telegramSecuritySettings.allowedUserIds;
    const state = getTelegramConfigurationState(token, allowedUserIds);
    if (!state.enabled || !token) throw telegramCommandRouteError('ZEUS_TELEGRAM_UNCONFIGURED', state.reason, 400);
    platformMutableState.telegramMessageSender ??= createTelegramBotMessageClient({ token });
    const sender = platformMutableState.telegramMessageSender;
    platformMutableState.telegramPollingService ??= createTelegramPollingService({
      client: createTelegramLongPollingClient({ token }),
      allowedUserIds,
      reply: (chatId, text, replyOptions) => {
        if (replyOptions?.editMessageId && sender.editMessage) {
          return sender.editMessage(chatId, replyOptions.editMessageId, text, { inlineKeyboard: replyOptions.inlineKeyboard });
        }
        return sender.sendMessage(chatId, text, { inlineKeyboard: replyOptions?.inlineKeyboard });
      },
      handleCommand: (command, update) => handleTelegramBusinessCommand(command, update),
    });
    return platformMutableState.telegramPollingService;
  }

  return {
    resolveModelCapability,
    positiveIntegerOrNull,
    resolveConversationCapabilities,
    assertCodexAccountReady,
    readServiceTierOverride,
    normalizeServiceTierForCapability,
    createTaskCodeReviewPrompt,
    taskPushPromptContent,
    buildTaskPushLayoutForTask,
    taskPushTrustedAttachmentRoots,
    inspectTaskPushAttachment,
    inspectTaskPushAttachments,
    normalizeTaskPushAttachments,
    normalizeTaskPushSupplementalAttachments,
    listTaskPushAncestors,
    inspectTaskPushConversationPath,
    resolveTaskPushCurrentConversationState,
    resolveTaskPushParentContextState,
    resolveTaskPushRelatedContextState,
    resolveTaskPushContextState,
    parseTaskPushSelectionStringArray,
    parseTaskPushContextSelections,
    resolveSelectedTaskPushContext,
    mergeTaskPushAttachmentInputs,
    prepareWorkManagementRuntimeStart,
    invokeWorkManagementRuntimeStart,
    finalizeWorkManagementRuntimeStart,
    startTaskNativeConversation,
    stopRunningTaskRuntimeSessions,
    transitionTaskStatus,
    publishTaskStatusChanged,
    publishRuntimeSessionEvent,
    publishRuntimeLogEvent,
    publishRuntimeSessionEnded,
    parseTaskSourceContext,
    findProjectByRef,
    moveTaskTowardRunning,
    moveTaskToPushedManagementStatus,
    moveTaskToWaitingConfirmation,
    moveTaskToCancelled,
    parseTelegramLogsArgs,
    listTaskRuntimeSessions,
    collectRecentTaskRuntimeLogRows,
    formatTelegramTaskLogs,
    exportTelegramTaskLogs,
    formatTelegramGraphAsk,
    answerProjectGraphQuestion,
    createInsufficientGraphAnswer,
    stableGraphQuestionChildIdentity,
    persistGraphQuestionConversation,
    buildGraphQuestionPrompt,
    waitForRuntimeSessionExit,
    collectRuntimeAnswer,
    formatTelegramTaskDiff,
    formatTelegramTaskDiffAfterConfirmation,
    requireTelegramPollingService,
  };
}
