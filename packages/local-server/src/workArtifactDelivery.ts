import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filenameMatchesTaskCode } from './contextSourceCatalog.js';
import {
  ArtifactStore,
  TaskWorkStoreError,
  taskWorkDeliverableArtifactGeneration,
  type ArtifactRef,
  type ConversationRepository,
  type ProjectRepository,
  type TaskRepository,
  type TaskWorkDeliverableRecord,
  type TaskWorkDeliverableRepository,
  type TaskWorkRunRecord,
  type TaskWorkRunRepository,
  type TaskWorkspaceRepository,
  type WorkArtifactFile,
  type WorkArtifactRepository,
} from '@zeus/storage';

/** 固定成果正文和附件共用的最大读取容量。 */
const maximumArtifactBytes = 12 * 1024 * 1024;
/** 单次模型读取仅返回有界正文，余文通过偏移继续。 */
const maximumReadCharacters = 16_384;

/** Core 发布使用数据库身份及准确会话工作区，不接受模型指定根目录。 */
export interface WorkArtifactDeliveryOptions {
  /** 耐久清单与导出位置。 */
  publications: WorkArtifactRepository;
  /** 不可变正文和附件存储。 */
  artifacts: ArtifactStore;
  /** 正式成果身份读取器。 */
  deliverables: TaskWorkDeliverableRepository;
  /** 工作运行及冻结上下文读取器。 */
  runs: TaskWorkRunRepository;
  /** 稳定任务 ID 和当前编码。 */
  tasks: TaskRepository;
  /** 项目资料根目录。 */
  projects: ProjectRepository;
  /** 实际执行会话身份。 */
  conversations: ConversationRepository;
  /** 准确工作区根目录，不复用其他员工的工作区。 */
  workspaces: TaskWorkspaceRepository;
  /** 无有效项目目录时使用受管资料根目录。 */
  managedRoot: string;
}

/** 正式成果的读写以 Core 关系为准，docs 只是可以重建的阅读副本。 */
export class WorkArtifactDelivery {
  /** 不引入独立调度器或执行状态。 */
  constructor(private readonly options: WorkArtifactDeliveryOptions) {}

  /** 派发前恢复唯一可证的旧返工来源，不修改已有会话或已执行轮次。 */
  restorePreparedReworkHandoff(runId: string): boolean {
    return this.options.publications.restorePreparedReworkHandoff(runId);
  }

  /** 接纳修复节点时核对正式父失败成果，不能借关联任务突破权限。 */
  canPrepareRepairHandoff(taskId: string, sourceRef: string, deliverableId: string): boolean {
    return this.options.publications.repairHandoff(taskId, sourceRef, deliverableId);
  }

  /** 旧提交路径的真实文件引用也归入本轮清单；上游正文只保留引用，不重复复制。 */
  includeReferencedFile(run: TaskWorkRunRecord, ref: ArtifactRef): void {
    if (ref.owner.projectId !== run.projectId || ref.owner.conversationId !== run.conversationId) return;
    const files = this.options.publications.submissions(run.id);
    if (files.some((file) => file.ref.contentSha256 === ref.contentSha256)) return;
    if (files.length >= 64) throw scopeError('一轮工作最多提交 64 个文件。');
    this.options.artifacts.readAuthorizedSync({ sha256: ref.sha256, owner: ref.owner, maximumContentBytes: maximumArtifactBytes });
    const owned = this.options.artifacts.attachOwner({ sha256: ref.sha256, owner: { kind: 'task_work_submission', id: run.id, generationId: 'work_artifact_submission', projectId: run.projectId, conversationId: run.conversationId } });
    const extension = ref.mimeType === 'text/markdown' ? '.md' : ref.mimeType === 'application/json' ? '.json' : ref.mimeType.startsWith('text/') ? '.txt' : '.bin';
    this.options.publications.submit(run.id, { path: `引用/${ref.contentSha256}${extension}`, ref: owned });
  }

  /** 复用 Task Work 的调度循环重建，失败轮转且不占用模型执行资源。 */
  retryPending(now: Date, limit = 3): Array<{ taskId: string; error: string | null }> {
    const pending = this.options.publications.pendingTaskIds(limit, new Date(now.getTime() - 30_000).toISOString());
    return pending.map((taskId) => {
      try {
        this.rebuildTask(taskId);
        return { taskId, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const publication of this.options.publications.list(taskId)) this.options.publications.exported(publication.deliverableId, null, message);
        return { taskId, error: message };
      }
    });
  }

  /** 员工显式提交工作区内真实文件；不追踪符号链接或读取工作区外资料。 */
  async submit(run: TaskWorkRunRecord, relativePath: string): Promise<WorkArtifactFile> {
    if (!['prepared', 'dispatching', 'active', 'waiting_input'].includes(run.status)) throw scopeError('工作已结束，不能继续提交文件。');
    /** 源目录由当前会话绑定决定，文件内容在提交时冻结。 */
    const path = safeRelativePath(relativePath);
    const source = safePath(this.workspaceRoot(run), path);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size > maximumArtifactBytes) throw scopeError('只允许提交不超过 12 MiB 的普通文件。');
    const submitted = this.options.publications.submissions(run.id);
    if (submitted.length >= 64 && !submitted.some((file) => file.path === `文件/${path}`)) throw scopeError('一轮工作最多提交 64 个文件。');
    /** 同一运行的所有附件由确定 owner 管理，模型不能冒用别人的 owner。 */
    const ref = await this.options.artifacts.putFile({
      sourcePath: source,
      mimeType: mimeType(path),
      owner: { kind: 'task_work_submission', id: run.id, generationId: 'work_artifact_submission', projectId: run.projectId, conversationId: run.conversationId },
    });
    /** 原相对路径保留在成果的文件目录中，避免同名附件冲突。 */
    const file = { path: `文件/${path}`, ref };
    this.options.publications.submit(run.id, file);
    return file;
  }

  /** 将既有正式正文和显式附件冻结为同一交接清单，重复调用不会替换它。 */
  freeze(deliverable: TaskWorkDeliverableRecord): ReturnType<WorkArtifactRepository['freeze']> {
    const existing = this.options.publications.get(deliverable.id);
    if (existing) return existing;
    /** 正式关系必须与准确工作运行完全一致。 */
    const run = this.options.runs.getById(deliverable.runId);
    if (!run || run.taskId !== deliverable.taskId || run.projectId !== deliverable.projectId || run.workItemId !== deliverable.workItemId) throw scopeError('成果与工作运行归属不一致。');
    /** 既有正文由 ArtifactStore 再核对 owner 和摘要，不能信任外部引用字段。 */
    const body = this.options.artifacts.readAuthorizedSync({ sha256: deliverable.artifactSha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, maximumContentBytes: maximumArtifactBytes });
    if (body.ref.contentSha256 !== deliverable.contentSha256) throw scopeError('正式成果正文摘要不一致。');
    const files: WorkArtifactFile[] = [{ path: '交接.md', ref: body.ref }];
    for (const file of this.options.publications.submissions(run.id)) {
      /** 先核对原运行 owner，再附加正式成果 owner，避免跨工作引用扩大授权。 */
      this.options.artifacts.readAuthorizedSync({ sha256: file.ref.sha256, owner: { kind: 'task_work_submission', id: run.id }, maximumContentBytes: maximumArtifactBytes });
      const ref = this.options.artifacts.attachOwner({
        sha256: file.ref.sha256,
        owner: { kind: 'task_work_deliverable', id: deliverable.id, generationId: taskWorkDeliverableArtifactGeneration, projectId: run.projectId, conversationId: run.conversationId },
      });
      this.options.artifacts.hold({ sha256: ref.sha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, ownerClass: 'active_task', reason: `task-work-deliverable:${run.taskId}` });
      files.push({ path: safeRelativePath(file.path), ref });
    }
    return this.options.publications.freeze({ deliverableId: deliverable.id, taskId: deliverable.taskId, runId: deliverable.runId, files });
  }

  /** Core 导出失败只保存错误，冻结成果仍可以受控读取及重建。 */
  publish(deliverable: TaskWorkDeliverableRecord): { root: string | null; error: string | null } {
    this.freeze(deliverable);
    try {
      const root = this.rebuildTask(deliverable.taskId);
      return { root, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.publications.exported(deliverable.id, null, message);
      return { root: null, error: message };
    }
  }

  /** 只凭固定成果重建目录；不启动会话，不读取执行员工的可变文件。 */
  rebuildTask(taskId: string): string {
    /** 任务重编号始终从稳定 ID 查最新编码。 */
    const task = this.options.tasks.getById(taskId);
    if (!task) throw scopeError('成果所属任务不存在。');
    const project = this.options.projects.getById(task.projectId);
    const docsRoot = resolve(project?.localPath || this.options.managedRoot, 'docs');
    mkdirSync(docsRoot, { recursive: true });
    const root = safePath(docsRoot, safeRelativePath(task.taskCode || task.id));
    const previous = this.options.publications.location(taskId);
    /** 已登记旧位置才允许整体搬移；目标存在即停止，不合并或覆盖。 */
    if (previous && previous.root !== root && existsSync(previous.root)) {
      safePath(dirname(previous.root), basename(previous.root));
      if (existsSync(root)) throw scopeError('任务重编号后的资料目录已存在，保留两处现场等待处理。');
      renameSync(previous.root, root);
      this.options.publications.saveLocation(taskId, root, previous.ownedFiles, previous.legacySources);
    }
    mkdirSync(root, { recursive: true });
    const ownedFiles = { ...(previous?.ownedFiles ?? {}) };
    const legacySources = { ...(previous?.legacySources ?? {}) };
    /** 旧文档保留原位置，附件相对路径不变；稳定任务关系继续记录原编码来源。 */
    const legacy = this.indexLegacyDocs(docsRoot, root, task.taskCode, legacySources);
    const publications = this.options.publications.list(task.id);
    const links: string[] = [];
    for (const publication of publications) {
      const deliverable = this.options.deliverables.getById(publication.deliverableId)!;
      const run = this.options.runs.getById(publication.runId)!;
      const folder = `成果/${safeRelativePath(deliverable.workItemId)}/${run.attempt}`;
      for (const file of publication.files) {
        const bytes = this.options.artifacts.readAuthorizedSync({ sha256: file.ref.sha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, maximumContentBytes: maximumArtifactBytes }).bytes;
        writeOwnedFile(root, `${folder}/${safeRelativePath(file.path)}`, bytes, ownedFiles);
      }
      links.push(`- [${markdownText(deliverable.title)}](${encodeURI(`${folder}/交接.md`)})：${markdownText(deliverable.summary)}（${deliverable.status}；成果 ${deliverable.id}；摘要 ${deliverable.contentSha256}）`);
    }
    /** 主索引只由 Core 写；工作员工不能通过共享 docs 覆盖它。 */
    const index = `<!-- zeus-task:${task.id} -->\n# ${markdownText(task.taskCode)} ${markdownText(task.title)}\n\n${task.description}\n\n## 当前资料\n\n${links.join('\n') || '尚无正式成果。'}\n${legacy.links.length ? `\n## 原任务资料\n\n${legacy.links.join('\n')}\n` : ''}${legacy.issues.length ? `\n## 待处理迁移\n\n${legacy.issues.map((issue) => `- ${issue}`).join('\n')}\n` : ''}`;
    writeOwnedFile(root, 'README.md', Buffer.from(index), ownedFiles);
    this.options.publications.saveLocation(taskId, root, ownedFiles, legacySources);
    for (const publication of publications) this.options.publications.exported(publication.deliverableId, root, null);
    return root;
  }

  /** 只列出本工作拥有或启动时明确交接的固定成果，不默认暴露同项目其他任务。 */
  list(run: TaskWorkRunRecord): Array<Record<string, unknown>> {
    /** 修复工作的显式父成果也进入相同目录，不扩大为父任务整体读取。 */
    const upstream = Array.isArray(run.entrypointSnapshot.upstreamDeliverableIds)
      ? run.entrypointSnapshot.upstreamDeliverableIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => this.options.deliverables.getById(id))
          .filter((item): item is TaskWorkDeliverableRecord => Boolean(item))
      : [];
    return [...new Map([...this.options.deliverables.listByTask(run.taskId), ...upstream].map((deliverable) => [deliverable.id, deliverable])).values()]
      .filter((deliverable) => this.canRead(run, deliverable))
      .map((deliverable) => {
        /** 历史正式成果可补建清单，正文和身份保持原样。 */
        const publication = this.options.publications.get(deliverable.id) ?? this.freeze(deliverable);
        return {
          deliverableId: deliverable.id,
          version: deliverable.version,
          summary: deliverable.summary,
          contentSha256: deliverable.contentSha256,
          status: deliverable.status,
          exportError: publication.exportError,
          files: publication.files.map((file) => ({ path: file.path, sha256: file.ref.contentSha256, bytes: file.ref.contentByteLength, mimeType: file.ref.mimeType })),
        };
      });
  }

  /** 正文按字符偏移有界读取，二进制附件只提供受控物化。 */
  read(run: TaskWorkRunRecord, input: { deliverableId: string; path: string; offset?: number; limit?: number }): Record<string, unknown> {
    const file = this.requireFile(run, input.deliverableId, input.path);
    if (!/^(text\/|application\/(json|xml|javascript))/.test(file.ref.mimeType)) throw scopeError('该附件为二进制，请使用 materialize_artifact 物化后读取。');
    const offset = boundedInteger(input.offset ?? 0, 0, maximumArtifactBytes, '读取偏移');
    const limit = boundedInteger(input.limit ?? 8_000, 1, maximumReadCharacters, '读取上限');
    const content = Buffer.from(this.options.artifacts.readAuthorizedSync({ sha256: file.ref.sha256, owner: { kind: 'task_work_deliverable', id: input.deliverableId }, maximumContentBytes: maximumArtifactBytes }).bytes).toString('utf8');
    return {
      deliverableId: input.deliverableId,
      path: file.path,
      contentSha256: file.ref.contentSha256,
      content: content.slice(offset, offset + limit),
      nextOffset: offset + limit < content.length ? offset + limit : null,
      totalCharacters: content.length,
    };
  }

  /** 受控复制到当前工作区相同资料结构；不同内容的已有文件永不覆盖。 */
  materialize(run: TaskWorkRunRecord, input: { deliverableId: string; path?: string }): { root: string; files: string[] } {
    const deliverable = this.requireDeliverable(run, input.deliverableId);
    const publication = this.options.publications.get(deliverable.id) ?? this.freeze(deliverable);
    const ownerRun = this.options.runs.getById(deliverable.runId)!;
    const task = this.options.tasks.getById(run.taskId)!;
    const root = this.workspaceRoot(run);
    const selected = input.path ? [this.requireFile(run, deliverable.id, input.path)] : publication.files;
    const paths: string[] = [];
    for (const file of selected) {
      const target = `docs/${safeRelativePath(task.taskCode || task.id)}/成果/${safeRelativePath(deliverable.workItemId)}/${ownerRun.attempt}/${safeRelativePath(file.path)}`;
      const bytes = this.options.artifacts.readAuthorizedSync({ sha256: file.ref.sha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, maximumContentBytes: maximumArtifactBytes }).bytes;
      writeOwnedFile(root, target, bytes, {});
      paths.push(target);
    }
    return { root, files: paths };
  }

  /** 工作区身份来自绑定会话；缺少工作区时不退回项目源码目录。 */
  private workspaceRoot(run: TaskWorkRunRecord): string {
    const conversation = run.conversationId ? this.options.conversations.getRecordById(run.conversationId) : undefined;
    if (!conversation || conversation.taskId !== run.taskId || conversation.projectId !== run.projectId) throw scopeError('当前工作没有可核对的执行会话。');
    const workspace = conversation.workspaceId ? this.options.workspaces.getById(conversation.workspaceId) : undefined;
    if (conversation.workspaceId && (!workspace || workspace.taskId !== run.taskId || workspace.projectId !== run.projectId || workspace.state !== 'ready')) throw scopeError('当前工作区的归属或有效状态不匹配，不能读取或物化成果文件。');
    const root = workspace?.worktreePath || (run.workspaceSnapshot?.mode === 'direct' ? this.options.projects.getById(run.projectId)?.localPath : null);
    if (!root) throw scopeError('当前工作区不可用，不能从其他目录读取或写出文件。');
    return realpathSync(root);
  }

  /** 启动时冻结的成果授权不能由员工提交的结果字段扩大。 */
  private canRead(run: TaskWorkRunRecord, deliverable: TaskWorkDeliverableRecord): boolean {
    const upstream = run.entrypointSnapshot.upstreamDeliverableIds;
    return (
      deliverable.projectId === run.projectId &&
      (deliverable.taskId === run.taskId || (Array.isArray(upstream) && upstream.includes(deliverable.id) && this.options.publications.repairHandoffForRun(run.id, deliverable.id))) &&
      (deliverable.runId === run.id ||
        run.contextManifest.acceptedDeliverables.some((ref) => ref.deliverableId === deliverable.id && ref.contentSha256 === deliverable.contentSha256) ||
        (Array.isArray(upstream) && upstream.includes(deliverable.id)))
    );
  }

  /** 先核对工作权限再读取对象，owner 存在本身不是业务授权。 */
  private requireDeliverable(run: TaskWorkRunRecord, id: string): TaskWorkDeliverableRecord {
    const deliverable = this.options.deliverables.getById(id);
    if (!deliverable || !this.canRead(run, deliverable)) throw scopeError('该正式成果没有交接给当前工作。');
    return deliverable;
  }

  /** 读取只能引用冻结目录内的精确文件。 */
  private requireFile(run: TaskWorkRunRecord, id: string, path: string): WorkArtifactFile {
    const deliverable = this.requireDeliverable(run, id);
    const publication = this.options.publications.get(id) ?? this.freeze(deliverable);
    const file = publication.files.find((candidate) => candidate.path === safeRelativePath(path));
    if (!file) throw scopeError('成果目录中不存在该文件。');
    return file;
  }

  /** 旧资料只登记原位置，沿用上下文候选规则，不搬动正文或破坏相对附件链接。 */
  private indexLegacyDocs(docsRoot: string, root: string, taskCode: string, sources: Record<string, string>): { links: string[]; issues: string[] } {
    /** 已登记的来源在任务重编号后仍参与索引，不按新编码遗忘旧文件。 */
    const names = new Set(readdirSync(docsRoot).filter((name) => taskCode && filenameMatchesTaskCode(name, taskCode) && ['.md', '.html'].includes(extname(name).toLowerCase())));
    const issues: string[] = [];
    const links: string[] = [];
    for (const source of Object.keys(sources)) {
      /** 只认本项目 docs 根下原来的平铺文件，旧账本不能扩大路径范围。 */
      const name = relative(docsRoot, source);
      if (!name || name.includes(sep) || name === '..' || resolve(docsRoot, name) !== source) {
        issues.push(`${markdownText(basename(source))} 的原来源不在当前资料根，保留记录等待核对。`);
        continue;
      }
      names.add(name);
    }
    /** 历史迁移副本仍保留；源文件存在时优先回到有效原位置。 */
    const copies = safePath(root, '旧资料');
    if (existsSync(copies)) for (const name of readdirSync(copies)) if (lstatSync(safePath(root, `旧资料/${name}`)).isFile()) names.add(name);
    for (const name of [...names].sort()) {
      const source = safePath(docsRoot, name);
      if (!existsSync(source)) {
        const copy = safePath(root, `旧资料/${name}`);
        if (existsSync(copy) && lstatSync(copy).isFile()) links.push(`- [${markdownText(name)}](${documentLink(root, copy)})（历史副本）`);
        issues.push(`${markdownText(name)} 原来源已缺失，保留历史副本与来源记录；相对附件需核对。`);
        continue;
      }
      const sourceStat = lstatSync(source);
      if (!sourceStat.isFile()) continue;
      /** 索引不读取超大正文，原有文件读取容量仍由受控工具核对。 */
      if (sourceStat.size > maximumArtifactBytes) {
        issues.push(`${markdownText(name)} 超过读取容量，保留来源等待人工整理。`);
      }
      /** 旧迁移副本可能已被用户编辑，内容冲突保留两份并明确提示，绝不覆盖。 */
      const copy = safePath(root, `旧资料/${name}`);
      if (existsSync(copy) && lstatSync(copy).isFile()) {
        const copyStat = lstatSync(copy);
        if (copyStat.size > maximumArtifactBytes || sourceStat.size > maximumArtifactBytes) issues.push(`${markdownText(name)} 的历史副本超过核对容量，保留两份等待核对。`);
        else if (copyStat.size !== sourceStat.size || !readFileSync(copy).equals(readFileSync(source))) issues.push(`${markdownText(name)} 历史副本与原来源内容不一致，保留两份并优先原位置。`);
      }
      sources[source] = `${sourceStat.dev}:${sourceStat.ino}:${sourceStat.size}:${sourceStat.mtimeMs}:${sourceStat.ctimeMs}`;
      links.push(`- [${markdownText(name)}](${documentLink(root, source)})（原位置）`);
    }
    return { links, issues };
  }
}

/** 链接从当前索引位置计算，特殊文件名不能改变 Markdown 或 URL 的解析范围。 */
function documentLink(root: string, target: string): string {
  return relative(root, target)
    .split(sep)
    .map((part) => encodeURIComponent(part).replace(/[()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/** 只允许明确的相对路径，不接受绝对路径、空段或目录逃逸。 */
function safeRelativePath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 1_024 || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..'))
    throw scopeError('成果路径必须是工作区内的安全相对路径。');
  return path;
}

/** 逐段拒绝符号链接，目录不存在时也不能逃出已知根目录。 */
function safePath(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, safeRelativePath(path));
  if (relative(base, target).startsWith(`..${sep}`) || target === base) throw scopeError('成果路径越过资料根目录。');
  for (const part of [base, ...path.split('/').map((_, index, parts) => join(base, ...parts.slice(0, index + 1)))]) if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw scopeError('成果路径不能使用符号链接。');
  return target;
}

/** Core 只覆盖上次写出的相同内容，人工或其他工作修改一律保留并报冲突。 */
function writeOwnedFile(root: string, path: string, bytes: Uint8Array, ownedFiles: Record<string, string>): void {
  const target = safePath(root, path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) throw scopeError(`资料路径已有非文件：${path}`);
    const current = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (current === digest) {
      ownedFiles[path] = digest;
      return;
    }
    if (current !== ownedFiles[path]) throw scopeError(`资料已被其他来源修改，保留现场：${path}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  /** 临时文件仅用于同目录原子替换；正常路径不暴露半份文档。 */
  const pending = `${target}.${randomUUID()}.zeus-pending`;
  try {
    writeFileSync(pending, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(pending, target);
  } finally {
    if (existsSync(pending)) unlinkSync(pending);
  }
  ownedFiles[path] = digest;
}

/** 文本类型明确时允许按需正文读取，其余附件按二进制处理。 */
function mimeType(path: string): string {
  return /\.(md|txt|log|csv|[cm]?ts|tsx|[cm]?js|jsx|py|sh|css|html|xml|yaml|yml)$/i.test(path) ? 'text/plain' : /\.json$/i.test(path) ? 'application/json' : 'application/octet-stream';
}

/** 摘要与标题不允许改变索引的 Markdown 结构。 */
function markdownText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\[\]()*_`<>]/g, '\\$&');
}

/** 数字输入在受控读取入口完整校验。 */
function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw scopeError(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  return value;
}

/** 业务权限与目录冲突使用既有工作错误契约。 */
function scopeError(message: string): TaskWorkStoreError {
  return new TaskWorkStoreError('ZEUS_WORK_ARTIFACT_SCOPE', message);
}
